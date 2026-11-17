// workspaces-o9o.31: a Codex seat names its running tool, read from its rollout, because Codex relays no tool hook. The rollout lines here
// have the shape measured (structure only) on this host's codex-cli 0.137 to 0.158 rollouts and one 0.166.0 turn: a `custom_tool_call`
// (name `exec`) with a call_id, closed by a `custom_tool_call_output` with the same call_id, inside `task_started` .. `task_complete`.
// The consumers are driven through the real relay (its Codex UserPromptSubmit), the real AgentActivityStore and the real adapter on a file.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { openCallsIn, type SeatOpenCallsSource, type SeatTurnEvent } from "../src/domain/codex-open-calls.js";
import { CodexRolloutOpenCalls, codexRolloutEvent } from "../src/adapters/codex-rollout-open-calls.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => Record<string, unknown> | null;
};

const T0 = Date.parse("2031-03-04T16:04:41.008Z");
const SEC = 1_000;
const SEAT = "cx1@eztrack";
const at = (ms: number, base = T0) => new Date(base + ms).toISOString();

/** The adapter's translation of each line, folded by the domain: what the seat status sees for these rollout lines. */
const codexOpenCallsIn = (lines: string[]) => openCallsIn(lines.map(codexRolloutEvent).filter((e): e is SeatTurnEvent => e !== null));

/** Rollout records, in the measured shape. */
const R = {
  turnStart: (ms: number, base?: number) => JSON.stringify({ timestamp: at(ms, base), type: "event_msg", payload: { type: "task_started" } }),
  turnEnd: (ms: number, base?: number) => JSON.stringify({ timestamp: at(ms, base), type: "event_msg", payload: { type: "task_complete" } }),
  call: (id: string, ms: number, base?: number, kind = "custom_tool_call", name: string | null = "exec") =>
    JSON.stringify({ timestamp: at(ms, base), type: "response_item", payload: { type: kind, call_id: id, ...(name === null ? {} : { name }), status: "completed", input: "sleep 20" } }),
  output: (id: string, ms: number, base?: number, kind = "custom_tool_call_output") =>
    JSON.stringify({ timestamp: at(ms, base), type: "response_item", payload: { type: kind, call_id: id, output: "done" } }),
  message: (ms: number, base?: number) => JSON.stringify({ timestamp: at(ms, base), type: "response_item", payload: { type: "message", role: "assistant" } }),
};

describe("a rollout's open calls", () => {
  it("a call of the current turn with no output is open, named as Codex names it, from its record's timestamp", () => {
    expect(codexOpenCallsIn([R.turnStart(0), R.message(1 * SEC), R.call("c1", 60 * SEC)])).toEqual([{ tool: "exec", callId: "c1", startedAt: at(60 * SEC) }]);
  });

  it("its output with the same call_id closes it; another call's output does not", () => {
    expect(codexOpenCallsIn([R.turnStart(0), R.call("c1", SEC), R.output("c1", 2 * SEC)])).toEqual([]);
    expect(codexOpenCallsIn([R.turnStart(0), R.call("c1", SEC), R.output("c2", 2 * SEC)]).map((c) => c.callId)).toEqual(["c1"]);
  });

  it("a finished turn has no open call, and a new turn starts with none of the last one's", () => {
    expect(codexOpenCallsIn([R.turnStart(0), R.call("c1", SEC), R.turnEnd(2 * SEC)])).toEqual([]);
    expect(codexOpenCallsIn([R.turnStart(0), R.call("c1", SEC), R.turnStart(5 * SEC), R.call("c2", 6 * SEC)]).map((c) => c.callId)).toEqual(["c2"]);
  });

  it("the Responses API spelling (function_call, function_call_output) counts the same", () => {
    expect(codexOpenCallsIn([R.turnStart(0), R.call("f1", SEC, T0, "function_call", "shell")])).toEqual([{ tool: "shell", callId: "f1", startedAt: at(SEC) }]);
    expect(codexOpenCallsIn([R.turnStart(0), R.call("f1", SEC, T0, "function_call"), R.output("f1", 2 * SEC, T0, "function_call_output")])).toEqual([]);
  });

  it("parallel calls are all open, oldest first; a call with no name is 'a tool'", () => {
    const calls = codexOpenCallsIn([R.turnStart(0), R.call("late", 9 * SEC), R.call("early", 3 * SEC, T0, "custom_tool_call", null)]);
    expect(calls.map((c) => [c.callId, c.tool])).toEqual([["early", "a tool"], ["late", "exec"]]);
  });

  it("skips what it cannot read: a cut line, a call with no call_id or no usable timestamp, a record that is not a response item", () => {
    const noId = JSON.stringify({ timestamp: at(SEC), type: "response_item", payload: { type: "custom_tool_call", name: "exec" } });
    const badTime = JSON.stringify({ timestamp: "not a time", type: "response_item", payload: { type: "custom_tool_call", call_id: "c9", name: "exec" } });
    const notItem = JSON.stringify({ timestamp: at(SEC), type: "event_msg", payload: { type: "custom_tool_call", call_id: "c8", name: "exec" } });
    expect(codexOpenCallsIn(['{"timestamp":"2031', R.turnStart(0), noId, badTime, notItem, "", "null", R.call("c1", 2 * SEC).slice(0, 40)])).toEqual([]);
  });
});

