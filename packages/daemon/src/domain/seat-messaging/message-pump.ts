import { messageId, type GateLookup, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "./ports.js";
import type { MessageAcceptInput, MessageOutcome, MessageStore, StoredMessage } from "./message-store.js";
import type { HeldMessages, SeatDirectory, SeatMessagingPorts, SenderReturn } from "./pump-ports.js";

/**
 * The pump (census-delivery-guarantees-20261101, part 2): the one retry owner. One timer; per seat, only the oldest open message, one
 * attempt at a time; every decision read from the row, so a restart resumes where the database says. An attempt is free because the
 * gate drops a repeat, so nothing here works out what happened to a send, and nothing here ever needs a person: a row leaves only on a
 * gate record, or when its seat is gone for good (Jim's decision 1).
 *
 * The values are the design's, to be tuned on M7.
 */
/** On a held message that outlived the occupant it was for (Jim's decision): the new occupant is told it was not written to them. */
export const PREVIOUS_OCCUPANT_LABEL = "[sent to the previous occupant of this seat]";
export const PUMP_TICK_MS = 5_000;
/** How soon a paused seat is looked at again. A pause is not an attempt, so it spends no backoff. */
export const PUMP_PAUSE_RECHECK_MS = 15_000;
/** After the first attempt (at once), then after each further one, capped at the last. */
export const ATTEMPT_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
/** How often a waiter reads its row. */
const AWAIT_POLL_MS = 100;

export interface MessagePumpTiming { tickMs: number; pauseRecheckMs: number; backoffMs: readonly number[] }

export interface MessagePumpDeps {
  store: MessageStore;
  ports: SeatMessagingPorts;
  directory: SeatDirectory;
  held: HeldMessages;
  senders: SenderReturn;
  clock?: () => number;
  timing?: Partial<MessagePumpTiming>;
  log?: (line: string) => void;
}

/** The wait after `attemptsMade` attempts. */
export function nextAttemptDelayMs(attemptsMade: number, backoffMs: readonly number[] = ATTEMPT_BACKOFF_MS): number {
  return backoffMs[Math.min(attemptsMade, backoffMs.length) - 1]!;
}

type Visit = "next" | "stop";

export class MessagePump {
  private readonly timing: MessagePumpTiming;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  /** Seats with a pass running. It guards this process only: across a restart, the row's committed next time does the same job. */
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: MessagePumpDeps) {
    this.timing = { tickMs: PUMP_TICK_MS, pauseRecheckMs: PUMP_PAUSE_RECHECK_MS, backoffMs: ATTEMPT_BACKOFF_MS, ...deps.timing };
    this.clock = deps.clock ?? Date.now;
    this.log = deps.log ?? ((line) => console.warn(`[message-pump] ${line}`));
  }

  /** At boot: a pass at once, then the one timer. It does not keep the process alive. */
  start(): void {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.timing.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Commits the message (invariant 1) and starts a pass, so a first attempt does not wait for the timer. Idempotent on the id. */
  accept(input: MessageAcceptInput & { freezeBody?: boolean }): MessageId {
    const accepted = this.deps.store.accept(input);
    void this.tick();
    return messageId(accepted.id);
  }

  /** Waits up to `waitMs` for the message to end, then says where it stands. `open` is not a failure: the pump goes on. */
  async awaitReceived(id: MessageId, waitMs: number): Promise<MessageOutcome> {
    const deadline = this.clock() + waitMs;
    for (;;) {
      const outcome = this.deps.store.outcomeOf(id);
      if (outcome !== "open" || this.clock() >= deadline) return outcome;
      await new Promise((resolve) => setTimeout(resolve, Math.min(AWAIT_POLL_MS, Math.max(deadline - this.clock(), 1))));
    }
  }

  /** Ends a row nobody should still deliver. False when it was not open. */
  cancel(id: MessageId, reason: string): boolean {
    return this.deps.store.cancel(id, reason, new Date(this.clock()).toISOString());
  }

  /** One pass. A seat whose last pass is still running is skipped, so one slow hop holds up only its own seat. */
  async tick(): Promise<void> {
    try {
      this.rejoinHeld();
      const seats = this.deps.store.seatsWithOpenMessages().filter((seat) => !this.inFlight.has(seat));
      await Promise.all(seats.map((seat) => this.driveSeat(seat)));
    } catch (error) {
      if (!this.deps.store.isOpen) { this.stop(); return; }  // the daemon closed its database: nothing here can run again
      this.log(`pass failed: ${(error as Error).message}`);
    }
  }

  /** No message stays held waiting for a person: it leaves the guard when the guard lifts, and at once when its seat is gone for good.
   *  A seat with no gate keeps its held rows while it lives, as it keeps everything else. */
  private rejoinHeld(): void {
    const at = new Date(this.clock()).toISOString();
    for (const held of this.deps.store.listHeld()) {
      const gone = this.deps.directory.fate(held.seat).kind === "gone";
      if (gone) { this.deps.store.adoptHeld(held.id, at, null); continue; }
      if (!this.deps.ports.gateFor(held.seat)) continue;
      const status = this.deps.held.status(held.binding, held.seat);
      if (status === "occupant_changed") this.deps.store.adoptHeld(held.id, at, held.binding?.occupant ?? "unknown");
      else if (status === "lifted") this.deps.store.adoptHeld(held.id, at, null);
    }
  }

  private async driveSeat(seat: string): Promise<void> {
    this.inFlight.add(seat);
    try {
      for (;;) {
        const head = this.stopped ? null : this.deps.store.headOf(seat);
        if (!head || await this.visit(head) === "stop") return;
      }
    } catch (error) {
      this.log(`seat ${seat}: ${(error as Error).message}`);
    } finally {
      this.inFlight.delete(seat);
    }
  }

  private async visit(message: StoredMessage): Promise<Visit> {
    const gate = this.deps.ports.gateFor(message.seat);
    if (!gate) {
      // A row the pump took whose seat has no gate now: the seat's record went with its rig (decision 1). Any other row on a gateless seat is
      // not the pump's, in any fate: nothing here can know what reached it. It stays as it is, and shows on health.
      const fate = message.pumpOwned ? this.deps.directory.fate(message.seat) : null;
      return fate?.kind === "gone" ? this.end(message, fate.reason) : "stop";
    }
    const lookup = await this.readGate(gate, message);
    // First, ahead of the seat's fate: a record means the message arrived, whatever became of the seat since.
    if (lookup.kind === "seen") {
      if (!this.deps.store.recordReceived(lookup.record, gate.version)) return "stop";
      if (message.attempts > 1) await this.tidyAfterReceived(message);
      return "next";
    }
    const fate = this.deps.directory.fate(message.seat);
    const bound = message.occupantGeneration;
    // Lifecycle text stays with the occupant it was for: a held copy goes back to its sender, never on to the new occupant.
    if (message.messageClass === "lifecycle" && message.previousOccupant !== null) {
      return this.end(message, `occupant ${message.previousOccupant} of ${message.seat} has ended`);
    }
    if (bound !== null) {
      const changed = fate.kind === "successor" || fate.kind === "gone" || (fate.kind === "live" && fate.occupantGeneration !== null && fate.occupantGeneration !== bound);
      if (fate.kind === "live" && fate.occupantGeneration === null) return "stop";
      if (changed && message.messageClass === "lifecycle") return this.end(message, `occupant ${bound} of ${message.seat} has ended`);
      // Only lifecycle text stays with its occupant (Jim's rule): the rest goes on, labelled.
      if (changed && fate.kind !== "gone") return this.deps.store.rebindToNewOccupant(message.id, bound) ? "next" : "stop";
    }
    if (fate.kind === "successor") return this.deps.store.moveToSuccessor(message.id, fate.seat) ? "next" : "stop";
    if (fate.kind === "gone") return this.end(message, fate.reason);
    if (lookup.kind === "unavailable") {
      this.deps.store.recordGateUnavailable(message.id, this.clock() + this.timing.pauseRecheckMs);
      return "stop";
    }
    return this.attempt(message);
  }

  /** Anything but a record of this very id proves nothing, so it never moves a row. */
  private async readGate(gate: SeatGate, message: StoredMessage): Promise<GateLookup> {
    let lookup: GateLookup;
    try {
      lookup = await gate.lookup(message.seat, message.id);
    } catch (error) {
      return { kind: "unavailable", cause: (error as Error).message };
    }
    if (lookup.kind === "seen" && lookup.record.id !== message.id) return { kind: "unavailable", cause: `the gate answered with a record of ${lookup.record.id}` };
    // A marker with another nonce is forged: the real message has not arrived.
    if (lookup.kind === "seen" && lookup.record.nonce !== null && lookup.record.nonce !== this.deps.store.nonceOf(message.id)) return { kind: "not_seen" };
    return lookup;
  }

  private async attempt(message: StoredMessage): Promise<Visit> {
    const hop = this.deps.ports.hopFor(message.seat);
    if (!hop) return "stop";
    const now = this.clock();
    if (message.nextAttemptAtMs !== null && now < message.nextAttemptAtMs) return "stop";
    if (!this.deps.store.claimAttempt(message, now + nextAttemptDelayMs(message.attempts + 1, this.timing.backoffMs))) return "stop";
    let result: LastHopResult;
    try {
      result = await hop.attempt(this.seatMessage(message));
    } catch (error) {
      result = { kind: "refused", reason: `the hop threw: ${(error as Error).message}` };
    }
    if (result.kind === "sent") this.deps.store.recordSent(message.id);
    else if (result.kind === "refused") this.deps.store.recordRefusal(message.id, result.reason);
    else this.deps.store.recordHopPause(message.id, result.reason, this.clock() + this.timing.pauseRecheckMs);
    return "stop";
  }

  private seatMessage(message: StoredMessage): SeatMessage {
    return {
      ids: [message.id], seat: message.seat, body: message.previousOccupant === null ? message.body : `${PREVIOUS_OCCUPANT_LABEL} ${message.body}`,
      occupantGeneration: message.occupantGeneration, messageClass: message.messageClass, lane: message.lane,
    };
  }

  private async tidyAfterReceived(message: StoredMessage): Promise<void> {
    try {
      await this.deps.ports.hopFor(message.seat)?.afterReceived?.(this.seatMessage(message));
    } catch (error) {
      this.log(`message ${message.id}: tidying the seat after it arrived failed: ${(error as Error).message}`);
    }
  }

  private async end(message: StoredMessage, reason: string): Promise<Visit> {
    let returned;
    try {
      returned = await this.deps.senders.returnToSender(message, reason);
    } catch (error) {
      this.log(`message ${message.id} could not go back to ${message.sender} now: ${(error as Error).message}`);
      return "stop";
    }
    const at = new Date(this.clock()).toISOString();
    const closed = returned.kind === "returned"
      ? this.deps.store.recordUndeliverable(message.id, reason, returned.qitemId, at)
      : this.deps.store.recordUndeliverable(message.id, `${reason}; not returned: ${returned.reason}`, null, at);
    return closed ? "next" : "stop";
  }
}
