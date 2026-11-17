import { afterEach, describe, expect, it } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStubScript, StubScriptError } from "../src/adapters/stub-script.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { stubSeatScriptPath, stubSeatSidecarPath } from "../src/adapters/stub-runner-protocol.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";

// workspaces-o9o.29: a stub seat can be held short of ready, so the launch-failure paths o9o.3 reports (a readiness
// timeout, a runner that exits before ready) can be exercised end to end. The runner used to write its ready sidecar
// before it read its script, so no script could hold a seat back; and a stub launch failure carried no pane tail and no
// runner ERROR line, which o9o.3 gave only to Pi.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");

describe("o9o.29: a stub script's readiness", () => {
  it("defaults to ready, and reads hold and exit", () => {
    expect(parseStubScript('{"steps":[]}').readiness ?? "ready").toBe("ready");
    expect(parseStubScript('{"readiness":"hold","steps":[{"kind":"say","text":"held"}]}')).toMatchObject({ readiness: "hold" });
    expect(parseStubScript('{"readiness":"exit","error":"refused: no seat login","steps":[]}'))
      .toMatchObject({ readiness: "exit", error: "refused: no seat login" });
  });

  it.each([
    ["an unknown readiness", '{"readiness":"later","steps":[]}', /readiness/],
    ["exit without an error", '{"readiness":"exit","steps":[]}', /error/],
    ["exit with an empty error", '{"readiness":"exit","error":"","steps":[]}', /error/],
    ["an error on a seat that does not exit", '{"readiness":"hold","error":"x","steps":[]}', /error/],
    ["an emit on a held seat", '{"readiness":"hold","steps":[{"kind":"emit","behavior":"compaction"}]}', /ready seat/],
    ["an emit on a seat that exits", '{"readiness":"exit","error":"x","steps":[{"kind":"emit","behavior":"restore"}]}', /ready seat/],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => parseStubScript(raw)).toThrow(StubScriptError);
    expect(() => parseStubScript(raw)).toThrow(message);
  });
});

/** A stub adapter on its runner path, with a fake filesystem holding the sidecar and a fake pane. */
function adapterWith(sidecar: () => string | null, pane: string) {
  const files = new Map<string, string>([["/r.js", ""]]);
  const tmux = Object.assign(mockTmuxAdapter(), {
    sendShellCommand: async () => ({ ok: true as const }),
    capturePaneContent: async () => pane,
  });
  const adapter = new StubRuntimeAdapter({
    tmux,
    runnerEntryPath: "/r.js",
    newLaunchId: () => "launch-1",
    sleep: async () => {},
    fsOps: {
      readFile: (p) => (p === stubSeatSidecarPath("/work") ? sidecar() ?? "" : files.get(p) ?? ""),
      writeFile: () => {},
      exists: (p) => (p === stubSeatSidecarPath("/work") ? sidecar() !== null : files.has(p)),
      mkdirp: () => {},
    },
  });
  return adapter.launchHarness({ tmuxSession: "dev@rig", cwd: "/work" } as Parameters<StubRuntimeAdapter["launchHarness"]>[0], { name: "dev@rig" });
}

describe("o9o.29: a stub launch failure says what the pane showed", () => {
  it("a runner that exits says so with its own ERROR line, and carries the pane tail apart", async () => {
    const exited = JSON.stringify({ ready: false, launchId: "launch-1", exited: { code: 1, at: "t" }, updatedAt: "t" });
    const result = await adapterWith(() => exited, "booting\n[stub-runner] ERROR refused: no seat login\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("stub launch failed: the runner exited (code 1) — runner said: [stub-runner] ERROR refused: no seat login");
    expect(result.recovery).toBe("attention_required");
    expect(result.paneTail).toBe("booting | [stub-runner] ERROR refused: no seat login");
  });

  it("a seat held short of ready times out with the pane tail, and its durable error does not store the tail", async () => {
    const result = await adapterWith(() => null, "[stub] held line one\n[stub] held line two\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("stub launch: timed out waiting for the runner to report ready — pane tail not stored");
    expect(result.paneTail).toBe("[stub] held line one | [stub] held line two");
  });

  it("an ERROR line carrying a token is redacted in the error and the tail", async () => {
    const token = ["xox", "b-", "1234567890", "-", "abcdefghijklmnop"].join("");
    const exited = JSON.stringify({ ready: false, launchId: "launch-1", exited: { code: 1, at: "t" }, updatedAt: "t" });
    const result = await adapterWith(() => exited, `[stub-runner] ERROR refused with ${token}\n`);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).not.toContain(token);
    expect(result.paneTail ?? "").not.toContain(token);
    expect(result.error).toContain("[stub-runner] ERROR refused with");
  });
});

describe("o9o.29: the real stub runner held short of ready, or exiting before ready", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function spawnWith(script: object): { out: () => string; exit: Promise<number | null> } {
    dir = mkdtempSync(join(tmpdir(), "o9o29-"));
    mkdirSync(dirname(stubSeatScriptPath(dir)), { recursive: true });
    writeFileSync(stubSeatScriptPath(dir), JSON.stringify(script));
    const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: join(dir, "home") };
    for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_ACTIVITY_HOOK_TOKEN"]) delete env[key];
    let out = "";
    child = execFile("node", ["--import", "tsx", RUNNER, "--session-name", "dev@rig", "--cwd", dir, "--launch-id", "launch-9", "--posture", "floor"], { env });
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += String(d); });
    const exit = new Promise<number | null>((done) => child!.on("exit", (code) => done(code)));
    return { out: () => out, exit };
  }

  const sidecar = () => (existsSync(stubSeatSidecarPath(dir!)) ? JSON.parse(readFileSync(stubSeatSidecarPath(dir!), "utf8")) : null);
  const until = async (cond: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !cond();) await new Promise((r) => setTimeout(r, 50));
  };

  it("hold: prints its lines, never reports ready, and stays running until a signal, which it records", async () => {
    const run = spawnWith({ readiness: "hold", steps: [{ kind: "say", text: "o9o29 held seat line" }] });
    await until(() => run.out().includes("o9o29 held seat line"), 15_000);
    expect(run.out()).toContain("o9o29 held seat line");
    await new Promise((r) => setTimeout(r, 1500));
    expect(sidecar()?.ready ?? false).toBe(false);
    expect(run.out()).not.toContain("[stub-runner] READY");
    expect(child!.exitCode).toBeNull();
    child!.kill("SIGTERM");
    expect(await run.exit).toBe(0);
    expect(sidecar()).toMatchObject({ ready: false, launchId: "launch-9", exited: { code: 0 } });
  }, 30_000);

  it("exit: prints its lines and its ERROR line, records the exit for this launch, and exits 1 without ever being ready", async () => {
    const run = spawnWith({ readiness: "exit", error: "o9o29 refused: no seat login", steps: [{ kind: "say", text: "o9o29 checking login" }] });
    const code = await Promise.race([run.exit, new Promise<"alive">((r) => setTimeout(() => r("alive"), 15_000))]);
    expect(code).toBe(1);
    expect(run.out()).toContain("o9o29 checking login");
    expect(run.out()).toContain("[stub-runner] ERROR o9o29 refused: no seat login");
    expect(run.out()).not.toContain("[stub-runner] READY");
    expect(sidecar()).toMatchObject({ ready: false, launchId: "launch-9", exited: { code: 1 } });
  }, 30_000);
});
