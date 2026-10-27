import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import { attentionRoutes } from "../src/routes/attention.js";
import {
  HealthProjectionService, evaluateHealthDetectors,
  type HealthDetectorObservation, type HealthObservationSource,
} from "../src/domain/health-detectors.js";
import { DEFAULT_HEALTH_POLICY, HEALTH_DETECTORS, validateHealthPolicy } from "../src/domain/health-policy.js";
import { boundHealthEvidence, deriveHealthSourceFreshness, type HealthRecord } from "../src/domain/health-projection.js";
import { RSI_ARCHIVED_RIG_LIVE_SESSION } from "../src/domain/rsi/detector-ids.js";
import { TelemetryHealthSource } from "../src/domain/rsi/telemetry-source.js";

// The clock is injected far from wall clock (2026): a wall-clock reversion would put every
// fixture session in the future of "now" and break the window.
const NOW = new Date("2031-03-04T05:06:07.000Z");
const dirs: string[] = [];
const open: Database.Database[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** File-backed fixture: SQLite refuses a read-only connection to an in-memory database. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rsi-telemetry-"));
  dirs.push(dir);
  const dbPath = join(dir, "openrig.sqlite");
  const db = createDb(dbPath);
  open.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rig = (id: string, name: string, archivedAt: string | null = null) =>
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)").run(id, name, archivedAt);
  const node = (id: string, rigId: string) =>
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(id, rigId, id);
  const session = (id: string, nodeId: string, status: string, createdAt: string) =>
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)").run(id, nodeId, `${id}@x`, status, createdAt);
  const source = (extra: { rowLimit?: number } = {}) => new TelemetryHealthSource({ dbPath, now: () => NOW, ...extra });
  const records = (extra: { rowLimit?: number } = {}): HealthRecord[] => new HealthProjectionService([source(extra)]).records();
  return { dir, dbPath, db, rig, node, session, source, records };
}

function span(record: HealthRecord) {
  const item = record.evidence.find((e) => e.type === "telemetry-span");
  if (!item || item.type !== "telemetry-span") throw new Error("record carries no telemetry-span evidence");
  return item;
}

