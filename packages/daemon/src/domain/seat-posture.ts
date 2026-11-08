import type { AgentActivity } from "./types.js";
import { latestHookState } from "./agent-activity-store.js";

// OF-267 — what a sender may be told about a seat that has not yet received its message.
//
// A seat in a long foreground tool call records no hook for the whole call. Its newest hook then ages past the store's freshness
// window and reads `unknown / stale_runtime_hook`, which a sender takes for a broken delivery path. The posture reads that same
// newest hook (the retained raw event included) and says what it supports, no more:
//   busy               a FRESH hook says a turn is running.
//   unknown-open-turn  the newest hook is stale, but it is a running-class event and nothing (no Stop) came after it. The seat may be
//                      in a long call, or may have been interrupted or restarted without a Stop: events cannot tell the two apart, so
//                      this is never reported as busy. The line states the facts (last hook, how long ago) instead.
//   idle / needs_input as the store's own helpers read them (a stale Stop still means idle; a stale unanswered prompt still waits).
//   unknown            everything else: no hook, generation-mismatched or unresolvable evidence, an unmapped event.
// Pi records the START of each tool call (PreToolUse) and never its end, and Claude records the end (PostToolUse) and never the
// start, so no runtime's hooks can say "a tool call is running since T". The wording says "last tool started" / "last hook".

/** A timestamp more than this ahead of the reader's clock is not believed (clock skew, not evidence): a hook dated so, or an hc status begun so. */
const FUTURE_SLACK_MS = 60_000;

export type SeatPostureKind = "busy" | "unknown-open-turn" | "idle" | "needs_input" | "unknown";
export type SeatPostureSource = "runtime_hook" | "hc_status";

export interface SeatPosture {
  kind: SeatPostureKind;
  /** The evidence behind `kind`: the seat's newest runtime hook, or (busy only) the hc terminal status. */
  source: SeatPostureSource | null;
  /** When the evidence was observed: the newest hook's eventAt, or for hc_status the time the status began. Null when none. */
  at: string | null;
  /** The newest hook's tool name (Pi PreToolUse), when it has one. */
  tool: string | null;
  /** One human line, already worded for `rig send` and `rig ps`. */
  line: string;
}

/** `HH:MMZ` (UTC), with `MM-DD ` first when `iso` is not on the same UTC day as `nowMs`. Null for an unparseable time. */
export function formatPostureTime(iso: string | null | undefined, nowMs: number): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms).toISOString();
  const time = `${d.slice(11, 16)}Z`;
  return d.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10) ? time : `${d.slice(5, 10)} ${time}`;
}

export function formatPostureAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

function hookLabel(activity: AgentActivity): string {
  return activity.rawEvent === "PreToolUse" && activity.rawSubtype ? `PreToolUse ${activity.rawSubtype}` : (activity.rawEvent ?? "hook");
}

