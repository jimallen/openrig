import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import { readProjectReadiness, resolveProjectRoot } from "./judgments.js";

export interface ProofSourceWatch {
  close(): void;
  /**
   * "unavailable" and why, when evidence shows a watched path without a live watch, the evidence cannot be read, the
   * watcher failed or the inputs are unreadable. Otherwise "watching", with `verified`: true when the port's evidence
   * shows a live watch on every watched path (Linux), false with a `cause` when the platform gives no evidence at all
   * (darwin: the file watcher's word only; workspaces-o9o.134).
   */
  observation(): ProofSourceObservation;
}
export interface ProofSourceObservation {
  state: "watching" | "unavailable";
  revision: string;
  /** Set only on "watching": whether the claim rests on evidence of the watch, or on the watcher's word. */
  verified?: boolean;
  cause?: string;
}
/** The cause on a "watching" claim the platform gives no evidence for. */
export const UNVERIFIED_WATCH_CAUSE = "no kernel evidence of the watch on this platform: the file watcher's word only";

export function proofSourceObservation(c: { get: (key: never) => unknown }): ProofSourceObservation {
  return (c.get("proofSourceWatch" as never) as ProofSourceWatch | undefined)?.observation() ?? { state: "unavailable", revision: "unverified" };
}

export interface SourceTreeWatch { close(): void }

/** Outbound port: arm file watches and say, from evidence outside the watcher itself, which watched paths have none. */
export interface SourceTreeWatcher {
  /** Arm a watch on `dir`; throws when it cannot be armed at all. */
  watch(dir: string, options: { recursive: boolean }, onChange: (filename: string | null) => void, onError: (err: Error) => void): SourceTreeWatch;
  /**
   * The paths (dir and, when recursive, every entry under it) that hold no live watch; null when this platform gives no
   * evidence. Throws when the evidence cannot be read in full; the claim is then "unavailable" with that cause.
   */
  unwatched(dir: string, recursive: boolean): string[] | null;
}

export interface ProofSourceWatchDeps {
  watcher: SourceTreeWatcher;
  /** Where a change of the claim, and its cause, is reported. */
  log?: (message: string) => void;
  /** How often the evidence is checked again while nothing changes (ms). */
  recheckMs?: number;
}

const RECHECK_MS = 30_000;

/**
 * Push invalidation over the existing bus; existing client quiet refresh is the missed-event repair.
 * workspaces-o9o.38: the claim is "watching" only while the port's evidence shows a live watch on every watched
 * path. That evidence is read after arming, after each burst of changes and every `recheckMs`; a gap turns the
 * claim to "unavailable" with its cause, and only full evidence turns it back.
 */
export function watchProofSources(missionsRoot: string, invalidate: () => void, bus: EventBus, deps: ProofSourceWatchDeps): ProofSourceWatch {
  const { watcher } = deps;
  const log = deps.log ?? (() => {});
  const workspace = path.dirname(missionsRoot);
  let projectRoot = workspace;
  try { projectRoot = resolveProjectRoot(missionsRoot); } catch { /* Legacy roots retain their existing watch boundary. */ }
  // ponytail: bounded local workspaces use a full semantic read after a file burst.
  // Keep this workload measured; subtree indexing is warranted only when that bound is exceeded.
  const basis = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(missionsRoot).missions.map(m => [m.name, m.revision]))).digest("hex");
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* Quiet refresh remains the repair path. */ } };
  const roots: { dir: string; recursive: boolean }[] = [{ dir: workspace, recursive: true }];
  if (projectRoot !== workspace) roots.push({ dir: projectRoot, recursive: false });

  let revision = "unavailable";
  let inputsReadable = false;
  try { revision = basis(); inputsReadable = true; } catch { /* Direct reads name unavailable inputs; watching may recover them. */ }
  /** Why the watch itself cannot be trusted (the watcher failed, or a watched path has no live watch); null when it can. */
  let watchFault: string | null = null;
  /** Whether the port gave evidence at the last read (false on a platform that gives none). */
  let evidenced = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const watches: SourceTreeWatch[] = [];
  const state = (): "watching" | "unavailable" => (!closed && inputsReadable && watchFault === null ? "watching" : "unavailable");

  /** Re-read the inputs and the evidence; invalidate and push when the claim or the revision changed. */
  const settle = () => {
    const before = { state: state(), revision };
    try { revision = basis(); inputsReadable = true; } catch { revision = "unavailable"; inputsReadable = false; }
    // Where the platform gives evidence it decides, a past watcher error included; where it gives none, a watcher error stands.
    const evidence = evidenceFault();
    evidenced = evidence !== undefined;
    if (evidence !== undefined) watchFault = evidence;
    if (state() === "unavailable") revision = "unavailable";
    if (state() !== before.state) log(`[proof-source-watch] ${missionsRoot}: ${state()}${state() === "unavailable" ? ` (${cause() ?? "proof inputs unreadable"})` : ""}`);
    if (state() === before.state && revision === before.revision) return;
    invalidate();
    notify(revision);
  };
  /** A gap in the evidence as a cause; null when every watched path has a live watch; undefined when there is no evidence to read. */
  const evidenceFault = (): string | null | undefined => {
    let any = false;
    for (const root of roots) {
      let missing: string[] | null;
      try { missing = watcher.unwatched(root.dir, root.recursive); } catch (err) {
        return `the watch evidence could not be read: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (missing === null) continue;
      any = true;
      if (missing.length > 0) {
        return `no live watch on ${missing.length} of the watched path(s) under ${root.dir} (inotify watch limit reached?); first: ${missing[0]}`;
      }
    }
    return any ? null : undefined;
  };
  const cause = (): string | undefined => watchFault ?? (inputsReadable ? undefined : "proof inputs unreadable");

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = undefined; settle(); }, 40);
    timer.unref();
  };
  const onError = (err: Error) => {
    if (closed) return;
    const before = state();
    watchFault = `the file watcher failed: ${err.message}`;
    revision = "unavailable";
    if (before !== "unavailable") log(`[proof-source-watch] ${missionsRoot}: unavailable (${watchFault})`);
    invalidate(); notify("unavailable");
  };

  try {
    watches.push(watcher.watch(workspace, { recursive: true }, schedule, onError));
    if (projectRoot !== workspace) {
      watches.push(watcher.watch(projectRoot, { recursive: false }, (filename) => {
        if (filename === null || filename === "project.yaml") schedule();
      }, onError));
    }
  } catch (err) {
    for (const watch of watches) watch.close();
    closed = true;
    const why = `the file watch could not be armed: ${err instanceof Error ? err.message : String(err)}`;
    log(`[proof-source-watch] ${missionsRoot}: unavailable (${why})`);
    invalidate(); notify("unavailable");
    return { close() {}, observation: () => ({ state: "unavailable", revision, cause: why }) };
  }

  const armedEvidence = evidenceFault();
  evidenced = armedEvidence !== undefined;
  watchFault = armedEvidence ?? null;
  if (watchFault !== null) {
    revision = "unavailable";
    log(`[proof-source-watch] ${missionsRoot}: unavailable (${watchFault})`);
    invalidate(); notify("unavailable");
  }
  const recheck = setInterval(settle, deps.recheckMs ?? RECHECK_MS);
  recheck.unref();

  return {
    observation: () => {
      const current = state();
      const why = cause();
      if (current === "watching") return evidenced ? { state: current, revision, verified: true } : { state: current, revision, verified: false, cause: UNVERIFIED_WATCH_CAUSE };
      return why !== undefined ? { state: current, revision, cause: why } : { state: current, revision };
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(recheck);
      for (const watch of watches) watch.close();
    },
  };
}
