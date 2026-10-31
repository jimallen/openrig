// OF-184: the seam that makes the post-restart prompt run, against a real database and the real event bus. Only the
// transport's `send` is faked; nothing here reaches a seat, a socket or tmux. The notifier's own rules are pinned in
// post-restart-notifier.test.ts; this file pins what the notifier is plugged into: the sessions/rigs SQL, the event
// subscription, the settings switch, and the re-derivation after a daemon restart.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { wirePostRestartPrompt, sqliteUtcToIso } from "../src/domain/post-restart-wiring.js";
import { postRestartDeliveryId, type PostRestartSendResult } from "../src/domain/post-restart-notifier.js";
import type { RestoreResult } from "../src/domain/types.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

interface Sent { sessionName: string; text: string; deliveryId: string }

function world(opts: { readSwitch?: () => boolean; windowMs?: number } = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  const eventBus = new EventBus(db);
  const rigRepo = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const outbox = new OutboxHandler(db);
  const rig = rigRepo.createRig("wired-rig");
  const node = rigRepo.addNode(rig.id, "dev.impl");
  const session = registry.registerSession(node.id, "dev-impl@wired-rig");
  registry.updateStatus(session.id, "running");
  const clock = { t: Date.now() };
  const sent: Sent[] = [];
  const logs: string[] = [];
  const reply: PostRestartSendResult = { ok: true, verified: true };
  const wiring = () => wirePostRestartPrompt({
    db, eventBus, outbox,
    readSwitch: opts.readSwitch ?? (() => true),
    send: async (sessionName, text, o) => { sent.push({ sessionName, text, deliveryId: o.deliveryId }); return reply; },
    log: (l) => logs.push(l),
    // A clock that only the notifier's sleeps move, starting at the real now (the events table stamps real time): a seat
    // that never takes the prompt runs the window out in zero real time instead of spinning for 30 minutes.
    timing: { now: () => new Date(clock.t), sleep: async (ms) => { clock.t += ms; }, firstDelayMs: 0, retryEveryMs: 60_000, windowMs: opts.windowMs ?? 30 * 60_000 },
  });
  const restored = (): RestoreResult => ({
    snapshotId: "snap-1", preRestoreSnapshotId: null, rigResult: "fully_restored", warnings: [],
    nodes: [{ nodeId: node.id, logicalId: "dev.impl", status: "resumed" }],
  });
  const emitRestore = () => eventBus.emit({ type: "restore.completed", rigId: rig.id, snapshotId: "snap-1", result: restored() });
  const restoredResult = restored;
  const setSessionStart = (sqlite: string) => db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(sqlite, session.id);
  const settle = () => new Promise<void>((r) => setTimeout(r, 25));
  return { db, eventBus, outbox, rig, node, session, sent, logs, wiring, emitRestore, restoredResult, setSessionStart, settle };
}

describe("OF-184: restore.completed on the event bus reaches the seat (the startup seam)", () => {
  it("a restore.completed event sends one prompt to the node's running session, named from the rigs table", async () => {
    const w = world();
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.sessionName).toBe("dev-impl@wired-rig");
    expect(w.sent[0]!.text).toContain("rig wired-rig was restored");
    expect(w.sent[0]!.deliveryId).toMatch(/^post-restart-\d+-/);
  });

  it("only restore.completed does: restore.subset_completed (same payload shape, a resumed node) sends nothing", async () => {
    const w = world();
    w.wiring();
    w.eventBus.emit({ type: "restore.subset_completed", rigId: w.rig.id, snapshotId: "snap-1", result: w.restoredResult() });
    await w.settle();
    expect(w.sent).toHaveLength(0);
  });

  it("with two running sessions on the node the latest is the one judged: a newer one that started after the restore is a replacement", async () => {
    const w = world();
    w.wiring();
    const newer = new SessionRegistry(w.db).registerSession(w.node.id, "dev-impl-2@wired-rig");
    new SessionRegistry(w.db).updateStatus(newer.id, "running");
    w.db.prepare("UPDATE sessions SET created_at = '2999-01-01 00:00:00' WHERE id = ?").run(newer.id);
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(0);
  });

  it("'restarted at' is the session's start taken from the sessions table, as UTC ISO", async () => {
    const w = world();
    w.setSessionStart("2026-10-30 17:58:12");
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent[0]!.text).toContain("restarted at 2026-10-30T17:58:12.000Z");
  });

  it("a session that is not running (exited) gets nothing", async () => {
    const w = world();
    w.db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(w.session.id);
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(0);
  });

  it("a seat launched again after the restore (session starts later) is not told its conversation resumed", async () => {
    const w = world();
    w.setSessionStart("2999-01-01 00:00:00");
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(0);
  });
});

