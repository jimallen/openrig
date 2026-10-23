// pda runtime L2a: the REAL createDaemon composition registers `runtime: pda` and wires `rig send`'s runner readiness
// from the adapter map through L0's factory (review L0 delta f587d48d, nit D2: "keep L2a's pin that startup calls the
// factory"). Pins read the composed objects, never startup.ts's text. No pda, tmux or seat is touched: tmux exec is a
// stub and the state root is a scratch OPENRIG_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { PdaResumeAdapter } from "../src/adapters/pda-resume.js";
import { adapterFreshStart, RUNTIMES_WITHOUT_FRESH_START, type RunnerSendReadinessSource, type RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { pdaSeatPaths } from "../src/adapters/pda-runner-protocol.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";

let db: Database.Database;
let deps: AppDeps;
let scratch: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pda-l2a-wiring-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL", "OPENRIG_PDA_TOKEN_FILE"]) saved[k] = process.env[k];
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "wiring.sqlite");
  process.env.OPENRIG_PDA_TOKEN_FILE = path.join(scratch, "no-such-token");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async () => "";
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(scratch, { recursive: true, force: true });
});

const priv = <T>(obj: unknown, key: string): T => (obj as Record<string, T>)[key] as T;

describe("pda L2a startup wiring", () => {
  it("registers the pda adapter in the routes' adapter map (census rows 1, 2)", () => {
    const map = deps.runtimeAdapters as Record<string, RuntimeAdapter>;
    expect(map.pda).toBeInstanceOf(PdaRuntimeAdapter);
    expect(Object.keys(map).sort()).toEqual(["claude-code", "codex", "omp", "pda", "pi", "stub", "terminal"]);
  });

  it("the instantiator launches through the SAME pda adapter (census row 1)", () => {
    const inst = priv<{ deps: { adapters: Record<string, RuntimeAdapter> } }>(deps, "podInstantiator");
    expect(inst.deps.adapters.pda).toBe((deps.runtimeAdapters as Record<string, RuntimeAdapter>).pda);
  });

  it("rig send's runner readiness is the factory's source over the adapter map: it asks pda, and only pda", async () => {
    const source = priv<RunnerSendReadinessSource | undefined>(deps.sessionTransport, "runnerSendReadiness");
    expect(source).toBeDefined();
    expect([...source!.runtimes]).toEqual(["pda"]);
    // A hand-built source claiming every runtime would also answer for claude-code; the factory's answers null.
    expect(await source!.ask({ sessionName: "x@y", nodeId: null, runtime: "claude-code" })).toBeNull();
    // It reaches the registered adapter: a ready, alive sidecar under this daemon's state root reads idle.
    const pdaAdapter = (deps.runtimeAdapters as Record<string, RuntimeAdapter>).pda!;
    const stateRoot = priv<{ stateRoot: string }>(pdaAdapter, "deps").stateRoot;
    // <OPENRIG_HOME>/state/pda (the suite's setup pins OPENRIG_HOME to a fixture home at module load).
    expect(stateRoot.endsWith(`${path.sep}state${path.sep}pda`)).toBe(true);
    expect(stateRoot.startsWith(os.tmpdir())).toBe(true);
    const paths = pdaSeatPaths(stateRoot, "seat@rig");
    fs.mkdirSync(paths.seatRoot, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify({ ready: true, launchId: "l", updatedAt: at, aliveAt: at, agent: "a1", baseUrl: "http://127.0.0.1:8150", connected: true, busy: false, outboxPending: 0 }));
    expect(await source!.ask({ sessionName: "seat@rig", nodeId: null, runtime: "pda" })).toMatchObject({ state: "idle", reason: "runner_idle" });
  });

  it("the restore orchestrator resumes pda tokens through the pda resume adapter (census rows 3, 8)", () => {
    const restore = deps.restoreOrchestrator;
    expect(priv(restore, "pdaResume")).toBeInstanceOf(PdaResumeAdapter);
    expect(priv<PdaResumeAdapter>(restore, "pdaResume").canResume("pda_agent", "http://127.0.0.1:8150/agents/a1")).toBe(true);
  });

  it("RUNTIMES_WITHOUT_FRESH_START is exactly the adapter map's freshStart=unsupported keys (no drift)", () => {
    const map = deps.runtimeAdapters as Record<string, RuntimeAdapter>;
    const unsupported = Object.entries(map).filter(([, a]) => adapterFreshStart(a) === "unsupported").map(([k]) => k).sort();
    expect(unsupported).toEqual([...RUNTIMES_WITHOUT_FRESH_START].sort());
    expect(unsupported).toEqual(["pda"]); // positive control: the comparison is not of two empty sets
  });

  it("the pda adapter reads the token file from OPENRIG_PDA_TOKEN_FILE, as a path, at launch", () => {
    const pdaAdapter = (deps.runtimeAdapters as Record<string, RuntimeAdapter>).pda!;
    expect(priv<{ tokenFile: () => string }>(pdaAdapter, "deps").tokenFile()).toBe(process.env.OPENRIG_PDA_TOKEN_FILE);
  });
});
