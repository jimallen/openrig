import type Database from "better-sqlite3";
import type { HealthScope } from "../health-projection.js";
import { PDA_HELD_CODES } from "../../adapters/pda-runner-protocol.js";
import {
  RSI_COMPACTION_STORM, RSI_PERMISSION_STALL, RSI_WATCHDOG_DELIVERY_FAILURE,
} from "./detector-ids.js";
import {
  RsiFindingSource, hoursBefore, partitionText, sortedParts, sqliteUtcStamp, toIso,
  type FindingSpec, type RsiFindingSourceDeps, type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * The event-counted detectors: D5 compaction storm, D9 permission-prompt stalls, D12 watchdog
 * delivery failures. All three read the `events` table (never a derived table: D12 reads events,
 * rev2 §2 F2), count supporting events per subject inside a trailing window, and fire for a
 * subject whose count reaches a threshold.
 *
 * Cost: one grouped statement over the window, served by the index events(type, created_at)
 * (migration 114). Firing, quiet, population and the class split are derived in JS from it.
 *
 * Narrowest readings chosen where the design is silent (also listed in the PR report):
 *  - "in a day" is the trailing 24 hours, not a calendar day, so a storm does not vanish at 00:00 UTC.
 *  - D9 and D12 have no threshold in the design: D9 reuses D5's 8 per seat per 24 h; D12 reuses
 *    D1's "same class recurs" shape, 3 failed deliveries per job in 7 days.
 *  - D12 counts `deliveryStatus = 'failed'` only; `retained` and any other status are not failures.
 */
export const COMPACTION_STORM_THRESHOLD = 8;
export const COMPACTION_STORM_WINDOW_HOURS = 24;
export const PERMISSION_STALL_THRESHOLD = 8;
export const PERMISSION_STALL_WINDOW_HOURS = 24;
export const WATCHDOG_DELIVERY_FAILURE_THRESHOLD = 3;
export const WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS = 24 * 7;

/** SQL fragments over `events.payload`. Constants only; no caller text is ever interpolated. */
interface EventThresholdConfig {
  name: string;
  detectorId: string;
  className: string;
  eventType: string;
  windowHours: number;
  threshold: number;
  /** The subject the count is kept per (a seat session name, a job id). */
  subjectSql: string;
  subjectNoun: string;
  /** Which events are judged at all: the population the control is read against. */
  universeSql: string;
  /** Which judged events support a finding. */
  hitSql: string;
  /** The partition of every judged event into a closed list of classes plus `other`. */
  classSql: string;
  classLabel: string;
  /** An independent series that must agree with the judged events; a disagreement throws (source unavailable). `classes` is the
   *  judged events split by `classSql`, so a check can leave out the classes its series does not cover. */
  crossCheck?(db: Database.Database, since: string, judgedEvents: number, classes: ReadonlyMap<string, number>): void;
  /** What a reader of the coverage must know about what this detector did NOT judge (seats exempt or invisible to it), read with the
   *  window's `since`. A `note` rides the source's coverage row; a `notice` is its own coverage row (status `notice`, never partial). */
  coverageNotes?(db: Database.Database, since: string): CoverageNote[];
  scope(row: { rigId: string | null; nodeId: string | null }, instanceId: string): HealthScope;
  describe(subject: string, n: number): { summary: string; thresholdText: string; suggestedInspection: string; fixHint: string };
}

interface CoverageNote { text: string; kind: "note" | "notice" }

interface GroupRow {
  k: string; cls: string; hit: number; n: number; first_seq: number; last_seq: number;
  first_seen: string; last_seen: string; rig_id: string | null; node_id: string | null;
}
interface Subject {
  events: number; hits: number; firstSeq: number; lastSeq: number; firstSeen: string; lastSeen: string;
  rigId: string | null; nodeId: string | null;
}

const seatScope = (row: { rigId: string | null; nodeId: string | null }, instanceId: string): HealthScope =>
  row.rigId && row.nodeId ? { type: "seat", rigId: row.rigId, seatId: row.nodeId } : { type: "instance", instanceId };

class EventThresholdSource extends RsiFindingSource {
  readonly name: string;
  readonly detectors: readonly string[];

  constructor(deps: RsiFindingSourceDeps, private readonly config: EventThresholdConfig) {
    super(deps);
    this.name = config.name;
    this.detectors = [config.detectorId];
  }

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const c = this.config;
    const since = sqliteUtcStamp(hoursBefore(now, c.windowHours));
    // ONE grouped pass over the window; everything else is derived below.
    const rows = db.prepare(`SELECT coalesce(${c.subjectSql}, '(unattributed)') AS k, ${c.classSql} AS cls,
        CASE WHEN ${c.hitSql} THEN 1 ELSE 0 END AS hit, count(*) AS n,
        min(seq) AS first_seq, max(seq) AS last_seq, min(created_at) AS first_seen, max(created_at) AS last_seen,
        max(json_extract(payload, '$.rigId')) AS rig_id, max(json_extract(payload, '$.nodeId')) AS node_id
      FROM events WHERE type = ? AND created_at >= ? AND json_valid(payload) AND (${c.universeSql}) GROUP BY k, cls, hit`).all(c.eventType, since) as GroupRow[];

    const subjects = new Map<string, Subject>();
    const classes = new Map<string, number>();
    let events = 0;
    for (const row of rows) {
      events += row.n;
      classes.set(row.cls, (classes.get(row.cls) ?? 0) + row.n);
      const s = subjects.get(row.k) ?? { events: 0, hits: 0, firstSeq: Infinity, lastSeq: -Infinity, firstSeen: "", lastSeen: "", rigId: null, nodeId: null };
      s.events += row.n;
      if (row.hit === 1) {
        s.hits += row.n;
        s.firstSeq = Math.min(s.firstSeq, row.first_seq);
        s.lastSeq = Math.max(s.lastSeq, row.last_seq);
        if (s.firstSeen === "" || row.first_seen < s.firstSeen) s.firstSeen = row.first_seen;
        if (row.last_seen > s.lastSeen) s.lastSeen = row.last_seen;
        s.rigId = row.rig_id ?? s.rigId;
        s.nodeId = row.node_id ?? s.nodeId;
      }
      subjects.set(row.k, s);
    }
    c.crossCheck?.(db, since, events, classes);

    const firing = [...subjects.entries()].filter(([, s]) => s.hits >= c.threshold)
      .sort(([ka, a], [kb, b]) => b.hits - a.hits || (ka < kb ? -1 : ka > kb ? 1 : 0));
    const population = subjects.size;
    const quiet = population - firing.length;
    const classParts = sortedParts(classes);
    const findings: FindingSpec[] = firing.slice(0, limit).map(([k, s]) => {
      const text = c.describe(k, s.hits);
      return {
        detectorId: c.detectorId,
        className: c.className,
        subjectKey: `${c.subjectNoun}:${k}`,
        scope: c.scope({ rigId: s.rigId, nodeId: s.nodeId }, this.deps.instanceId),
        count: s.hits,
        controlTotal: quiet,
        population,
        firstSeq: s.firstSeq,
        lastSeq: s.lastSeq,
        firstSeen: toIso(s.firstSeen),
        lastSeen: toIso(s.lastSeen),
        summary: text.summary,
        threshold: text.thresholdText,
        explanation: `${s.hits} of ${events} judged events in the last ${c.windowHours} h; ${firing.length} ${c.subjectNoun}(s) fire and ${quiet} judged ${c.subjectNoun}(s) do not, out of ${population}. ${c.classLabel}: ${partitionText(classParts)}. ${text.fixHint}`,
        suggestedInspection: text.suggestedInspection,
      };
    });
    // OF-168: the grouped read above counts only events whose payload is JSON (json_extract over a damaged payload would end the whole
    // scan). A damaged event cannot be judged, so it is in neither the universe nor the hits: the coverage row says how many were left
    // out, so a quiet detector is not read as "every event was judged". Nothing about which events are counted changes.
    const unjudged = db.prepare("SELECT count(*) AS n, min(seq) AS first_seq, max(seq) AS last_seq FROM events WHERE type = ? AND created_at >= ? AND NOT json_valid(payload)")
      .get(c.eventType, since) as { n: number; first_seq: number | null; last_seq: number | null };
    const unjudgedNote = unjudged.n > 0
      ? `${unjudged.n} ${c.eventType} event(s) in the window (seq ${unjudged.first_seq} to ${unjudged.last_seq}) have a payload that is not readable JSON and were not judged (a damaged payload cannot be classified, so this may include events the detector would have ignored); the counts above leave them out. Repair or remove the event rows.`
      : undefined;
    const coverageNotes = c.coverageNotes?.(db, since) ?? [];
    const note = [unjudgedNote, ...coverageNotes.filter((n) => n.kind === "note").map((n) => n.text)].filter((t): t is string => t !== undefined).join(" ");
    const notices = coverageNotes.filter((n) => n.kind === "notice").map((n) => n.text);
    return {
      findings, total: firing.length, unit: `${c.subjectNoun}s`, order: "count desc, subject",
      ...(note !== "" ? { note } : {}), ...(notices.length > 0 ? { notices } : {}),
    };
  }
}

