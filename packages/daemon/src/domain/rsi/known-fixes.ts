import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { normaliseSubjectKey } from "./fingerprint.js";

/**
 * Known-fix anchors (`~/.openrig/rsi/known-fixes.json`): a fix that shipped, so that the
 * history before it is not proposed again. The semantics are REGRESSION-ONLY:
 *
 *  - a hit older than the anchor's `deployedAt` is `historical-fixed:<ref>` and is not an
 *    active fingerprint;
 *  - a hit at or after `deployedAt` is active, with class `regression-after:<fixSha>`;
 *  - an anchor that cannot be trusted is REFUSED, permanently, and its hits stay active
 *    (an anchor can only hide history, never a recurrence).
 *
 * An anchor is refused when:
 *  - it carries no `recordedAt` (the instant the entry was written);
 *  - `deployedAt` or `recordedAt` has no timezone (it would be read in host-local time);
 *  - its subject is `class:other` (the catch-all class: an anchor there hides and relabels
 *    unrelated failures);
 *  - `deployedAt` is after `recordedAt` (a fix cannot have shipped after the entry was written,
 *    so a mistyped future date stays refused after that date passes);
 *  - `recordedAt` is after now.
 * Several accepted anchors for one fingerprint: the LATEST `deployedAt` governs (the file order
 * does not matter; equal dates keep the first listed).
 *
 * The file is one bounded read (64 KB) of a regular file, opened non-blocking. A file that
 * cannot be read, is not a regular file (a FIFO would block the daemon's event loop), or does not
 * parse makes its sources `unavailable`, never "no anchors".
 *
 * WRITE BOUNDARY (accepted risk, Jim's D8): any process running as the daemon's user can write
 * this file, including every seat. `deployedAt` and `recordedAt` are self-asserted, so the
 * checks above catch honest mistakes, not an adversary: a forged pair of dates can still hide up
 * to a window of history. That is the same exposure as the forgeable approvals of D8(a).
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
  /** Optional denominator line, e.g. "Codex launches since deploy: 0". */
  denominator?: string;
}

export type AnchorRefusalReason =
  | "missing-recordedAt" | "no-timezone" | "subject-other" | "deployed-after-recorded" | "recorded-in-the-future";
export interface RefusedAnchor { fingerprint: string; ref: string; reason: AnchorRefusalReason }

export type KnownFixesRead =
  | { status: "available"; anchors: readonly KnownFixAnchor[]; refused: readonly RefusedAnchor[] }
  | { status: "unavailable"; reason: string };

/** What a source learns about one fingerprint from the anchors. */
export interface AnchorVerdict { anchor: KnownFixAnchor | null; deployedAtMs: number | null }

/** Hits of a fingerprint that predate its anchor: reported, never active. */
export interface HistoricalFixedHits { fingerprint: string; label: string; count: number }

// ISO 8601 date-time with a timezone designator: an offset-less time is read in the host's zone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

interface RawAnchor { fingerprint: string; ref: string; fixSha: string; deployedAt: string; recordedAt: string | null; denominator?: string }

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
      fingerprint: normaliseSubjectKey(e.fingerprint as string),
      ref: e.ref as string, fixSha: e.fixSha as string, deployedAt: e.deployedAt as string,
      recordedAt: typeof e.recordedAt === "string" ? e.recordedAt : null,
      ...(e.denominator !== undefined ? { denominator: e.denominator as string } : {}),
    };
  });
}

/** The reason an anchor is refused, or null when it is accepted. */
function refusalFor(anchor: RawAnchor, nowMs: number): AnchorRefusalReason | null {
  if (anchor.recordedAt === null) return "missing-recordedAt";
  if (!ISO_WITH_ZONE.test(anchor.deployedAt) || !ISO_WITH_ZONE.test(anchor.recordedAt)) return "no-timezone";
  if (anchor.fingerprint.endsWith("/class:other")) return "subject-other";
  if (Date.parse(anchor.deployedAt) > Date.parse(anchor.recordedAt)) return "deployed-after-recorded";
  if (Date.parse(anchor.recordedAt) > nowMs) return "recorded-in-the-future";
  return null;
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
      const reason = refusalFor(raw, now.getTime());
      if (reason !== null) refused.push({ fingerprint: raw.fingerprint, ref: raw.ref, reason });
      else anchors.push({ ...raw, recordedAt: raw.recordedAt! });
    }
    return { status: "available", anchors, refused };
  } catch (error) {
    return { status: "unavailable", reason: `known-fixes.json unparseable: ${(error as Error).message}` };
  } finally {
    closeSync(fd);
  }
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
 * refused. `undefined` when no anchor had any effect. Served on the coverage row. */
export function describeAnchorEffects(historical: readonly HistoricalFixedHits[], refused: readonly RefusedAnchor[]): string | undefined {
  const parts = [
    ...historical.map((h) => `${h.label} x${h.count} [${h.fingerprint}]`),
    ...refused.map((r) => `refused anchor ${r.ref} [${r.fingerprint}]: ${r.reason}`),
  ];
  return parts.length > 0 ? parts.join("; ") : undefined;
}
