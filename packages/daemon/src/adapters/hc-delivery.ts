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
 * `delivery_outcome_unknown` therefore means VERIFY, never resend. This module is the one place that decides. It reads
 * the terminal before the send (state, status, turn, and the core's start time), sends, and on silence reads again and
 * settles by evidence in this order: a token already or now on the screen, the turn advanced, then proof that the text
 * never reached the program. Silence the evidence does not settle is `waiting`: the send may still be the core's, or may
 * have landed, and nobody resends. The `pending` record it returns is everything a later check needs, so a daemon
 * restart loses nothing.
 *
 * A core restart alone is NOT proof that a send is gone. A queued send does not survive a restart, but a send that was
 * delivered and then lost its reply does, and "the core started after the send was issued" is true of both. So the
 * restart only says "gone" when the program also shows it never took the text (`neverReachedProgram`): it reports
 * status, it was at rest before the send, it is at rest now, its turn did not move and the text was not a command a
 * program can run without a turn. Anything else is `waiting`, which
 * the daemon surfaces to a person after a while (hc-unsettled-health): a lost message a person resends costs one nudge, a
 * message delivered twice cannot be taken back.
 */

/** Shorter than the core's own start-up and a connect, so a restart that merely overlaps the send is never read as
 *  proof that the send went to the old core. */
export const CORE_RESTART_MARGIN_MS = 2_000;
/** How much history a token is looked for in. */
export const TOKEN_HISTORY_LINES = 200;

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
}

export type HcNotDelivered =
  | "not_found" | "finished" | "blocked" | "status_mismatch" | "core_unreachable" | "refused" | "guard_refused" | "core_restarted_send_gone";

/** Why a send is `waiting`, for whoever reads it: the core may still hold the text; the core restarted and the text was
 *  either delivered first or lost; or the text is on the screen and nothing started (typed but not submitted, or taken by a
 *  command: not told apart). */
export type HcWaitingCause = "queued_in_core" | "restart_unsettled" | "text_present_no_turn";

