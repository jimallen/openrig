// Seat Messaging: the last hops the pump drives on real seats. Every copy a seat gets carries the gate's marker, `[openrig-msg <id>:<nonce>]`,
// on its own last line, one per id, so the gate can drop a repeat. Paste included: an unmarked paste would pass every gate.
//
// A hop never works out what happened to an earlier attempt, and its result says only whether bytes left. Everything typed goes through
// the delivery guard, so a held seat pauses; the socket types nothing, so it does not ask.

import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-host.js";
import { CodexPasteHop, type CodexPasteInput } from "./codex-paste-hop.js";
import type { PiRunnerState } from "./pi-runner-protocol.js";
import { nativeMarker, type NativeEndpointRow, type NativeEligibility } from "../domain/claude-native-inbox.js";
import { decideClaudeRetry } from "../domain/seat-messaging/claude-last-hop.js";
import type { LastHop, LastHopResult, MessageId, SeatMessage } from "../domain/seat-messaging/ports.js";
import type { GuardTarget } from "../domain/seat-delivery-guard.js";

export interface HopRows {
  nonceOf(id: MessageId): string | null;
  senderOf(id: MessageId): string | null;
  lastSocketWriteMs(id: MessageId): number | null;
  recordSocketWrite(id: MessageId, atMs: number): void;
}

export interface HopGuard {
  operation<T>(name: string, fn: () => Promise<T>, held?: (target: GuardTarget) => Promise<T>): Promise<T>;
}

export type HcHopInput = CodexPasteInput;
type HopClient = Pick<HcClient, "call">;

/** The text an attempt carries: the body, then the markers on the next lines, with no blank line: Codex's composer reads down to a blank
 *  line, so a blank one would hide the marker from the Enter-only check. Null when a row has no nonce, which must never reach a seat. */
export function markedText(message: SeatMessage, rows: Pick<HopRows, "nonceOf">): string | null {
  const markers: string[] = [];
  for (const id of message.ids) {
    const nonce = rows.nonceOf(id);
    if (nonce === null) return null;
    markers.push(nativeMarker(id, nonce));
  }
  return `${message.body}\n${markers.join("\n")}`;
}

const unmarked: LastHopResult = { kind: "refused", reason: "no_nonce" };

/** A typed attempt under the delivery guard. A held seat pauses; a changed target is a reason to come back, never a failure. */
function guarded(guard: HopGuard, seat: string, fn: () => Promise<LastHopResult>): Promise<LastHopResult> {
  return guard.operation<LastHopResult>(seat, fn, async () => ({ kind: "paused", reason: "guard_held" }))
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === "typing_guard_enabled") return { kind: "paused", reason: "guard_held" } as const;
      if ((error as { code?: string }).code?.startsWith("guard_")) return { kind: "paused", reason: "busy" } as const;
      throw error;
    });
}

/** The seat's terminal and screen, or the pause that reading them came to. */
async function readSeat(client: HopClient, seat: string): Promise<{ status: string | null; screen: string } | LastHopResult> {
  const terminal = hcTerminalName(seat);
  try {
    const found = await client.call<HcTerminal>("terminal.get", { terminal });
    if (found.state !== "live") return { kind: "paused", reason: "seat_stopped" };
    const { text } = await client.call<{ text: string }>("terminal.read", { terminal, lines: 200 });
    return { status: found.status?.state ?? null, screen: text };
  } catch (error) {
    if (error instanceof HcError && error.kind === "not_found") return { kind: "paused", reason: "seat_stopped" };
    if (error instanceof HcUnavailableError || error instanceof HcOutcomeUnknownError) return { kind: "paused", reason: "seat_stopped" };
    throw error;
  }
}

function sentOrRefused(sent: { ok: true } | { ok: false; code: string; message: string }): LastHopResult {
  if (sent.ok) return { kind: "sent" };
  return sent.code === "seat_blocked" ? { kind: "paused", reason: "blocked" } : { kind: "refused", reason: sent.code };
}

const AT_REST = new Set(["idle", "done"]);
const RULE_LINE = /^[─═-]{10,}$/;

/** Claude's composer: the screen's last `❯` line, down to the rule under it. Null when no composer shows, which proves nothing. */
export function readClaudeComposer(screen: string): string | null {
  const lines = screen.replace(/\n+$/, "").split("\n");
  let start = lines.length - 1;
  while (start >= 0 && !lines[start]!.trimStart().startsWith("❯")) start -= 1;
  if (start < 0) return null;
  // Down to the screen's last rule: a body may hold a rule-like line of its own.
  let end = lines.length;
  while (end > start + 1 && !RULE_LINE.test(lines[end - 1]!.trim())) end -= 1;
  const below = end > start + 1 ? lines.slice(start + 1, end - 1) : lines.slice(start + 1);
  return [lines[start]!.trimStart().slice(1).trim(), ...below.map((line) => line.trim())].join("\n").trim();
}

export interface ClaudeHopDeps {
  rows: HopRows;
  guard: HopGuard;
  client: HopClient;
  input: HcHopInput;
  eligibility(seat: string): Promise<NativeEligibility>;
  writeToSeat(endpoint: NativeEndpointRow, sender: string, text: string): Promise<"none" | "all" | "partial">;
  now?: () => number;
}