// o9o.31 review FIX 5: the domain folds events and knows no Codex label; FIX 4: an end recorded before its start still ends the call.
describe("the domain fold of a seat's turn events", () => {
  const started = (callId: string, s: number): SeatTurnEvent => ({ kind: "call_started", callId, tool: "exec", at: at(s * SEC) });

  it("an end recorded before its start ends the call", () => {
    expect(openCallsIn([{ kind: "turn_started" }, { kind: "call_ended", callId: "c1" }, started("c1", 1)])).toEqual([]);
    expect(codexOpenCallsIn([R.turnStart(0), R.output("c1", 2 * SEC), R.call("c1", SEC)])).toEqual([]);
  });

  it("an end from an earlier turn does not end a later turn's call of the same id", () => {
    expect(openCallsIn([{ kind: "turn_started" }, { kind: "call_ended", callId: "c1" }, { kind: "turn_started" }, started("c1", 5)]).map((c) => c.callId)).toEqual(["c1"]);
  });

  it("the translation: each measured record kind is its event, and everything else is none", () => {
    expect([R.turnStart(0), R.turnEnd(0), R.call("c1", SEC), R.output("c1", SEC), R.call("f1", SEC, T0, "function_call", "shell"), R.output("f1", SEC, T0, "function_call_output"), R.message(SEC)].map(codexRolloutEvent))
      .toEqual([{ kind: "turn_started" }, { kind: "turn_ended" }, { kind: "call_started", callId: "c1", tool: "exec", at: at(SEC) }, { kind: "call_ended", callId: "c1" },
        { kind: "call_started", callId: "f1", tool: "shell", at: at(SEC) }, { kind: "call_ended", callId: "f1" }, null]);
  });
});

