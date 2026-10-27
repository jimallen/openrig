// OF-146: a queue item whose saved tags cannot be read is served flagged `unreadable: ["tags"]` with `tags: null` (OF-117).
// The CLI and UI show it as damaged (OF-136); the TUI's Pulse lists, seat table and delivered-updates feed used to read the
// null as "no tags" and show an ordinary row. These rows run the REAL daemon queue routes over an in-memory database with
// really damaged rows, then hydrate and render the way the TUI does.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { damagedColumns, damagedPhrase } from "../src/damaged.js";
import { buildPulseModel } from "../src/pulse/pulse-model.js";
import { renderPulseView } from "../src/pulse/render-pulse.js";
import { composeHumanUpdates, attentionLines, type DeliveredHumanUpdates } from "../src/attention/attention-model.js";
import type { FleetSnapshot, QueueRead, ViewState } from "../src/types.js";

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const MARK = "DAMAGED: tags unreadable";
const RIG = "selected";
const SEAT = "dev.worker";

function fixture() {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  let n = 0;
  /** A queue row; `tags` is the raw saved column, so `{not json` is a really damaged row. */
  const seed = (o: { destination?: string; state: string; tags?: string | null; blocker?: string | null; body?: string; humanIntent?: string }) => {
    const id = `dmg-${n}`; n++;
    const at = new Date(Date.UTC(2026, 9, 27, 10, 0, n)).toISOString();
    db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body,blocked_on,tags,human_intent) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, at, at, "source@selected", o.destination ?? `${SEAT}@${RIG}`, o.state, o.body ?? `Work ${id}`, o.blocker ?? null, o.tags ?? null, o.humanIntent ?? null);
    return id;
  };
  const deliver = (id: string) => db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,transition_note,actor_session) VALUES(?,?,?,?,?)")
    .run(id, "2026-10-27T11:00:00.000Z", "done", "slack-owner-notification-posted notification_key=k level=ALERT message_ts=1.2", "gateway@kernel");
  const node = { logicalId: SEAT, podNamespace: "dev", nodeKind: "agent", runtime: "codex", lifecycleState: "running", sessionStatus: "running", canonicalSessionName: `${SEAT}@${RIG}`, resolvedSpecName: null };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    const u = new URL(String(input));
    if (u.pathname === "/api/queue/list" || u.pathname === "/api/queue/human-updates") return app.request(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/rigs/summary") return Response.json([{ id: `${RIG}-id`, name: RIG, lifecycleState: "running" }]);
    if (u.pathname === `/api/rigs/${RIG}-id/nodes`) return Response.json([node]);
    if (u.pathname === "/api/queue/recent-transitions" || u.pathname === "/api/specs/library") return Response.json([]);
    if (u.pathname === "/api/health") return Response.json({ schema: "openrig.health-list/v0alpha1", total: 0, limit: 200, records: [], truncated: false, evaluatedAt: null });
    throw Error(`Unexpected fixture route ${u.pathname}`);
  }) as typeof fetch });
  const context = (scope: "rig" | "agent") => ({ section: "topology", viewTab: "table", drill: [
    { kind: "host", name: "fixture" }, { kind: "rig", name: RIG }, { kind: "pod", name: "dev" },
    ...(scope === "agent" ? [{ kind: "agent", name: SEAT }] : []),
  ] }) as ViewState;
  const read = (scope: "rig" | "agent") => hydrateSnapshot(client, undefined, null, null, RIG, context(scope));
  const render = (snap: FleetSnapshot, scope: "rig" | "agent") => {
    const state = { ...createViewState({ instanceId: "fixture", getSnapshot: () => snap }).get(), ...context(scope) };
    return renderScreen(state, snap, { cols: 160, rows: 100 }).lines.join("\n");
  };
  return { seed, deliver, client, read, render };
}

const pulseText = (snap: FleetSnapshot, nowMs = Date.UTC(2026, 9, 27, 12, 0, 0)) => renderPulseView(buildPulseModel(snap, nowMs)).map(l => l.text).join("\n");
const lineWith = (text: string, needle: string) => text.split("\n").filter(l => l.includes(needle));

describe("OF-146 damaged marker helper", () => {
  it.each([[undefined], [null], [""], [[]], [false]])("reads %j as readable", marker => {
    expect(damagedColumns({ unreadable: marker })).toEqual([]);
    expect(damagedPhrase({ unreadable: marker })).toBe("");
  });
  it.each([[["tags"], ["tags"]], ["tags", ["tags"]], [[""], ["unknown columns"]], [{}, ["unknown columns"]], [true, ["unknown columns"]]] as const)("reads %j as damaged", (marker, expected) => {
    expect(damagedColumns({ unreadable: marker })).toEqual(expected);
    expect(damagedPhrase({ unreadable: marker })).toContain("unreadable");
  });
});

