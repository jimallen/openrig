// hc cutover N4 (QA N4, OF-177): an unreachable core never reads as a seat that is gone. `hasSession` collapses "the host did
// not answer" into false, and on hc that is wrong in the one way that matters: the holder keeps every program alive through a
// core outage. The sites that DECIDE on absence (adopt, launch, mark detached, hold, refuse, call a name free) ask the classified
// probe instead. The census, with each site's disposition, is in the PR body; the sites with their own suites carry their rows
// there (launch-node-subset, seat-handover-service, rigspec-preflight, rig-lifecycle-route, session-liveness).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionReconciler } from "../src/domain/session-reconciler.js";
import { probeSessionActivity } from "../src/domain/session-transport.js";
import { probePresence, classifySessionLiveness } from "../src/domain/session-liveness.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { TmuxAdapter, type SessionProbe, type TmuxPane } from "../src/adapters/tmux.js";

function refuse(): never { throw new Error("stand-in: no exec"); }

/** A seat host of the given kind that answers `probeSession` as scripted. Its collapsed `hasSession` says false, as hc's does. */
class ScriptedHost extends TmuxAdapter {
  override readonly hostKind: "tmux" | "hc";
  constructor(kind: "tmux" | "hc", private readonly answer: SessionProbe) {
    super(async () => refuse(), undefined, async () => refuse());
    this.hostKind = kind;
  }
  override async probeSession(): Promise<SessionProbe> { return this.answer; }
  override async hasSession(): Promise<boolean> { return this.answer.state === "present"; }
  override async listPanes(): Promise<TmuxPane[]> { return [{ id: "t9", index: 0, cwd: "/", width: 80, height: 24, active: true }]; }
  override async getPaneCommand(): Promise<string | null> { return "zsh"; }
}

const DARK: SessionProbe = { state: "transport_unavailable", cause: "hc core not reachable" };

describe("probePresence", () => {
  it("reads an unreachable hc core as unknown, never absent", async () => {
    await expect(probePresence(new ScriptedHost("hc", DARK), "s@r")).resolves.toBe("unknown");
  });
  it("keeps tmux's no-server answer as absent (no session can be live then)", async () => {
    await expect(probePresence(new ScriptedHost("tmux", DARK), "s@r")).resolves.toBe("absent");
  });
  it.each(["tmux", "hc"] as const)("%s: present is present, absent is absent", async (kind) => {
    await expect(probePresence(new ScriptedHost(kind, { state: "present" }), "s@r")).resolves.toBe("present");
    await expect(probePresence(new ScriptedHost(kind, { state: "absent" }), "s@r")).resolves.toBe("absent");
  });
});

describe("the real hc adapter aimed at a socket nobody listens on", () => {
  const adapter = new HcAdapter(new HcClient("/nonexistent/hc-core.sock"));
  it("probeSession says transport_unavailable, and the decision readings are unknown and unreadable, never absent and dead", async () => {
    expect(await adapter.probeSession("seat@rig")).toMatchObject({ state: "transport_unavailable" });
    expect(await probePresence(adapter, "seat@rig")).toBe("unknown");
    expect(await classifySessionLiveness(adapter, "seat@rig")).toBe("unreadable");
    // The collapsed view is what read as gone before: still false, which is why the decision sites no longer ask it.
    expect(await adapter.hasSession("seat@rig")).toBe(false);
  });
});

describe("SessionReconciler.reconcileSession (rig reconcile-session)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); rigRepo = new RigRepository(db); registry = new SessionRegistry(db); });
  afterEach(() => db.close());

  function seat() {
    const rig = rigRepo.createRig("hc-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", cwd: "/tmp" });
    registry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: "dev-impl@hc-rig", terminalAddress: "t3" });
    return { rigId: rig.id, nodeId: node.id };
  }
  const reconcile = (host: TmuxAdapter, rigId: string) => new SessionReconciler({ db, rigRepo, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: host })
    .reconcileSession({ sessionName: "dev-impl@hc-rig", rigId, logicalId: "dev.impl" });
  const rowCount = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("a core that does not answer is not 'No live tmux session': the refusal says so and nothing is written", async () => {
    const { rigId, nodeId } = seat();
    const before = db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId);
    const out = await reconcile(new ScriptedHost("hc", DARK), rigId);
    expect(out).toMatchObject({ ok: false, code: "reconcile_error" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("did not answer");
    expect(out.message).not.toContain("No live tmux session");
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId)).toEqual(before);
    expect(rowCount("sessions")).toBe(0);
  });

  it("control: a core that answers 'absent' is session_not_found", async () => {
    const { rigId } = seat();
    expect(await reconcile(new ScriptedHost("hc", { state: "absent" }), rigId)).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("control: a core that answers 'present' adopts", async () => {
    const { rigId } = seat();
    expect(await reconcile(new ScriptedHost("hc", { state: "present" }), rigId)).toMatchObject({ ok: true });
  });
});

describe("probeSessionActivity", () => {
  const activity = (host: TmuxAdapter) => probeSessionActivity({ sessionName: "dev-impl@hc-rig", runtime: "codex", attachmentType: "hc", tmuxAdapter: host });

  it("a core that does not answer is tmux_unavailable, never session_missing", async () => {
    expect(await activity(new ScriptedHost("hc", DARK))).toMatchObject({ state: "unknown", reason: "tmux_unavailable" });
  });
  it("control: a core that answers 'absent' is session_missing", async () => {
    expect(await activity(new ScriptedHost("hc", { state: "absent" }))).toMatchObject({ state: "unknown", reason: "session_missing" });
  });
});
