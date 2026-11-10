// OF-286: tell a rig's Chief of Staff when a Pi or OMP seat starts looping on model errors, and when it stops. On 2026-11-10 verify-qa and
// verify-sec@eztrack had their model requests cut for hours; the seat read busy, `rig ps` showed nothing, and the CoS found out by reading panes and
// relaunched them (losing their context). This uses the notice path OF-221 built for erased simulators and nothing new: `rigChiefOfStaff` resolves who,
// a queue item from `daemon@kernel` carries it (the same repository, the same deterministic ids), and the item waits in the CoS's queue.
//
// What it sends, per seat (Jim, 2026-11-10):
//   - every time a seat's flag is raised: ONE start item, which wakes the CoS (the default nudge). No rate limit: the first build held a start back for
//     an hour after the last one and so said nothing about verify-qa's 08:24-08:54 loop, right after the CoS had relaunched it.
//   - when the flag is gone while the SAME runner is observed (a turn completed with no model error): ONE recovery item, no wake, for an episode whose
//     start was told. A relaunch is not a recovery: when the runner goes away (its sidecar is not live) or its launch id changes, the episode is
//     dropped and nothing is sent; a loop that starts after the relaunch is a new episode and is announced again.
//   - a start item that could not be filed (the queue write threw, no Chief of Staff yet) is tried again on the next pass while the flag lasts; the
//     reason is logged once per episode. No item when the looping seat IS the Chief of Staff (it cannot read its queue while its model fails).
// Item ids derive from (seat, the episode's first failure), so a daemon restart inside an episode files the same item again, which the queue absorbs
// (no second row, no second wake), and two episodes of one seat never share an id. The recovery's id differs from its start's. State is in memory: a
// recovery that happens while the daemon is down is not sent.
import { createHash } from "node:crypto";
import { shellWord } from "./active-occupant.js";
import { MODEL_ERROR_LOOP_THRESHOLD, MODEL_ERROR_LOOP_WINDOW_MS } from "./model-error-loop-rule.js";
import { rigChiefOfStaff, type TopologyDb } from "./rig-chief-of-staff.js";
import type { QueueCreateInput } from "./queue-repository.js";
import type { PublishedModelErrorLoop } from "./seat-model-error-loop.js";
import type { NodeInventoryEntry } from "./types.js";

export const MODEL_ERROR_LOOP_NOTICE_SOURCE = "daemon@kernel";
export const MODEL_ERROR_LOOP_NOTICE_INTERVAL_MS = 30_000;

export interface ModelErrorLoopNoticeDeps {
  db: TopologyDb;
  queue: { create(input: QueueCreateInput): Promise<unknown> };
  /** Every seat of every live rig (the node inventory). */
  inventory(): readonly NodeInventoryEntry[];
  /** The runner's flag for a seat: `observed` is false when its sidecar is no answer (not live, not ready), which is neither looping nor recovered. */
  read(runtime: "pi" | "omp", sessionName: string): { observed: boolean; loop: PublishedModelErrorLoop | null; launchId?: string };
  now?: () => Date;
  log?: (line: string) => void;
  intervalMs?: number;
}

/** The flag of one runner launch, from its first failure. `told`: the start item is filed. `logged`: why it was not has been logged. */
interface Episode { since: string; launchId: string | null; told: boolean; logged: boolean }

export function modelLoopNoticeId(kind: "looping" | "recovered", sessionName: string, since: string): string {
  return `qitem-modelloop-${kind === "looping" ? "" : "ok-"}${createHash("sha256").update(`${kind}|${sessionName}|${since}`).digest("hex").slice(0, 24)}`;
}

export function modelLoopStartBody(seat: string, sessionName: string, loop: PublishedModelErrorLoop): string {
  return [
    `${seat} is looping on model errors: ${loop.total} failed model requests since ${loop.since} (at least ${MODEL_ERROR_LOOP_THRESHOLD} within ${MODEL_ERROR_LOOP_WINDOW_MS / 60_000} minutes), the latest at ${loop.lastAt}: "${loop.lastError}".`,
    loop.gaveUpAt ? `Its runtime gave up at ${loop.gaveUpAt}: the turn ended on the error and the seat is idle with its task undone.` : "It reads busy while its runtime retries, and steps may succeed between the failures.",
    "The cut is between the runtime and the model provider, not in OpenRig. A relaunch loses the seat's context and starts the same request again, so try the cheaper things first.",
    `Look: rig capture ${shellWord(sessionName)}   (rig ps --nodes shows the seat in ATTN with this reason; rig health names it too).`,
    "If it keeps failing, end the turn and re-send a smaller step rather than relaunching. OpenRig sends one more item when the seat's flag clears after a clean turn; a relaunch sends none, and a loop that starts after one is announced again.",
  ].join("\n");
}

