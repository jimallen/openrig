import { partId } from "./long-message.js";
import { PREVIOUS_OCCUPANT_LABEL } from "./message-label.js";
import { messageId, type GateLookup, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "./ports.js";
import { MESSAGE_LANES, type MessageAcceptInput, type MessageOutcome, type MessageStore, type StoredMessage } from "./message-store.js";
import type { HeldMessages, MessageObligations, SeatDirectory, SeatMessagingPorts, SenderReturn } from "./pump-ports.js";

/**
 * The pump (census-delivery-guarantees-20261101, part 2): the one retry owner. One timer; per seat, only the oldest open message, one
 * attempt at a time; every decision read from the row, so a restart resumes where the database says. An attempt is free because the
 * gate drops a repeat, so nothing here works out what happened to a send, and nothing here ever needs a person: a row leaves only on a
 * gate record, or when its seat is gone for good (Jim's decision 1).
 *
 * The values are the design's, to be tuned on M7.
 */
export { PREVIOUS_OCCUPANT_LABEL };
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
  /** Absent: every message is wanted until a gate records it. */
  obligations?: MessageObligations;
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
  /** Seats with a pass running, and how it ends. It guards this process only: across a restart, the row's committed next time does the same job. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Seats whose content lane is held, and by how many. In memory by design: see `MessageHandOff.holdContentLane`. */
  private readonly contentLaneHolds = new Map<string, number>();
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
    void this.ask();
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

  /** Lane 2 waits on `seat` until the returned function is called. Calling it again changes nothing. */
  holdContentLane(seat: string): () => void {
    this.contentLaneHolds.set(seat, (this.contentLaneHolds.get(seat) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.contentLaneHolds.get(seat)! - 1;
      if (left > 0) this.contentLaneHolds.set(seat, left);
      else this.contentLaneHolds.delete(seat);
      void this.ask();
    };
  }

  /** The timer's pass. A seat whose last pass is still running is skipped, so one slow hop holds up only its own seat. */
  tick(): Promise<void> {
    return this.pass((seat) => (this.inFlight.has(seat) ? Promise.resolve() : this.driveSeat(seat, false)));
  }

  /** A pass someone asked for, in the caller's context: a caller under a lifecycle lease has its own attempts made under that lease. Unlike the
   *  timer's, it is never skipped. A seat's running pass may be outside that lease, in which case it can only pause, so this one waits for it and
   *  then runs, and a pause does not make it wait out the recheck: a pause spent no attempt. It never shortens a backoff. */
  ask(): Promise<void> {
    return this.pass(async (seat) => {
      while (this.inFlight.has(seat)) await this.inFlight.get(seat);
      await this.driveSeat(seat, true);
    });
  }

  private async pass(drive: (seat: string) => Promise<void>): Promise<void> {
    try {
      this.rejoinHeld();
      await Promise.all(this.deps.store.seatsWithOpenMessages().map(drive));
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

  private driveSeat(seat: string, asked: boolean): Promise<void> {
    const running = this.walkSeat(seat, asked).finally(() => { this.inFlight.delete(seat); });
    this.inFlight.set(seat, running);
    return running;
  }

  private async walkSeat(seat: string, asked: boolean): Promise<void> {
    await Promise.resolve();  // so `inFlight` names this pass before any of it runs
    try {
      for (;;) {
        const head = this.stopped ? null : this.deps.store.headOf(seat);
        if (!head || await this.visit(head, asked) === "stop") return;
      }
    } catch (error) {
      this.log(`seat ${seat}: ${(error as Error).message}`);
    }
  }

  private async visit(message: StoredMessage, asked: boolean): Promise<Visit> {
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
      // Read first: the seat was sent the whole group, and a blocked repeat in its composer is that text.
      const sent = message.attempts > 1 ? this.deps.store.groupOf(message) : [];
      if (!this.deps.store.recordReceived(lookup.record, gate.version)) return "stop";
      if (sent.length > 0) await this.tidyAfterReceived(sent);
      this.forgetText(message.seat);
      return "next";
    }
    if (this.endIfNoLongerWanted(message)) return "next";
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
    if (message.lane === MESSAGE_LANES.content && this.contentLaneHolds.has(message.seat)) {
      this.deps.store.recordLaneHeld(message.id);
      return "stop";
    }
    // A part arrived: the next one is due now, on a fresh backoff, not at the end of the last one's.
    if (lookup.nextPart !== undefined && lookup.nextPart - 1 > message.partsDone) {
      return this.deps.store.recordPartsDone(message, lookup.nextPart - 1) ? "next" : "stop";
    }
    return this.attempt(gate, message, lookup.nextPart, asked);
  }

  /** The message's own id, then, for a long message, each of its numbered parts. All of them seen is the message seen. */
  private async readGate(gate: SeatGate, message: StoredMessage): Promise<GateLookup & { nextPart?: number }> {
    if (message.parts === null || message.parts < 2) return await this.readOne(gate, message, message.id);
    return this.readParts(gate, message, message.parts);
  }

  private async readParts(gate: SeatGate, message: StoredMessage, parts: number): Promise<GateLookup & { nextPart?: number }> {
    const whole = await this.readOne(gate, message, message.id);
    if (whole.kind !== "not_seen") return whole;
    let last: GateLookup = whole;
    for (let index = 1; index <= parts; index += 1) {
      last = await this.readOne(gate, message, partId(message.id, index, parts));
      if (last.kind === "not_seen") return { kind: "not_seen", nextPart: index };
      if (last.kind === "unavailable") return last;
    }
    return last.kind === "seen" ? { kind: "seen", record: { ...last.record, id: message.id } } : last;
  }

  /** The obligation is read before every attempt. A check that throws proves nothing, so the message stays wanted. */
  private endIfNoLongerWanted(message: StoredMessage): boolean {
    let reason: string | null;
    try {
      reason = this.deps.obligations?.whyNoLongerWanted(message) ?? null;
    } catch (error) {
      this.log(`message ${message.id}: its obligation could not be read: ${(error as Error).message}`);
      return false;
    }
    return reason !== null && this.cancel(message.id, reason);
  }

  /** Anything but a record of this very id proves nothing, so it never moves a row. */
  private async readOne(gate: SeatGate, message: StoredMessage, id: MessageId): Promise<GateLookup> {
    let lookup: GateLookup;
    try {
      lookup = await gate.lookup(message.seat, id);
    } catch (error) {
      return { kind: "unavailable", cause: (error as Error).message };
    }
    if (lookup.kind === "seen" && lookup.record.id !== id) return { kind: "unavailable", cause: `the gate answered with a record of ${lookup.record.id}` };
    // A marker with another nonce is forged: the real message has not arrived.
    if (lookup.kind === "seen" && lookup.record.nonce !== null && lookup.record.nonce !== this.deps.store.nonceOf(message.id)) return { kind: "not_seen" };
    return lookup;
  }

  /** The head and the rows of its group still to go. A row the gate recorded is settled here and stays out of the text: a copy of its id would
   *  be a repeat, and the rest would go out without it. Null when a member's gate cannot be read: the text cannot be known, so nothing goes. */
  private async rowsToSend(gate: SeatGate, head: StoredMessage): Promise<StoredMessage[] | null> {
    const rows: StoredMessage[] = [];
    for (const member of this.deps.store.groupOf(head)) {
      if (member.id === head.id) { rows.push(member); continue; }
      const lookup = await this.readGate(gate, member);
      if (lookup.kind === "unavailable") {
        this.deps.store.recordGateUnavailable(head.id, this.clock() + this.timing.pauseRecheckMs);
        return null;
      }
      if (lookup.kind === "seen") this.deps.store.recordReceived(lookup.record, gate.version);
      else if (!this.endIfNoLongerWanted(member)) rows.push(member);
    }
    return rows;
  }

  private async attempt(gate: SeatGate, message: StoredMessage, part: number | undefined, asked: boolean): Promise<Visit> {
    const hop = this.deps.ports.hopFor(message.seat);
    if (!hop) return "stop";
    const now = this.clock();
    if (message.nextAttemptAtMs !== null && now < message.nextAttemptAtMs && !(asked && message.pauseReason !== null)) return "stop";
    const rows = await this.rowsToSend(gate, message);
    if (rows === null || rows.length === 0) return "stop";
    if (!this.deps.store.claimAttempts(rows, now + nextAttemptDelayMs(message.attempts + 1, this.timing.backoffMs))) return "stop";
    let result: LastHopResult;
    try {
      result = await hop.attempt({ ...this.seatMessage(rows), ...(part === undefined ? {} : { part }) });
    } catch (error) {
      result = { kind: "refused", reason: `the hop threw: ${(error as Error).message}` };
    }
    for (const { id } of rows) {
      if (result.kind === "sent") this.deps.store.recordSent(id);
      else if (result.kind === "refused") this.deps.store.recordRefusal(id, result.reason);
      else this.deps.store.recordHopPause(id, result.reason, this.clock() + this.timing.pauseRecheckMs);
    }
    return "stop";
  }

  /** One text however many rows: the group's is every body in staging order, as a drain wrote it. */
  private seatMessage(rows: readonly StoredMessage[]): SeatMessage {
    const [head, ...rest] = rows as [StoredMessage, ...StoredMessage[]];
    const text = (row: StoredMessage) => (row.previousOccupant === null ? row.body : `${PREVIOUS_OCCUPANT_LABEL} ${row.body}`);
    return {
      ids: [head.id, ...rest.map((row) => row.id)], seat: head.seat, body: rows.map(text).join("\n"), bodies: rows.map(text),
      occupantGeneration: head.occupantGeneration, messageClass: head.messageClass, lane: head.lane,
    };
  }

  private forgetText(seat: string): void {
    try {
      this.deps.ports.hopFor(seat)?.forget?.(seat);
    } catch (error) {
      this.log(`seat ${seat}: clearing its spool failed: ${(error as Error).message}`);
    }
  }

  private async tidyAfterReceived(rows: readonly StoredMessage[]): Promise<void> {
    const message = rows[0]!;
    try {
      await this.deps.ports.hopFor(message.seat)?.afterReceived?.(this.seatMessage(rows));
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
    if (closed) this.forgetText(message.seat);
    return closed ? "next" : "stop";
  }
}
