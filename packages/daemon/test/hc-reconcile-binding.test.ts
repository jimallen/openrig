// hc cutover B1: `rig reconcile-session` is the operator repair for drift. On an hc host the pane the host reports is the terminal's
// ADDRESS: it belongs in `terminal_address`, the row stays attachment_type 'hc', and `tmux_pane` is never written. These drive the real
// SessionReconciler and SessionRegistry over a fully migrated database; only the seat host is a stand-in.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionReconciler } from "../src/domain/session-reconciler.js";
import { registeredPaneOf } from "../src/domain/binding-pane.js";
import { TmuxAdapter, type SessionProbe, type TmuxPane } from "../src/adapters/tmux.js";

function refuse(): never { throw new Error("hc stand-in: no exec"); }

/** A seat host that answers as hc does: one pane per terminal, whose id is the terminal's address. */
class HcHostStandIn extends TmuxAdapter {
  override readonly hostKind = "hc" as const;
  constructor(private readonly panes: () => string[] | Error) {
    super(async () => refuse(), undefined, async () => refuse());
  }
  override async hasSession(): Promise<boolean> { return true; }
  override async probeSession(): Promise<SessionProbe> { return { state: "present" }; }
  override async listPanes(): Promise<TmuxPane[]> {
    const got = this.panes();
    if (got instanceof Error) throw got;
    return got.map((id, index) => ({ id, index, cwd: "/", width: 80, height: 24, active: index === 0 }));
  }
  override async getPaneCommand(): Promise<string | null> { return "zsh"; }
}

describe("SessionReconciler on an hc host writes the terminal address (B1)", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
  });
  afterEach(() => { db.close(); });

  const reconciler = (host: TmuxAdapter) => new SessionReconciler({ db, rigRepo, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: host });
  const row = (nodeId: string) => db.prepare("SELECT attachment_type, tmux_pane, terminal_address FROM bindings WHERE node_id = ?")
    .get(nodeId) as { attachment_type: string; tmux_pane: string | null; terminal_address: string | null };

  function seat(): { rigId: string; nodeId: string } {
    const rig = rigRepo.createRig("hc-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", cwd: "/tmp" });
    return { rigId: rig.id, nodeId: node.id };
  }
  const SESSION = "dev-impl@hc-rig";

  it("a respawned terminal (t3 to t9) moves the registered pane to t9 and leaves tmux_pane NULL", async () => {
    const { rigId, nodeId } = seat();
    registry.updateBinding(nodeId, { attachmentType: "hc", tmuxSession: SESSION, terminalAddress: "t3" });
    const out = await reconciler(new HcHostStandIn(() => ["t9"])).reconcileSession({ sessionName: SESSION, rigId, logicalId: "dev.impl" });
    expect(out.ok).toBe(true);
    expect(row(nodeId)).toEqual({ attachment_type: "hc", tmux_pane: null, terminal_address: "t9" });
    expect(registeredPaneOf(registry.getBindingForNode(nodeId))).toBe("t9");
  });

  it("a migrated row (hc, no address yet) gains its address", async () => {
    const { rigId, nodeId } = seat();
    registry.updateBinding(nodeId, { attachmentType: "hc", tmuxSession: SESSION });
    expect(row(nodeId).terminal_address).toBeNull();
    await reconciler(new HcHostStandIn(() => ["t9"])).reconcileSession({ sessionName: SESSION, rigId, logicalId: "dev.impl" });
    expect(row(nodeId)).toEqual({ attachment_type: "hc", tmux_pane: null, terminal_address: "t9" });
  });

  it("a node with no binding row yet whose first observation fails is still filed as hc", async () => {
    const { rigId, nodeId } = seat();
    registry.registerSession(nodeId, SESSION); // the daemon's history maps the name to the node; no binding row exists
    expect(registry.getBindingForNode(nodeId)).toBeNull();
    const out = await reconciler(new HcHostStandIn(() => new Error("core unreachable"))).reconcileSession({ sessionName: SESSION, rigId, logicalId: "dev.impl" });
    expect(out.ok).toBe(true);
    expect(row(nodeId)).toEqual({ attachment_type: "hc", tmux_pane: null, terminal_address: null });
  });

  it("control: on a tmux host the pane id still goes in tmux_pane", async () => {
    const { rigId, nodeId } = seat();
    registry.updateBinding(nodeId, { tmuxSession: SESSION, tmuxPane: "%1" });
    // A tmux-kind stand-in: same answers as the hc one, default hostKind.
    class TmuxStandIn extends TmuxAdapter {
      constructor() { super(async () => refuse(), undefined, async () => refuse()); }
      override async hasSession(): Promise<boolean> { return true; }
      override async probeSession(): Promise<SessionProbe> { return { state: "present" }; }
      override async listPanes(): Promise<TmuxPane[]> { return [{ id: "%7", index: 0, cwd: "/", width: 80, height: 24, active: true }]; }
      override async getPaneCommand(): Promise<string | null> { return "zsh"; }
    }
    await reconciler(new TmuxStandIn()).reconcileSession({ sessionName: SESSION, rigId, logicalId: "dev.impl" });
    expect(row(nodeId)).toEqual({ attachment_type: "tmux", tmux_pane: "%7", terminal_address: null });
  });
});