describe("OF-146 Pulse lists mark a damaged row", () => {
  it("NEEDS YOU: the damaged row is marked, the readable row beside it is not", async () => {
    const f = fixture();
    const bad = f.seed({ destination: "human-person@kernel", state: "pending", tags: "{not json", body: "Choose the cover" });
    const ok = f.seed({ destination: "human-person@kernel", state: "pending", tags: '["project:alpha"]', body: "Pick the font" });
    const snap = await f.read("rig");
    expect(snap.attention.find(r => r.qitemId === bad)?.tags).toBeNull();            // the blank the old render showed as ordinary
    expect(snap.attention.find(r => r.qitemId === bad)?.unreadable).toEqual(["tags"]); // served marker survives hydrate
    expect(snap.attention.find(r => r.qitemId === ok)?.unreadable).toBeUndefined();
    const text = pulseText(snap);
    // the same row also leads the UP NEXT lane; the exception row is the one carrying the NEEDS YOU bullet
    const exception = (needle: string) => lineWith(text, needle).filter(l => l.includes("●"));
    expect(exception("Choose the cover")).toHaveLength(1);
    expect(exception("Choose the cover")[0]).toContain(MARK);
    expect(exception("Pick the font")).toHaveLength(1);
    expect(exception("Pick the font")[0]).not.toContain("DAMAGED");
  });

  it("BLOCKED ON AGENTS: a damaged blocked row is marked", async () => {
    const f = fixture();
    const blocker = f.seed({ destination: "dev.helper@selected", state: "in-progress", tags: '["a"]' });
    f.seed({ state: "blocked", blocker, tags: "{not json", body: "Waiting on the helper" });
    f.seed({ destination: "dev.other@selected", state: "blocked", blocker, tags: '["a"]', body: "Also waiting" });
    const text = pulseText(await f.read("rig"));
    expect(text).toContain("BLOCKED ON AGENTS (2)");
    expect(lineWith(text, "Waiting on the helper")[0]).toContain(MARK);
    expect(lineWith(text, "Also waiting")[0]).not.toContain("DAMAGED");
  });

  it("PARKED WITH BATON, NOW, JUST FINISHED and UP NEXT lead the damaged row's label with DAMAGED", async () => {
    const f = fixture();
    f.seed({ state: "in-progress", tags: "{not json", body: "Stranded work" });
    f.seed({ state: "pending", tags: "{not json", body: "Queued work" });
    f.seed({ state: "pending", tags: '["a"]', body: "Healthy queued" });
    const snap = await f.read("rig");
    const finished: QueueRead = { ...snap.pending.find(r => r.unreadable)!, qitemId: "dmg-fin", state: "done", summary: "Shipped work", tsUpdated: "2026-10-27T11:40:00.000Z" };
    const live: FleetSnapshot = { ...snap,
      seatActivity: [{ session: `${SEAT}@${RIG}`, logicalId: SEAT, terminalActive: false, lastActivityAt: "2026-10-27T11:00:00.000Z" }],
      recentlyFinished: [finished] };
    const parked = pulseText(live);
    expect(lineWith(parked, "no handoff")[0]).toContain(MARK);
    expect(lineWith(parked, "Queued work")[0]).toContain("DAMAGED Queued work");
    expect(parked).toContain("○ Healthy queued"); // lanes share terminal rows, so pin the cell's own text
    expect(parked).not.toContain("DAMAGED Healthy");
    expect(lineWith(parked, "✓ 11:40")[0]).toContain("DAMAGED Shipped"); // cut at the cell edge, marker first
    const now = pulseText({ ...live, seatActivity: [{ ...live.seatActivity[0]!, terminalActive: true }] });
    // the 30-column NOW cell cuts the long label at the right, which is why the marker leads it
    expect(lineWith(now, "● dev.worker")[0]).toContain("DAMAGED Strande");
  });

  it("seat table: a damaged seat row says its slice is unknown, not '—'", async () => {
    const f = fixture();
    f.seed({ state: "in-progress", tags: "{not json", body: "Stranded work" });
    const snap = await f.read("rig");
    const text = f.render(snap, "rig");
    const row = lineWith(text, "worker").join("\n");
    expect(row).toContain("unknown");
    expect(row).toContain(MARK);
    const readable = fixture(); readable.seed({ state: "in-progress", tags: '["a"]', body: "Stranded work" });
    const okRow = lineWith(readable.render(await readable.read("rig"), "rig"), "worker").join("\n");
    expect(okRow).not.toContain("DAMAGED");
    expect(okRow).not.toContain("unknown");
  });
});

describe("OF-146 delivered updates feed marks a damaged row", () => {
  it("served by the real /human-updates route: summary, scope and detail say damaged; the readable update is unchanged", async () => {
    const f = fixture();
    const bad = f.seed({ destination: "human-person@kernel", state: "done", tags: "{not json", body: "Deployed the cover", humanIntent: "update" });
    const ok = f.seed({ destination: "human-person@kernel", state: "done", tags: '["project:alpha"]', body: "Deployed the font", humanIntent: "update" });
    f.deliver(bad); f.deliver(ok);
    const served = await f.client.humanUpdates() as DeliveredHumanUpdates;
    expect(served.items.find(i => i.qitemId === bad)?.unreadable).toEqual(["tags"]);
    const read = composeHumanUpdates(null, served, `human-update:${bad}`)!;
    const badItem = read.items.find(i => i.id === `human-update:${bad}`)!;
    const okItem = read.items.find(i => i.id === `human-update:${ok}`)!;
    expect(badItem.summary).toBe(`[${MARK}] Deployed the cover`);
    expect(badItem.scope).toBe("project unknown (saved tags unreadable)");
    expect(read.detail?.lines[0]).toContain(MARK);
    expect(okItem.summary).toBe("Deployed the font");
    expect(okItem.scope).toBe("project alpha (queue tag)");
    const lines = attentionLines({ ...createViewState({ instanceId: "f", getSnapshot: () => ({}) as FleetSnapshot }).get() }, { attentionRead: read } as FleetSnapshot, 120).map(l => l.text);
    expect(lines.filter(l => l.includes("Deployed the cover"))[0]).toContain(MARK);
    expect(lines.filter(l => l.includes("Deployed the font"))[0]).not.toContain("DAMAGED");
  });
});
