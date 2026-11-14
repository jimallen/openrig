import { setOff } from "../domain/active-occupant.js";
import { createHash } from "node:crypto";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-seat.js";
import type { BlockedPolicy, HcSubmitOptions, HcSubmitResult } from "./hc-input.js";
import type { SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";

/**
 * Delivery to a seat on herdr-core, exactly once.
 *
 * `terminal.send` queues in the core, and a queued send outlives the client that made it (spike 1+2, 2.2: the client was
 * killed at +3 s and the text still arrived at +12 s). It does not outlive a core restart. So a send whose reply never
 * came has three possible fates, and a retry is right for only one of them:
 *
 *   - it will still be delivered (the core is the same and the person is still typing): a retry puts the text in twice;
 *   - it was delivered (the reply was lost): a retry puts the text in twice;
 *   - it is gone (the core that held it restarted): a retry is the only way it arrives.
 *
 * `delivery_outcome_unknown` therefore means VERIFY, never resend. This module is the one place that decides, and it decides by
 * the table below and nothing else (`classifyEvidence`). Three rounds of review found a hole in this state machine each time, every
 * one a case the prose rules had not named. So the rule is the converse: the table lists the ONLY evidence that settles a send, and
 * every case not in it reads `waiting`, which the daemon surfaces to a person after a while (hc-unsettled-health). A message a
 * person sends again costs one nudge; a message delivered twice cannot be taken back, and one lost silently cannot be found.
 *
 *   evidence seen (first row that matches)                                                    ->  state
 *   ------------------------------------------------------------------------------------------------------------------------
 *   1. the core's own reply to `terminal.send`                                                ->  delivered (reply)
 *   2. the screen could not be read                                                           ->  waiting   (screen_unreadable)
 *   3. a turn started AND this send's token is on the screen                                  ->  delivered (turn_with_token)
 *   4. this send's token is on the screen, no turn                                            ->  waiting   (text_present_no_turn)
 *   5. a turn started, the token is not on the screen (or the send has no token)              ->  waiting   (turn_without_token)
 *   6. the core restarted after the send, the program is at rest with no turn, the text was not a command, the screen is
 *      byte-identical to its state before the send, AND the program is declared to show a paste on its screen   ->  gone
 *   7. the core restarted after the send, anything else                                       ->  waiting   (restart_unsettled)
 *   8. nothing else                                                                           ->  waiting   (queued_in_core)
 *
 * Why each row is the size it is (all measured on a private core, hc 0.1.15, unless marked):
 *   - Row 3 needs the token. A turn alone is any turn: a person pressing Enter on their own text, a background event. Measured:
 *     a send lost in a restart, then a person's Enter, moved the turn counter with the text never having arrived.
 *   - Row 4: the token on the screen proves the paste, never the Enter. With the Enter lost the text sits typed and unsubmitted,
 *     token included, status idle, turn unchanged. A resend then types it a second time (the composer held it twice).
 *   - Row 3 can still be wrong in one way hc does not let us exclude: the text staged and unsubmitted (token in the INPUT) while a
 *     turn from another source starts. Telling the input from the transcript needs the cursor row, which only an attach stream
 *     gives; not used. Unverified on a real agent.
 *   - Row 5: a turn the token cannot be tied to. Includes every token-free seat: with no token nothing ties a turn to this send.
 *   - Row 6 is `gone`, the one state a retry may follow, so it asks for everything: a screen that did not change is only evidence
 *     if the program would have shown the paste. A program that renders nothing on a paste leaves the same screen whether the paste
 *     arrived or not (a stub measured so), so `pasteEchoes` is declared by the caller and defaults to false. No runtime is declared
 *     yet: whether Claude, Codex and Pi show a paste on the screen is for the real-agent test to measure. Until then `gone` does not
 *     happen in production, and every send lost in a restart waits for a person.
 *     Pi (hc-w37, live-pi-hc-20261101.md 2b-2d): the OpenRig Pi runner's pane editor does show a paste on the screen (measured live,
 *     one case), so the input to the declaration exists; the proof that row 6 is then safe does not. Needed before `pi` is added:
 *     (a) a lost send with `pi` declared, on a real runner seat, reads `gone` only when the text never arrived, and a send delivered
 *     before the restart never does (its screen differs: editor echo, then the runner's mirror line); (b) the runner's screen is
 *     byte-identical across an idle wait (no tick, clock or spinner output), measured, since an unchanged screen is the evidence.
 *     Row 6 also needs the seat to report status, which the Pi and pda runners did not before hc-w37 (`reported` was false, so
 *     "at rest with no turn" could never hold for them); with the runners reporting, (a) is now measurable. Until then: empty.
 *   - A slash command is a turn-less input (measured: the core's record is the same as for a send that never arrived), so it can
 *     never be `gone`, and its token does not tie a turn.
 *   - A restart is not proof by itself: a send delivered before the restart lost its reply, and "the core started after the send"
 *     is true of both.
 *   The pending record is everything a later check needs, so a daemon restart loses nothing.
 */

/** Shorter than the core's own start-up and a connect, so a restart that merely overlaps the send is never read as
 *  proof that the send went to the old core. */
export const CORE_RESTART_MARGIN_MS = 2_000;
/** How much history a token is looked for in. */
export const TOKEN_HISTORY_LINES = 200;

/** Runtimes declared to show a pasted text on their screen (the table, row 6: the only thing that lets an unchanged screen mean "the
 *  text never arrived"). EMPTY on purpose: none has been measured on a real agent yet, so `gone` is unavailable and a send lost in a
 *  restart waits for a person. A runtime is added here only with that measurement behind it. */
export const PASTE_ECHOING_RUNTIMES: ReadonlySet<string> = new Set<string>();

/** What a later check needs to settle a send whose reply never came. Plain JSON; kept in the outbox row. */
export interface HcPendingSend {
  version: 1;
  seat: string;
  /** The terminal's address when the send was issued. A new address is a new terminal. */
  address: string;
  token: string | null;
  /** Wall clock when the send was issued. */
  sendStartedAtMs: number;
  preTurn: number;
  /** `status.state` before the send; null when the program reports none. */
  preStatus: string | null;
  /** Whether the program ever reported a status: without it a turn counter says nothing. */
  preReported: boolean;
  /** The text began like a slash command. A program takes one without starting a turn (measured on a stub: `terminal.get`
   *  is the same afterwards as after a send that never arrived), so "no turn" proves nothing about such a send. Absent on a
   *  record saved before the field existed: read as true, the side that never claims "gone". */
  commandLed: boolean;
  /** sha256 of the screen (and its recent history) read just before the send; null when it could not be read. A screen that is the
   *  same afterwards is the only way, for a seat with no token, to say the text never arrived. Absent on a record saved before the
   *  field existed: read as null, the side that never claims "gone". */
  preScreen: string | null;
  /** The caller declares this program shows a paste on its screen. Without it an unchanged screen proves nothing (a program that
   *  renders nothing on a paste looks the same), so `gone` is not available. Absent on a record saved before the field: false. */
  pasteEchoes: boolean;
}

export type HcNotDelivered =
  | "not_found" | "finished" | "blocked" | "status_mismatch" | "core_unreachable" | "refused" | "guard_refused" | "core_restarted_send_gone";

/** Why a send is `waiting`, for whoever reads it: the core may still hold the text; the core restarted and the text was
 *  either delivered first or lost; or the text is on the screen and nothing started (typed but not submitted, or taken by a
 *  command: not told apart); or the screen could not be read, so whether the text is on it is not known. */
export type HcWaitingCause = "queued_in_core" | "restart_unsettled" | "text_present_no_turn" | "screen_unreadable" | "turn_without_token";

export type HcDeliveryOutcome =
  | { state: "delivered"; evidence: "reply" | "turn_with_token"; verified: boolean; started: boolean | null; status: string | null; turn: number | null }
  /** Nothing was typed, or the send is proved gone. The only state a blind retry is allowed to follow. */
  | { state: "not_delivered"; reason: HcNotDelivered; message: string; code: string }
  /** The core still holds the send and nothing says it was delivered: a person is typing, or the program is slow. Not a failure. */
  | { state: "waiting"; reason: "waiting_on_person"; cause: HcWaitingCause; pending: HcPendingSend; message: string }
  /** The evidence cannot settle it and the core no longer holds it, or cannot be asked. Never resend; the seat or an operator decides. */
  | { state: "unknown"; reason: "seat_ended" | "terminal_replaced" | "core_unreachable"; pending: HcPendingSend; message: string };

/** The only outcome after which sending the same text again cannot double it. */
export function isBlindRetrySafe(outcome: HcDeliveryOutcome): boolean {
  return outcome.state === "not_delivered";
}

/** What `deliver` needs of the input path: HcInput's `submitText`. */
export interface HcSubmitter {
  submitText(target: string, text: string, options?: HcSubmitOptions): Promise<HcSubmitResult>;
}

export interface HcDeliveryOptions {
  /** Wall clock, injectable so a test can put it far from the real one. */
  now?: () => number;
  /** How much history a token is looked for in. */
  tokenLines?: number;
}

export interface HcDeliverOptions {
  /** The program is known to show a paste on its screen (see the table, row 6). Default false: nothing is declared yet. */
  pasteEchoes?: boolean;
  /** A string that appears in the delivered text and nowhere else: found on the screen, it proves a landing. */
  token?: string;
  /** Type even if the program is blocked (a caller that answers a dialog). */
  blocked?: BlockedPolicy;
  /** Only type if the status is exactly this. */
  ifStatus?: "idle" | "working";
  beforeInput?: () => void;
  timeoutMs?: number;
}

interface Facts {
  terminal: HcTerminal;
  coreStartedAtMs: number | null;
}

type Observation =
  | { ok: true; facts: Facts }
  | { ok: false; kind: "absent" | "finished" | "unreachable"; detail: string };

export class HcDelivery {
  private readonly now: () => number;
  private readonly tokenLines: number;

  constructor(private readonly client: HcClient, private readonly submitter: HcSubmitter, options: HcDeliveryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenLines = options.tokenLines ?? TOKEN_HISTORY_LINES;
  }

  async deliver(seat: string, text: string, options: HcDeliverOptions = {}): Promise<HcDeliveryOutcome> {
    const blocked = options.blocked ?? "refuse";
    const pre = await this.observe(seat, false);
    if (!pre.ok) return this.refusal(seat, pre);
    const status = pre.facts.terminal.status?.state ?? null;
    if (blocked === "refuse" && status === "blocked") {
      const kind = pre.facts.terminal.status?.kind ? ` (${pre.facts.terminal.status.kind})` : "";
      return { state: "not_delivered", reason: "blocked", code: "seat_blocked", message: `${seat} is blocked on a dialog${kind}; typing could answer it. Nothing was typed.` };
    }
    if (options.ifStatus && status !== options.ifStatus) {
      return { state: "not_delivered", reason: "status_mismatch", code: "status_mismatch", message: `${seat} is ${status ?? "silent"}, not ${options.ifStatus}. Nothing was typed.` };
    }
    const screen = await this.readScreen(seat);
    const pending: HcPendingSend = {
      version: 1, seat, address: pre.facts.terminal.address, token: options.token ?? null, sendStartedAtMs: this.now(),
      preTurn: pre.facts.terminal.turn ?? 0, preStatus: status, preReported: pre.facts.terminal.reported === true,
      commandLed: startsLikeCommand(text), preScreen: screen === null ? null : hashScreen(screen), pasteEchoes: options.pasteEchoes === true,
    };
    if (options.token) {
      // A token already on the screen means an earlier attempt's paste is there. That is not "delivered": the paste is all the
      // screen shows, and the text may sit typed and unsubmitted (the Enter lost). Nothing is typed again, and nothing is claimed:
      // a person is told. A screen that cannot be read says nothing either, so nothing is typed then too.
      if (screen === null) {
        return { state: "not_delivered", reason: "core_unreachable", code: "transport_unavailable", message: `the screen of ${seat} could not be read to check whether this message is already there; nothing was typed.` };
      }
      if (screen.includes(options.token)) return { state: "waiting", reason: "waiting_on_person", cause: "text_present_no_turn", pending, message: textPresentMessage(seat, true) };
    }
    const sent = await this.submitter.submitText(seat, text, {
      ...(blocked === "allow" ? { force: true } : {}), ...(options.ifStatus ? { ifStatus: options.ifStatus } : {}),
      ...(options.beforeInput ? { beforeInput: options.beforeInput } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (sent.ok) {
      return { state: "delivered", evidence: "reply", verified: sent.started === true, started: sent.started, status: sent.status, turn: sent.turn };
    }
    const refused = definiteRefusal(sent.code, sent.message);
    if (refused) return refused;
    // Silence (or a failure this module cannot classify): the send may be queued. Verify; never resend. One path for a send proved
    // gone: the caller gets `waiting` and the row it leaves is what the sweep, on its own read, marks `send_gone` (a `not_delivered`
    // here would have been recorded as a plain failure, outside the unsettled list that `rig health` reads).
    const verdict = await this.verify(pending);
    if (verdict.state === "not_delivered" && verdict.reason === "core_restarted_send_gone") {
      return { state: "waiting", reason: "waiting_on_person", cause: "restart_unsettled", pending, message: `${verdict.message} It is listed as lost for a person; nothing sends it again.` };
    }
    return verdict;
  }

  /** Settle a send whose reply never came, now or on a later sweep. Reads only; sends nothing. */
  async verify(pending: HcPendingSend): Promise<HcDeliveryOutcome> {
    const post = await this.observe(pending.seat, true);
    if (!post.ok && post.kind === "unreachable") {
      return { state: "unknown", reason: "core_unreachable", pending, message: `the hc core could not be asked about ${pending.seat}; the send may still be delivered. Do not resend.` };
    }
    if (!post.ok) {
      return { state: "unknown", reason: "seat_ended", pending, message: `${pending.seat} is gone (${post.detail}); whether the text landed first is not known. Do not resend.` };
    }
    const { terminal, coreStartedAtMs } = post.facts;
    if (terminal.address !== pending.address) {
      return { state: "unknown", reason: "terminal_replaced", pending, message: `${pending.seat} is a different terminal now (${pending.address} became ${terminal.address}); the old send's fate is not known. Do not resend.` };
    }
    const screen = await this.readScreen(pending.seat);
    const restarted = coreStartedAtMs !== null && coreStartedAtMs >= pending.sendStartedAtMs + CORE_RESTART_MARGIN_MS;
    const verdict = classifyEvidence({
      screenRead: screen !== null,
      tokenOnScreen: screen !== null && pending.token !== null && screen.includes(pending.token),
      turnStarted: turnAdvanced(pending, terminal),
      restarted,
      atRestNoTurn: noTurnSince(pending, terminal),
      commandLed: pending.commandLed,
      screenUnchanged: screen !== null && pending.preScreen !== null && hashScreen(screen) === pending.preScreen,
      pasteEchoes: pending.pasteEchoes,
    });
    if (verdict.state === "delivered") {
      return { state: "delivered", evidence: "turn_with_token", verified: false, started: null, status: terminal.status?.state ?? null, turn: terminal.turn ?? null };
    }
    if (verdict.state === "gone") {
      return { state: "not_delivered", reason: "core_restarted_send_gone", code: "send_gone", message: `the hc core restarted after the send to ${pending.seat} was issued, ${pending.seat} reports no turn started since, and its screen is as it was before the send: the queued send did not survive the restart. Nothing was delivered. It is not sent again for you: send it again by hand.` };
    }
    return { state: "waiting", reason: "waiting_on_person", cause: verdict.cause, pending, message: waitingMessage(verdict.cause, pending.seat) };
  }

  /** The screen and its recent history as one string, or null when it could not be read. */
  private async readScreen(seat: string): Promise<string | null> {
    try {
      const read = await this.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(seat), lines: this.tokenLines });
      return read.text;
    } catch {
      return null;
    }
  }

  private async observe(seat: string, withCore: boolean): Promise<Observation> {
    let terminal: HcTerminal;
    try {
      terminal = await this.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
    } catch (err) {
      if (err instanceof HcError && err.kind === "not_found") return { ok: false, kind: "absent", detail: "not_found" };
      if (err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) return { ok: false, kind: "unreachable", detail: err.message };
      throw err;
    }
    if (terminal.state !== "live") return { ok: false, kind: "finished", detail: terminal.reason ?? terminal.state };
    return { ok: true, facts: { terminal, coreStartedAtMs: withCore ? await this.coreStartedAt() : null } };
  }

  /** When the core now answering started, from its own uptime; null when it cannot say. */
  private async coreStartedAt(): Promise<number | null> {
    try {
      const at = this.now();
      const status = await this.client.call<{ uptime_ms?: number }>("server.status");
      return typeof status.uptime_ms === "number" ? at - status.uptime_ms : null;
    } catch {
      return null;
    }
  }

  private refusal(seat: string, seen: Extract<Observation, { ok: false }>): HcDeliveryOutcome {
    if (seen.kind === "unreachable") {
      return { state: "not_delivered", reason: "core_unreachable", code: "transport_unavailable", message: `the hc core could not be reached about ${seat}; nothing was typed.` };
    }
    return {
      state: "not_delivered", reason: seen.kind === "absent" ? "not_found" : "finished", code: "session_not_found",
      message: `${seat} ${seen.kind === "absent" ? "was not found" : `has finished (${seen.detail})`}; nothing was typed.`,
    };
  }
}

/** Statuses of a program at rest: not mid-turn, not on a dialog, not failed. */
const AT_REST = new Set(["idle", "done"]);

/** Everything verify reads about a send, as facts. The table at the top of this file is `classifyEvidence`. */
export interface HcEvidence {
  /** The screen (with history) was read. */
  screenRead: boolean;
  /** This send's token is on it. False when there is no token, and when the screen was not read. */
  tokenOnScreen: boolean;
  /** The turn counter moved past the send's baseline, for a program that reports status and was not mid-turn at the send. */
  turnStarted: boolean;
  /** The core now answering started more than the margin after the send was issued. */
  restarted: boolean;
  /** Reports status, at rest before and now, same turn. */
  atRestNoTurn: boolean;
  /** The text began like a slash command. */
  commandLed: boolean;
  /** The screen is byte-identical to the one read before the send (false when either was not read). */
  screenUnchanged: boolean;
  /** The caller declared that this program shows a paste on its screen. */
  pasteEchoes: boolean;
}

export type HcVerdict = { state: "delivered" } | { state: "gone" } | { state: "waiting"; cause: HcWaitingCause };

/** The table at the top of this file, row for row. Pure: no read, no clock. Anything not matched by a delivered or gone row waits. */
export function classifyEvidence(e: HcEvidence): HcVerdict {
  if (!e.screenRead) return { state: "waiting", cause: "screen_unreadable" };                                  // row 2
  if (e.turnStarted && e.tokenOnScreen) return { state: "delivered" };                                         // row 3
  if (e.tokenOnScreen) return { state: "waiting", cause: "text_present_no_turn" };                             // row 4
  if (e.turnStarted) return { state: "waiting", cause: "turn_without_token" };                                 // row 5
  if (e.restarted && e.atRestNoTurn && !e.commandLed && e.screenUnchanged && e.pasteEchoes) return { state: "gone" };  // row 6
  if (e.restarted) return { state: "waiting", cause: "restart_unsettled" };                                    // row 7
  return { state: "waiting", cause: "queued_in_core" };                                                         // row 8
}

function waitingMessage(cause: HcWaitingCause, seat: string): string {
  switch (cause) {
    case "screen_unreadable": return `the screen of ${seat} could not be read to look for this message, so whether the text is there is not known. Do not resend: look at the seat (${setOff("rig capture")}) when it can be read, and close this row once it is dealt with.`;
    case "text_present_no_turn": return textPresentMessage(seat, false);
    case "turn_without_token": return `a turn started on ${seat} after this send, but this message's token is not on its screen (or it carries none), so the turn cannot be tied to it: a person may have pressed Enter on their own text, or the message was delivered and has scrolled away. Not told apart. Do not resend: look at the seat (${setOff("rig capture")}), send again only if the text is not there, and close this row once it is dealt with.`;
    case "restart_unsettled": return `the hc core restarted after the send to ${seat} was issued, and the text was either delivered before the restart, typed and unsubmitted, or lost with it; nothing the seat shows tells which. Do not resend: check the seat (${setOff("rig capture")}) and send again only if the text is not there.`;
    case "queued_in_core": return `the text for ${seat} is queued in the hc core and not delivered yet (a person may be typing there). It will arrive; do not resend.`;
  }
}

function hashScreen(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The turn counter moved past the send's baseline, for a program that reports status and was not already mid-turn (otherwise it
 *  advances for work this send did not start). The one evidence that the Enter reached the program. */
function turnAdvanced(pending: HcPendingSend, now: HcTerminal): boolean {
  return pending.preReported && pending.preStatus !== null && pending.preStatus !== "working" && (now.turn ?? 0) > pending.preTurn;
}

function textPresentMessage(seat: string, resend: boolean): string {
  return `${resend ? "this message is already on the screen of " : "the text for "}${seat}${resend ? " from an earlier attempt, and" : " is on its screen, but"} no turn that this send started is shown: it may be typed and never submitted (the Enter lost), the seat may have been busy or reports no status, or it may have been a command run without a turn. Not told apart. Do not resend: look at the seat (${setOff("rig capture")}), press Enter there if the text is waiting in the input, and close this row once it is dealt with.`;
}

/** A program that reports status was at rest before the send, is at rest now, and its turn counter is where it was. */
function noTurnSince(pending: HcPendingSend, now: HcTerminal): boolean {
  // `preStatus` is null for a program that reports none, so a status on both sides is also "reports status".
  return pending.preStatus !== null && AT_REST.has(pending.preStatus)
    && now.status != null && AT_REST.has(now.status.state)
    && (now.turn ?? 0) === pending.preTurn;
}

/** The text begins like a slash command (after any leading blanks). Deliberately only that: the one class this module has
 *  measured as taken with no turn; a `!` shell escape or other prefix is not claimed (unverified, and the sweep still never
 *  resends). */
export function startsLikeCommand(text: string): boolean {
  return /^\s*\//.test(text);
}

/** The refusals after which nothing was typed, by the code HcInput gives them. Anything else is silence. */
function definiteRefusal(code: string, message: string): HcDeliveryOutcome | null {
  const reason = ((): HcNotDelivered | null => {
    switch (code) {
      case "session_not_found": return "not_found";
      case "seat_blocked": return "blocked";
      case "status_mismatch": return "status_mismatch";
      case "transport_unavailable": return "core_unreachable";  // nothing reached the core: HcInput reads only its own pre-write failures this way
      default: break;
    }
    // The delivery guard refuses before it writes (DeliveryGuardError codes).
    if (code.startsWith("guard_") || code === "typing_guard_enabled") return "guard_refused";
    // The core answered with an error of a kind HcInput does not name: it processed nothing.
    if (code === "unknown" && message.startsWith("hc refused: ")) return "refused";
    return null;
  })();
  return reason ? { state: "not_delivered", reason, message, code } : null;
}

/** The pid the native inbox walks up from: an ancestor of the agent, or the agent itself. Under the login-shell launch
 *  it is the shell the agent was typed into, not the agent. Null when the terminal is gone or reports none. */
export async function hcPanePid(client: HcClient, seat: string): Promise<number | null> {
  try {
    const terminal = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
    return terminal.state === "live" && typeof terminal.pid === "number" && terminal.pid > 0 ? terminal.pid : null;
  } catch {
    return null;
  }
}

/** Who is typing decides whether a blocked dialog may be answered: a person in the viewer may, an automatic send may
 *  not. The lease the broker takes for a person says so; no lease, or an automatic one, refuses. */
export function defaultBlockedPolicy(guard: Pick<SeatDeliveryGuard, "leaseOrigin"> | undefined, target: string): BlockedPolicy {
  try {
    return guard?.leaseOrigin(target) === "human" ? "allow" : "refuse";
  } catch {
    return "refuse";
  }
}
