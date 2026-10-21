import { closeSync, openSync, readSync } from "node:fs";
import { normaliseSubjectKey } from "./fingerprint.js";

/**
 * Known-fix anchors (`~/.openrig/rsi/known-fixes.json`): a fix that shipped, so that the
 * history before it is not proposed again. The semantics are REGRESSION-ONLY:
 *
 *  - a hit older than the anchor's `deployedAt` is `historical-fixed:<ref>` and is not an
 *    active fingerprint;
 *  - a hit at or after `deployedAt` is active, with class `regression-after:<fixSha>`;
 *  - an anchor dated in the future is refused (it would hide a recurrence that has not
 *    happened yet), and its hits stay active.
 *
 * So an anchor can only hide history, never a recurrence. The file is one bounded read; one
 * that cannot be read or parsed makes its sources `unavailable`, never "no anchors".
 */
export const KNOWN_FIXES_MAX_BYTES = 64 * 1024;

export interface KnownFixAnchor {
  fingerprint: string;
  ref: string;
  fixSha: string;
  /** ISO instant the fix was verified deployed. */
  deployedAt: string;
  /** Optional denominator line, e.g. "Codex launches since deploy: 0". */
  denominator?: string;
}

export interface RefusedAnchor { fingerprint: string; ref: string; reason: "dated-in-the-future" }

export type KnownFixesRead =
  | { status: "available"; anchors: readonly KnownFixAnchor[]; refused: readonly RefusedAnchor[] }
  | { status: "unavailable"; reason: string };

/** What a source learns about one fingerprint from the anchors. */
export interface AnchorVerdict { anchor: KnownFixAnchor | null; deployedAtMs: number | null }

/** Hits of a fingerprint that predate its anchor: reported, never active. */
export interface HistoricalFixedHits { fingerprint: string; label: string; count: number }

function parseAnchors(text: string): KnownFixAnchor[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("known-fixes.json must be a JSON array of anchors");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`anchor ${index} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const key of ["fingerprint", "ref", "fixSha", "deployedAt"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).trim() === "") throw new Error(`anchor ${index} lacks ${key}`);
    }
    if (e.denominator !== undefined && typeof e.denominator !== "string") throw new Error(`anchor ${index} denominator must be a string`);
    if (Number.isNaN(Date.parse(e.deployedAt as string))) throw new Error(`anchor ${index} deployedAt is not a date`);
    return {
      fingerprint: normaliseSubjectKey(e.fingerprint as string),
      ref: e.ref as string, fixSha: e.fixSha as string, deployedAt: e.deployedAt as string,
      ...(e.denominator !== undefined ? { denominator: e.denominator as string } : {}),
    };
  });
}

/** Read at most KNOWN_FIXES_MAX_BYTES; a longer file is unavailable, not truncated. A missing
 * file is "no anchors yet" (the normal state before the first fix ships). */
export function readKnownFixes(path: string, now: Date): KnownFixesRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "available", anchors: [], refused: [] };
    return { status: "unavailable", reason: `known-fixes.json unreadable: ${(error as Error).message}` };
  }
  try {
    const buffer = Buffer.alloc(KNOWN_FIXES_MAX_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > KNOWN_FIXES_MAX_BYTES) return { status: "unavailable", reason: `known-fixes.json exceeds ${KNOWN_FIXES_MAX_BYTES} bytes` };
    const all = parseAnchors(buffer.toString("utf8", 0, bytes));
    const refused: RefusedAnchor[] = [];
    const anchors: KnownFixAnchor[] = [];
    for (const anchor of all) {
      if (Date.parse(anchor.deployedAt) > now.getTime()) refused.push({ fingerprint: anchor.fingerprint, ref: anchor.ref, reason: "dated-in-the-future" });
      else anchors.push(anchor);
    }
    return { status: "available", anchors, refused };
  } catch (error) {
    return { status: "unavailable", reason: `known-fixes.json unparseable: ${(error as Error).message}` };
  } finally {
    closeSync(fd);
  }
}

/** The anchor that governs a fingerprint: the latest non-refused deployment. */
export function anchorFor(read: Extract<KnownFixesRead, { status: "available" }>, fingerprint: string): AnchorVerdict {
  const key = normaliseSubjectKey(fingerprint);
  let best: KnownFixAnchor | null = null;
  for (const anchor of read.anchors) {
    if (anchor.fingerprint === key && (best === null || Date.parse(anchor.deployedAt) > Date.parse(best.deployedAt))) best = anchor;
  }
  return { anchor: best, deployedAtMs: best ? Date.parse(best.deployedAt) : null };
}

/** True when a hit at `hitMs` predates the anchor's deployment. */
export function isHistoricalFixed(verdict: AnchorVerdict, hitMs: number): boolean {
  return verdict.deployedAtMs !== null && hitMs < verdict.deployedAtMs;
}

/** The class of an active finding under a governing anchor. */
export function regressionClass(verdict: AnchorVerdict, ordinaryClass: string): string {
  return verdict.anchor ? `regression-after:${verdict.anchor.fixSha}` : ordinaryClass;
}