export function modelLoopRecoveredBody(seat: string, sessionName: string, since: string): string {
  return [
    `${seat} is no longer flagged as looping on model errors (flagged since ${since}).`,
    "Its runner reports no flag now: a turn completed with no model error in it. Nothing is needed unless it loops again.",
    `Check: rig ps --nodes (session ${sessionName}).`,
  ].join("\n");
}

export class SeatModelErrorLoopNotifier {
  private readonly episodes = new Map<string, Episode>();
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ModelErrorLoopNoticeDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? MODEL_ERROR_LOOP_NOTICE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the live Pi and OMP seats. Never throws; one pass at a time. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = new Set<string>();
      for (const entry of this.deps.inventory()) {
        if ((entry.runtime !== "pi" && entry.runtime !== "omp") || entry.storedSessionStatus !== "running" || !entry.canonicalSessionName) continue;
        const session = entry.canonicalSessionName;
        live.add(session);
        let read: { observed: boolean; loop: PublishedModelErrorLoop | null; launchId?: string };
        try { read = this.deps.read(entry.runtime, session); } catch { continue; }
        // No live runner: it is going away or being relaunched, which is not a recovery. The episode ends here without an item.
        if (!read.observed) { this.episodes.delete(session); continue; }
        const launchId = read.launchId ?? null;
        let episode = this.episodes.get(session);
        // Another launch of the seat: whatever the last runner flagged is not this one's.
        if (episode && episode.launchId !== launchId) { this.episodes.delete(session); episode = undefined; }
        if (read.loop) {
          // A flag with another first failure than the one told is a new episode (the clear and the new loop fell between two passes).
          if (!episode || episode.since !== read.loop.since) {
            episode = { since: read.loop.since, launchId, told: false, logged: false };
            this.episodes.set(session, episode);
          }
          if (!episode.told) await this.started(entry, session, read.loop, episode);
        } else if (episode) {
          this.episodes.delete(session);
          if (episode.told) await this.recovered(entry, session, episode.since);
        }
      }
      for (const session of [...this.episodes.keys()]) if (!live.has(session)) this.episodes.delete(session); // a stopped seat is neither looping nor recovered
    } catch (err) {
      this.log(`[model-error-loop] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async started(entry: NodeInventoryEntry, session: string, loop: PublishedModelErrorLoop, episode: Episode): Promise<void> {
    const seat = `${entry.logicalId}@${entry.rigName}`;
    const once = (line: string): void => { if (!episode.logged) { episode.logged = true; this.log(line); } };
    try {
      const cos = rigChiefOfStaff(this.deps.db, entry.rigId);
      if (!cos.ok) { once(`[model-error-loop] no notice for ${session} yet: no Chief of Staff (${cos.reason})`); return; }
      if (cos.session === session) { once(`[model-error-loop] no notice for ${session}: it is the Chief of Staff`); return; }
      await this.deps.queue.create({
        qitemId: modelLoopNoticeId("looping", session, loop.since),
        sourceSession: MODEL_ERROR_LOOP_NOTICE_SOURCE,
        destinationSession: cos.session,
        body: modelLoopStartBody(seat, session, loop),
        tags: ["model-error-loop", `rig:${entry.rigName}`, "state:looping"],
        summary: `${seat} is looping on model errors`,
      });
      episode.told = true;
    } catch (err) {
      this.log(`[model-error-loop] notice for ${session} failed, trying again next pass: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async recovered(entry: NodeInventoryEntry, session: string, since: string): Promise<void> {
    const seat = `${entry.logicalId}@${entry.rigName}`;
    try {
      const cos = rigChiefOfStaff(this.deps.db, entry.rigId);
      if (!cos.ok || cos.session === session) return;
      await this.deps.queue.create({
        qitemId: modelLoopNoticeId("recovered", session, since),
        sourceSession: MODEL_ERROR_LOOP_NOTICE_SOURCE,
        destinationSession: cos.session,
        body: modelLoopRecoveredBody(seat, session, since),
        priority: "routine",
        tags: ["model-error-loop", `rig:${entry.rigName}`, "state:recovered"],
        summary: `${seat} is no longer looping on model errors`,
        nudge: false,
      });
    } catch (err) {
      this.log(`[model-error-loop] recovery notice for ${session} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