describe("OF-184: the setting, and a failed read of it", () => {
  it("switched off: nothing is sent", async () => {
    const w = world({ readSwitch: () => false });
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(0);
  });

  it("a settings read that throws fails open, to the default (on), and says so in the log", async () => {
    const w = world({ readSwitch: () => { throw new Error("settings.json unreadable"); } });
    w.wiring();
    w.emitRestore();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.logs.some((l) => l.includes("could not read recovery.post_restart_prompt") && l.includes("settings.json unreadable"))).toBe(true);
  });
});

describe("OF-184: a daemon restart inside the window does not lose the prompt", () => {
  it("a restore.completed already in the log (the daemon was down when its delivery was due) is delivered on boot", async () => {
    const w = world();
    w.emitRestore(); // before any subscriber: the daemon that handled it is gone
    const wired = w.wiring();
    expect(w.sent).toHaveLength(0);
    const out = await wired.rederiveFromLog();
    expect(out).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it("one already delivered (an outbox row exists under its delivery id) is not sent again", async () => {
    const w = world();
    const ev = w.emitRestore();
    w.outbox.record({ outboxId: postRestartDeliveryId(ev.seq, w.node.id), senderSession: "restore@system", destinationSession: "dev-impl@wired-rig", body: "x", auditPointer: "x", identityProvenance: "transport:v1" });
    const out = await w.wiring().rederiveFromLog();
    expect(out.map((o) => o.outcome)).toEqual(["already_sent"]);
    expect(w.sent).toHaveLength(0);
  });

  it("a restore older than the window is left alone", async () => {
    const w = world();
    w.emitRestore();
    w.db.prepare("UPDATE events SET created_at = datetime('now', '-31 minutes') WHERE type = 'restore.completed'").run();
    const out = await w.wiring().rederiveFromLog();
    expect(out).toEqual([]);
    expect(w.sent).toHaveLength(0);
  });

  it("a restore 5 minutes old is inside the window", async () => {
    const w = world();
    w.emitRestore();
    w.db.prepare("UPDATE events SET created_at = datetime('now', '-5 minutes') WHERE type = 'restore.completed'").run();
    w.db.prepare("UPDATE sessions SET created_at = datetime('now', '-20 minutes')").run(); // the resumed seat started before the restore
    await w.wiring().rederiveFromLog();
    expect(w.sent).toHaveLength(1);
  });

  it("an older restore whose seat was launched again since is not told it resumed", async () => {
    const w = world();
    w.emitRestore();
    w.db.prepare("UPDATE events SET created_at = datetime('now', '-10 minutes') WHERE type = 'restore.completed'").run();
    w.setSessionStart(new Date(Date.now() - 2 * 60_000).toISOString().replace("T", " ").slice(0, 19));
    const out = await w.wiring().rederiveFromLog();
    expect(out.map((o) => o.outcome)).toEqual(["replaced"]);
    expect(w.sent).toHaveLength(0);
  });

  it("a malformed restore.completed payload is logged and skipped; the others still run", async () => {
    const w = world();
    w.db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, NULL, 'restore.completed', ?)").run(w.rig.id, "{not json");
    w.emitRestore();
    await w.wiring().rederiveFromLog();
    expect(w.logs.some((l) => l.includes("not re-derived"))).toBe(true);
    expect(w.sent).toHaveLength(1);
  });
});

describe("sqliteUtcToIso", () => {
  it("reads SQLite datetime('now') text as UTC", () => {
    expect(sqliteUtcToIso("2026-10-30 17:58:12")).toBe("2026-10-30T17:58:12.000Z");
  });
});
