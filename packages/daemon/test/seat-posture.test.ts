// OF-267 — a sender must be able to tell a busy seat from a broken delivery path.
//
// The measured case (build-arch@eztrack, a Pi seat, 2026-11-06): PreToolUse bash at 16:04:41Z, no hook of any kind until
// 17:20:10Z. After 16:09:41Z the store reads `unknown / stale_runtime_hook`, and every `rig send` said only "Accepted, not yet
// received". These tests replay that shape on an injected clock far from wall clock (2031) and pin what the posture may say.
//
// Production path: startup.ts constructs SessionTransport (whose pump hand-off builds the send answer) and the node-inventory
// route calls attachAgentActivity (the `rig ps` rows); both read the AgentActivityStore's newest hook for the seat.
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { deriveSeatPosture, refineSeatPosture, withTerminalStatus, type SeatPosture, type SeatTerminalStatus } from "../src/domain/seat-posture.js";
import type { AgentActivity } from "../src/domain/types.js";

const T0 = Date.parse("2031-03-04T16:04:41.008Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function hook(over: Partial<AgentActivity>): AgentActivity {
  return {
    state: "running", reason: "bash", evidenceSource: "runtime_hook", sampledAt: new Date(T0).toISOString(), evidence: "bash",
    eventAt: new Date(T0).toISOString(), rawEvent: "PreToolUse", rawSubtype: "bash", runtime: "pi", fallback: false, stale: false, ...over,
  };
}

describe("deriveSeatPosture", () => {
  it("a fresh running hook is busy and names the last tool started, not a running call", () => {
    const p = deriveSeatPosture(hook({}), "pi", at(2));
    expect(p).toMatchObject({ kind: "busy", source: "runtime_hook", tool: "bash", at: "2031-03-04T16:04:41.008Z" });
    expect(p.line).toBe("busy: last tool started 16:04Z (bash)");
  });

  it("a fresh Claude PostToolUse is busy with no tool name (Claude records the end of a call, never the start)", () => {
    const p = deriveSeatPosture(hook({ rawEvent: "PostToolUse", rawSubtype: "Bash", runtime: "claude-code" }), "claude-code", at(1));
    expect(p).toMatchObject({ kind: "busy", tool: null });
    expect(p.line).toBe("busy: turn running, last hook PostToolUse 16:04Z");
  });

  it("the measured case: the same hook 66 minutes on is unknown-open-turn, never busy, and the line states the facts", () => {
    const stale = hook({ state: "unknown", reason: "stale_runtime_hook", stale: true });
    const p = deriveSeatPosture(stale, "pi", at(66));
    expect(p.kind).toBe("unknown-open-turn");
    expect(p.line).toBe("unknown: last hook PreToolUse bash 16:04Z (66 min ago), no Stop since");
    expect(JSON.stringify(p)).not.toMatch(/busy/);
  });

  it("an event on an earlier UTC day carries its date", () => {
    const stale = hook({ state: "unknown", reason: "stale_runtime_hook", stale: true });
    expect(deriveSeatPosture(stale, "pi", at(24 * 60 + 5)).line).toBe("unknown: last hook PreToolUse bash 03-04 16:04Z (24 h 5 min ago), no Stop since");
  });

  it("a stale Stop is still idle, and a stale unanswered prompt still waits on a person", () => {
    const stop = hook({ state: "unknown", reason: "stale_runtime_hook", stale: true, rawEvent: "Stop", rawSubtype: "agent_end" });
    expect(deriveSeatPosture(stop, "pi", at(90))).toMatchObject({ kind: "idle", line: "idle: last hook Stop 16:04Z" });
    const prompt = hook({ state: "unknown", reason: "stale_runtime_hook", stale: true, rawEvent: "Notification", rawSubtype: "permission_prompt" });
    expect(deriveSeatPosture(prompt, "claude-code", at(90))).toMatchObject({ kind: "needs_input", line: "needs input: permission_prompt since 16:04Z" });
  });

  it("evidence of a dead tenure or an unresolvable generation says unknown, even when the retained event was a tool start", () => {
    for (const reason of ["generation_mismatch", "generation_unresolvable", "generation_unverifiable", "generation_resolver_error"]) {
      const p = deriveSeatPosture(hook({ state: "unknown", reason, stale: true }), "pi", at(1));
      expect(p.kind, reason).toBe("unknown");
      expect(p.line).toBe(`unknown: ${reason}`);
    }
  });

  it("no hook at all is unknown, not idle", () => {
    expect(deriveSeatPosture(null, "pi", at(1))).toMatchObject({ kind: "unknown", source: null, at: null, line: "unknown: no runtime hook recorded" });
    expect(deriveSeatPosture(undefined, null, at(1)).kind).toBe("unknown");
  });

  it("a pda held report is display evidence and is never busy or waiting", () => {
    const held = hook({ state: "needs_input", rawEvent: "Notification", rawSubtype: "pda_message_held" });
    expect(deriveSeatPosture(held, "pda", at(1)).kind).not.toBe("needs_input");
  });
});