const KNOWN_SESSION_START = `('startup', 'resume', 'compact', 'clear')`;
const KNOWN_ACTIVITY_STATES = `('idle', 'running', 'needs_input', 'unknown')`;
const KNOWN_DELIVERY_STATUSES = `('ok', 'failed', 'retained')`;

/**
 * A compaction of a Pi (or OMP) seat. Those runtimes post no SessionStart; the runner posts `agent.activity` rawEvent `active`,
 * rawSubtype `compaction` for each `compaction_start` (pi-runner.ts). Measured on a backup of the live database, 2026-11-07 09:10Z:
 * 47 in 24 h for four Pi seats, equal to the `compaction` records in those seats' Pi session files (OF-268).
 */
const PI_COMPACTION_SQL = `(json_extract(payload, '$.activity.rawEvent') = 'active' AND json_extract(payload, '$.activity.rawSubtype') = 'compaction' AND json_extract(payload, '$.runtime') IN ('pi', 'omp'))`;
const PI_COMPACTION_CLASS = "pi-compaction";

/** D5: one seat records at least 8 compactions in 24 h: `SessionStart/compact` for hook runtimes, `active/compaction` for pi and omp. */
export function createCompactionStormSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-compaction-storm",
    detectorId: RSI_COMPACTION_STORM,
    className: "seat-compaction-storm",
    eventType: "agent.activity",
    windowHours: COMPACTION_STORM_WINDOW_HOURS,
    threshold: COMPACTION_STORM_THRESHOLD,
    subjectSql: `json_extract(payload, '$.sessionName')`,
    subjectNoun: "seat",
    universeSql: `(json_extract(payload, '$.activity.rawEvent') = 'SessionStart' OR ${PI_COMPACTION_SQL})`,
    hitSql: `(json_extract(payload, '$.activity.rawSubtype') = 'compact' OR ${PI_COMPACTION_SQL})`,
    classSql: `CASE WHEN ${PI_COMPACTION_SQL} THEN '${PI_COMPACTION_CLASS}' WHEN json_extract(payload, '$.activity.rawSubtype') IN ${KNOWN_SESSION_START} THEN json_extract(payload, '$.activity.rawSubtype') ELSE 'other' END`,
    classLabel: "SessionStart and Pi compaction events by kind",
    // Rev1's independent control: every SessionStart hook event is followed by one agent.session_identity
    // event with provenance 'hook' (live 24 h: 33 = 33; all time: 800 = 800). Pi and OMP seats post identity with
    // provenance 'rpc' and never emit a SessionStart, so only the hook series is comparable. A disagreement means
    // the counted series is wrong. OF-268: the judged events now also hold the pi and omp compactions, which are not SessionStarts
    // and have no identity event; the comparison is over the SessionStart events only, so it neither breaks nor passes them.
    crossCheck: (db, since, judged, classes) => {
      const sessionStarts = judged - (classes.get(PI_COMPACTION_CLASS) ?? 0);
      const identities = (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.session_identity' AND json_valid(payload) AND json_extract(payload, '$.provenance') = 'hook' AND created_at >= ?").get(since) as { n: number }).n;
      if (identities !== sessionStarts) {
        // OF-168: the count above leaves out an identity event whose payload is not JSON (its provenance cannot be read). Say so, so a
        // disagreement caused by a damaged row is not read as a wrong counted series.
        const unreadable = (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.session_identity' AND created_at >= ? AND NOT json_valid(payload)").get(since) as { n: number }).n;
        const damaged = unreadable > 0 ? ` (${unreadable} agent.session_identity event(s) in the window have a payload that is not readable JSON and were not counted; repair or remove them)` : "";
        throw new Error(`${RSI_COMPACTION_STORM}: ${sessionStarts} SessionStart activity events disagree with ${identities} hook agent.session_identity events in the same window${damaged}`);
      }
    },
    coverageNotes: () => [{
      kind: "note",
      text: "Hook seats are counted from SessionStart/compact; pi and omp seats from their active/compaction activity (the runner posts it for each compaction start). A runtime that posts neither is not seen.",
    }],
    scope: seatScope,
    describe: (seat, n) => ({
      summary: `Seat ${seat} recorded ${n} context compactions in the last ${COMPACTION_STORM_WINDOW_HOURS} h.`,
      thresholdText: `a seat records >= ${COMPACTION_STORM_THRESHOLD} agent.activity events with rawEvent SessionStart and rawSubtype compact, or (pi, omp) rawEvent active and rawSubtype compaction, within ${COMPACTION_STORM_WINDOW_HOURS} h`,
      suggestedInspection: `Inspect the context hygiene and model window of seat ${seat}.`,
      fixHint: "Fix lands in a persona (context hygiene) or a spec (model or window).",
    }),
  });
}

