import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { RSI_DETECTORS } from "./detector-ids.js";
import { normaliseSubjectKey } from "./fingerprint.js";

/**
 * Known-fix anchors (`~/.openrig/rsi/known-fixes.json`): a fix that shipped, so that the
 * history before it is not proposed again. The semantics are REGRESSION-ONLY:
 *
 *  - a hit older than the anchor's `deployedAt` is `historical-fixed:<ref>` and is not an
 *    active fingerprint;
 *  - a hit at or after `deployedAt` is active, with class `regression-after:<fixSha>`;
 *  - an anchor that cannot be trusted is REFUSED and its hits stay active (an anchor can only
 *    hide history, never a recurrence).
 *
 * The file is untrusted text: any seat can write it. Its strings reach the coverage `note`, the
 * findings' summary and explanation, and a terminal, so each entry is validated when it is parsed
 * and a bad entry is refused BY INDEX, without echoing any of its text. An anchor is refused when:
 *  - its fingerprint is not a well-formed fingerprint (`bad-fingerprint`), or its detector id is
 *    not an RSI detector (`unknown-detector`);
 *  - its `ref` is not 1-64 characters of [A-Za-z0-9._:#/-] (`bad-ref`), or its `fixSha` is not
 *    7-40 hex digits (`bad-fixSha`);
 *  - it carries no `recordedAt` (the instant the entry was written);
 *  - `deployedAt` or `recordedAt` has no timezone (it would be read in host-local time);
 *  - its subject is `class:other` (the catch-all class: an anchor there hides and relabels
 *    unrelated failures);
 *  - `deployedAt` is after `recordedAt` (a fix cannot have shipped after the entry was written,
 *    so a mistyped future date stays refused after that date passes);
 *  - `recordedAt` is after now.
 * The LAST refusal is TEMPORARY, unlike the others: it is a comparison with the clock on every
 * read, so an entry whose `recordedAt` AND `deployedAt` are both mistyped into the future is
 * refused until that date passes and accepted afterwards. No stateless check can do better;
 * remembering when an entry was first seen would need state this lane does not keep.
 *
 * Several accepted anchors for one fingerprint: the LATEST `deployedAt` governs (the file order
 * does not matter). Two anchors with the same `deployedAt`: the first listed governs.
 *
 * The file is one bounded read (64 KB) of a regular file, opened non-blocking. A file that
 * cannot be read, is not a regular file (a FIFO would block the daemon's event loop), or does not
 * parse makes its sources `unavailable`, never "no anchors". The reason never quotes file text.
 *
 * WRITE BOUNDARY (accepted risk, Jim's D8): any process running as the daemon's user can write
 * this file, including every seat. `deployedAt` and `recordedAt` are self-asserted, so the checks
 * above catch honest mistakes, not an adversary. A forged, self-consistent pair hides history up
 * to its `deployedAt`: for D1 and D2 that is at most their 7-day window, but D3 has no window, so
 * it hides every orphan dated before the forged `deployedAt`, at any age. This is the same
 * exposure as the forgeable approvals of D8(a).
 */
export const KNOWN_FIXES_MAX_BYTES = 64 * 1024;

export interface KnownFixAnchor {
  fingerprint: string;
  ref: string;
  fixSha: string;
  /** ISO instant, with a timezone, the fix was verified deployed. */
  deployedAt: string;
  /** ISO instant, with a timezone, the entry was written. */
  recordedAt: string;
  /** Optional denominator line, e.g. "Codex launches since deploy: 0". Never served. */
  denominator?: string;
}

export type AnchorRefusalReason =
  | "bad-fingerprint" | "unknown-detector" | "bad-ref" | "bad-fixSha"
  | "missing-recordedAt" | "no-timezone" | "subject-other" | "deployed-after-recorded" | "recorded-in-the-future";

/**
 * A refused entry, named by its position in the file. `fingerprint` and `ref` are present only
 * when they passed validation (so they are safe to serve); `detectorId` is the RSI detector the
 * fingerprint names, or null when the entry cannot be attributed to one.
 */
export interface RefusedAnchor {
  index: number;
  detectorId: string | null;
  fingerprint: string | null;
  ref: string | null;
  reason: AnchorRefusalReason;
}

export type KnownFixesRead =
  | { status: "available"; anchors: readonly KnownFixAnchor[]; refused: readonly RefusedAnchor[] }
  | { status: "unavailable"; reason: string };