describe("the measured case replayed through the real store", () => {
  function build() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("eztrack");
    const node = rigRepo.addNode(rig.id, "arch", { role: "worker", runtime: "pi" });
    sessions.updateStatus(sessions.registerSession(node.id, "build-arch@eztrack").id, "running");
    const store = new AgentActivityStore({ db, eventBus });
    return { db, store, node };
  }
  const SEAT = "build-arch@eztrack";
  const fire = (store: AgentActivityStore, hookEvent: string, subtype: string | null, minutes: number) =>
    store.recordHookEvent({ sessionName: SEAT, runtime: "pi", hookEvent, subtype, occurredAt: at(minutes).toISOString() });

  it("busy for the first minutes, unknown-open-turn for the next hour, idle after the Stop", () => {
    const { store } = build();
    fire(store, "PreToolUse", "bash", 0);
    const read = (minutes: number) => deriveSeatPosture(store.getLatestForNode({ sessionName: SEAT, now: at(minutes) }), "pi", at(minutes));
    expect(read(4).kind).toBe("busy");
    expect(read(7).kind).toBe("unknown-open-turn");
    expect(read(66).line).toBe("unknown: last hook PreToolUse bash 16:04Z (66 min ago), no Stop since");
    fire(store, "PreToolUse", "bash", 75);
    expect(read(76).kind).toBe("busy");
    fire(store, "Stop", "agent_end", 80);
    expect(read(81).kind).toBe("idle");
  });

  it("attachAgentActivity (the rig ps rows) carries the posture beside agentActivity", async () => {
    const { store } = build();
    fire(store, "PreToolUse", "bash", 0);
    const rows = await attachAgentActivity(
      [{ canonicalSessionName: SEAT, runtime: "pi", attachmentType: "hc", logicalId: "build.arch" }] as never,
      { tmuxAdapter: {} as never, activityStore: store, now: at(66) },
    );
    expect(rows[0]!.agentActivity).toMatchObject({ state: "unknown", reason: "stale_runtime_hook" });
    expect(rows[0]!.seatPosture).toMatchObject({ kind: "unknown-open-turn", source: "runtime_hook", tool: "bash" });
  });

  it("a seat whose session is confirmed missing gets no posture (no hook speaks for a seat that is not there)", async () => {
    const { store } = build();
    fire(store, "PreToolUse", "bash", 0);
    const rows = await attachAgentActivity(
      [{ canonicalSessionName: SEAT, runtime: "pi", attachmentType: "hc", logicalId: "build.arch",
        identityVerdict: { kind: "absent", reason: "session_missing", observedAt: at(1).toISOString() } }] as never,
      { tmuxAdapter: {} as never, activityStore: store, now: at(2) },
    );
    expect(rows[0]!.seatPosture).toBeUndefined();
  });
});

