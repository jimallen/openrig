// Seat Messaging, stage S2: how an attempt reaches a Claude seat, and what a retry may do. A decision over what the caller observed,
// with no I/O: the pump (S3) is its first caller. Measured in S0, on Claude 2.1.316:
//   - M1: Claude drops a socket line identical to the one before it, inside a window of 25 to 40 s, before any hook, and a write returns
//     the same either way. So a completed write proves nothing, and only the gate confirms. A retry inside the window would be swallowed
//     with no trace, so it waits.
//   - M3: a multi-line paste shows as `[Pasted text #N +L lines]`, which carries no id, so a staged multi-line paste is told from a person's
//     only by the row's own record that it was pasted. A paste is appended to a person's draft, and a blocked paste comes back to the
//     composer. Only `ctrl+c` clears it, only at rest, and only when the composer holds exactly that text. `esc esc` on an empty
//     composer opens the rewind picker, so it is never used.
//   - M10: a slash command on the socket is text, so a command goes by paste and carries no marker.

export const CLAUDE_SOCKET_REPEAT_WINDOW_MS = 40_000;
const PLACEHOLDER = /^\[Pasted text #\d+ \+(\d+) lines\]$/;

export type ClaudeRetryStep =
  | { readonly kind: "socket" }
  /** Not before `notBefore`, an instant in ms: an earlier identical write would vanish. */
  | { readonly kind: "wait"; readonly notBefore: number }
  | { readonly kind: "paste" }
  /** The message is staged and unsubmitted: Enter alone. */
  | { readonly kind: "enter_only" }
  /** A blocked copy sits in the composer. */
  | { readonly kind: "clear_composer"; readonly key: "ctrl+c" }
  /** This message's collapsed copy is staged with its Enter lost: clear it and paste again under the same id. */
  | { readonly kind: "clear_and_resend"; readonly key: "ctrl+c" }
  /** The composer holds text that may be a person's. */
  | { readonly kind: "paused"; readonly reason: "guard_held" | "busy" };

export interface ClaudeRetryInput {
  /** The message's text as an attempt would carry it, marker included. */
  readonly text: string;
  readonly socketEligible: boolean;
  readonly nowMs: number;
  /** When the last socket attempt of this message was written; null when there was none. */
  readonly lastSocketAttemptMs: number | null;
  readonly gateSeen: boolean;
  readonly atRest: boolean;
  /** The composer's text, null when it could not be read. */
  readonly composer: string | null;
  /** This message was pasted into an empty composer before: the row's own record. Absent or false: a placeholder is not ours. */
  readonly pastedBefore?: boolean;
}

/** A placeholder shows only a line count, which a person's paste can match, so it is this message only if the row says it pasted into an
 *  empty composer. Enter is never pressed on one: clearing and pasting again sends exactly this text, whatever is really there. */
function collapsedCopy(composer: string, text: string, pastedBefore: boolean): boolean {
  const lines = PLACEHOLDER.exec(composer)?.[1];
  return pastedBefore && lines !== undefined && Number(lines) === text.split("\n").length;
}

export function decideClaudeRetry(input: ClaudeRetryInput): ClaudeRetryStep {
  if (input.socketEligible) {
    const notBefore = (input.lastSocketAttemptMs ?? Number.NEGATIVE_INFINITY) + CLAUDE_SOCKET_REPEAT_WINDOW_MS;
    return input.nowMs < notBefore ? { kind: "wait", notBefore } : { kind: "socket" };
  }
  if (!input.atRest) return { kind: "paused", reason: "busy" };
  if (input.composer === null) return { kind: "paused", reason: "guard_held" };
  const composer = input.composer.trim();
  if (composer === "") return { kind: "paste" };
  const text = input.text.trim();
  if (composer === text) return input.gateSeen ? { kind: "clear_composer", key: "ctrl+c" } : { kind: "enter_only" };
  if (!collapsedCopy(composer, text, input.pastedBefore === true)) return { kind: "paused", reason: "guard_held" };
  return input.gateSeen ? { kind: "clear_composer", key: "ctrl+c" } : { kind: "clear_and_resend", key: "ctrl+c" };
}
