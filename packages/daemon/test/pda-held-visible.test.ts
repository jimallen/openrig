// OF-89 (review R8b of pda L0): a pda seat that HOLDS a message must be visible to an operator, not only through a
// refused `rig send`. The runner reports the hold through the activity hook it already uses; the daemon's
// `hookEventState` maps it to needs_input for a pda seat only, which is what `rig ps` (text and --json) and the UI's
// seat activity read.
//
// The chain under test is real from the runner to the oracle: the REAL PdaRunner (L1b's rig, real client, real outbox,
// L1a's loopback fake pda) posts its activity payloads; each is delivered, in order, through the REAL
// POST /api/activity/hooks route into the REAL AgentActivityStore and SeatActivityService (the arbitrated seat state
// `rig ps` renders). Only the HTTP hop between runner and route is replaced by a direct call (the runner's own
// poster is pinned in pda-runner.test.ts). The rig's node id, session name and generation are rewritten to the
// registered seat's, because the rig's constants are not a registered seat.
//
// Boundary: no tmux, no live daemon. `rig ps` text/--json rendering of a needs_input reason is pinned in the CLI
// suite (ps.test.ts); this file pins what the daemon computes for the seat.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { arbitratedNeedsInputSignal, seatNeedsAttention } from "../src/domain/ps-projection.js";
import type { NodeInventoryEntry } from "../src/domain/types.js";
import { makeRig, runEnd, runStart, snapshotEvent, waitFor, type Rig } from "./helpers/pda-runner-rig.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function seat(runtime: "pda" | "codex" = "pda") {
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("held-visible");
  const node = rigs.addNode(rig.id, "lab.research", { runtime });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerSession(node.id, "lab-research@held-visible");
  sessions.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({
    db, eventBus,
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation),
  });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3 });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  let delivered = 0;
  /** Deliver, in order, every payload the runner has posted since the last call. */
  async function deliver(r: Rig): Promise<void> {
    while (delivered < r.activity.length) {
      const payload = r.activity[delivered++]!;
      const res = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, sessionName: session.sessionName, nodeId: node.id, generation }),
      });
      expect(res.status).toBe(200);
    }
  }
  /** What `rig ps` computes for the seat: the hook store's activity (the per-seat row's agentActivity), and the rig
   *  roll-up's own predicate over the arbitrated needs-input signal with the hook store as its fallback. */
  const view = () => {
    const activity = store.getLatestForNode({ nodeId: node.id, sessionName: session.sessionName });
    const arbitrated = oracle.getSeatStateBySession(session.sessionName);
    const entry = { lifecycleState: "running", startupStatus: "ready", heldReason: null, latestError: null } as unknown as NodeInventoryEntry;
    return { activity, attention: seatNeedsAttention(entry, activity, arbitratedNeedsInputSignal(arbitrated)) };
  };
  return { db, node, session, store, oracle, app, deliver, view, generation };
}

let rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });

async function attachedRig(options: Parameters<typeof makeRig>[0] = {}) {
  const rig = await makeRig(options);
  rigs.push(rig);
  rig.start();
  const stream = await rig.stream();
  stream.push(snapshotEvent());
  await waitFor(() => rig.pane().includes("READY"), "READY");
  return { rig, stream };
}

const five = { action: "status" as const, status: 500, body: { error: "conversation missing" } };
const subtypes = (r: Rig): string[] => r.activity.map((a) => `${a.hookEvent}/${a.subtype}`);

