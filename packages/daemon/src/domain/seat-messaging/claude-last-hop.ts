// Seat Messaging, stage S2: how an attempt reaches a Claude seat, and what a retry may do. A decision over what the caller observed,
// with no I/O: the pump (S3) is its first caller. Measured in S0, on Claude 2.1.316:
//   - M1: Claude drops a socket line identical to the one before it, inside a window of 25 to 40 s, before any hook, and a write returns
//     the same either way. So a completed write proves nothing, and only the gate confirms. A retry inside the window would be swallowed
//     with no trace, so it waits.
//   - M3: a multi-line paste shows as `[Pasted text #N +L lines]`, which carries no id, so a staged Claude paste is recognised by the
//     composer and the line count, never by the marker. A paste is appended to a person's draft, and a blocked paste comes back to the
//     composer. Only `ctrl+c` clears it, only at rest, and only when the composer holds exactly that text. `esc esc` on an empty
//     composer opens the rewind picker, so it is never used.
//   - M10: a slash command on the socket is text, so a command goes by paste and carries no marker.

export const CLAUDE_SOCKET_REPEAT_WINDOW_MS = 40_000;
const PLACEHOLDER = /^\[Pasted text #\d+(?: \+(\d+) lines)?\]$/;

export type ClaudeRetryStep =
  | { readonly kind: "socket" }
  /** Not before `notBefore`, an instant in ms: an earlier identical write would vanish. */
  | { readonly kind: "wait"; readonly notBefore: number }
  | { readonly kind: "paste" }
  /** The message is staged and unsubmitted: Enter alone. */
  | { readonly kind: "enter_only" }
  /** A blocked copy sits in the composer. */
  | { readonly kind: "clear_composer"; readonly key: "ctrl+c" }
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
}

function holdsThisMessage(composer: string, text: string): boolean {
  const placeholder = PLACEHOLDER.exec(composer);
  if (!placeholder) return composer === text;
  return placeholder[1] !== undefined && Number(placeholder[1]) === text.split("\n").length;
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
  if (!holdsThisMessage(composer, input.text.trim())) return { kind: "paused", reason: "guard_held" };
  return input.gateSeen ? { kind: "clear_composer", key: "ctrl+c" } : { kind: "enter_only" };
}
