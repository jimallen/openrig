import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  boundHealthEvidence,
  deriveHealthSourceFreshness,
  type HealthEvidenceReference,
} from "../health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { SLOW_OPERATION_THRESHOLD_MS } from "../slow-op-recorder.js";
import { RSI_SLOW_OP_SUBTHRESHOLD_FLOOD } from "./detector-ids.js";
import { rsiFingerprint } from "./fingerprint.js";

/** The recorder keeps the live file plus three rotations (SLOW_OPERATION_ROTATION_COUNT), so
 * four files is the whole history. The source never reads a fifth, whatever the directory holds. */
export const SLOW_OP_MAX_FILES = 4;
/** Most bytes read from one file: its newest bytes. The recorder rotates at 1 MiB (plus the
 * line that crossed it), so a file past this cap is not a normal recorder file. */
export const SLOW_OP_MAX_FILE_BYTES = 1024 * 1024 + 64 * 1024;
/** Most end spans one read keeps, newest first. Four capped files of minimum-size records hold
 * fewer, so this is a hard bound on the work, not a normal limit. */
export const SLOW_OP_MAX_SPANS = 60_000;
/** Floor: a site needs at least this many sub-threshold spans in the files read. A statistical
 * floor only; on its own it counts history (a finished flood stays in the window for days). */
export const SLOW_OP_FLOOD_MIN_SUBTHRESHOLD = 1000;
/** Rate: a site must also have at least SLOW_OP_FLOOD_MIN_RECENT sub-threshold spans in the
 * hour ending at the anchor: the later of the newest record in the log and the recorder's last
 * proof of life (see SlowOpFileSource), so the finding goes quiet within an hour of a fix. 360 an hour is one span every 10 s; the live flood runs at about 1,440 an hour. */
export const SLOW_OP_FLOOD_RECENT_WINDOW_MS = 60 * 60 * 1000;
export const SLOW_OP_FLOOD_MIN_RECENT = 360;
export const SLOW_OP_SUBTHRESHOLD_FLOOD_CLASS = "subthreshold-span-flood";
export const SLOW_OP_COVERAGE_ORDER = "oldest rotated file first, newest four files";
export const SLOW_OP_NO_LOG_NOTE = "no slow-op log yet";

interface EndSpan { site: string; durationMs: number; ts: number }
interface SiteTally {
  total: number; under: number; recent: number;
  firstSeen: number; lastSeen: number; firstSeq: number; lastSeq: number;
}

/**
 * D13: spans under the slow threshold fill the slow-operation log. One finding per site.
 *
 * A site is a flood when BOTH hold: at least SLOW_OP_FLOOD_MIN_SUBTHRESHOLD of its spans in the
 * files read are under the recorder's own threshold, AND at least SLOW_OP_FLOOD_MIN_RECENT of
 * them fall in the hour ending at the anchor: the later of the newest record (a diagnostic counts)
 * and the recorder's last-alive time. The anchor is never plain read time, so a dead recorder's
 * frozen log does not look current: with no liveness the anchor is the newest record, the log is
 * stale, and a frozen flood reads indeterminate. An alive recorder on a quiet instance anchors at
 * read time, so a flood that ended more than an hour ago reads quiet instead of staying
 * indeterminate for ever (OF-73). Freshness follows the same anchor.
 *
 * Coverage: a log directory with no log file yet is an honest zero with a note. A log that
 * exists but cannot be read (no file readable, a permission error) throws, which the projection
 * serves as `unavailable`. Everything that stops the source evaluating the whole window (a
 * cut or unparseable file, a fifth file, the span cap, a record stamped after read time that
 * had to be clamped) is `partial`. None of these reads as a clean zero.
 *
 * The health record id hashes the episode start, and a flood's start here is its oldest span
 * still in the files, which moves at every rotation. The id is therefore per-window; the
 * fingerprint is the stable identity (rsi/fingerprint.ts). A stable id needs the activation
 * time that B1's rsi_finding_state stores; a stateless file read cannot know it.
 *
 * `firstSeq`/`lastSeq` are positions among the end spans of this read, oldest first.
 */
export class SlowOpFileSource implements HealthObservationSource {
  readonly name = "rsi-slow-op-file";
  readonly detectors = [RSI_SLOW_OP_SUBTHRESHOLD_FLOOD];
  private lastCoverage: HealthSourceCoverage[] = [];

