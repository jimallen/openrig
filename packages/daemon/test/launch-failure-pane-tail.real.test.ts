// workspaces-o9o.3, on a real tmux server (a private socket directory, never the operator's; the session's TMUX is not
// passed on): on Sparky an oh-my-zsh "update? [Y/n]" prompt swallowed a seat's launch command and OpenRig reported only
// "Readiness timeout after 30s". Here a controlled script stands in for that shell: it prints the prompt, reads one line
// (the launch command typed into the pane becomes its answer) and then waits. The surfaced error must quote it.
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { paneTailQuote } from "../src/domain/launch-failure-report.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!HAS_TMUX || process.platform === "win32")("a launch swallowed by a shell prompt names the prompt in its error (real tmux)", () => {
  // Set only once each step succeeds, so cleanup never acts on a half-made fixture (verify-sec, o9o.3 review): with no
  // private env, a bare `tmux kill-server` would inherit this process's environment and could reach a LIVE server.
  let base: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let tmuxAdapter: TmuxAdapter;
  let db: Database.Database | undefined;
  const tmux = (...args: string[]) => {
    if (!env) throw new Error("no private tmux environment: refusing to run tmux against an inherited server");
    return execFileSync("tmux", args, { env, encoding: "utf8" });
  };
  const SESSION = "build-impl@o9o3";

  beforeAll(() => {
    // A short socket directory under /tmp (a unix socket path is bounded), and an environment built from scratch: no TMUX,
    // no TMUX_PANE, HOME pointed at the scratch dir so no rc file of the operator's runs.
    const root = realpathSync(mkdtempSync("/tmp/o9o3-"));
    base = root;
    const privateEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMUX_TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh" };
    env = privateEnv;
    tmuxAdapter = new TmuxAdapter((cmd) => new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { env: privateEnv, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
    }));
    db = createFullTestDb();
  });
  afterAll(() => {
    try { db?.close(); } finally {
      // Only a server this fixture started, on its own socket directory; only the temp root it made.
      if (env) { try { tmux("kill-server"); } catch { /* already gone */ } }
      if (base) rmSync(base, { recursive: true, force: true });
    }
  });

  it("the readiness-timeout result quotes the prompt that ate the launch command, and the durable error does not", async () => {
    if (!base || !db) throw new Error("fixture not initialized");
    const root = base;
    const database = db;
    const script = join(root, "swallow.sh");
    writeFileSync(script, "printf '[oh-my-zsh] Would you like to update? [Y/n] '\nread answer\nexec sleep 600\n");
    tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "20", `/bin/sh ${script}`);
    for (let i = 0; i < 100 && !tmux("capture-pane", "-p", "-t", `=${SESSION}:`).includes("[Y/n]"); i++) await new Promise((r) => setTimeout(r, 50));

    const rigRepo = new RigRepository(database);
    const sessionRegistry = new SessionRegistry(database);
    const rig = rigRepo.createRig("o9o3-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SESSION);
    sessionRegistry.updateStatus(session.id, "running");

    // The launch types its command the way a runtime adapter does; the prompt's `read` takes it as the answer.
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => { tmux("send-keys", "-t", `=${SESSION}:`, "-l", "claude --permission-mode auto"); tmux("send-keys", "-t", `=${SESSION}:`, "Enter"); return { ok: true as const }; },
      checkReady: async () => ({ ready: false, reason: "harness not interactive" }),
    };
    const orch = new StartupOrchestrator({
      db: database, sessionRegistry, eventBus: new EventBus(database), tmuxAdapter,
      sleep: async () => {}, listProcesses: async () => [],
    });
    const result = await orch.startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "b1", nodeId: node.id, tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: root },
      adapter, plan: { runtime: "claude-code", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, resolvedStartupFiles: [], startupActions: [], isRestore: false,
      readinessTimeoutMs: 1500,
    });

    if (result.ok) throw new Error("expected a readiness failure");
    expect(result.errors).toHaveLength(1);
    // workspaces-o9o.3 review: the pane tail is never stored. The error (persisted in node.startup_failed) carries a fixed
    // marker; the tail rides StartupResult.paneTail, which only responses carry.
    expect(result.errors).toEqual(["Readiness timeout after 1.5s — harness did not become interactive: harness not interactive — pane tail not stored"]);
    expect(result.paneTail).toContain("[oh-my-zsh] Would you like to update? [Y/n] claude --permission-mode auto");
    const persisted = (database.prepare("SELECT payload FROM events WHERE type = 'node.startup_failed' AND node_id = ?").all(node.id) as { payload: string }[]).map((r) => r.payload);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toContain("oh-my-zsh");
  });

  // workspaces-o9o.3 review (verify-sec 2): a token wider than the pane soft-wraps. Captured without -J it arrives as two
  // lines, neither of which matches a pattern; captured with -J it is one line again and is redacted.
  it("a soft-wrapped token is redacted once the capture joins wrapped lines", async () => {
    if (!base) throw new Error("fixture not initialized");
    const token = "sk-" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const session = "build-qa@o9o3";
    const script = join(base, "wrap.sh");
    writeFileSync(script, `printf '%s\\n' 'KEY=${token}'\nexec sleep 600\n`);
    tmux("new-session", "-d", "-s", session, "-x", "24", "-y", "10", `/bin/sh ${script}`);
    for (let i = 0; i < 100 && !tmux("capture-pane", "-p", "-t", `=${session}:`).includes("0123"); i++) await new Promise((r) => setTimeout(r, 50));
    const split = (await tmuxAdapter.capturePaneContent(session, 40)) ?? "";
    expect(split).not.toContain(token); // the defect's precondition: tmux really wrapped it
    // The defect: unjoined, the first fragment may still match a pattern, but the wrapped remainder of the token leaks.
    expect(paneTailQuote(split)).toContain("rstuvwxyz0123456789");
    const joined = (await tmuxAdapter.capturePaneContent(session, 40, { joinWrappedLines: true })) ?? "";
    expect(joined).toContain(token);
    expect(paneTailQuote(joined)).toBe("KEY=[REDACTED]");
    expect(paneTailQuote(joined)).not.toContain("rstuvwxyz0123456789");
  });
});
