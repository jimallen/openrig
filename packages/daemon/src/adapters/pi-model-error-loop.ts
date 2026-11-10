// OF-286: when is a Pi or OMP seat looping on model errors? The rule, in the words of the incident (verify-qa/verify-sec@eztrack, 2026-11-10):
// the provider cut a request about every 2 minutes for up to an hour, Pi retried each time, and in between some steps succeeded, so the seat read
// busy and no run of "failures in a row" was ever long (Pi's retry budget is 3 and its counter resets on any answer, a tool call included).
//
//   flag    N failed model requests within the window (a failure is an assistant message that ended with stopReason "error"),
//           whether or not something succeeded in between;
//   keep    when the runtime gives up (a turn ends on a model error), the flag stays, with `gaveUpAt`;
//   clear   only when a turn completes with no model error in it (a retry that got through is not a clean turn).
//
// Event order differs by runtime and the rule does not depend on it. Pi: message_end(error) -> agent_end{willRetry:true} -> auto_retry_start ->
// agent_start; the last agent_end has no willRetry and is followed by agent_settled. OMP 18.18.6: message_end(error) (sometimes only turn_end) ->
// auto_retry_start -> agent_end{isTerminal:false} -> continuation; its last agent_end is isTerminal:true. Counting the failed message makes the
// rule independent of auto_retry_start, and `isFinalAgentEnd` is the one definition of "the run is over" for both runtimes.
import { stripVTControlCharacters } from "node:util";
import type { RunnerRuntime, PiModelErrorLoop } from "./pi-runner-protocol.js";
import { PI_MODEL_ERROR_LOOP_THRESHOLD, PI_MODEL_ERROR_LOOP_WINDOW_MS } from "./pi-runner-protocol.js";

/** OMP marks a non-final agent_end with isTerminal:false; Pi with willRetry:true (its retry's own agent_start/agent_end follow). */
export function isFinalAgentEnd(event: Record<string, unknown>, runtime: RunnerRuntime): boolean {
  return event.type === "agent_end" && !((runtime === "omp" && event.isTerminal === false) || (runtime === "pi" && event.willRetry === true));
}

const MAX_ERROR_TEXT = 200;
const MAX_REMEMBERED_FAILURES = 64;

function errorText(candidates: unknown[]): string {
  const text = candidates.map((c) => typeof c === "string"
    ? stripVTControlCharacters(c).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()
    : "").find(Boolean);
  return (text ?? "unknown error").slice(0, MAX_ERROR_TEXT);
}

export class ModelErrorLoopTracker {
  private failures: number[] = [];
  private loop: PiModelErrorLoop | null = null;
  private turnOpen = false;
  private turnErrors = 0;
  /** Assistant messages of the turn that ended in an answer (not an error, not an abort). */
  private turnAnswers = 0;
  /** The latest assistant message of the run ended in an error (nothing answered since). */
  private lastWasError = false;
  /** The failure of the assistant message in hand is already counted: OMP repeats it on turn_end, which must not count twice. */
  private counted = false;

  constructor(private readonly runtime: RunnerRuntime, private readonly now: () => string) {}

  get current(): PiModelErrorLoop | null { return this.loop; }

  /** Feed one runtime event. Returns true when the published flag changed (the runner then rewrites its sidecar). */
  observe(event: Record<string, unknown>): boolean {
    const type = event.type;
    const message = event.message as Record<string, unknown> | undefined;
    if (type === "agent_start" || type === "turn_start") {
      this.counted = false;
      this.openTurn();
      return false;
    }
    if (type === "message_start" && message?.role === "assistant") { this.counted = false; return false; }
    if (message?.role === "assistant" && (type === "message_end" || (type === "turn_end" && this.runtime === "omp"))) {
      if (message.stopReason !== "error") {
        if (type === "message_end") {
          this.lastWasError = false;
          this.counted = false;
          this.openTurn();
          if (message.stopReason !== "aborted") this.turnAnswers++;
        }
        return false;
      }
      if (type === "turn_end" && this.counted) return false;
      this.counted = true;
      return this.fail(errorText([message.errorMessage, message.error, event.error]));
    }
    if (isFinalAgentEnd(event, this.runtime)) return this.endTurn(true);
    if (type === "agent_settled" && this.turnOpen) return this.endTurn(false);
    return false;
  }

  private openTurn(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.turnErrors = 0;
    this.turnAnswers = 0;
  }

  private fail(lastError: string): boolean {
    this.openTurn();
    this.turnErrors++;
    this.lastWasError = true;
    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);
    this.failures = [...this.failures.filter((t) => nowMs - t < PI_MODEL_ERROR_LOOP_WINDOW_MS), nowMs].slice(-MAX_REMEMBERED_FAILURES);
    if (this.loop) {
      const { gaveUpAt: _gone, ...rest } = this.loop;
      this.loop = { ...rest, count: this.failures.length, total: this.loop.total + 1, lastAt: nowIso, lastError };
      return true;
    }
    if (this.failures.length < PI_MODEL_ERROR_LOOP_THRESHOLD) return false;
    this.loop = { count: this.failures.length, total: this.failures.length, since: new Date(this.failures[0]!).toISOString(), lastAt: nowIso, lastError };
    return true;
  }

  private endTurn(final: boolean): boolean {
    const clean = this.turnErrors === 0 && this.turnAnswers > 0;
    const gaveUp = final && this.lastWasError;
    this.turnOpen = false;
    this.counted = false;
    if (!this.loop) return false;
    if (clean) {
      this.loop = null;
      this.failures = [];
      return true;
    }
    if (gaveUp && this.loop.gaveUpAt === undefined) {
      this.loop = { ...this.loop, gaveUpAt: this.now() };
      return true;
    }
    return false;
  }
}
