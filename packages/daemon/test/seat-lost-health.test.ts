// OF-200 follow-up (lead, before merge): a seat whose agent ended its terminal is a lost seat. While a login shell stayed above the agent, a crash left a pane
// someone could look at; now the terminal is gone with the agent, so `rig health --instance` must say so as a FINDING (not only `det` in `rig ps`, and not only a
// coverage notice about waiting messages), name the seat, the messages waiting and the command that brings it back, and say nothing about a seat that was stopped on
// purpose (`rig down`, `rig seat stop`). The condition is the one `rig ps` already reads: a session recorded running whose terminal the identity reconciler found
// missing, with no supported stop behind it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { SeatLostHealthSource, inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";
import { DEFAULT_HEALTH_POLICY } from "../src/domain/health-policy.js";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";

const NOW = new Date("2026-11-02T12:30:00.000Z");
const RIG = "01RIGOF200000000000000000A";
const NODE = "01NODEOF20000000000000000A";
const SESSION = "dev-impl@lost-rig";

let db: Database.Database;
let sessions: SessionRegistry;
let waiting: Record<string, { open: number; oldestId: string | null }>;

function seed(opts: { rigName?: string; logicalId?: string; sessionName?: string; status?: "running" | "exited"; stopped?: boolean; verdict?: "session_missing" | "none" | "pane_pid_gone" | "tmux_unavailable" } = {}): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(RIG, opts.rigName ?? "lost-rig");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, 'pi', '/tmp')").run(NODE, RIG, opts.logicalId ?? "dev.impl");
  const sessionName = opts.sessionName ?? SESSION;
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-1', ?, ?, 'running', '2026-11-02 12:00:00')").run(NODE, sessionName);
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES ('b-1', ?, 'hc', ?, 't7')").run(NODE, sessionName);
  if (opts.status === "exited") {
    if (opts.stopped) sessions.markIntentionallyStopped("s-1");
    else db.prepare("UPDATE sessions SET status = 'exited' WHERE id = 's-1'").run();
  }
  const verdict = opts.verdict ?? "session_missing";
  if (verdict !== "none") {
    new SeatIdentityStore(db).upsert({
      nodeId: NODE,
      verdict: verdict === "tmux_unavailable" ? "tmux_unavailable" : "pane_missing",
      evidenceSource: "tmux_session",
      reason: verdict === "session_missing" ? "session_missing" : verdict === "pane_pid_gone" ? "pane_pid_gone" : "tmux_unavailable",
      evidence: { registeredPane: "t7", observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName,
      observedAt: "2026-11-02T12:20:00.000Z",
    });
  }
}

let source: SeatLostHealthSource;

/** The same source across reads, as the daemon holds it: an episode is remembered between them. */
function records(options: { disabled?: string[] } = {}) {
  const policy = { version: "t", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors: options.disabled ?? [] }, contextPressure: { warningPercent: 95, criticalPercent: 99 } };
  return new HealthProjectionService([source], () => policy).records();
}

beforeEach(() => {
  db = createFullTestDb();
  sessions = new SessionRegistry(db);
  waiting = {};
  source = new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: (seat) => waiting[seat] ?? null, now: () => NOW });
});
afterEach(() => db.close());

describe("a seat whose terminal is gone is a finding in rig health", () => {
  it("a running session whose terminal the reconciler found missing is one active finding, scoped to the seat, naming it", () => {
    seed();
    const found = records();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      detector: "seat.lost", category: "process", status: "active", severity: "warning",
      scope: { type: "seat", rigId: RIG, seatId: NODE },
    });
    expect(found[0]!.summary).toContain("dev.impl@lost-rig");
    expect(found[0]!.summary).toMatch(/terminal is gone|lost its terminal/);
  });

  it("the finding is the prompt: it names the seat, the command that resumes its conversation, and the fresh start as the second choice", () => {
    seed();
    const text = `${records()[0]!.explanation}\n${records()[0]!.suggestedInspection}`;
    expect(text).toContain(`rig launch ${RIG} dev.impl`);
    expect(text).toContain("rig seat launch 'dev.impl@lost-rig' --fresh");
    expect(text).toMatch(/nothing restarts it|does not restart/i);
  });

  it("with messages waiting it is critical and says how many and which is oldest", () => {
    seed();
    waiting[SESSION] = { open: 3, oldestId: "m-first" };
    const found = records()[0]!;
    expect(found.severity).toBe("critical");
    expect(found.summary).toContain("3 message(s) waiting");
    expect(found.explanation).toContain("m-first");
  });

  it("a seat with nothing waiting does not claim any", () => {
    seed();
    const found = records()[0]!;
    expect(found.summary).not.toMatch(/waiting/);
    expect(found.severity).toBe("warning");
  });

  it("the same lost seat is the same finding on every read (a stable id), and the evidence is the verdict that proved it", () => {
    seed();
    const [a] = records();
    const [b] = records();
    expect(a!.id).toBe(b!.id);
    expect(a!.evidence).toEqual([expect.objectContaining({ type: "topology-activity", nodeId: NODE, sessionName: SESSION, activity: "session_missing" })]);
  });
});

