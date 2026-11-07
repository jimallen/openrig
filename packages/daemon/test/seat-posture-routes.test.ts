// OF-267 — route wiring pins, like activity-background-job-routes.test.ts: the unit rows (seat-posture.test.ts) prove the rule, these
// prove the two node route call sites hand the hc terminal-status reader to it, so `rig ps` sees a Pi seat's busy report. (The UI graph
// route does not serve seatPosture and is not given the reader: nothing there would read it, and it is polled.)
//   GET /api/rigs/:id/nodes            (rig ps)        routes/sessions.ts
//   GET /api/rigs/:id/nodes/:logicalId (node detail)   routes/sessions.ts
// Real AgentActivityStore rows over the real routes; the hook is 66 minutes older than the request (relative to the clock the route reads).
import { describe, expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { SeatTerminalStatusReader } from "../src/domain/seat-posture.js";

const SESSION = "build-arch@eztrack";

function piSeat(reader: SeatTerminalStatusReader | undefined) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const reg = new SessionRegistry(db);
  const rig = rigRepo.createRig("eztrack");
  const node = rigRepo.addNode(rig.id, "build.arch", { runtime: "pi" });
  reg.updateStatus(reg.registerSession(node.id, SESSION).id, "running");
  reg.updateBinding(node.id, { tmuxSession: SESSION, attachmentType: "tmux" });
  const writer = new AgentActivityStore({
    db,
    eventBus: new EventBus(db),
    resolveOccupantGeneration: (nodeId) => reg.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => reg.isOccupantGenerationRegistered(nodeId, generation),
  });
  const hookAt = new Date(Date.now() - 66 * 60_000).toISOString();
  expect(writer.recordHookEvent({ runtime: "pi", sessionName: SESSION, hookEvent: "PreToolUse", subtype: "bash", occurredAt: hookAt, generation: reg.currentOccupantTenure(node.id)?.generationUuid ?? null }).ok).toBe(true);
  const { app } = createTestApp(db, { appDeps: { ...(reader ? { seatTerminalStatus: reader } : {}) } as never });
  return { app, rig, db };
}

const sinceMs = Date.now() - 70 * 60_000;
const working: SeatTerminalStatusReader = async (seat) => (seat === SESSION ? { live: true, status: "working", sinceMs } : null);

describe("a Pi seat silent in a tool call, through the node routes", () => {
  it("GET /nodes: with the core's status the posture is busy, from hc status; ACTIVITY still reads the stale hook", async () => {
    const { app, rig, db } = piSeat(working);
    const seat = ((await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as Array<Record<string, any>>).find((n) => n.canonicalSessionName === SESSION);
    expect(seat?.seatPosture).toMatchObject({ kind: "busy", source: "hc_status", at: new Date(sinceMs).toISOString() });
    expect(seat?.agentActivity).toMatchObject({ state: "unknown", reason: "stale_runtime_hook" });
    db.close();
  });

  it("GET /nodes: without a reader (no hc core) the posture is the hook's unknown-open-turn", async () => {
    const { app, rig, db } = piSeat(undefined);
    const seat = ((await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as Array<Record<string, any>>).find((n) => n.canonicalSessionName === SESSION);
    expect(seat?.seatPosture).toMatchObject({ kind: "unknown-open-turn", source: "runtime_hook", tool: "bash" });
    expect(seat?.seatPosture.line).toMatch(/^unknown: last hook PreToolUse bash .*\(66 min ago\), no Stop since$/);
    db.close();
  });

  it("GET /nodes/:logicalId (detail) agrees with the list", async () => {
    const { app, rig, db } = piSeat(working);
    const detail = (await (await app.request(`/api/rigs/${rig.id}/nodes/build.arch`)).json()) as Record<string, any>;
    expect(detail.seatPosture).toMatchObject({ kind: "busy", source: "hc_status" });
    db.close();
  });
});