describe("OF-89: a pda seat holding a message is visible in the seat's activity (rig ps, UI)", () => {
  it("held: six 5xx on one message show the seat as needing a person, with the reason", async () => {
    const s = seat();
    const { rig } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held in the sidecar");
    // The hook is posted before the sidecar that shows the hold is written, so nothing else is waited for.
    await s.deliver(rig);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held", evidenceSource: "runtime_hook" });
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });

  it("each hold code is its own reason: a 404 on POST reads pda_agent_missing, not pda_message_held", async () => {
    const s = seat();
    const { rig } = await attachedRig();
    rig.fake.script({ action: "status", status: 404 });
    rig.runner.submit("to nowhere");
    await waitFor(() => rig.sidecar().held?.code === "pda_agent_missing", "pda_agent_missing held");
    await s.deliver(rig);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_agent_missing" });
    expect(s.view().attention).toBe(true);
  });

  it("held stays visible when the runner posts other activity: a stream loss does not erase it", async () => {
    const s = seat();
    const { rig, stream } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    rig.scripted.eventsDown = true; // no reconnect: the hold cannot be retried
    stream.error(); // posts Notification/pda_disconnected, which is unknown on its own
    await waitFor(() => subtypes(rig).includes("Notification/pda_disconnected"), "pda_disconnected");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });

  it("held stays visible while the agent works: run_start (running) and run_end (idle) do not erase it", async () => {
    const s = seat();
    const { rig, stream } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    stream.push(runStart());
    await waitFor(() => subtypes(rig).includes("active/run_start"), "run_start");
    await waitFor(() => subtypes(rig).lastIndexOf("Notification/pda_message_held") > subtypes(rig).indexOf("active/run_start"), "re-asserted after run_start");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    stream.push(runEnd());
    await waitFor(() => subtypes(rig).includes("Stop/run_end"), "run_end");
    await waitFor(() => subtypes(rig).lastIndexOf("Notification/pda_message_held") > subtypes(rig).indexOf("Stop/run_end"), "re-asserted after run_end");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });

  it("held across a runner restart: a hold recorded by the previous runner is reported by the new one before it delivers anything", async () => {
    const s = seat();
    const id = "openrig/node-under-test/launch-0/1";
    const rig = await makeRig({
      aliveIntervalMs: 600_000, // no tick: only the start itself can report it
      preseedOutbox: (baseUrl) => [
        JSON.stringify({ op: "enq", requestId: id, agent: "research", baseUrl, content: "held from before", at: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ op: "hold", requestId: id, code: "pda_message_held", status: 500, attempts: 6, at: "2026-01-01T00:00:01.000Z" }),
      ].join("\n") + "\n",
    });
    rigs.push(rig);
    rig.start();
    await waitFor(() => subtypes(rig).includes("Notification/pda_message_held"), "the restarted runner's held hook");
    expect(rig.fake.entries("research")).toEqual([]); // nothing delivered: the report did not wait for a delivery
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    // And it survives the first snapshot's idle post.
    const stream = await rig.stream();
    stream.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });

  it("held -> delivered: the retry after a reconnect is acked, and the seat stops showing a hold", async () => {
    const s = seat();
    const { rig, stream } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("will be held");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    await waitFor(() => subtypes(rig).includes("Notification/pda_message_held"), "the held hook");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    stream.error();
    const s2 = await rig.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig.fake.entries("research").length === 1, "retried after the reconnect");
    await waitFor(() => rig.sidecar().held === undefined && rig.sidecar().outboxPending === 0, "delivered and acked");
    await waitFor(() => subtypes(rig).includes("Stop/held_cleared"), "the clear");
    await s.deliver(rig);
    expect(s.view().activity).toMatchObject({ state: "idle", reason: "held_cleared" });
    expect(s.view().attention).toBe(false);
  });

  it("held -> released: release.request ends the hold at once, while the message is still undelivered (pda is unreachable)", async () => {
    const s = seat();
    const { rig, stream } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    rig.scripted.eventsDown = true; // no attach: a released head cannot be delivered yet
    stream.error();
    await waitFor(() => subtypes(rig).includes("Notification/pda_disconnected"), "pda_disconnected");
    await s.deliver(rig);
    expect(s.view().attention).toBe(true);
    expect(s.view().activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    fs.writeFileSync(rig.paths.releaseRequestPath, "", { mode: 0o600 });
    await waitFor(() => rig.sidecar().held === undefined, "the hold released");
    expect(rig.sidecar().outboxPending).toBe(1); // released, not delivered
    expect(rig.fake.entries("research")).toEqual([]);
    await waitFor(() => subtypes(rig).includes("Stop/held_cleared") || subtypes(rig).includes("active/held_cleared"), "the clear");
    await s.deliver(rig);
    expect(s.view().attention).toBe(false);
    expect(s.view().activity?.state).not.toBe("needs_input");
  });

  it("the hold ends while the agent is running: the clear says running, not idle", async () => {
    const s = seat();
    const { rig, stream } = await attachedRig();
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    stream.push(runStart()); // the agent is busy with something else while the head is held
    await waitFor(() => subtypes(rig).includes("active/run_start"), "run_start");
    fs.writeFileSync(rig.paths.releaseRequestPath, "", { mode: 0o600 });
    await waitFor(() => rig.fake.entries("research").length === 1 && rig.sidecar().held === undefined, "released and delivered");
    await waitFor(() => subtypes(rig).includes("active/held_cleared"), "the clear");
    expect(subtypes(rig)).not.toContain("Stop/held_cleared");
    await s.deliver(rig);
    expect(s.view().activity).toMatchObject({ state: "running", reason: "held_cleared" });
    expect(s.view().attention).toBe(false);
  });

  it("a seat whose runner never holds posts no hold or clear at all", async () => {
    const { rig } = await attachedRig();
    rig.runner.submit("fine");
    await waitFor(() => rig.fake.entries("research").length === 1, "delivered");
    await new Promise((r) => setTimeout(r, 150)); // several alive ticks
    expect(subtypes(rig).filter((x) => /held/.test(x))).toEqual([]);
  });

  it("the hold is re-asserted before the daemon's freshness window lapses, and not on every tick", async () => {
    const s = seat();
    let clock = Date.parse("2031-03-04T05:06:07.000Z"); // far from wall clock
    const { rig } = await attachedRig({ now: () => new Date(clock) });
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    await waitFor(() => subtypes(rig).includes("Notification/pda_message_held"), "the held hook");
    await new Promise((r) => setTimeout(r, 200)); // five or so ticks at a frozen clock
    const heldPosts = () => subtypes(rig).filter((x) => x === "Notification/pda_message_held").length;
    expect(heldPosts()).toBe(1);
    clock += 3 * 60_000; // inside the 5 minute freshness window, past the re-assertion interval
    await waitFor(() => heldPosts() === 2, "the re-assertion");
    await s.deliver(rig);
    const last = s.store.getLatestForNode({ nodeId: s.node.id, now: new Date(clock + 4 * 60_000) });
    expect(last).toMatchObject({ state: "needs_input", reason: "pda_message_held", stale: false });
  });
});