/**
 * A project rig's coordinator (OF-269; Jim, 2026-11-07: "Exempt coordinators"). Since 10-31 it asks Jim itself, in a modal, so its
 * blocking questions to Jim are not stalls. The daemon has no coordinator field; the role binding it holds is the node row's
 * `agent_ref`: the coordinator is the seat whose persona is chief-of-staff, matched on the ref's final path segment (`local:agents/`,
 * `local:../../agents/` and `path:/.../agents/` forms all end `/chief-of-staff`), never the seat name and never `remote_control`
 * (a feature flag any seat may turn on). The daemon does not record that a rig is a project rig (no column; the flag is read from the
 * spec at launch only), so the rig is not part of the binding. Live database, 2026-11-07: 36 of 307 nodes resolve, all `exec.cos`;
 * among the 15 nodes of the live rigs only eztrack's, and the kernel has none.
 */
const COORDINATOR_NODE_SQL = `EXISTS (SELECT 1 FROM nodes cn WHERE cn.id = events.node_id AND (cn.agent_ref LIKE '%/chief-of-staff' OR cn.agent_ref LIKE '%:chief-of-staff'))`;
const NAMED_SEATS_SHOWN = 20;
const seatList = (names: readonly string[]): string =>
  names.length === 0 ? "" : ` (${names.slice(0, NAMED_SEATS_SHOWN).join(", ")}${names.length > NAMED_SEATS_SHOWN ? `, and ${names.length - NAMED_SEATS_SHOWN} more` : ""})`;