describe("D4 archived-rig-live-session source", () => {
  it("reports an archived rig whose latest session is running and never a live rig, with the live rig as the control", () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n-dead", "rig-dead");
    f.session("s-dead", "n-dead", "running", "2030-01-02 03:04:05");
    f.rig("rig-live", "kernel");
    f.node("n-live", "rig-live");
    f.session("s-live", "n-live", "running", "2030-01-03 00:00:00");

    const source = f.source();
    expect(source.read()).toHaveLength(1);
    // The live rig must not inflate the coverage total: that would show a false PARTIAL
    // (total 2, evaluated 1) and freeze a consumer that treats partial as "no transitions".
    expect(source.coverage()).toEqual([{
      source: "rsi-telemetry", evaluatedAt: NOW.toISOString(), unit: "sessions", limit: 500,
      total: 1, evaluated: 1, omitted: 0, partial: false, order: "rig id, session rowid",
    }]);
    const records = f.records();

    expect(records).toHaveLength(1);
    expect(records[0]!.scope).toEqual({ type: "rig", rigId: "rig-dead" });
    expect(records[0]!.detector).toBe(RSI_ARCHIVED_RIG_LIVE_SESSION);
    expect(span(records[0]!)).toMatchObject({ count: 1, controlTotal: 1, population: 2, class: "live-session-on-archived-rig" });
  });

  it("judges only the latest session of each node and counts detached as live", () => {
    const f = fixture();
    f.rig("rig-dead", "old", "2030-06-01 00:00:00");
    // b1: an old running session under a newer exited one is NOT a finding.
    f.node("b1", "rig-dead");
    f.session("b1-old", "b1", "running", "2030-01-01 00:00:00");
    f.session("b1-new", "b1", "exited", "2030-01-02 00:00:00");
    // b2: an old exited session under a newer detached one IS a finding.
    f.node("b2", "rig-dead");
    f.session("b2-old", "b2", "exited", "2030-01-01 00:00:00");
    f.session("b2-new", "b2", "detached", "2030-01-02 00:00:00");

    const records = f.records();

    expect(records).toHaveLength(1);
    // population counts nodes with a session (2), not sessions (4) and not findings (1).
    expect(span(records[0]!)).toMatchObject({ count: 1, controlTotal: 0, population: 2 });
  });

  it("reads the whole population as coverage, and names a row cap as partial rather than as zero", () => {
    const f = fixture();
    for (const id of ["rig-a", "rig-b"]) {
      f.rig(id, id, "2030-06-01 00:00:00");
      f.node(`n-${id}`, id);
      f.session(`s-${id}`, `n-${id}`, "running", "2030-01-01 00:00:00");
    }
    const complete = f.source();
    expect(complete.read()).toHaveLength(2);
    expect(complete.coverage()).toEqual([{
      source: "rsi-telemetry", evaluatedAt: NOW.toISOString(), unit: "sessions", limit: 500,
      total: 2, evaluated: 2, omitted: 0, partial: false, order: "rig id, session rowid",
    }]);

    const capped = f.source({ rowLimit: 1 });
    expect(capped.read()).toHaveLength(1);
    expect(capped.coverage()[0]).toMatchObject({ limit: 1, total: 2, evaluated: 1, omitted: 1, partial: true });
  });

  it("OF-70: a session stamped after the daemon clock is clamped to the evaluation time, not allowed to blind D4 for every rig", () => {
    const f = fixture();
    // A clock-skewed row (2032) next to a healthy one (2030) under two different archived rigs.
    f.rig("rig-skew", "skewed", "2030-06-01 00:00:00");
    f.node("n-skew", "rig-skew");
    f.session("s-skew", "n-skew", "running", "2032-01-02 03:04:05");
    f.rig("rig-ok", "ok", "2030-06-01 00:00:00");
    f.node("n-ok", "rig-ok");
    f.session("s-ok", "n-ok", "running", "2030-01-02 03:04:05");

    const projection = new HealthProjectionService([f.source()]);
    const records = projection.records();

    // The source stays available and reports both rigs.
    expect(projection.coverage()).toEqual([expect.not.objectContaining({ status: "unavailable" })]);
    expect(records.map((r) => (r.scope as { rigId: string }).rigId).sort()).toEqual(["rig-ok", "rig-skew"]);
    const skewed = records.find((r) => (r.scope as { rigId: string }).rigId === "rig-skew")!;
    // The future stamp reads as "now": the episode starts at the evaluation time, never after it.
    expect(span(skewed)).toMatchObject({ firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString() });
    // The healthy rig keeps its own stamp.
    expect(span(records.find((r) => (r.scope as { rigId: string }).rigId === "rig-ok")!).firstSeen).toBe("2030-01-02T03:04:05.000Z");
    // Clamping is never silent: the coverage row counts the clamped sessions.
    const source = f.source();
    source.read();
    expect(source.coverage()[0]).toMatchObject({ partial: false, total: 2, evaluated: 2 });
    expect(source.coverage()[0]).toMatchObject({ note: "1 session created_at later than the daemon clock was clamped to the evaluation time" });
  });

  it("OF-70: a session stamped exactly at the evaluation time is not clamped and adds no note", () => {
    const f = fixture();
    f.rig("rig-a", "a", "2030-06-01 00:00:00");
    f.node("n-a", "rig-a");
    f.session("s-a", "n-a", "running", "2031-03-04 05:06:07");
    const source = f.source();
    expect(source.read()).toHaveLength(1);
    expect(source.coverage()[0]).not.toHaveProperty("note");
  });

  it("serves an active, fresh, determinate record whose episode window covers its evidence", () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n1", "rig-dead");
    f.node("n2", "rig-dead");
    f.session("s1", "n1", "running", "2030-01-02 03:04:05");
    f.session("s2", "n2", "detached", "2030-02-03 04:05:06");

    const [record] = f.records();

    expect(record).toMatchObject({ status: "active", indeterminateReason: null, startedAt: "2030-01-02T03:04:05.000Z", lastObservedAt: NOW.toISOString() });
    expect(record!.freshness.state).toBe("fresh");
    expect(span(record!)).toMatchObject({ count: 2, firstSeen: "2030-01-02T03:04:05.000Z", lastSeen: "2030-02-03T04:05:06.000Z" });
  });
});

describe("the read-only connection", () => {
  it("refuses a write with SQLITE_READONLY yet sees rows a separate writer commits afterwards", () => {
    const f = fixture();
    const source = f.source();
    expect(source.read()).toEqual([]); // opens the handle while the database holds no finding

    expect(() => source.readonlyHandle().prepare("INSERT INTO rigs (id, name) VALUES ('x', 'x')").run())
      .toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
    expect(() => source.readonlyHandle().exec("DELETE FROM sessions")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));

    f.rig("rig-dead", "late", "2030-06-01 00:00:00");
    f.node("n", "rig-dead");
    f.session("s", "n", "running", "2030-01-01 00:00:00");
    expect(source.read()).toHaveLength(1);
  });

  it("reports a missing database as an unavailable source and never as zero findings", () => {
    const f = fixture();
    const missing = new TelemetryHealthSource({ dbPath: join(f.dir, "absent.sqlite"), now: () => NOW });
    const service = new HealthProjectionService([missing]);

    expect(service.records()).toEqual([]);
    expect(service.coverage()).toEqual([expect.objectContaining({ source: "rsi-telemetry", status: "unavailable", partial: true })]);
  });
});