export type HcDeliveryOutcome =
  | { state: "delivered"; evidence: "reply" | "already_on_screen" | "turn_advanced" | "token_on_screen"; verified: boolean; started: boolean | null; status: string | null; turn: number | null }
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
    // A token already on the screen is this delivery already made: the idempotent answer, with nothing typed.
    if (options.token && (await this.tokenOnScreen(seat, options.token)) === true) {
      return { state: "delivered", evidence: "already_on_screen", verified: false, started: null, status, turn: pre.facts.terminal.turn ?? null };
    }
    const pending: HcPendingSend = {
      version: 1, seat, address: pre.facts.terminal.address, token: options.token ?? null, sendStartedAtMs: this.now(),
      preTurn: pre.facts.terminal.turn ?? 0, preStatus: status, preReported: pre.facts.terminal.reported === true,
      commandLed: startsLikeCommand(text),
    };
    const sent = await this.submitter.submitText(seat, text, {
      ...(blocked === "allow" ? { force: true } : {}), ...(options.ifStatus ? { ifStatus: options.ifStatus } : {}),
      ...(options.beforeInput ? { beforeInput: options.beforeInput } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (sent.ok) {
      return { state: "delivered", evidence: "reply", verified: sent.started === true, started: sent.started, status: sent.status, turn: sent.turn };
    }
    const refused = definiteRefusal(sent.code, sent.message);
    if (refused) return refused;
    // Silence (or a failure this module cannot classify): the send may be queued. Verify; never resend.
    return this.verify(pending);
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
    const evidence = await this.evidence(pending, terminal);
    if (evidence === "token_without_turn") {
      // The text is on the screen and the program took no turn. Measured (core killed between the paste and the Enter, and
      // again with `hc server restart`): the paste landed, the Enter did not, and the text sits unsubmitted in the input,
      // token and all. A command the program ran and cleared leaves the same record. Neither is "delivered", and a resend
      // would type the text a second time (measured: the composer then held it twice).
      return { state: "waiting", reason: "waiting_on_person", cause: "text_present_no_turn", pending, message: `the text for ${pending.seat} is on its screen, but ${pending.seat} reports no turn started since: it may be typed and never submitted (the Enter lost), or it may have been a command the program ran without a turn. Not told apart. Do not resend: look at the seat (rig capture), press Enter there if the text is waiting in the input, and close this row once it is dealt with.` };
    }
    if (evidence) {
      return { state: "delivered", evidence, verified: false, started: null, status: terminal.status?.state ?? null, turn: terminal.turn ?? null };
    }
    if (coreStartedAtMs !== null && coreStartedAtMs >= pending.sendStartedAtMs + CORE_RESTART_MARGIN_MS && neverReachedProgram(pending, terminal)) {
      // A newer core began after the send was issued, so a send still queued in the old one is gone (spike 1+2, 2.2). That
      // alone does not say the text never landed (it may have been delivered first), so the program has to show it too.
      return { state: "not_delivered", reason: "core_restarted_send_gone", code: "send_gone", message: `the hc core restarted after the send to ${pending.seat} was issued, and ${pending.seat} reports no turn started since: the queued send did not survive the restart. Nothing was delivered, so sending again is safe.` };
    }
    if (coreStartedAtMs !== null && coreStartedAtMs >= pending.sendStartedAtMs + CORE_RESTART_MARGIN_MS) {
      // Restarted, and the program cannot say it never took the text: delivered before the restart, or lost with it. Not told apart.
      return { state: "waiting", reason: "waiting_on_person", cause: "restart_unsettled", pending, message: `the hc core restarted after the send to ${pending.seat} was issued, and the text was either delivered before the restart or lost with it; ${pending.seat} reports nothing that tells which. Do not resend: check the seat (rig capture) and send again only if the text is not there.` };
    }
    return { state: "waiting", reason: "waiting_on_person", cause: "queued_in_core", pending, message: `the text for ${pending.seat} is queued in the hc core and not delivered yet (a person may be typing there). It will arrive; do not resend.` };
  }

  /** The turn advanced, or the token is on the screen. Null: neither, which proves nothing. A token on the screen with no turn
   *  behind it is `token_without_turn`: present, and not shown to have been submitted. */
  private async evidence(pending: HcPendingSend, now: HcTerminal): Promise<"turn_advanced" | "token_on_screen" | "token_without_turn" | null> {
    if (pending.token && (await this.tokenOnScreen(pending.seat, pending.token)) === true) return noTurnSince(pending, now) ? "token_without_turn" : "token_on_screen";
    // The turn counts only for a program that reports status and was not already mid-turn: otherwise it advances for
    // work the send did not start.
    if (pending.preReported && pending.preStatus !== null && pending.preStatus !== "working" && (now.turn ?? 0) > pending.preTurn) return "turn_advanced";
    return null;
  }

  /** True/false when the screen was read, null when it could not be. */
  private async tokenOnScreen(seat: string, token: string): Promise<boolean | null> {
    try {
      const read = await this.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(seat), lines: this.tokenLines });
      return read.text.includes(token);
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

/**
 * The one way, short of a token, to tell a send that never reached the program from one that did and lost its reply: a
 * program that reports status and takes a prompt starts a turn. At rest before the send, at rest now, and the same turn
 * counter, it did not take the text. Needs all three: a program that reports nothing says nothing (null status), one that
 * was working or on a dialog would have changed state for other reasons, and a counter that differs (or went back, as it
 * would if a core forgot it; measured: it survives `hc server restart`) is not a measure of this send. A command-led text is
 * excluded outright: a program runs a slash command with no turn, and on a private core the core's record of that (status,
 * turn, status_ms) was identical to the record of a send that never arrived; only what the program chose to print differed. So
 * for such a text "no turn" is no evidence at all, and it stays `waiting`.
 */
export function neverReachedProgram(pending: HcPendingSend, now: HcTerminal): boolean {
  // A command takes no turn, so for a command-led text "no turn" is what both a lost send and a consumed one look like.
  return !pending.commandLed && noTurnSince(pending, now);
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
