// hc cutover W32: `rig release` is not a leftover of the removed adoption commands. Its input is a seat whose latest session row is
// origin 'claimed', and `rig reconcile-session` (which still ships and works on hc, see hc-reconcile-binding.test.ts) is what makes one.
// These drive the real SessionReconciler, SessionRegistry and RigLifecycleService over a fully migrated database; only the seat host is a
// stand-in that answers as hc does (one pane per terminal, the terminal's address as its id) and records what the daemon asks of it.
//
// Deployed entrypoint: routes/rigs.ts POST /api/rigs/:id/release (`rig release`) -> RigLifecycleService.releaseRig -> unclaimSession,
// which clears the seat's `@rigged_*` identity through the host's setSessionOption (labels on an hc terminal, hc-identity.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionReconciler } from "../src/domain/session-reconciler.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { TmuxAdapter, type SessionProbe, type TmuxPane, type TmuxResult } from "../src/adapters/tmux.js";

function refuse(): never { throw new Error("hc stand-in: no exec"); }

/** A seat host that answers as hc does, and records the options it is asked to set and the sessions it is asked to kill. */
class HcHostStandIn extends TmuxAdapter {
  override readonly hostKind = "hc" as const;
  readonly options: Array<{ session: string; key: string; value: string }> = [];
  readonly kills: string[] = [];
  constructor(private readonly setResult: TmuxResult = { ok: true }) {
    super(async () => refuse(), undefined, async () => refuse());
  }
  override async hasSession(): Promise<boolean> { return true; }
  override async probeSession(): Promise<SessionProbe> { return { state: "present" }; }
  override async listPanes(): Promise<TmuxPane[]> { return [{ id: "t9", index: 0, cwd: "/", width: 80, height: 24, active: true }]; }
  override async getPaneCommand(): Promise<string | null> { return "zsh"; }
  override async setSessionOption(session: string, key: string, value: string): Promise<TmuxResult> {
    this.options.push({ session, key, value });
    return this.setResult;
  }
  override async killSession(session: string): Promise<TmuxResult> { this.kills.push(session); return { ok: true }; }
}

describe("rig release of a seat that reconcile-session claimed on an hc host (W32)", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let rigRepo: RigRepository;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });
  afterEach(() => { db.close(); });

  const SESSION = "dev-impl@hc-rig";
  const RIGGED = ["@rigged_node_id", "@rigged_session_name", "@rigged_rig_id", "@rigged_rig_name", "@rigged_logical_id"];

  const lifecycle = (host: TmuxAdapter) => new RigLifecycleService({
    db, rigRepo, sessionRegistry: registry, discoveryRepo: new DiscoveryRepository(db), eventBus,
    queueRepo: new QueueRepository(db, eventBus), tmuxAdapter: host,
  });

  /** A seat re-bound by the real reconciler: its latest row is a claimed session and its binding names the hc terminal. */
  async function claimedSeat(host: TmuxAdapter): Promise<{ rigId: string; nodeId: string }> {
    const rig = rigRepo.createRig("hc-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", cwd: "/tmp" });
    registry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SESSION, terminalAddress: "t3" });
    const reconciler = new SessionReconciler({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: host });
    const out = await reconciler.reconcileSession({ sessionName: SESSION, rigId: rig.id, logicalId: "dev.impl" });
    expect(out.ok).toBe(true);
    return { rigId: rig.id, nodeId: node.id };
  }
  const latestSession = (nodeId: string) => db.prepare("SELECT origin, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { origin: string; status: string };

  it("reconcile-session is what makes the claimed row release acts on", async () => {
    const host = new HcHostStandIn();
    const { nodeId } = await claimedSeat(host);
    expect(latestSession(nodeId)).toEqual({ origin: "claimed", status: "running" });
  });

  it("detaches the claimed row, clears the five @rigged_* labels on the seat's terminal, drops the binding and kills nothing", async () => {
    const host = new HcHostStandIn();
    const { rigId, nodeId } = await claimedSeat(host);
    host.options.length = 0; // what the reconciler set on the way in is not what release is asked about

    const out = await lifecycle(host).releaseRig(rigId);

    expect(out).toMatchObject({ ok: true, status: "ok", deleted: false });
    expect(out.ok && out.released.map((r) => r.sessionName)).toEqual([SESSION]);
    expect(latestSession(nodeId)).toEqual({ origin: "claimed", status: "detached" });
    expect(registry.getBindingForNode(nodeId)).toBeNull();
    expect(host.options).toEqual(RIGGED.map((key) => ({ session: SESSION, key, value: "" })));
    expect(host.kills).toEqual([]);
  });

  it("a refused label clear does not stop the release: the clear is best effort and the row is still detached", async () => {
    const host = new HcHostStandIn({ ok: false, code: "transport_unavailable", message: "hc core unavailable" });
    const { rigId, nodeId } = await claimedSeat(host);

    const out = await lifecycle(host).releaseRig(rigId);

    expect(out).toMatchObject({ ok: true, status: "ok" });
    expect(latestSession(nodeId).status).toBe("detached");
    expect(host.kills).toEqual([]);
  });

  it("refuses a rig whose seat was launched by OpenRig, and detaches nothing", async () => {
    const host = new HcHostStandIn();
    const rig = rigRepo.createRig("launched-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", cwd: "/tmp" });
    registry.registerSession(node.id, "dev-impl@launched-rig");

    const out = await lifecycle(host).releaseRig(rig.id);

    expect(out).toMatchObject({ ok: false, code: "contains_launched_nodes", launchedLogicalIds: ["dev.impl"] });
    expect(host.options).toEqual([]);
    expect(latestSession(node.id).origin).toBe("launched");
  });
});