describe("the rollout adapter", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const rollout = (lines: string[]) => { dir = mkdtempSync(join(tmpdir(), "o9o31-")); const path = join(dir, "rollout.jsonl"); writeFileSync(path, `${lines.join("\n")}\n`); return path; };

  it("reads the seat's rollout on each call, so a call is open until its output is written", () => {
    const path = rollout([R.turnStart(0), R.call("c1", SEC)]);
    const source = new CodexRolloutOpenCalls((seat) => (seat === SEAT ? path : null));
    expect(source.openToolCalls({ sessionName: SEAT }).map((c) => c.callId)).toEqual(["c1"]);
    appendFileSync(path, `${R.output("c1", 2 * SEC)}\n`);
    expect(source.openToolCalls({ sessionName: SEAT })).toEqual([]);
  });

  it("reads only the tail: the line the window cuts into is dropped, and a call before the window is not shown", () => {
    const path = rollout([R.turnStart(0), R.call("old", SEC), ...Array.from({ length: 20 }, (_, i) => R.message((2 + i) * SEC)), R.call("new", 30 * SEC)]);
    const window = Buffer.byteLength(`${R.message(21 * SEC)}\n${R.call("new", 30 * SEC)}\n`) + 10;  // cuts into the message before
    expect(new CodexRolloutOpenCalls(() => path, window).openToolCalls({ sessionName: SEAT }).map((c) => c.callId)).toEqual(["new"]);
    expect(new CodexRolloutOpenCalls(() => path).openToolCalls({ sessionName: SEAT }).map((c) => c.callId)).toEqual(["old", "new"]);
  });

  it("a window that starts exactly at a line's start keeps that whole line", () => {
    const path = rollout([R.turnStart(0), ...Array.from({ length: 5 }, (_, i) => R.message((1 + i) * SEC)), R.call("edge", 30 * SEC)]);
    const window = Buffer.byteLength(`${R.call("edge", 30 * SEC)}\n`);  // exactly the last line
    expect(new CodexRolloutOpenCalls(() => path, window).openToolCalls({ sessionName: SEAT }).map((c) => c.callId)).toEqual(["edge"]);
  });

  // o9o.31 review FIX 2: the path comes from a database another program writes. Opening a FIFO with no writer blocks the daemon.
  it("a FIFO, a directory or a symlink at the rollout path has no open calls, and the FIFO is never waited on", () => {
    const real = rollout([R.turnStart(0), R.call("c1", SEC)]);
    const fifo = join(dir, "rollout.fifo"); execFileSync("mkfifo", [fifo]);
    const folder = join(dir, "rollout.d"); mkdirSync(folder);
    const link = join(dir, "rollout.link"); symlinkSync(real, link);
    const t0 = Date.now();
    for (const path of [fifo, folder, link]) expect(new CodexRolloutOpenCalls(() => path).openToolCalls({ sessionName: SEAT }), path).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(new CodexRolloutOpenCalls(() => real).openToolCalls({ sessionName: SEAT }).map((c) => c.callId)).toEqual(["c1"]);
  });

  it("a path swapped after its lstat: the open neither follows a link nor waits on a FIFO (in a child, so a block cannot hang this run)", () => {
    const real = rollout([R.turnStart(0), R.call("c1", SEC)]);
    const fifo = join(dir, "swap.fifo"); execFileSync("mkfifo", [fifo]);
    const link = join(dir, "swap.link"); symlinkSync(real, link);
    // The child reports what the adapter returns when lstat (the check before the open) is made to say "regular file" for every path.
    const probe = (path: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      fs.lstatSync = () => ({ isFile: () => true });
      const { CodexRolloutOpenCalls } = await import(${JSON.stringify(new URL("../src/adapters/codex-rollout-open-calls.ts", import.meta.url).pathname)});
      process.stdout.write(JSON.stringify(new CodexRolloutOpenCalls(() => ${JSON.stringify(path)}).openToolCalls({ sessionName: "s" })));
    `], { encoding: "utf8", timeout: 5_000, cwd: new URL("..", import.meta.url).pathname });
    for (const path of [fifo, link]) {
      const run = probe(path);
      expect(run.signal, `${path} must not block`).toBeNull();
      expect(run.stdout, `${path}: ${run.stderr.slice(0, 400)}`).toBe("[]");
    }
    expect(probe(real).stdout).toContain('"callId":"c1"');
  }, 20_000);

  it("no seat, no rollout, a missing file or a lookup that throws: no open calls, never an error", () => {
    expect(new CodexRolloutOpenCalls(() => "/nonexistent/o9o31/rollout.jsonl").openToolCalls({ sessionName: SEAT })).toEqual([]);
    expect(new CodexRolloutOpenCalls(() => null).openToolCalls({ sessionName: SEAT })).toEqual([]);
    expect(new CodexRolloutOpenCalls(() => { throw new Error("db closed"); }).openToolCalls({ sessionName: SEAT })).toEqual([]);
    expect(new CodexRolloutOpenCalls(() => { throw new Error("not asked"); }).openToolCalls({ sessionName: null })).toEqual([]);
  });
});

/** A running Codex seat whose turn the real relay opened (its UserPromptSubmit), on a 2031 clock. */
function codexSeat(runtime = "codex") {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const node = rigRepo.addNode(rigRepo.createRig("eztrack").id, "cx1", { role: "worker", runtime });
  sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, SEAT).id, "running");
  sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
  const store = new AgentActivityStore({ db, eventBus });
  const body = relay.buildOpenRigPayload({ hook_event_name: "UserPromptSubmit", prompt: "go" }, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: runtime }, () => new Date(T0));
  expect(store.recordHookEvent(body as never).ok).toBe(true);
  const row = async (ms: number, codexOpenCalls?: SeatOpenCallsSource) => (await attachAgentActivity(
    [{ canonicalSessionName: SEAT, runtime, attachmentType: "tmux", logicalId: "cx1", sessionStatus: "running" }] as never,
    { tmuxAdapter: {} as never, activityStore: store, now: new Date(T0 + ms), ...(codexOpenCalls ? { codexOpenCalls } : {}) },
  ))[0]!.seatPosture!;
  return { db, rigRepo, sessionRegistry, eventBus, store, row };
}

describe("a Codex seat's status names its running tool (rig ps)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const source = (lines: string[]) => {
    dir = mkdtempSync(join(tmpdir(), "o9o31-")); const path = join(dir, "rollout.jsonl"); writeFileSync(path, `${lines.join("\n")}\n`);
    return new CodexRolloutOpenCalls((seat) => (seat === SEAT ? path : null));
  };

  it("an exec the rollout shows open: 'busy: running exec for 12 s', not 'turn running'", async () => {
    const { db, row } = codexSeat();
    const posture = await row(72 * SEC, source([R.turnStart(0), R.call("c1", 60 * SEC)]));
    expect(posture).toMatchObject({ kind: "busy", tool: "exec", toolConfirmed: true, otherOpenCalls: 0 });
    expect(posture.line).toBe("busy: running exec for 12 s (since 16:05Z)");
    db.close();
  });

  it("two parallel calls: the oldest, and +1 more", async () => {
    const { db, row } = codexSeat();
    expect((await row(72 * SEC, source([R.turnStart(0), R.call("c1", 60 * SEC), R.call("c2", 65 * SEC)]))).line).toBe("busy: running exec for 12 s (since 16:05Z) +1 more");
    db.close();
  });

  it("once its output is written, the seat is back to 'turn running'", async () => {
    const { db, row } = codexSeat();
    const posture = await row(72 * SEC, source([R.turnStart(0), R.call("c1", 60 * SEC), R.output("c1", 61 * SEC)]));
    expect(posture).toMatchObject({ kind: "busy", tool: null });
    expect(posture.line).toBe("busy: turn running, last hook UserPromptSubmit 16:04Z");
    db.close();
  });

  it("a Claude seat never reads the Codex source: its open calls come from its own hooks", async () => {
    const { db, row } = codexSeat("claude-code");
    const never: SeatOpenCallsSource = { openToolCalls: () => { throw new Error("a Claude seat asked the Codex rollout"); } };
    expect((await row(72 * SEC, never)).line).toBe("busy: turn running, last hook UserPromptSubmit 16:04Z");
    db.close();
  });
});

describe("a Codex seat's running tool in the rig send answer, and on the node routes", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const rolloutFile = (lines: string[]) => { dir = mkdtempSync(join(tmpdir(), "o9o31-")); const path = join(dir, "rollout.jsonl"); writeFileSync(path, `${lines.join("\n")}\n`); return path; };

  it("the rig send answer (SessionTransport) names the open exec", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, store } = codexSeat();
    const path = rolloutFile([R.turnStart(0), R.call("c1", 60 * SEC)]);
    const tmuxAdapter = tmuxStub({
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n› ",
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
      sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    });
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry, agentActivityStore: store, eventBus, tmuxAdapter, sleep: async () => undefined, now: () => new Date(T0 + 72 * SEC),
      codexOpenCalls: new CodexRolloutOpenCalls((seat) => (seat === SEAT ? path : null)),
    });
    const posture = await transport.seatPostureFor(SEAT);
    expect(posture).toMatchObject({ kind: "busy", tool: "exec", line: "busy: running exec for 12 s (since 16:05Z)" });
    db.close();
  });

  it("GET /nodes and GET /nodes/:logicalId name it, through the app's codexOpenCalls", async () => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("eztrack");
      const node = rigRepo.addNode(rig.id, "cx1", { runtime: "codex" });
      const reg = new SessionRegistry(db);
      reg.updateStatus(reg.registerSession(node.id, SEAT).id, "running");
      const generation = reg.currentOccupantTenure(node.id)?.generationUuid ?? null;
      const now = Date.now();  // the routes read on wall clock: this test's records are dated relative to it
      const path = rolloutFile([R.turnStart(-90 * SEC, now), R.call("c1", -30 * SEC, now)]);
      const { app } = createTestApp(db, { activityHookToken: "tok", appDeps: { codexOpenCalls: new CodexRolloutOpenCalls((seat) => (seat === SEAT ? path : null)) } });
      const body = relay.buildOpenRigPayload({ hook_event_name: "UserPromptSubmit", prompt: "go" }, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "codex", ...(generation ? { OPENRIG_OCCUPANT_GENERATION: generation } : {}) }, () => new Date(now - 90 * SEC));
      expect((await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" }, body: JSON.stringify(body) })).status).toBe(200);
      const nodes = (await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as Array<Record<string, any>>;
      expect(nodes.find((n) => n.canonicalSessionName === SEAT)?.seatPosture).toMatchObject({ kind: "busy", tool: "exec", toolConfirmed: true });
      const detail = (await (await app.request(`/api/rigs/${rig.id}/nodes/cx1`)).json()) as Record<string, any>;
      expect(detail.seatPosture).toMatchObject({ kind: "busy", tool: "exec", toolConfirmed: true });
    } finally {
      db.close();
    }
  });
});