describe("OF-89: the daemon maps the hold to needs_input for a pda seat only", () => {
  /** Post one hook to the seat with its carried generation. Without it the store reads every hook as unknown
   *  (generation_unresolvable), which would make the negative rows below pass whatever the mapping did. */
  async function post(s: ReturnType<typeof seat>, subtype: string) {
    const res = await s.app.request("/api/activity/hooks", {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "pda", hookEvent: "Notification", subtype, sessionName: s.session.sessionName, nodeId: s.node.id, generation: s.generation }),
    });
    expect(res.status).toBe(200);
    return s.store.getLatestForNode({ nodeId: s.node.id });
  }

  it("a Notification/pda_message_held on a codex seat stays unknown (a hook cannot claim pda on another runtime's seat)", async () => {
    const s = seat("codex");
    // Positive control: this fixture can express needs_input on a codex seat, so unknown below is the mapping's doing.
    expect(await post(s, "permission_prompt")).toMatchObject({ state: "needs_input", stale: false });
    expect(await post(s, "pda_message_held")).toMatchObject({ state: "unknown", reason: "pda_message_held", stale: false });
  });

  it("an unlisted pda notification is not a hold: pda_disconnected stays unknown on a pda seat", async () => {
    const s = seat();
    expect(await post(s, "pda_message_held")).toMatchObject({ state: "needs_input", stale: false }); // control, same fixture
    expect(await post(s, "pda_disconnected")).toMatchObject({ state: "unknown", reason: "pda_disconnected", stale: false });
  });
});
