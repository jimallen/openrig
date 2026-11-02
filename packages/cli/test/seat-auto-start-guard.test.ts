import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { startCommand } from "../src/commands/start.js";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { startDaemon, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { HC_TESTED_VERSION } from "../src/tmux-health.js";

// A seat starts no daemon by any `rig` verb (decision 63, widened to the auto-start sites by the second plan read, S4): `rig up`,
// `rig start` and `rig context add` start a stopped local daemon, and so does startDaemon for any other caller. The identity names
// are restated here, not imported from the guard. The daemon is stopped in every row: the fake `spawn` is what a start would call.
const SEAT_VALUE = "seat-value-that-must-not-be-printed@somerig";
let root: string;
let source: string;
let output: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seat-auto-start-"));
  source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "manifest.yaml"), "name: fixture-pack\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: NOTES.md\n    role: instruction\n");
  writeFileSync(join(source, "NOTES.md"), "fixture context\n");
  vi.stubEnv("OPENRIG_HOME", join(root, "state"));
  vi.stubEnv("OPENRIG_CONTEXT_ROOT", join(root, "context"));
  vi.stubEnv("OPENRIG_DB", join(root, "state", "fixture.sqlite"));
  vi.stubEnv("OPENRIG_TRANSCRIPTS_PATH", join(root, "transcripts"));
  vi.stubEnv("OPENRIG_PORT", "42771");
  vi.stubEnv("OPENRIG_HOST", "127.0.0.1");
  vi.stubEnv("RIGGED_HOST", "");
  // A named runtime location on every platform, so these rows judge identity alone.
  vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run"));
  vi.stubEnv("OPENRIG_HC_NO_START_CORE", "");
  output = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function stoppedDeps() {
  // `spawn` is what a start calls: it records the call and throws, so no row ever reaches a daemon or a poll.
  const lifecycleDeps: LifecycleDeps = {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
    spawn: vi.fn((): ChildProcess => { throw new Error("spawn reached"); }),
    fetch: vi.fn(async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => false),
    sleep: async () => {},
  };
  const clientFactory = vi.fn((baseUrl: string) => new DaemonClient(baseUrl));
  const preflightExec = vi.fn(async (cmd: string) => cmd === "hc --version" ? `hc ${HC_TESTED_VERSION}` : "");
  return { lifecycleDeps, clientFactory, preflightExec };
}

// One row per call site that reaches startDaemon (census: up.ts, start.ts, context.ts getClient(true) from two context-add paths).
const SITES: Array<[string, (d: ReturnType<typeof stoppedDeps>) => Promise<unknown>]> = [
  ["rig up", (d) => new Command().exitOverride().addCommand(upCommand(d)).parseAsync(["node", "rig", "up", "/tmp/test.yaml"])],
  ["rig start", (d) => new Command().exitOverride().addCommand(startCommand({ ...d, promptYesNo: async () => false })).parseAsync(["node", "rig", "start", "--last"])],
  ["rig context add", (d) => new Command().exitOverride().addCommand(contextCommand(d)).parseAsync(["node", "rig", "context", "add", source, "--json"])],
];

describe.each(SITES)("%s with the daemon stopped", (_name, run) => {
  it.each(["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"])(
    "starts no daemon in a seat (%s set): nothing is spawned, the cause and the operator are named, no value is printed", async (name) => {
      vi.stubEnv(name, SEAT_VALUE);
      const d = stoppedDeps();
      await run(d).catch(() => undefined);
      expect(d.lifecycleDeps.spawn).not.toHaveBeenCalled();
      const text = output.join("\n");
      expect(text).toContain("rig daemon start is refused in a seat");
      expect(text).toContain(name);
      expect(text).toContain("operator");
      expect(text).not.toContain(SEAT_VALUE);
      expect(process.exitCode, "the command failed").toBeTruthy();
    });
  it("starts the daemon outside a seat (positive control: the same call, no identity)", async () => {
    const d = stoppedDeps();
    await run(d).catch(() => undefined);
    expect(d.lifecycleDeps.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("startDaemon itself, for any caller", () => {
  it("is refused in a seat before it takes the launch reservation or spawns", async () => {
    vi.stubEnv("OPENRIG_NODE_ID", SEAT_VALUE);
    const d = stoppedDeps();
    const acquire = vi.fn(d.lifecycleDeps.acquireStartLock);
    await expect(startDaemon({ port: 42771 }, { ...d.lifecycleDeps, acquireStartLock: acquire })).rejects.toThrow("rig daemon start is refused in a seat");
    expect(acquire).not.toHaveBeenCalled();
    expect(d.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });
  it("is refused when the env names no runtime location, even outside a seat", async () => {
    for (const name of ["HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HC_SOCKET"]) vi.stubEnv(name, "");
    const d = stoppedDeps();
    await expect(startDaemon({ port: 42771 }, d.lifecycleDeps)).rejects.toThrow("refusing to start an hc core");
    expect(d.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });
  it("does not judge the location when the daemon will not start a core (OPENRIG_HC_NO_START_CORE=1)", async () => {
    for (const name of ["HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HC_SOCKET"]) vi.stubEnv(name, "");
    vi.stubEnv("OPENRIG_HC_NO_START_CORE", "1");
    const d = stoppedDeps();
    await startDaemon({ port: 42771 }, d.lifecycleDeps).catch(() => undefined);
    expect(d.lifecycleDeps.spawn).toHaveBeenCalledTimes(1);
  });
});
