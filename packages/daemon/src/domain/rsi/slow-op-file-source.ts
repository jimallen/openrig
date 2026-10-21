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
/** Most bytes read from one file: its newest bytes. The recorder rotates at 1 MiB, so a file
 * past this cap is not a normal recorder file. */
export const SLOW_OP_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A site is a flood when at least this many of its logged spans are under the slow threshold. */
export const SLOW_OP_FLOOD_MIN_SUBTHRESHOLD = 1000;
export const SLOW_OP_SUBTHRESHOLD_FLOOD_CLASS = "subthreshold-span-flood";

interface EndSpan { site: string; durationMs: number; ts: number; ordinal: number }

/**
 * D13: spans under the slow threshold fill the slow-operation log. One finding per site. The
 * threshold is the recorder's own (a span under it should not be in the log). Anything that
 * stops the source reading the whole window (a file over the byte cap, an unparseable line,
 * an unreadable file, a fifth file) is reported as `partial` coverage; a log it cannot find or
 * read at all throws, which the projection serves as `unavailable`. Neither is ever zero.
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
    floodMinSubthreshold?: number;
  }) {}

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  private candidateFiles(): string[] {
    const dir = dirname(this.deps.logPath);
    const base = basename(this.deps.logPath);
    const ranked: { name: string; rank: number }[] = [];
    for (const name of readdirSync(dir)) {
      if (name === base) ranked.push({ name, rank: 0 });
      else if (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1))) ranked.push({ name, rank: Number(name.slice(base.length + 1)) });
    }
    // Newest first: the live file, then .1, .2, ...
    return ranked.sort((a, b) => a.rank - b.rank).map((entry) => `${dir}/${entry.name}`);
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    const evaluatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const maxBytes = this.deps.maxFileBytes ?? SLOW_OP_MAX_FILE_BYTES;
    const floodMin = this.deps.floodMinSubthreshold ?? SLOW_OP_FLOOD_MIN_SUBTHRESHOLD;
    const found = this.candidateFiles();
    if (found.length === 0) throw new Error(`no slow-operation log found at ${this.deps.logPath}`);
    const selected = found.slice(0, SLOW_OP_MAX_FILES);

    // Read oldest first, so record ordinals grow with time.
    const spans: EndSpan[] = [];
    let wholeFiles = 0;
    let filesRead = 0;
    let ordinal = 0;
    for (const file of [...selected].reverse()) {
      let text: string;
      let cut: boolean;
      try {
        ({ text, cut } = readNewestBytes(file, maxBytes));
      } catch {
        continue; // an unreadable file is not evaluated; it never reads as an empty one
      }
      filesRead++;
      let clean = !cut;
      // A tail read may begin inside a record: that fragment fails to parse and is ignored, and the
      // file is already partial because it was cut.
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const span = parseEndSpan(line);
        if (span === "other") continue;
        if (span === null) { clean = false; continue; }
        ordinal++;
        spans.push({ ...span, ordinal });
      }
      if (clean) wholeFiles++;
    }
    if (filesRead === 0) throw new Error(`no slow-operation log file could be read at ${this.deps.logPath}`);
    this.lastCoverage = [{
      source: this.name, evaluatedAt, unit: "files", limit: SLOW_OP_MAX_FILES, total: found.length,
      evaluated: wholeFiles, omitted: found.length - wholeFiles, partial: wholeFiles < found.length,
      order: "oldest rotated file first, newest four files",
    }];

    const bySite = new Map<string, EndSpan[]>();
    for (const span of spans) bySite.set(span.site, [...bySite.get(span.site) ?? [], span]);
    const controlTotal = spans.filter((span) => span.durationMs >= SLOW_OPERATION_THRESHOLD_MS).length;
    const observations: HealthDetectorObservation[] = [];
    for (const [site, siteSpans] of [...bySite].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const under = siteSpans.filter((span) => span.durationMs < SLOW_OPERATION_THRESHOLD_MS);
      if (under.length < floodMin) continue;
      const firstSeen = new Date(Math.min(...under.map((span) => span.ts))).toISOString();
      const lastSeen = new Date(Math.max(...under.map((span) => span.ts))).toISOString();
      const fingerprint = rsiFingerprint(RSI_SLOW_OP_SUBTHRESHOLD_FLOOD, `site:${site}`);
      const evidence: HealthEvidenceReference = {
        type: "telemetry-span", sourceOrder: 0, observedAt: lastSeen,
        detectorId: RSI_SLOW_OP_SUBTHRESHOLD_FLOOD, class: SLOW_OP_SUBTHRESHOLD_FLOOD_CLASS, fingerprint,
        count: under.length, controlTotal, population: spans.length,
        firstSeq: under[0]!.ordinal, lastSeq: under[under.length - 1]!.ordinal, firstSeen, lastSeen,
      };
      const windowSeconds = Math.max(1, Math.ceil((Date.parse(evaluatedAt) - Date.parse(firstSeen)) / 1000));
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
        }, deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: evaluatedAt, maxAgeSeconds: 600 })),
        summary: `Site ${site} logged ${under.length} spans under the ${SLOW_OPERATION_THRESHOLD_MS} ms slow-operation threshold.`,
        threshold: `at least ${floodMin} logged spans at one site with durationMs under ${SLOW_OPERATION_THRESHOLD_MS}`,
        explanation: `${under.length} of ${siteSpans.length} spans at ${site} are under the threshold; control: ${controlTotal} spans at or over it, out of ${spans.length} spans in the log window.`,
        suggestedInspection: `Check whether ${site} records its measurements through a path that applies no slow threshold (recordMeasurement) rather than recordRequest.`,
      });
    }
    return observations;
  }
}

/** Read the newest `maxBytes` of a file; `cut` is true when older bytes were left unread. */
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

/** `null`: not a record this source understands (malformed). `"other"`: a well-formed record
 * that is not an `end` span (a diagnostic such as event_loop_gap). */
function parseEndSpan(line: string): Omit<EndSpan, "ordinal"> | "other" | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.phase !== "end") return "other";
  const ts = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
  if (typeof record.site !== "string" || record.site === "" || typeof record.durationMs !== "number"
    || !Number.isFinite(record.durationMs) || !Number.isFinite(ts)) return null;
  return { site: record.site, durationMs: record.durationMs, ts };
}