export function deriveSeatPosture(activity: AgentActivity | null | undefined, seatRuntime: string | null, now: Date): SeatPosture {
  if (!activity || activity.evidenceSource !== "runtime_hook" || !activity.rawEvent) {
    return { kind: "unknown", source: null, at: null, tool: null, line: "unknown: no runtime hook recorded" };
  }
  const nowMs = now.getTime();
  const at = activity.eventAt ?? null;
  const when = formatPostureTime(at, nowMs);
  const tool = activity.rawEvent === "PreToolUse" ? (activity.rawSubtype ?? null) : null;
  // The store reads a hook dated ahead of its clock as fresh (a negative age is never past the window), which would make a skewed hook busy
  // for hours. For the posture only, such a hook is not trusted at all (OF-275 tracks the store's own rule).
  const atMs = at ? Date.parse(at) : Number.NaN;
  if (Number.isFinite(atMs) && atMs > nowMs + FUTURE_SLACK_MS) {
    return { source: "runtime_hook", at, tool, kind: "unknown", line: `unknown: last hook ${hookLabel(activity)} is dated ${when ?? "in the future"}, ahead of the clock` };
  }
  const state = latestHookState(activity, seatRuntime);
  const fresh = activity.stale !== true;
  const base = { source: "runtime_hook" as const, at, tool };
  if (state === "needs_input") {
    // OF-278: an AskUserQuestion dialog is a question to the human, not a permission prompt (Claude reports both as permission_prompt).
    const what = activity.dialog === "question" ? "waiting on a question to the human" : `needs input: ${activity.rawSubtype ?? activity.rawEvent}`;
    return { ...base, kind: "needs_input", line: `${what}${when ? ` since ${when}` : ""}` };
  }
  if (state === "idle") {
    return { ...base, kind: "idle", line: `idle: last hook ${hookLabel(activity)}${when ? ` ${when}` : ""}` };
  }
  if (state === "running") {
    if (fresh) {
      return { ...base, kind: "busy", line: tool
        ? `busy: last tool started ${when ?? "at an unknown time"} (${tool})`
        : `busy: turn running, last hook ${hookLabel(activity)}${when ? ` ${when}` : ""}` };
    }
    const atMs = at ? Date.parse(at) : NaN;
    const age = Number.isFinite(atMs) ? ` (${formatPostureAge(nowMs - atMs)} ago)` : "";
    return { ...base, kind: "unknown-open-turn", line: `unknown: last hook ${hookLabel(activity)}${when ? ` ${when}` : ""}${age}, no Stop since` };
  }
  return { ...base, kind: "unknown", line: `unknown: ${activity.reason || "no usable runtime hook"}` };
}

// OF-267 (B) — a Pi seat's runner tells herdr-core what it is doing (OSC 7501: `working` at agent_start / tool start, `idle` at
// agent_end; adapters/runner-hc-status.ts), and says nothing in between. So the core's terminal status, unlike the hook store,
// does not go stale during a silent tool call. Measured on a private core (test/seat-hc-status.real.test.ts): `working` at every poll
// through the call, `status_ms` unmoving, `status_ms` the epoch time the status began (the start of the run; later tool starts in the
// run do not move it), and a dead runner leaves a `finished` terminal, never a live one reading `working`.
// It refines only what the hooks could not settle (unknown-open-turn) and only for runtimes whose status OpenRig itself writes.
// Claude and Codex seats get the hook posture alone.

/** The slice of an hc terminal the posture reads. `sinceMs` is hc's `status_ms`: when the current status began, epoch ms. */
export interface SeatTerminalStatus {
  live: boolean;
  status: string | null;
  sinceMs: number | null;
}

/** Reads a seat's terminal status. Resolves null when it cannot say (no core, no such terminal, a timeout): the caller keeps its answer. */
export type SeatTerminalStatusReader = (sessionName: string) => Promise<SeatTerminalStatus | null>;

/** Runtimes whose runner writes OSC 7501 itself, so a `working` read means the runner has an open run. */
export const OPENRIG_WRITES_HC_STATUS: ReadonlySet<string> = new Set(["pi"]);

export function withTerminalStatus(posture: SeatPosture, status: SeatTerminalStatus | null | undefined, now: Date): SeatPosture {
  if (posture.kind !== "unknown-open-turn" || !status || !status.live || status.status !== "working") return posture;
  const since = status.sinceMs;
  if (since === null || !Number.isFinite(since) || since > now.getTime() + FUTURE_SLACK_MS) return posture;
  const at = new Date(since).toISOString();
  return { kind: "busy", source: "hc_status", at, tool: null, line: `busy: working since ${formatPostureTime(at, now.getTime())} (hc status)` };
}

/** `posture`, refined by the seat's terminal status when the hooks left an open turn and the runtime's status is OpenRig's own.
 *  Any failure of the read leaves `posture` exactly as it was. */
export async function refineSeatPosture(
  posture: SeatPosture, seatRuntime: string | null, sessionName: string, reader: SeatTerminalStatusReader | undefined, now: Date,
): Promise<SeatPosture> {
  if (!reader || posture.kind !== "unknown-open-turn" || seatRuntime === null || !OPENRIG_WRITES_HC_STATUS.has(seatRuntime)) return posture;
  try {
    return withTerminalStatus(posture, await reader(sessionName), now);
  } catch {
    return posture;
  }
}
