import { ConfigStore } from "./config-store.js";
import { readOpenRigEnv } from "./openrig-compat.js";

/**
 * The seat identity a CLI dispatch is attributed to — the SAME value the
 * DaemonClient stamps as `X-OpenRig-Session` (the P18 chokepoint), from which
 * the daemon DERIVES the actor / rendered `From:`. `--from` is deprecated and
 * ignored: origin is the seat env, never a caller-supplied body claim. Returns
 * `undefined` when the seat is unresolvable — the caller then delivers-and-labels
 * with `SENDER_FALLBACK` (never a refusal, never a forged actor).
 */
export function resolveSenderSession(): string | undefined {
  return readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
}

/**
 * The From: label for a send that carries no seat identity (OF-196): the configured `workspace.operator_seat_name` (a send from the
 * operator's own shell), or `undefined` when none is set, which leaves the caller on `SENDER_FALLBACK`. A LABEL only: the actor stays
 * null (`resolveSenderSession()` is still the identity), and nothing is invented when the setting is empty. Receiving seats read
 * `<unknown sender>` as a possible injection and loop on it.
 */
export function resolveOperatorLabel(): string | undefined {
  try {
    const name = new ConfigStore().resolve().workspace.operatorSeatName;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session-less fall-open marker for an unattributable CLI dispatch. P18 (deletion atom) REVERSES A1's
 * seat-boundary refusal: an env-less `rig send`/`broadcast` now DELIVERS carrying this HONEST label rather
 * than refusing, because the daemon half delivers-and-labels the header-absent write (no downstream 401) —
 * unverified is labelled unknown, never laundered to verified.
 *
 * This is ONE of the TWO named twin definition sites of the literal; the other is the daemon's
 * `pane-envelope.ts::SENDER_FALLBACK` (its byte-identical `wrapPaneEnvelope` twin). Both `send.ts`
 * (`wrapSendBody`) and `broadcast.ts` (the enveloped-fan-out marker) IMPORT this single CLI origin rather
 * than re-declaring it — so the CLI has NO scattered fallbacks. A THIRD literal definition anywhere in src
 * is caught BY NAME by the `send.test.ts` canonicity guard.
 */
export const SENDER_FALLBACK = "<unknown sender>";