describe("the stable finding fingerprint", () => {
  it("is unchanged when the same finding recurs under a new episode, though the record id changes", () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n1", "rig-dead");
    f.session("s1", "n1", "running", "2030-01-02 00:00:00");
    const [first] = f.records();

    // The condition clears (session exits), then recurs with a new session and a later episode start.
    f.db.prepare("UPDATE sessions SET status = 'exited' WHERE id = 's1'").run();
    expect(f.records()).toEqual([]);
    f.session("s2", "n1", "running", "2030-03-04 00:00:00");
    const [second] = f.records();

    expect(second!.id).not.toBe(first!.id);
    expect(second!.startedAt).not.toBe(first!.startedAt);
    expect(span(second!).fingerprint).toBe(span(first!).fingerprint);
    expect(span(first!).fingerprint).toBe(`${RSI_ARCHIVED_RIG_LIVE_SESSION}/rig:rig-dead`);
  });

  it("differs for a different subject and does not depend on the counts", () => {
    const f = fixture();
    for (const id of ["rig-a", "rig-b"]) {
      f.rig(id, "same-name", "2030-06-01 00:00:00");
      f.node(`${id}-n1`, id);
      f.session(`${id}-s1`, `${id}-n1`, "running", "2030-01-01 00:00:00");
    }
    f.node("rig-b-n2", "rig-b");
    f.session("rig-b-s2", "rig-b-n2", "running", "2030-01-01 00:00:00");

    const byRig = new Map(f.records().map((r) => [r.scope.type === "rig" ? r.scope.rigId : "", span(r)]));

    expect(byRig.get("rig-a")!.fingerprint).not.toBe(byRig.get("rig-b")!.fingerprint);
    expect(byRig.get("rig-b")!.count).toBe(2);
    expect(byRig.get("rig-b")!.fingerprint).toBe(`${RSI_ARCHIVED_RIG_LIVE_SESSION}/rig:rig-b`);
  });
});

describe("category and severity keep RSI findings out of the Attention view", () => {
  it("names category process and severity info", () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n1", "rig-dead");
    f.session("s1", "n1", "running", "2030-01-02 00:00:00");

    expect(f.records()[0]).toMatchObject({ category: "process", severity: "info" });
  });

  it("omits an RSI finding from /api/attention while a context-pressure finding from the same service is listed", async () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n1", "rig-dead");
    f.session("s1", "n1", "running", "2030-01-02 00:00:00");
    const at = NOW.toISOString();
    // Positive control: a real warning-or-higher record travels the same route.
    const control: HealthObservationSource = { read: () => [{
      kind: "context-pressure", scope: { type: "seat", rigId: "r", seatId: "s" }, episodeKey: "control", episodeStartedAt: at, lastObservedAt: at,
      sourceName: "fixture", continuity: null,
      source: boundHealthEvidence([{ type: "context-usage", sourceOrder: 0, observedAt: at, nodeId: "s", sessionId: "s", usedPercentage: 99, available: true, fresh: true }],
        { source: "context-usage", startedAt: at, endedAt: at, limit: 1, retentionSeconds: 600 },
        deriveHealthSourceFreshness({ evaluatedAt: at, newestSourceAt: at, maxAgeSeconds: 600, available: true })),
    }] };
    const service = new HealthProjectionService([f.source(), control]);
    expect(service.records().map((r) => r.detector).sort()).toEqual(["context.pressure", RSI_ARCHIVED_RIG_LIVE_SESSION]);

    const app = new Hono();
    app.use("*", async (c, next) => { c.set("healthProjection" as never, service as never); await next(); });
    app.route("/api/attention", attentionRoutes());
    const body = await (await app.request("/api/attention")).json() as { items: Array<{ id: string; summary: string }>; sources: Array<{ source: string; state: string }> };

    expect(body.sources.find((s) => s.source === "health")?.state).toBe("available");
    const healthIds = body.items.filter((i) => i.id.startsWith("health:")).map((i) => i.id);
    expect(healthIds).toHaveLength(1);
    expect(body.items.some((i) => /Archived rig/.test(i.summary))).toBe(false);
    expect(JSON.stringify(body)).not.toContain(RSI_ARCHIVED_RIG_LIVE_SESSION);
  });
});

