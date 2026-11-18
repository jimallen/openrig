// workspaces-o9o.136 (GAP-7 in the hc era): a seat must run with the HOME the daemon preseeds into, even on a seat host started with another
// HOME. Measured at release-7: every seat's env is built by seatEnvironment (hc-seat.ts) from the daemon's env, for every runtime, so a seat
// gets the daemon's HOME and not the hc core's. The stub makes that observable: its adapter writes a per-launch preseed record under the
// daemon's HOME before the runner starts, and the runner reports on its pane whether it found that record under its OWN HOME.
import { afterEach, describe, expect, it } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { stubSeatSidecarPath } from "../src/adapters/stub-runner-protocol.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
// The record's place, stated here as the contract: <HOME>/.openrig-stub/preseed/<session, URI-encoded>, holding {"launchId": ...}.
const preseedPath = (home: string, session: string) => join(home, ".openrig-stub", "preseed", encodeURIComponent(session));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "o9o136-")); dirs.push(d); return d; };

describe("the stub runner reports whether the daemon's preseed reached its HOME", () => {
  let child: ChildProcess | undefined;
  afterEach(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); child = undefined; });

  async function runnerOutput(home: string, launchId: string): Promise<string> {
    const cwd = temp();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, OPENRIG_HOME: join(cwd, "openrig-home") };
    for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_ACTIVITY_HOOK_TOKEN", "CLAUDE_CONFIG_DIR"]) delete env[key];
    let out = "";
    child = execFile("node", ["--import", "tsx", RUNNER, "--session-name", "dev@rig", "--cwd", cwd, "--launch-id", launchId, "--posture", "floor"], { env });
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += String(d); });
    for (const end = Date.now() + 10_000; Date.now() < end && !/preseed/.test(out) && child.exitCode === null;) await new Promise((r) => setTimeout(r, 50));
    return out;
  }

  it("a record for THIS launch under its HOME: 'trust reached'", async () => {
    const home = temp();
    mkdirSync(dirname(preseedPath(home, "dev@rig")), { recursive: true });
    writeFileSync(preseedPath(home, "dev@rig"), JSON.stringify({ launchId: "launch-136" }));
    expect(await runnerOutput(home, "launch-136")).toContain("[stub-runner] preseed: trust reached|");
  });

  it("no record under its HOME: the miss is visible, naming the HOME it ran with", async () => {
    const home = temp();
    const out = await runnerOutput(home, "launch-136");
    expect(out).toContain("[stub-runner] preseed NOT reached");
    expect(out).toContain(`HOME=${home}|`);
    expect(out).not.toContain("trust reached");
  });

  it("a record left by ANOTHER launch is not this launch's preseed", async () => {
    const home = temp();
    mkdirSync(dirname(preseedPath(home, "dev@rig")), { recursive: true });
    writeFileSync(preseedPath(home, "dev@rig"), JSON.stringify({ launchId: "launch-earlier" }));
    const out = await runnerOutput(home, "launch-136");
    expect(out).toContain("[stub-runner] preseed NOT reached");
    expect(out).not.toContain("trust reached");
  });
});

describe("the stub adapter preseeds under the daemon's HOME before the runner starts", () => {
  function launch(daemonHome: string | undefined) {
    const files = new Map<string, string>([["/r.js", ""]]);
    const order: string[] = [];
    const cwd = "/work";
    const tmux = Object.assign(mockTmuxAdapter(), {
      sendShellCommand: async () => { order.push("launch-command"); return { ok: true as const }; },
      capturePaneContent: async () => "",
      hasSession: async () => true,
      getPaneCommand: async () => "node",
    });
    const adapter = new StubRuntimeAdapter({
      tmux,
      runnerEntryPath: "/r.js",
      newLaunchId: () => "launch-136",
      sleep: async () => {},
      daemonHome,
      fsOps: {
        readFile: (p: string) => (p === stubSeatSidecarPath(cwd) ? JSON.stringify({ ready: true, launchId: "launch-136", updatedAt: "t" }) : files.get(p) ?? ""),
        writeFile: (p: string, c: string) => { order.push(`write ${p}`); files.set(p, c); },
        exists: (p: string) => p === stubSeatSidecarPath(cwd) || files.has(p),
        mkdirp: () => {},
      },
    } as never);
    return { files, order, run: adapter.launchHarness({ tmuxSession: "dev@rig", cwd } as never, { name: "dev@rig" }) };
  }

  it("writes {launchId} at <daemon HOME>/.openrig-stub/preseed/<session> before the launch command", async () => {
    const { files, order, run } = launch("/daemon-home");
    expect((await run).ok).toBe(true);
    const at = preseedPath("/daemon-home", "dev@rig");
    expect(JSON.parse(files.get(at) ?? "null")).toEqual({ launchId: "launch-136" });
    expect(order.indexOf(`write ${at}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`write ${at}`)).toBeLessThan(order.indexOf("launch-command"));
  });

  it("a daemon with no HOME writes no record and still launches (the runner then reports the miss)", async () => {
    const { files, run } = launch("");
    expect((await run).ok).toBe(true);
    expect([...files.keys()].some((p) => p.includes(".openrig-stub"))).toBe(false);
  });
});

describe("source pins", () => {
  it("the record's place is one shared definition (stub-runner-protocol.ts), used by the adapter and the runner", () => {
    const protocol = readFileSync(resolve(HERE, "../src/adapters/stub-runner-protocol.ts"), "utf8");
    expect(protocol).toContain('".openrig-stub", "preseed"');
    for (const f of ["stub-runtime-adapter.ts", "stub-runner.ts"]) {
      expect(readFileSync(resolve(HERE, `../src/adapters/${f}`), "utf8"), f).toContain("stubPreseedPath(");
    }
    expect(existsSync(resolve(HERE, "../src/adapters/stub-runner-protocol.ts"))).toBe(true);
  });
});
