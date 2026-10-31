// OF-177: a rig archived while its seats' session rows still read `running` (archive is allowed for an
// attention_required rig) kept those rows for ever -- they showed as running seats and were polled for cost --
// because the boot reconcile iterates listRigs(), which hides archived rigs. These pins cover the pass that
// ends such rows, and the archive route that runs it. The production consequence each guards is named in the row.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import type { SessionProbe, TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

type Answer = SessionProbe | Error;

/** The shared adapter double with its session probe replaced. */
function withProbe(probe: (name: string) => Promise<SessionProbe>): TmuxAdapter {
  return Object.assign(mockTmuxAdapter(), { probeSession: probe });
}

/** A probe double answering per session name; an unlisted name is absent. Records every name probed. */
function probing(answers: Record<string, Answer>) {
  const probed: string[] = [];
  const adapter = withProbe(async (name) => {
    probed.push(name);
    const answer = answers[name] ?? { state: "absent" as const };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { adapter, probed };
}

describe("OF-177 archived rigs keep no running session rows for gone hosts", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessions: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });
  afterEach(() => db.close());

  const reconciler = (adapter: TmuxAdapter) => new Reconciler({ db, sessionRegistry: sessions, eventBus, tmuxAdapter: adapter });

  function seed(rigName: string, seats: { name: string; status: string }[], archived: boolean) {
    const rig = rigRepo.createRig(rigName);
    const ids: string[] = [];
    for (const seat of seats) {
      const node = rigRepo.addNode(rig.id, `n-${seat.name}`, { runtime: "codex" });
      const session = sessions.registerSession(node.id, seat.name);
      sessions.updateStatus(session.id, seat.status);
      sessions.updateBinding(node.id, { tmuxSession: seat.name, tmuxPane: "%1", attachmentType: "tmux" });
      ids.push(session.id);
    }
    if (archived) expect(rigRepo.archiveRig(rig.id)).toBe(true);
    return { rig, ids };
  }
  const statusOf = (id: string) => (db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string }).status;
  const detachedEvents = () => db.prepare("SELECT rig_id AS rigId, node_id AS nodeId FROM events WHERE type = 'session.detached'").all();

  it("ends the running row of an archived rig whose tmux session is gone, keeping its binding, and emits session.detached", async () => {
    const { rig, ids } = seed("cel-track", [{ name: "exec-cos@cel-track", status: "running" }], true);
    const notified: string[] = [];
    eventBus.subscribe((e) => notified.push(e.type));
    const result = await reconciler(probing({}).adapter).reconcileArchivedRigs();
    expect(notified).toEqual(["session.detached"]);
    expect(result).toEqual({ checked: 1, detached: 1, errors: [] });
    expect(statusOf(ids[0]!)).toBe("detached");
    expect(db.prepare("SELECT COUNT(*) AS c FROM bindings").get()).toEqual({ c: 1 });
    expect(detachedEvents()).toEqual([{ rigId: rig.id, nodeId: expect.any(String) }]);
  });

  it("ends every active status (running, idle, unknown), not only running", async () => {
    const { ids } = seed("multi", [
      { name: "a@multi", status: "running" }, { name: "b@multi", status: "idle" }, { name: "c@multi", status: "unknown" },
    ], true);
    await reconciler(probing({}).adapter).reconcileArchivedRigs();
    expect(ids.map(statusOf)).toEqual(["detached", "detached", "detached"]);
  });

  it("leaves a row alone when its tmux session is still present (a force-archived live seat keeps its row)", async () => {
    const { ids } = seed("live", [{ name: "a@live", status: "running" }], true);
    const result = await reconciler(probing({ "a@live": { state: "present" } }).adapter).reconcileArchivedRigs();
    expect(result.detached).toBe(0);
    expect(statusOf(ids[0]!)).toBe("running");
  });

  it("does NOT end a row when the probe THROWS: a failed read is not an absence", async () => {
    const { ids } = seed("flaky", [{ name: "a@flaky", status: "running" }], true);
    const result = await reconciler(probing({ "a@flaky": new Error("tmux exploded") }).adapter).reconcileArchivedRigs();
    expect(result.detached).toBe(0);
    expect(result.errors).toEqual([{ sessionId: ids[0]!, error: "tmux exploded" }]);
    expect(statusOf(ids[0]!)).toBe("running");
  });

  it("does NOT end a row when the terminal server is unreachable (transport_unavailable proves nothing about the session)", async () => {
    const { ids } = seed("down", [{ name: "a@down", status: "running" }], true);
    const result = await reconciler(probing({ "a@down": { state: "transport_unavailable", cause: "no server" } }).adapter).reconcileArchivedRigs();
    expect(result.detached).toBe(0);
    expect(statusOf(ids[0]!)).toBe("running");
  });

  it("a failed probe on one seat does not stop the others from being ended", async () => {
    const { ids } = seed("mixed", [{ name: "bad@mixed", status: "running" }, { name: "gone@mixed", status: "running" }], true);
    const result = await reconciler(probing({ "bad@mixed": new Error("boom") }).adapter).reconcileArchivedRigs();
    expect(result.detached).toBe(1);
    expect([statusOf(ids[0]!), statusOf(ids[1]!)]).toEqual(["running", "detached"]);
  });

  it("never touches a NON-archived rig, even when its session is absent", async () => {
    const { ids } = seed("active", [{ name: "a@active", status: "running" }], false);
    const { adapter, probed } = probing({});
    const result = await reconciler(adapter).reconcileArchivedRigs();
    expect(result).toEqual({ checked: 0, detached: 0, errors: [] });
    expect(probed).toEqual([]);
    expect(statusOf(ids[0]!)).toBe("running");
  });

  it("skips rows already detached, exited or superseded without probing them", async () => {
    seed("done", [{ name: "d@done", status: "detached" }, { name: "e@done", status: "exited" }, { name: "s@done", status: "superseded" }], true);
    const { adapter, probed } = probing({});
    expect((await reconciler(adapter).reconcileArchivedRigs()).checked).toBe(0);
    expect(probed).toEqual([]);
  });

  it("is idempotent: a second pass probes nothing and writes no second event", async () => {
    seed("twice", [{ name: "a@twice", status: "running" }], true);
    const r = reconciler(probing({}).adapter);
    await r.reconcileArchivedRigs();
    const second = await r.reconcileArchivedRigs();
    expect(second).toEqual({ checked: 0, detached: 0, errors: [] });
    expect(detachedEvents()).toHaveLength(1);
  });

  it("scopes to one rig when given its id", async () => {
    const one = seed("one", [{ name: "a@one", status: "running" }], true);
    const two = seed("two", [{ name: "a@two", status: "running" }], true);
    await reconciler(probing({}).adapter).reconcileArchivedRigs(one.rig.id);
    expect([statusOf(one.ids[0]!), statusOf(two.ids[0]!)]).toEqual(["detached", "running"]);
  });

  it("re-checks inside the write: a rig unarchived while the probe was in flight keeps its running row", async () => {
    const { rig, ids } = seed("racy", [{ name: "a@racy", status: "running" }], true);
    const adapter = withProbe(async () => { rigRepo.unarchiveRig(rig.id); return { state: "absent" }; });
    const result = await reconciler(adapter).reconcileArchivedRigs();
    expect(result.detached).toBe(0);
    expect(statusOf(ids[0]!)).toBe("running");
  });

  it("the existing per-rig reconcile() still skips archived-rig logic: a non-archived rig with a gone session is detached as before", async () => {
    const { rig, ids } = seed("plain", [{ name: "a@plain", status: "running" }], false);
    await reconciler(probing({}).adapter).reconcile(rig.id);
    expect(statusOf(ids[0]!)).toBe("detached");
  });

  describe("POST /api/rigs/:id/archive", () => {
    function archiveVia(adapter: TmuxAdapter) {
      const setup = createTestApp(db, { tmux: adapter });
      return (rigId: string, force = false) => setup.app.request(`/api/rigs/${rigId}/archive`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
      });
    }

    it("ends the rig's running rows whose tmux session is gone, in the same call that archives it", async () => {
      const { rig, ids } = seed("route-gone", [{ name: "a@route-gone", status: "running" }], false);
      const adapter = withProbe(async () => ({ state: "absent" }));
      const res = await archiveVia(adapter)(rig.id, true);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ archived: true });
      expect(statusOf(ids[0]!)).toBe("detached");
    });

    it("touches only the rig being archived: another archived rig's row is left for the boot reconcile", async () => {
      const other = seed("route-other", [{ name: "a@route-other", status: "running" }], true);
      const { rig, ids } = seed("route-this", [{ name: "a@route-this", status: "running" }], false);
      const adapter = withProbe(async () => ({ state: "absent" }));
      expect((await archiveVia(adapter)(rig.id, true)).status).toBe(200);
      expect([statusOf(ids[0]!), statusOf(other.ids[0]!)]).toEqual(["detached", "running"]);
    });

    it("force-archiving a rig whose tmux session is still alive leaves that row running", async () => {
      const { rig, ids } = seed("route-live", [{ name: "a@route-live", status: "running" }], false);
      const adapter = withProbe(async () => ({ state: "present" }));
      expect((await archiveVia(adapter)(rig.id, true)).status).toBe(200);
      expect(statusOf(ids[0]!)).toBe("running");
    });

    it("a probe that throws does not fail the archive and does not end the row", async () => {
      const { rig, ids } = seed("route-throw", [{ name: "a@route-throw", status: "running" }], false);
      const adapter = withProbe(async () => { throw new Error("tmux exploded"); });
      const res = await archiveVia(adapter)(rig.id, true);
      expect(res.status).toBe(200);
      expect(statusOf(ids[0]!)).toBe("running");
    });
  });
});
