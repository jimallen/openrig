// OF-19 — leftovers from the archived-rig lookup fix (OF-2).
//
// Production consequences pinned here:
//  - hasTerminalTransport: a live seat with no session row and an external (paneless) binding was still
//    classified pane-bound when an archived rig of the same name had a tmux binding, so delivery tried the
//    pane path for a paneless seat.
//  - AgentActivityStore.resolveSession({nodeId: archivedNode}) answered the archived node id paired with
//    the LIVE node's session id, so a hook event naming an archived node was recorded against a session
//    that is not that node's.
//  - The oversight seat probe (startup.ts) is a function now, so it can be tested without createDaemon.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { isSessionNameRunning, resolveRunningSeat } from "../src/domain/latest-session-name-match.js";
import { createFullTestDb } from "./helpers/test-app.js";

const NAME = "dev-impl@alpha";

function terminalTransport(db: Database.Database, dest: string): boolean {
  const repo = Object.create(QueueRepository.prototype) as unknown as { db: Database.Database; hasTerminalTransport(d: string): boolean };
  repo.db = db;
  return repo.hasTerminalTransport(dest);
}

describe("hasTerminalTransport is live-first through the composed rig+seat leg (OF-19.1)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  // Both rigs are named "alpha": the live rig is a recreation of the archived one.
  function seedNode(opts: { archived: boolean; withSession: boolean; tmux: boolean }): string {
    const rig = rigRepo.createRig("alpha");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
    if (opts.withSession) registry.registerSession(node.id, NAME);
    if (opts.tmux) registry.updateBinding(node.id, { tmuxSession: NAME });
    else registry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "ext" });
    if (opts.archived) expect(rigRepo.archiveRig(rig.id)).toBe(true);
    return node.id;
  }

  it("a live external seat with no session row is not pane-bound because an archived same-name rig had a tmux session row", () => {
    seedNode({ archived: true, withSession: true, tmux: true });
    seedNode({ archived: false, withSession: false, tmux: false });
    expect(terminalTransport(db, NAME)).toBe(false);
  });

  it("a live external seat with no session row is not pane-bound because an archived same-name rig had a tmux binding (composed leg)", () => {
    seedNode({ archived: true, withSession: false, tmux: true });
    seedNode({ archived: false, withSession: false, tmux: false });
    expect(terminalTransport(db, NAME)).toBe(false);
  });

  it("a live tmux seat with no session row is pane-bound even when an archived same-name rig is external", () => {
    seedNode({ archived: true, withSession: false, tmux: false });
    seedNode({ archived: false, withSession: false, tmux: true });
    expect(terminalTransport(db, NAME)).toBe(true);
  });

  it("an archived rig still answers when no live rig has the name", () => {
    seedNode({ archived: true, withSession: false, tmux: true });
    expect(terminalTransport(db, NAME)).toBe(true);
  });

  it("a seat whose session name does not compose from its rig and logical id is decided by its session row alone", () => {
    const rig = rigRepo.createRig("gamma");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
    registry.registerSession(node.id, "custom-name@gamma"); // composes to seat "custom-name", not "dev-impl"
    registry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "ext" });
    expect(terminalTransport(db, "custom-name@gamma")).toBe(false);
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "custom-name@gamma" });
    expect(terminalTransport(db, "custom-name@gamma")).toBe(true);
  });

  it("a database whose rigs table has no archive column still resolves the composed leg (partial schema stays safe)", () => {
    db.exec("DROP INDEX idx_rigs_archived; ALTER TABLE rigs DROP COLUMN archived_at");
    seedNode({ archived: false, withSession: false, tmux: false });
    expect(terminalTransport(db, NAME)).toBe(false);
    seedNode({ archived: false, withSession: false, tmux: true });
    expect(terminalTransport(db, NAME)).toBe(true);
  });
});