/** The socket where a seat is eligible (a person's draft stays untouched, M3), the paste where it is not. `decideClaudeRetry` decides. */
export class ClaudeSeatHop implements LastHop {
  private readonly now: () => number;
  constructor(private readonly deps: ClaudeHopDeps) { this.now = deps.now ?? Date.now; }

  async attempt(message: SeatMessage): Promise<LastHopResult> {
    const text = markedText(message, this.deps.rows);
    if (text === null) return unmarked;
    const id = message.ids[0];
    const eligible = await this.deps.eligibility(message.seat);
    if (eligible.ok) {
      const step = decideClaudeRetry({ text, socketEligible: true, nowMs: this.now(), lastSocketAttemptMs: this.deps.rows.lastSocketWriteMs(id), gateSeen: false, atRest: true, composer: null });
      // An identical line inside the window would vanish with no trace (M1): this attempt was not made, so it costs no backoff.
      if (step.kind === "wait") return { kind: "paused", reason: "busy" };
      this.deps.rows.recordSocketWrite(id, this.now());
      const written = await this.deps.writeToSeat(eligible.endpoint, this.deps.rows.senderOf(id) ?? "unknown", text);
      if (written !== "none") return { kind: "sent" };
    }
    return this.paste(message, text);
  }

  private paste(message: SeatMessage, text: string): Promise<LastHopResult> {
    return guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat);
      if ("kind" in seat) return seat;
      if (seat.status === "blocked") return { kind: "paused", reason: "blocked" };
      const step = decideClaudeRetry({
        text, socketEligible: false, nowMs: this.now(), lastSocketAttemptMs: null, gateSeen: false,
        atRest: seat.status !== null && AT_REST.has(seat.status), composer: readClaudeComposer(seat.screen),
      });
      switch (step.kind) {
        case "paste": return sentOrRefused(await this.deps.input.submitText(message.seat, text));
        case "enter_only": return sentOrRefused(await this.deps.input.sendKeys(message.seat, ["Enter"]));
        case "paused": return { kind: "paused", reason: step.reason };
        default: return { kind: "paused", reason: "busy" };
      }
    });
  }

  /** M3: a blocked repeat comes back to the composer. Cleared only at rest, only when it holds exactly this text, only with `ctrl+c`. */
  async afterReceived(message: SeatMessage): Promise<void> {
    const text = markedText(message, this.deps.rows);
    if (text === null) return;
    await guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat);
      if ("kind" in seat) return seat;
      const step = decideClaudeRetry({
        text, socketEligible: false, nowMs: this.now(), lastSocketAttemptMs: null, gateSeen: true,
        atRest: seat.status !== null && AT_REST.has(seat.status), composer: readClaudeComposer(seat.screen),
      });
      if (step.kind === "clear_composer") await this.deps.input.sendKeys(message.seat, ["C-c"]);
      return { kind: "sent" };
    });
  }
}

export interface CodexHopDeps {
  rows: Pick<HopRows, "nonceOf">;
  guard: HopGuard;
  client: HopClient;
  input: HcHopInput;
}

export class CodexSeatHop implements LastHop {
  private readonly hop: CodexPasteHop;
  constructor(private readonly deps: CodexHopDeps) { this.hop = new CodexPasteHop(deps.client, deps.input); }

  attempt(message: SeatMessage): Promise<LastHopResult> {
    const text = markedText(message, this.deps.rows);
    if (text === null) return Promise.resolve(unmarked);
    return guarded(this.deps.guard, message.seat, () => this.hop.attempt({ ...message, body: text }));
  }
}

export interface PiHopDeps {
  rows: Pick<HopRows, "nonceOf">;
  guard: HopGuard;
  client: HopClient;
  input: HcHopInput;
  /** The runner's sidecar, null when it cannot be read. */
  runnerState(seat: string): PiRunnerState | null;
}

/** Pi and OMP: a paste the runner's gate reads. Pi refusing a prompt (M6: during compaction) clears the runner's intent, so the next
 *  attempt passes: the pump's retry is the answer, and nothing here needs to know about compaction. */
export class PiSeatHop implements LastHop {
  constructor(private readonly deps: PiHopDeps) {}

  attempt(message: SeatMessage): Promise<LastHopResult> {
    const text = markedText(message, this.deps.rows);
    if (text === null) return Promise.resolve(unmarked);
    return guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat);
      if ("kind" in seat) return seat;
      if (seat.status === "blocked") return { kind: "paused", reason: "blocked" };
      const state = this.deps.runnerState(message.seat);
      if (state === null) return { kind: "paused", reason: "seat_stopped" };
      if (state.pasteOpen) return { kind: "paused", reason: "busy" };
      if (state.pasteLeftover) {
        // Staged text with its Enter lost (M8): this message's marker on the line means Enter alone. Anything else is not ours to send.
        const lastMarker = text.split("\n").pop()!;
        if (!seat.screen.replace(/\s+/g, "").includes(lastMarker.replace(/\s+/g, ""))) return { kind: "paused", reason: "draft" };
        return sentOrRefused(await this.deps.input.sendKeys(message.seat, ["Enter"]));
      }
      return sentOrRefused(await this.deps.input.submitText(message.seat, text));
    });
  }
}