  constructor(private readonly deps: {
    logPath: string;
    instanceId: string;
    now?: () => Date;
    maxFileBytes?: number;
    maxSpans?: number;
    /** The slow-op recorder's last proof of life, epoch ms, or null when it cannot persist records
     * (closed, Worker lost, a write failed). Absent: no recorder to ask, same as null. */
    lastAliveAt?: () => number | null;
  }) {}

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  /** Newest first: the live file, then .1, .2, ... A missing directory is no log yet; a path that is
   * not a directory throws, which the projection serves as unavailable. */
  private candidateFiles(): string[] {
    const dir = dirname(this.deps.logPath);
    const base = basename(this.deps.logPath);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTDIR is not "no log yet": the recorder cannot create its log under a path that is not a directory.
      if (code === "ENOENT") return [];
      throw error;
    }
    const ranked: { name: string; rank: number }[] = [];
    for (const name of names) {
      if (name === base) ranked.push({ name, rank: 0 });
      else if (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1))) ranked.push({ name, rank: Number(name.slice(base.length + 1)) });
    }
    return ranked.sort((a, b) => a.rank - b.rank).map((entry) => `${dir}/${entry.name}`);
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    const evaluatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const evaluatedMs = Date.parse(evaluatedAt);
    const maxBytes = this.deps.maxFileBytes ?? SLOW_OP_MAX_FILE_BYTES;
    const maxSpans = this.deps.maxSpans ?? SLOW_OP_MAX_SPANS;
    const found = this.candidateFiles();
    if (found.length === 0) {
      this.lastCoverage = [{
        source: this.name, evaluatedAt, unit: "files", limit: SLOW_OP_MAX_FILES, total: 0,
        evaluated: 0, omitted: 0, partial: false, order: SLOW_OP_NO_LOG_NOTE,
      }];
      return [];
    }
    const selected = found.slice(0, SLOW_OP_MAX_FILES);

    // Newest file first and newest line first, so the span cap drops the OLDEST records.
    const newestFirst: EndSpan[] = [];
    let wholeFiles = 0;
    let filesRead = 0;
    let clamped = 0;
    let capHit = false;
    let newestMs: number | null = null;
    for (const file of selected) {
      if (capHit) break;
      let text: string;
      let cut: boolean;
      try {
        ({ text, cut } = readNewestBytes(file, maxBytes));
      } catch {
        continue; // an unreadable file is not evaluated; it never reads as an empty one
      }
      filesRead++;
      let clean = !cut;
      const lines = text.split("\n");
      // A tail read may begin inside a record: that fragment fails to parse and is ignored, and the
      // file is already partial because it was cut.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line === "") continue;
        const parsed = parseRecord(line);
        if (parsed === null) { clean = false; continue; }
        let ts = parsed.ts;
        const future = ts !== null && ts > evaluatedMs;
        if (future) ts = evaluatedMs;
        if (ts !== null && (newestMs === null || ts > newestMs)) newestMs = ts;
        if (parsed.span !== null && newestFirst.length >= maxSpans) { capHit = true; clean = false; break; }
        // Counted only for a record this read keeps: the one that trips the cap is never read.
        if (future) clamped++;
        if (parsed.span === null) continue;
        newestFirst.push({ ...parsed.span, ts: ts! });
      }
      if (clean) wholeFiles++;
    }
    if (filesRead === 0) throw new Error(`no slow-operation log file could be read at ${this.deps.logPath}`);
    const notes = [SLOW_OP_COVERAGE_ORDER];
    if (clamped > 0) notes.push(`${clamped} record(s) stamped after read time were clamped to it`);
    if (capHit) notes.push(`span cap ${maxSpans} reached, oldest records not read`);
    this.lastCoverage = [{
      source: this.name, evaluatedAt, unit: "files", limit: SLOW_OP_MAX_FILES, total: found.length,
      evaluated: wholeFiles, omitted: found.length - wholeFiles,
      partial: wholeFiles < found.length || clamped > 0, order: notes.join("; "),
    }];

    // Oldest first from here on: position i + 1 is the span's sequence in this read.
    const spans = newestFirst.reverse();
    // The anchor: the later of the newest record and the recorder's proof of life, never later than
    // read time. Without liveness it is the newest record alone (a dead recorder stays stale).
    const aliveAt = this.deps.lastAliveAt?.() ?? null;
    const aliveMs = aliveAt !== null && Number.isFinite(aliveAt) ? Math.min(aliveAt, evaluatedMs) : null;
    const anchorMs = newestMs === null ? aliveMs : aliveMs === null ? newestMs : Math.max(newestMs, aliveMs);
    const recentFloorMs = (anchorMs ?? evaluatedMs) - SLOW_OP_FLOOD_RECENT_WINDOW_MS;
    const bySite = new Map<string, SiteTally>();
    let controlTotal = 0;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const isUnder = span.durationMs < SLOW_OPERATION_THRESHOLD_MS;
      if (!isUnder) controlTotal++;
      let tally = bySite.get(span.site);
      if (!tally) {
        tally = { total: 0, under: 0, recent: 0, firstSeen: Infinity, lastSeen: -Infinity, firstSeq: 0, lastSeq: 0 };
        bySite.set(span.site, tally);
      }
      tally.total++;
      if (!isUnder) continue;
      tally.under++;
      if (span.ts > recentFloorMs) tally.recent++;
      if (tally.firstSeq === 0) tally.firstSeq = i + 1;
      tally.lastSeq = i + 1;
      if (span.ts < tally.firstSeen) tally.firstSeen = span.ts;
      if (span.ts > tally.lastSeen) tally.lastSeen = span.ts;
    }

    const freshnessAt = anchorMs === null ? null : new Date(anchorMs).toISOString();
    const observations: HealthDetectorObservation[] = [];
    for (const [site, tally] of [...bySite].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (tally.under < SLOW_OP_FLOOD_MIN_SUBTHRESHOLD || tally.recent < SLOW_OP_FLOOD_MIN_RECENT) continue;
      const firstSeen = new Date(tally.firstSeen).toISOString();
      const lastSeen = new Date(tally.lastSeen).toISOString();
      const fingerprint = rsiFingerprint(RSI_SLOW_OP_SUBTHRESHOLD_FLOOD, `site:${site}`);
      const evidence: HealthEvidenceReference = {
        type: "telemetry-span", sourceOrder: 0, observedAt: lastSeen,
        detectorId: RSI_SLOW_OP_SUBTHRESHOLD_FLOOD, class: SLOW_OP_SUBTHRESHOLD_FLOOD_CLASS, fingerprint,
        count: tally.under, controlTotal, population: spans.length,
        firstSeq: tally.firstSeq, lastSeq: tally.lastSeq, firstSeen, lastSeen,
      };
      const windowSeconds = Math.max(1, Math.ceil((evaluatedMs - tally.firstSeen) / 1000));
      observations.push({
        kind: "telemetry-finding",
        detectorId: RSI_SLOW_OP_SUBTHRESHOLD_FLOOD,
        fingerprint,
        episodeKey: fingerprint,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        episodeStartedAt: firstSeen,
        lastObservedAt: evaluatedAt,
        source: boundHealthEvidence([evidence], {
          source: "telemetry-span", startedAt: firstSeen, endedAt: evaluatedAt, limit: 1, retentionSeconds: windowSeconds,
        }, deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: freshnessAt, maxAgeSeconds: 600 })),
        summary: `Site ${site} logged ${tally.under} spans under the ${SLOW_OPERATION_THRESHOLD_MS} ms slow-operation threshold.`,
        threshold: `at least ${SLOW_OP_FLOOD_MIN_SUBTHRESHOLD} logged spans at one site with durationMs under ${SLOW_OPERATION_THRESHOLD_MS}, and at least ${SLOW_OP_FLOOD_MIN_RECENT} of them in the hour ending at the newest log record or the recorder's last-alive time, whichever is later`,
        explanation: `${tally.under} of ${tally.total} spans at ${site} are under the threshold, ${tally.recent} of them in the hour ending at the newest log record or the recorder's last-alive time; control: ${controlTotal} spans at or over it, out of ${spans.length} spans in the log window.`,
        suggestedInspection: `Check how ${site} records its spans: a path that logs every measurement without applying the slow threshold floods this log.`,
      });
    }
    return observations;
  }
}

/** Read the newest `maxBytes` of a file; `cut` is true when older bytes were left unread.
 * Only a regular file is opened: opening a FIFO would block the event loop. */
function readNewestBytes(file: string, maxBytes: number): { text: string; cut: boolean } {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  const size = stat.size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buffer, done, length - done, size - length + done);
      if (n === 0) break;
      done += n;
    }
    return { text: buffer.subarray(0, done).toString("utf8"), cut: size > maxBytes };
  } finally {
    closeSync(fd);
  }
}

/** `null`: a line this source cannot read (malformed). Otherwise the record's own timestamp
 * (null when it has none) and, for an `end` span, the span itself. A well-formed record that is
 * not an `end` span (a diagnostic such as event_loop_gap) carries `span: null`. */
function parseRecord(line: string): { ts: number | null; span: { site: string; durationMs: number } | null } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ts = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
  if (record.phase !== "end") return { ts: Number.isFinite(ts) ? ts : null, span: null };
  if (typeof record.site !== "string" || record.site === "" || typeof record.durationMs !== "number"
    || !Number.isFinite(record.durationMs) || !Number.isFinite(ts)) return null;
  return { ts, span: { site: record.site, durationMs: record.durationMs } };
}