describe("what is not a lost seat", () => {
  it("a seat stopped on purpose (rig down, rig seat stop) raises nothing", () => {
    seed({ status: "exited", stopped: true });
    expect(records()).toEqual([]);
  });

  it("a seat the boot reconcile detached after its terminal went (the daemon restarted since the crash) is still lost", () => {
    seed();
    db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's-1'").run();
    expect(records()).toHaveLength(1);
  });

  it("a seat a restore holds down on purpose (node.held) is not lost", () => {
    seed();
    db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's-1'").run();
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.held', ?)").run(RIG, NODE, JSON.stringify({ reason: "excluded_from_subset" }));
    expect(records()).toEqual([]);
  });

  it("a session recorded exited is not lost, even with a missing-terminal verdict and no recorded intent: only a row still running or detached is", () => {
    seed({ status: "exited", stopped: false });
    expect(records()).toEqual([]);
  });

  it("a session that exited on its own without a supported stop and without a missing-terminal verdict raises nothing here", () => {
    seed({ status: "exited", stopped: false, verdict: "none" });
    expect(records()).toEqual([]);
  });

  it("a running seat with no verdict, or a verdict that is not a missing session, raises nothing", () => {
    for (const verdict of ["none", "pane_pid_gone", "tmux_unavailable"] as const) {
      db.close();
      db = createFullTestDb();
      sessions = new SessionRegistry(db);
      seed({ verdict });
      expect(records(), verdict).toEqual([]);
    }
  });

  it("a seat that came back (session running again, the verdict replaced) clears: the next read has no finding", () => {
    seed();
    expect(records()).toHaveLength(1);
    new SeatIdentityStore(db).upsert({
      nodeId: NODE, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "t7", observedPid: 9, observedCommand: "node", matchedLayer: 1 }, sessionName: SESSION, observedAt: "2026-11-02T12:29:00.000Z",
    });
    expect(records()).toEqual([]);
  });

  it("a seat that was lost, came back, and was lost again is a new episode: a new finding id", () => {
    seed();
    const first = records()[0]!.id;
    const store = new SeatIdentityStore(db);
    store.upsert({ nodeId: NODE, verdict: "verified", evidenceSource: null, reason: null, evidence: { registeredPane: "t7", observedPid: 9, observedCommand: "node", matchedLayer: 1 }, sessionName: SESSION, observedAt: "2026-11-02T12:25:00.000Z" });
    expect(records()).toEqual([]);
    store.upsert({ nodeId: NODE, verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing", evidence: { registeredPane: "t7", observedPid: null, observedCommand: null, matchedLayer: null }, sessionName: SESSION, observedAt: "2026-11-02T12:28:00.000Z" });
    const second = records()[0]!;
    expect(second.id).not.toBe(first);
    expect(second.startedAt).toBe("2026-11-02T12:28:00.000Z");
  });

  it("the reconciler rewriting its verdict's time on every poll does not change the finding's id or its start", () => {
    seed();
    const before = records()[0]!;
    db.prepare("UPDATE seat_identity_verdicts SET observed_at = '2026-11-02T12:29:30.000Z' WHERE node_id = ?").run(NODE);
    const after = records()[0]!;
    expect(after.id).toBe(before.id);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.lastObservedAt).toBe("2026-11-02T12:29:30.000Z");
  });

  it("a seat of an archived rig raises nothing: the rig was put away on purpose", () => {
    seed();
    db.prepare("UPDATE rigs SET archived_at = '2026-11-02 12:25:00' WHERE id = ?").run(RIG);
    expect(records()).toEqual([]);
  });

  it("a policy that disables seat.lost hides it", () => {
    seed();
    expect(records({ disabled: ["seat.lost"] })).toEqual([]);
  });
});

describe("the daemon serves it", () => {
  it("rig health --instance lists the lost seat as a finding, with the message waiting for it counted, on a daemon built over that database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-lost-"));
    const file = join(dir, "openrig.sqlite");
    const seeded = createDb(file);
    migrate(seeded, ALL_MIGRATIONS);
    db = seeded;
    sessions = new SessionRegistry(db);
    seed();
    new MessageStore(db).accept({ id: messageId("m-waiting"), seat: SESSION, sender: "lead@lost-rig", body: "body" });
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    try {
      const listed = daemon.deps.healthProjection!.list();
      const found = listed.records.filter((r) => r.detector === "seat.lost");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: "critical", scope: { type: "seat", rigId: RIG, seatId: NODE } });
      expect(found[0]!.summary).toContain("1 message(s) waiting");
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      rmSync(dir, { recursive: true, force: true });
      db = createFullTestDb();
    }
  }, 120_000);
});