/** D9: one seat records at least 8 `needs_input` activity events in 24 h. */
export function createPermissionStallSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-permission-stall",
    detectorId: RSI_PERMISSION_STALL,
    className: "seat-permission-stall",
    eventType: "agent.activity",
    windowHours: PERMISSION_STALL_WINDOW_HOURS,
    threshold: PERMISSION_STALL_THRESHOLD,
    subjectSql: `json_extract(payload, '$.sessionName')`,
    subjectNoun: "seat",
    // A coordinator seat is not judged at all (OF-269): it is in neither the population nor the hits. coverageNotes says how many it left out.
    // Nor is a pi or omp seat (OF-268 review F2): the coverage notice says they are not judged, and the runner reports needs_input only for an
    // open or leftover paste, never a permission prompt, so they are out of the population and the controls too.
    universeSql: `NOT ${COORDINATOR_NODE_SQL} AND COALESCE(json_extract(payload, '$.runtime'), '') NOT IN ('pi', 'omp')`,
    // A pda runner's held-message report reads needs_input so the seat shows in rig ps (OF-89); it is a delivery
    // hold, re-reported while it lasts, not a permission stall, so it is not a hit.
    // A question to Jim is not a stall either (Jim, 2026-10-31: the rig asks in a modal). Claude Code reports its
    // AskUserQuestion modal as Notification/permission_prompt, like a real permission prompt (measured: 46 of
    // exec-cos@eztrack's 49 needs_input in 7 days followed an AskUserQuestion call by 6-12 s). What tells them apart is
    // the seat's NEXT PostToolUse in the same generation: AskUserQuestion after an answered modal, with no other
    // needs_input in between (a denied prompt right before a modal must not borrow the modal's answer). Only a
    // Notification row can be a modal (a PermissionRequest is always a real request). A permission prompt is followed by its own
    // tool's PostToolUse, a denied one by none, and an unanswered modal by none yet: all still count. Another tool's
    // PostToolUse first (a racing or subagent tool) also counts: ambiguous, so reported. The answer must come within
    // 12 hours: Jim answered all 151 of exec-cos's modals within 11.7 h (median 0.7 min, p95 4.4 h), and a later
    // answer must not hide an old prompt. The lookup walks idx_events_node_type_seq from the row's own seq.
    hitSql: `json_extract(payload, '$.activity.state') = 'needs_input' AND NOT (json_extract(payload, '$.activity.rawEvent') IS 'Notification' AND COALESCE(json_extract(payload, '$.activity.rawSubtype'), '') IN (${PDA_HELD_CODES.map((c) => `'${c}'`).join(", ")}))`
      + ` AND NOT (json_extract(payload, '$.activity.rawEvent') IS 'Notification' AND COALESCE((SELECT CASE WHEN json_extract(nx.payload, '$.activity.rawEvent') = 'PostToolUse' THEN json_extract(nx.payload, '$.activity.rawSubtype') END`
      + ` FROM events nx WHERE nx.node_id = events.node_id AND nx.type = 'agent.activity' AND nx.seq > events.seq`
      + ` AND nx.created_at <= datetime(events.created_at, '+12 hours')`
      + ` AND json_valid(nx.payload) AND (json_extract(nx.payload, '$.activity.rawEvent') = 'PostToolUse' OR json_extract(nx.payload, '$.activity.state') = 'needs_input')`
      + ` AND json_extract(nx.payload, '$.sessionName') IS json_extract(events.payload, '$.sessionName')`
      + ` AND json_extract(nx.payload, '$.activity.generation') IS json_extract(events.payload, '$.activity.generation')`
      + ` ORDER BY nx.seq LIMIT 1), '') = 'AskUserQuestion')`,
    classSql: `CASE WHEN json_extract(payload, '$.activity.state') IN ${KNOWN_ACTIVITY_STATES} THEN json_extract(payload, '$.activity.state') ELSE 'other' END`,
    classLabel: "activity events by state",
    coverageNotes: (db, since) => {
      const exempt = db.prepare(`SELECT json_extract(payload, '$.sessionName') AS seat, count(*) AS n FROM events
        WHERE type = 'agent.activity' AND created_at >= ? AND json_valid(payload) AND json_extract(payload, '$.activity.state') = 'needs_input' AND ${COORDINATOR_NODE_SQL}
        GROUP BY seat`).all(since) as Array<{ seat: string | null; n: number }>;
      const exemptNames = exempt.map((r) => r.seat ?? "(unattributed)").sort();
      // Runtimes whose runner cannot report a permission prompt: Pi's needs_input is an open or leftover paste only (pi-runtime-adapter.ts);
      // measured, none of the 13,964 Pi activity events of the live database is needs_input. Seats of the live rigs, by latest session.
      const blind = db.prepare(`SELECT s.session_name AS name FROM nodes n JOIN rigs r ON r.id = n.rig_id
        JOIN sessions s ON s.node_id = n.id AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        WHERE r.archived_at IS NULL AND n.runtime IN ('pi', 'omp') ORDER BY s.session_name`).all() as Array<{ name: string }>;
      return [
        { kind: "note" as const, text: `Coordinator seats (nodes whose agent_ref is the chief-of-staff persona) are exempt: they ask Jim in a modal and were not judged. ${exempt.reduce((t, r) => t + r.n, 0)} needs_input event(s) from ${exempt.length} coordinator seat(s) in the last ${PERMISSION_STALL_WINDOW_HOURS} h were left out${seatList(exemptNames)}.` },
        ...(blind.length > 0
          ? [{ kind: "notice" as const, text: `${blind.length} seat(s) on runtime pi or omp are not judged: the runner reports no permission prompts${seatList(blind.map((b) => b.name))}.` }]
          : []),
      ];
    },
    scope: seatScope,
    describe: (seat, n) => ({
      summary: `Seat ${seat} stalled for input ${n} times in the last ${PERMISSION_STALL_WINDOW_HOURS} h.`,
      thresholdText: `a seat records >= ${PERMISSION_STALL_THRESHOLD} agent.activity events with state needs_input within ${PERMISSION_STALL_WINDOW_HOURS} h`,
      suggestedInspection: `Inspect the permission policy and prompts of seat ${seat}.`,
      fixHint: "Fix lands in a spec (permission policy) or a persona.",
    }),
  });
}

