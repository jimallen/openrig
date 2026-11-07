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
import { deriveSeatPosture } from "../src/domain/seat-posture.js";
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