/** What a source learns about one fingerprint from the anchors. */
export interface AnchorVerdict { anchor: KnownFixAnchor | null; deployedAtMs: number | null }

/** Hits of a fingerprint that predate its anchor: reported, never active. */
export interface HistoricalFixedHits { fingerprint: string; label: string; count: number }

// ISO 8601 date-time with a timezone designator: an offset-less time is read in the host's zone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const FINGERPRINT_SHAPE = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9._:-]+$/;
const FINGERPRINT_MAX = 200;
const REF_SHAPE = /^[A-Za-z0-9._:#/-]{1,64}$/;
const FIX_SHA_SHAPE = /^[0-9a-f]{7,40}$/i;
/** Most parts a served anchor note lists; the rest are counted. */
export const ANCHOR_NOTE_MAX_PARTS = 10;

interface RawAnchor { index: number; fingerprint: string; ref: string; fixSha: string; deployedAt: string; recordedAt: string | null; denominator?: string }

function parseRawAnchors(text: string): RawAnchor[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("known-fixes.json must be a JSON array of anchors");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`anchor ${index} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const key of ["fingerprint", "ref", "fixSha", "deployedAt"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).trim() === "") throw new Error(`anchor ${index} lacks ${key}`);
    }
    if (e.recordedAt !== undefined && typeof e.recordedAt !== "string") throw new Error(`anchor ${index} recordedAt must be a string`);
    if (e.denominator !== undefined && typeof e.denominator !== "string") throw new Error(`anchor ${index} denominator must be a string`);
    if (Number.isNaN(Date.parse(e.deployedAt as string))) throw new Error(`anchor ${index} deployedAt is not a date`);
    if (typeof e.recordedAt === "string" && Number.isNaN(Date.parse(e.recordedAt))) throw new Error(`anchor ${index} recordedAt is not a date`);
    return {
      index, fingerprint: e.fingerprint as string, ref: e.ref as string, fixSha: e.fixSha as string, deployedAt: e.deployedAt as string,
      recordedAt: typeof e.recordedAt === "string" ? e.recordedAt : null,
      ...(e.denominator !== undefined ? { denominator: e.denominator as string } : {}),
    };
  });
}

/** The normalised fingerprint when it is well formed, else null. */
function wellFormedFingerprint(raw: string): string | null {
  if (raw.length > FINGERPRINT_MAX) return null;
  let key: string;
  try { key = normaliseSubjectKey(raw); } catch { return null; }
  return FINGERPRINT_SHAPE.test(key) ? key : null;
}

/** A refusal for an anchor, or null when it is accepted. Validation comes first and quotes nothing. */
function judge(raw: RawAnchor, nowMs: number): { refusal: RefusedAnchor } | { anchor: KnownFixAnchor } {
  const refuse = (reason: AnchorRefusalReason, fingerprint: string | null, detectorId: string | null, ref: string | null): { refusal: RefusedAnchor } =>
    ({ refusal: { index: raw.index, detectorId, fingerprint, ref, reason } });
  const fingerprint = wellFormedFingerprint(raw.fingerprint);
  if (fingerprint === null) return refuse("bad-fingerprint", null, null, null);
  const detectorId = fingerprint.slice(0, fingerprint.indexOf("/"));
  if (!(RSI_DETECTORS as readonly string[]).includes(detectorId)) return refuse("unknown-detector", null, null, null);
  if (!REF_SHAPE.test(raw.ref)) return refuse("bad-ref", fingerprint, detectorId, null);
  if (!FIX_SHA_SHAPE.test(raw.fixSha)) return refuse("bad-fixSha", fingerprint, detectorId, raw.ref);
  const refuseSafe = (reason: AnchorRefusalReason) => refuse(reason, fingerprint, detectorId, raw.ref);
  if (raw.recordedAt === null) return refuseSafe("missing-recordedAt");
  if (!ISO_WITH_ZONE.test(raw.deployedAt) || !ISO_WITH_ZONE.test(raw.recordedAt)) return refuseSafe("no-timezone");
  if (fingerprint.endsWith("/class:other")) return refuseSafe("subject-other");
  if (Date.parse(raw.deployedAt) > Date.parse(raw.recordedAt)) return refuseSafe("deployed-after-recorded");
  if (Date.parse(raw.recordedAt) > nowMs) return refuseSafe("recorded-in-the-future");
  return { anchor: { fingerprint, ref: raw.ref, fixSha: raw.fixSha, deployedAt: raw.deployedAt, recordedAt: raw.recordedAt,
    ...(raw.denominator !== undefined ? { denominator: raw.denominator } : {}) } };
}

/** Read at most KNOWN_FIXES_MAX_BYTES of a regular file; a longer file is unavailable, not
 * truncated. A missing file is "no anchors yet" (the normal state before the first fix ships). */
export function readKnownFixes(path: string, now: Date): KnownFixesRead {
  let fd: number;
  try {
    // Check the type BEFORE opening: opening a FIFO for reading blocks until a writer appears.
    if (!statSync(path).isFile()) return { status: "unavailable", reason: "known-fixes.json is not a regular file" };
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "available", anchors: [], refused: [] };
    return { status: "unavailable", reason: `known-fixes.json unreadable: ${(error as Error).message}` };
  }
  try {
    // The path may have been swapped between the check and the open.
    if (!fstatSync(fd).isFile()) return { status: "unavailable", reason: "known-fixes.json is not a regular file" };
    const buffer = Buffer.alloc(KNOWN_FIXES_MAX_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > KNOWN_FIXES_MAX_BYTES) return { status: "unavailable", reason: `known-fixes.json exceeds ${KNOWN_FIXES_MAX_BYTES} bytes` };
    const all = parseRawAnchors(buffer.toString("utf8", 0, bytes));
    const refused: RefusedAnchor[] = [];
    const anchors: KnownFixAnchor[] = [];
    for (const raw of all) {
      const judged = judge(raw, now.getTime());
      if ("refusal" in judged) refused.push(judged.refusal);
      else anchors.push(judged.anchor);
    }
    return { status: "available", anchors, refused };
  } catch (error) {
    // A JSON syntax error quotes the file's text; never serve it.
    const detail = error instanceof SyntaxError ? "is not valid JSON" : (error as Error).message;
    return { status: "unavailable", reason: `known-fixes.json unparseable: ${detail}` };
  } finally {
    closeSync(fd);
  }
}

/** The refusals a source may list: those naming its own detector, and those that cannot be
 * attributed to any detector (by index only). A bad entry is not amplified onto other sources. */
export function refusalsFor(read: Extract<KnownFixesRead, { status: "available" }>, detectorId: string): RefusedAnchor[] {
  return read.refused.filter((r) => r.detectorId === null || r.detectorId === detectorId);
}

/** The anchor that governs a fingerprint: the accepted anchor with the latest `deployedAt`. */
export function anchorFor(read: Extract<KnownFixesRead, { status: "available" }>, fingerprint: string): AnchorVerdict {
  const key = normaliseSubjectKey(fingerprint);
  let best: KnownFixAnchor | null = null;
  for (const anchor of read.anchors) {
    if (anchor.fingerprint === key && (best === null || Date.parse(anchor.deployedAt) > Date.parse(best.deployedAt))) best = anchor;
  }
  return { anchor: best, deployedAtMs: best ? Date.parse(best.deployedAt) : null };
}

/** True when a hit at `hitMs` predates the anchor's deployment. A hit whose instant is unknown
 * (`null`) is never historical. */
export function isHistoricalFixed(verdict: AnchorVerdict, hitMs: number | null): boolean {
  return verdict.deployedAtMs !== null && hitMs !== null && hitMs < verdict.deployedAtMs;
}

/** The class of an active finding under a governing anchor. */
export function regressionClass(verdict: AnchorVerdict, ordinaryClass: string): string {
  return verdict.anchor ? `regression-after:${verdict.anchor.fixSha}` : ordinaryClass;
}

/** The anchor effects of one read as text: what history was hidden, and which anchors were
 * refused. At most ANCHOR_NOTE_MAX_PARTS parts, then a count. `undefined` when no anchor had any
 * effect. Served on the coverage row; every interpolated value passed validation at parse. */
export function describeAnchorEffects(historical: readonly HistoricalFixedHits[], refused: readonly RefusedAnchor[]): string | undefined {
  const parts = [
    ...historical.map((h) => `${h.label} x${h.count} [${h.fingerprint}]`),
    ...refused.map((r) => `refused anchor #${r.index}${r.ref !== null ? ` ${r.ref}` : ""}${r.fingerprint !== null ? ` [${r.fingerprint}]` : ""}: ${r.reason}`),
  ];
  if (parts.length === 0) return undefined;
  const shown = parts.slice(0, ANCHOR_NOTE_MAX_PARTS);
  if (parts.length > shown.length) shown.push(`and ${parts.length - shown.length} more`);
  return shown.join("; ");
}
