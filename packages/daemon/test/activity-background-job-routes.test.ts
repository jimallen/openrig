// OF-34 — route wiring pins. The unit rows in activity-background-job.test.ts prove the rule; these
// prove the three route call sites actually hand the structural cache to it:
//   GET /api/rigs/:id/nodes            attachAgentActivity (structuralActivity) + attachTerminalActivityAndWork
//   GET /api/rigs/:id/nodes/:logicalId attachAgentActivity (backgroundJobActivity only)
// Real AgentActivityStore rows (a Stop hook) over the real routes.

import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

const SESSION = "dev-impl@r";
const RULE = "─".repeat(40);
const pane = (footer: string) => ["● Started the build in the background.", "", RULE, "❯ ", RULE, `  ${footer}`].join("\n");

async function seatWithStopHook(paneText: string, opts: { withHook?: boolean; livePane?: string } = {}) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const reg = new SessionRegistry(db);
  const rig = rigRepo.createRig("r");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const sess = reg.registerSession(node.id, SESSION);
  reg.updateStatus(sess.id, "running");
  reg.updateBinding(node.id, { tmuxSession: SESSION, attachmentType: "tmux" });
  // The same persisted rows the production Stop hook writes; the route's own store reads them back.
  const writer = new AgentActivityStore({
    db,
    eventBus: new EventBus(db),
    resolveOccupantGeneration: (nodeId) => reg.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => reg.isOccupantGenerationRegistered(nodeId, generation),
  });
  const withHook = opts.withHook ?? true;
  const recorded = !withHook ? { ok: true } : writer.recordHookEvent({ runtime: "claude-code", sessionName: SESSION, hookEvent: "Stop", generation: reg.currentOccupantTenure(node.id)?.generationUuid ?? null });
  expect(recorded.ok).toBe(true);
  // Guard against the vacuous path: the stored hook must itself read as a POSITIVE idle, so the lift under test is the hook-idle branch.
  if (withHook) expect(writer.getLatestForNode({ sessionName: SESSION, nodeId: node.id })).toMatchObject({ state: "idle" });
  // Production wiring: SeatActivityService arbitrated from the same hook.
  const seatActivity = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3 } as never);
  seatActivity.declareRungInventory({ seatNodeId: node.id, sessionName: SESSION }, {
    adapterId: "claude-code-adapter", runtime: "claude-code",
    rungs: [{ rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  } as never);
  seatActivity.reportEvidence({
    seatNodeId: node.id, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
    seq: 1, observedAt: new Date().toISOString(), activity: "idle-at-prompt",
  } as never);
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => paneText } as never);
  await structural.pollSeat(SESSION);
  const tmux = opts.livePane === undefined ? undefined : ({
    ...mockTmuxAdapter(),
    hasSession: async () => true,
    getPaneCommand: async () => "claude",
    capturePaneContent: async () => opts.livePane,
  } as never);
  const { app } = createTestApp(db, { seatStructuralActivityService: structural, ...(tmux ? { tmux } : {}), appDeps: { seatActivityService: seatActivity } as never });
  return { app, rig, db };
}

type NodeRow = {
  canonicalSessionName?: string;
  agentActivity?: { state: string; reason: string; evidence: string | null };
  activityState?: { activity: string; display: string } | null;
};

describe("OF-34 routes: a Stop-hook seat with a background shell", () => {
  it("GET /nodes: agentActivity AND the arbitrated activityState (rig ps / down / TUI) both read working", async () => {
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on · 1 shell"));
    const res = await app.request(`/api/rigs/${rig.id}/nodes`);
    expect(res.status).toBe(200);
    const seat = ((await res.json()) as NodeRow[]).find((n) => n.canonicalSessionName === SESSION);
    expect(seat?.agentActivity).toMatchObject({ state: "running", reason: "background_job", evidence: "1 shell" });
    expect(seat?.activityState).toMatchObject({ activity: "working", display: "working" });
    db.close();
  });

  it("GET /nodes/:logicalId (detail): agentActivity agrees with the list", async () => {
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on · 1 shell"));
    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev.impl`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as NodeRow;
    expect(detail.agentActivity).toMatchObject({ state: "running", reason: "background_job" });
    db.close();
  });

  it("GET /graph (UI topology dots): the node's agentActivity reads running / background_job", async () => {
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on · 1 shell"));
    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const graph = (await res.json()) as { nodes: Array<{ data?: { logicalId?: string; agentActivity?: { state: string; reason: string } | null } }> };
    const seat = graph.nodes.find((n) => n.data?.logicalId === "dev.impl");
    expect(seat?.data?.agentActivity).toMatchObject({ state: "running", reason: "background_job" });
    db.close();
  });

  it("detail must not read the cache for a hook-less seat: the LIVE probe decides (a question beats a cached idle+shell)", async () => {
    const question = ["Which region?", "❯ 1. us-east-1", "  2. eu-west-1", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    // cache: idle prompt with a shell chip (would lift to running if the detail route read it as a verdict source)
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on · 1 shell"), { withHook: false, livePane: question });
    const detail = (await (await app.request(`/api/rigs/${rig.id}/nodes/dev.impl`)).json()) as NodeRow;
    expect(detail.agentActivity).toMatchObject({ state: "needs_input", evidenceSource: "pane_heuristic" });
    expect(detail.agentActivity?.reason).not.toBe("background_job");
    db.close();
  });

  it("the lifted agentActivity JSON shape the UI consumes (key set pinned)", async () => {
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on · 1 shell"));
    const seat = ((await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as NodeRow[]).find((n) => n.canonicalSessionName === SESSION);
    expect(Object.keys(seat!.agentActivity!).sort()).toEqual(["evidence", "evidenceSource", "reason", "runtime", "sampledAt", "state"]);
    expect(seat!.agentActivity).toMatchObject({ state: "running", reason: "background_job", evidenceSource: "pane_heuristic", evidence: "1 shell", runtime: "claude-code" });
    db.close();
  });

  it("no job: list and detail stay idle", async () => {
    const { app, rig, db } = await seatWithStopHook(pane("⏵⏵ bypass permissions on (shift+tab to cycle)"));
    const list = ((await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as NodeRow[]).find((n) => n.canonicalSessionName === SESSION);
    expect(list?.agentActivity?.state).toBe("idle");
    expect(list?.activityState).toMatchObject({ display: "idle" });
    const detail = (await (await app.request(`/api/rigs/${rig.id}/nodes/dev.impl`)).json()) as NodeRow;
    expect(detail.agentActivity?.state).toBe("idle");
    db.close();
  });
});