// OF-267 (B). The facts the rows rest on are measured on a private hc core in seat-hc-status.real.test.ts (working at every poll through a
// silent call, status_ms unmoving and the epoch start of the run, a dead runner never live-and-working).
describe("refineSeatPosture: a Pi seat's hc terminal status settles an open turn", () => {
  const stale = hook({ state: "unknown", reason: "stale_runtime_hook", stale: true });
  const open = (): SeatPosture => deriveSeatPosture(stale, "pi", at(66));
  const SINCE = T0 - 1_000; // the run began a second before the recorded tool start
  const working: SeatTerminalStatus = { live: true, status: "working", sinceMs: SINCE };

  it("working: busy since the status began, sourced to hc status, not to the hook", async () => {
    const p = await refineSeatPosture(open(), "pi", "build-arch@eztrack", async () => working, at(66));
    expect(p).toEqual({ kind: "busy", source: "hc_status", at: "2031-03-04T16:04:40.008Z", tool: null, line: "busy: working since 16:04Z (hc status)" });
  });

  it("names a date when the run began on an earlier UTC day", async () => {
    const p = await refineSeatPosture(open(), "pi", "s", async () => ({ ...working, sinceMs: T0 - 26 * 3_600_000 }), at(66));
    expect(p.line).toBe("busy: working since 03-03 14:04Z (hc status)");
  });

  it.each([
    ["idle", { live: true, status: "idle", sinceMs: SINCE }],
    ["blocked", { live: true, status: "blocked", sinceMs: SINCE }],
    ["done", { live: true, status: "done", sinceMs: SINCE }],
    ["unreported", { live: true, status: null, sinceMs: null }],
    ["finished with working left on it", { live: false, status: "working", sinceMs: SINCE }],
    ["working with no start time", { live: true, status: "working", sinceMs: null }],
    ["working with a start time in the future (clock skew)", { live: true, status: "working", sinceMs: T0 + 3 * 3_600_000 }],
    ["working with a non-finite start time", { live: true, status: "working", sinceMs: Number.NaN }],
  ] as Array<[string, SeatTerminalStatus]>)("%s keeps the hook answer", async (_n, status) => {
    expect(await refineSeatPosture(open(), "pi", "s", async () => status, at(66))).toEqual(open());
  });

  it("the pure refinement itself keeps the hook answer for a start time it cannot print (no reliance on the caller's catch)", () => {
    expect(withTerminalStatus(open(), { live: true, status: "working", sinceMs: Number.NaN }, at(66))).toEqual(open());
    expect(withTerminalStatus(open(), { live: true, status: "working", sinceMs: Number.POSITIVE_INFINITY }, at(66))).toEqual(open());
  });

  it("a read that returns null, throws or rejects keeps the hook answer", async () => {
    expect(await refineSeatPosture(open(), "pi", "s", async () => null, at(66))).toEqual(open());
    expect(await refineSeatPosture(open(), "pi", "s", async () => { throw new Error("socket closed"); }, at(66))).toEqual(open());
    expect(await refineSeatPosture(open(), "pi", "s", () => { throw new Error("sync throw"); }, at(66))).toEqual(open());
  });

  it("only an open turn is refined: busy, idle, needs-input and unknown postures never ask the reader", async () => {
    let asked = 0;
    const reader = async () => { asked++; return working; };
    const postures = [
      deriveSeatPosture(hook({}), "pi", at(1)),
      deriveSeatPosture(hook({ state: "unknown", reason: "stale_runtime_hook", stale: true, rawEvent: "Stop", rawSubtype: "agent_end" }), "pi", at(90)),
      deriveSeatPosture(hook({ state: "unknown", reason: "stale_runtime_hook", stale: true, rawEvent: "Notification", rawSubtype: "permission_prompt" }), "pi", at(90)),
      deriveSeatPosture(null, "pi", at(1)),
    ];
    expect(postures.map((p) => p.kind)).toEqual(["busy", "idle", "needs_input", "unknown"]);
    for (const p of postures) expect(await refineSeatPosture(p, "pi", "s", reader, at(66))).toEqual(p);
    expect(asked).toBe(0);
  });

  it.each(["claude-code", "codex", "omp", "pda", "terminal", null])("a %s seat is never asked: only a runtime whose status OpenRig writes is", async (runtime) => {
    let asked = 0;
    const p = deriveSeatPosture(stale, runtime, at(66));
    expect(p.kind).toBe("unknown-open-turn");
    expect(await refineSeatPosture(p, runtime, "s", async () => { asked++; return working; }, at(66))).toEqual(p);
    expect(asked).toBe(0);
  });

  it("no reader is no change", async () => {
    expect(await refineSeatPosture(open(), "pi", "s", undefined, at(66))).toEqual(open());
    expect(withTerminalStatus(open(), undefined, at(66))).toEqual(open());
  });

  it("attachAgentActivity (the rig ps rows) refines the open-turn row and leaves the others", async () => {
    const asked: string[] = [];
    const { store } = (() => {
      const db = createDb();
      migrate(db, ALL_MIGRATIONS);
      const repo = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const rig = repo.createRig("eztrack");
      for (const [logical, session] of [["arch", "build-arch@eztrack"], ["impl", "build-impl@eztrack"]] as const) {
        const node = repo.addNode(rig.id, logical, { role: "worker", runtime: "pi" });
        sessions.updateStatus(sessions.registerSession(node.id, session).id, "running");
      }
      return { store: new AgentActivityStore({ db, eventBus: new EventBus(db) }) };
    })();
    store.recordHookEvent({ sessionName: "build-arch@eztrack", runtime: "pi", hookEvent: "PreToolUse", subtype: "bash", occurredAt: at(0).toISOString() });
    store.recordHookEvent({ sessionName: "build-impl@eztrack", runtime: "pi", hookEvent: "Stop", subtype: "agent_end", occurredAt: at(0).toISOString() });
    const entry = (s: string) => ({ canonicalSessionName: s, runtime: "pi", attachmentType: "hc", logicalId: s.split("@")[0] });
    const rows = await attachAgentActivity([entry("build-arch@eztrack"), entry("build-impl@eztrack")] as never, {
      tmuxAdapter: {} as never, activityStore: store, now: at(66),
      seatTerminalStatus: async (seat) => { asked.push(seat); return working; },
    });
    expect(rows[0]!.seatPosture).toMatchObject({ kind: "busy", source: "hc_status", at: "2031-03-04T16:04:40.008Z" });
    expect(rows[1]!.seatPosture).toMatchObject({ kind: "idle", source: "runtime_hook" });
    expect(asked).toEqual(["build-arch@eztrack"]);
    expect(rows[0]!.agentActivity).toMatchObject({ state: "unknown", reason: "stale_runtime_hook" }); // ACTIVITY is untouched
  });
});