/** D12: one watchdog job records at least 3 failed deliveries in 7 days. */
export function createWatchdogDeliveryFailureSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-watchdog-delivery-failure",
    detectorId: RSI_WATCHDOG_DELIVERY_FAILURE,
    className: "watchdog-job-delivery-failure",
    eventType: "watchdog.evaluation_fired",
    windowHours: WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS,
    threshold: WATCHDOG_DELIVERY_FAILURE_THRESHOLD,
    subjectSql: `json_extract(payload, '$.jobId')`,
    subjectNoun: "job",
    universeSql: `1`,
    hitSql: `json_extract(payload, '$.deliveryStatus') = 'failed'`,
    classSql: `CASE WHEN json_extract(payload, '$.deliveryStatus') IN ${KNOWN_DELIVERY_STATUSES} THEN json_extract(payload, '$.deliveryStatus') ELSE 'other' END`,
    classLabel: "sent wake-ups by delivery status",
    scope: (_row, instanceId) => ({ type: "instance", instanceId }),
    describe: (job, n) => ({
      summary: `Watchdog job ${job} failed to deliver ${n} wake-ups in the last ${WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS / 24} days.`,
      thresholdText: `a watchdog job records >= ${WATCHDOG_DELIVERY_FAILURE_THRESHOLD} watchdog.evaluation_fired events with deliveryStatus failed within ${WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS / 24} days`,
      suggestedInspection: `Inspect the watchdog history and the delivery transport of job ${job}.`,
      fixHint: "Fix lands in OpenRig code (transport).",
    }),
  });
}