describe("AgentActivityStore.resolveSession answers one node's pair (OF-19.2)", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let live: { nodeId: string; sessionId: string };
  let archived: { nodeId: string; sessionId: string };

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    // Live first, archived second: the archived node's session carries the newest id.
    const liveNode = rigRepo.addNode(rigRepo.createRig("alpha").id, "dev.impl", { role: "worker", runtime: "codex" });
    live = { nodeId: liveNode.id, sessionId: registry.registerSession(liveNode.id, NAME).id };
    const oldRig = rigRepo.createRig("alpha-old");
    const oldNode = rigRepo.addNode(oldRig.id, "dev.impl", { role: "worker", runtime: "codex" });
    archived = { nodeId: oldNode.id, sessionId: registry.registerSession(oldNode.id, NAME).id };
    expect(rigRepo.archiveRig(oldRig.id)).toBe(true);
    expect(archived.sessionId > live.sessionId).toBe(true);
  });
  afterEach(() => db.close());

  it("a hook event naming an archived node resolves that node's own session, not the live node's", () => {
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
    const resolved = store.resolveSession({ nodeId: archived.nodeId, sessionName: NAME });
    expect(resolved?.nodeId).toBe(archived.nodeId);
    expect(resolved?.sessionId).toBe(archived.sessionId);
  });

  it("a live node's explicit nodeId resolves the live node's own session", () => {
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
    const resolved = store.resolveSession({ nodeId: live.nodeId });
    expect(resolved?.nodeId).toBe(live.nodeId);
    expect(resolved?.sessionId).toBe(live.sessionId);
  });

  it("a name alone still resolves live-first", () => {
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
    const resolved = store.resolveSession({ sessionName: NAME });
    expect(resolved?.nodeId).toBe(live.nodeId);
    expect(resolved?.sessionId).toBe(live.sessionId);
  });
});

describe("the oversight seat probe and the classifier-lease liveness share one meaning (OF-19.3, OF-19.4)", () => {
  const OVERSIGHT = "watch-lead@oversight";
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  function seat(rigName: string, name: string, status: string, archive = false): string {
    const rig = rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, "watch.lead", { role: "worker", runtime: "codex" });
    const session = registry.registerSession(node.id, name);
    db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, session.id);
    if (archive) expect(rigRepo.archiveRig(rig.id)).toBe(true);
    return session.id;
  }

  it("names the seat when the live-first row is running, and nothing otherwise", () => {
    expect(resolveRunningSeat(db, OVERSIGHT)).toBeNull();
    const id = seat("oversight", OVERSIGHT, "running");
    expect(resolveRunningSeat(db, OVERSIGHT)).toBe(OVERSIGHT);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(id);
    expect(resolveRunningSeat(db, OVERSIGHT)).toBeNull();
  });

  it("a stale running row in an archived rig does not vouch for a stopped live oversight seat", () => {
    seat("oversight", OVERSIGHT, "exited");
    seat("oversight-old", OVERSIGHT, "running", true);
    expect(resolveRunningSeat(db, OVERSIGHT)).toBeNull();
  });

  it("classifier lease: a running live seat is alive, a relaunch in flight (newest row not yet running) is not, whatever an older row says", () => {
    // Restore/relaunch supersedes or exits a node's older rows before it registers the new one
    // (restore-orchestrator clearStaleState, seat-lifecycle markSuperseded), so an older 'running' row
    // beside a newer non-running one is stale by construction; the newest row is the seat's truth.
    const first = seat("cls", "classifier@cls", "running");
    expect(isSessionNameRunning(db, "classifier@cls")).toBe(true);
    const node = (db.prepare("SELECT node_id FROM sessions WHERE id = ?").get(first) as { node_id: string }).node_id;
    registry.registerSession(node, "classifier@cls"); // default status 'unknown' until launch marks it running
    expect(isSessionNameRunning(db, "classifier@cls")).toBe(false);
    db.prepare("UPDATE sessions SET status = 'superseded' WHERE id = ?").run(first);
    db.prepare("UPDATE sessions SET status = 'running' WHERE node_id = ? AND status = 'unknown'").run(node);
    expect(isSessionNameRunning(db, "classifier@cls")).toBe(true);
  });
});