describe("telemetry-finding evaluation", () => {
  it("refuses a finding whose span evidence does not carry its own fingerprint", () => {
    const at = NOW.toISOString();
    const observation = (fingerprint: string): HealthDetectorObservation => ({
      kind: "telemetry-finding", detectorId: RSI_ARCHIVED_RIG_LIVE_SESSION, fingerprint, scope: { type: "rig", rigId: "r" },
      episodeStartedAt: at, lastObservedAt: at, summary: "s", threshold: "t", explanation: "e", suggestedInspection: "i",
      source: boundHealthEvidence([{ type: "telemetry-span", sourceOrder: 0, observedAt: at, detectorId: RSI_ARCHIVED_RIG_LIVE_SESSION, class: "c",
        fingerprint: `${RSI_ARCHIVED_RIG_LIVE_SESSION}/rig:r`, count: 1, controlTotal: 0, population: 1, firstSeq: 1, lastSeq: 1, firstSeen: at, lastSeen: at }],
        { source: "telemetry-span", startedAt: at, endedAt: at, limit: 1, retentionSeconds: 1 },
        deriveHealthSourceFreshness({ evaluatedAt: at, newestSourceAt: at, maxAgeSeconds: 600 })),
    });

    expect(evaluateHealthDetectors([observation(`${RSI_ARCHIVED_RIG_LIVE_SESSION}/rig:r`)])).toHaveLength(1);
    expect(() => evaluateHealthDetectors([observation(`${RSI_ARCHIVED_RIG_LIVE_SESSION}/rig:other`)])).toThrow(/lacks matching telemetry-span evidence/);
  });
});

describe("policy: RSI ids are disableable but are not diagnosis targets", () => {
  const withPolicy = (patch: { disabledDetectors?: string[]; detectors?: string[] }) => ({
    ...DEFAULT_HEALTH_POLICY,
    disabledDetectors: patch.disabledDetectors ?? [],
    diagnosis: { ...DEFAULT_HEALTH_POLICY.diagnosis, detectors: patch.detectors ?? DEFAULT_HEALTH_POLICY.diagnosis.detectors },
  });

  it("accepts the RSI id in disabledDetectors and rejects it in diagnosis.detectors", () => {
    expect(validateHealthPolicy(withPolicy({ disabledDetectors: [RSI_ARCHIVED_RIG_LIVE_SESSION] })).disabledDetectors).toEqual([RSI_ARCHIVED_RIG_LIVE_SESSION]);
    expect(() => validateHealthPolicy(withPolicy({ detectors: [RSI_ARCHIVED_RIG_LIVE_SESSION] }))).toThrow("Unknown or duplicate detector");
    expect(HEALTH_DETECTORS as readonly string[]).not.toContain(RSI_ARCHIVED_RIG_LIVE_SESSION);
  });

  it("still rejects an unknown id and a duplicate in both lists", () => {
    expect(() => validateHealthPolicy(withPolicy({ disabledDetectors: ["rsi.nonexistent"] }))).toThrow("Unknown or duplicate detector");
    expect(() => validateHealthPolicy(withPolicy({ disabledDetectors: [RSI_ARCHIVED_RIG_LIVE_SESSION, RSI_ARCHIVED_RIG_LIVE_SESSION] }))).toThrow("Unknown or duplicate detector");
    expect(() => validateHealthPolicy(withPolicy({ detectors: ["rsi.nonexistent"] }))).toThrow("Unknown or duplicate detector");
  });

  it("lets a policy disable the detector: the source is never read", () => {
    const f = fixture();
    f.rig("rig-dead", "cel-track", "2030-06-01 00:00:00");
    f.node("n1", "rig-dead");
    f.session("s1", "n1", "running", "2030-01-02 00:00:00");
    const policy = (disabled: string[]) => () => ({ version: "t", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors: disabled }, contextPressure: { warningPercent: 95, criticalPercent: 99 } });

    expect(new HealthProjectionService([f.source()], policy([])).records()).toHaveLength(1);
    const disabled = new HealthProjectionService([f.source()], policy([RSI_ARCHIVED_RIG_LIVE_SESSION]));
    expect(disabled.records()).toEqual([]);
    expect(disabled.coverage()).toEqual([]);
  });
});

describe("daemon wiring", () => {
  it("registers the telemetry source on a file-backed daemon and not on an in-memory one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-wiring-"));
    dirs.push(dir);
    const fileDaemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    open.push(fileDaemon.db);
    const memoryDaemon = await createDaemon({ dbPath: ":memory:" });
    open.push(memoryDaemon.db);

    const sources = (daemon: typeof fileDaemon) => (daemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source);

    expect(sources(fileDaemon)).toContain("rsi-telemetry");
    expect(sources(memoryDaemon)).not.toContain("rsi-telemetry");
  });
});
