// Seat Messaging: the last hops the pump drives on real seats. Every copy a seat gets carries the gate's marker, `[openrig-msg <id>:<nonce>]`,
// on its own last line, one per id, so the gate can drop a repeat. Paste included: an unmarked paste would pass every gate.
//
// A hop never works out what happened to an earlier attempt, and its result says only whether bytes left. Everything typed goes through
// the delivery guard, so a held seat pauses; the socket types nothing, so it does not ask.

import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-host.js";
import { SPOOL_GATE_VERSION } from "./hook-gate-version.js";
import { spooledNote, type SeatMarker } from "./seat-gate-marker.js";
import { CodexPasteHop, type CodexPasteInput } from "./codex-paste-hop.js";
import type { PiRunnerState } from "./pi-runner-protocol.js";
import { nativeMarker, type NativeEndpointRow, type NativeEligibility } from "../domain/claude-native-inbox.js";
import { decideClaudeRetry } from "../domain/seat-messaging/claude-last-hop.js";
import { isStartupText, partId, splitLongMessage } from "../domain/seat-messaging/long-message.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../domain/seat-messaging/message-label.js";
import type { LastHop, LastHopResult, MessageId, SeatMessage } from "../domain/seat-messaging/ports.js";
import type { GuardTarget } from "../domain/seat-delivery-guard.js";

export interface HopRows {
  nonceOf(id: MessageId): string | null;
  senderOf(id: MessageId): string | null;
  lastSocketWriteMs(id: MessageId): number | null;
  recordSocketWrite(id: MessageId, atMs: number): void;
  partsOf(id: MessageId): number | null;
  markParts(id: MessageId, parts: number): void;
}

/** Where a long message's text waits for the seat's gate hook. */
export interface SeatSpool {
  declaredVersion(seat: string): number | null;
  spool(seat: string, marker: SeatMarker, text: string): void;
  discardSpool(seat: string): void;
}

/** Past this a paste may collapse on screen, hiding its marker. Measured on Codex (a paste of 1000 characters or fewer shows whole). Bytes,
 *  because a non-ASCII paste's count is unmeasured and bytes are never under characters. Claude's paste path takes the same limit, unmeasured. */
export const PASTE_LIMIT = 1000;

/** Decision 35: the spool route is off for Claude, because a record with the body lost is the failure Jim's rule forbids and `additionalContext` is
 *  unmeasured on real Claude. Set this to true after the macOS Claude test: nothing else changes. While false, a Claude message over the paste
 *  limit goes by socket only, and with no socket it pauses (`long_no_socket`) and goes when the socket is back. */
export const CLAUDE_SPOOL_ROUTE = false;

/** The short paste that stands for a long message, when one is due: the text this attempt types. The spool is written and the row marked first,
 *  so both are committed before a byte. A short message, or a seat whose relay cannot add the text, goes as it is: whole, its marker perhaps hidden,
 *  and a collapsed paste is then held as a draft, which loses nothing. The note, never the body, is what a staged attempt finds again. */
function prepareLongPaste(message: SeatMessage, text: string, rows: Pick<HopRows, "nonceOf" | "partsOf" | "markParts">, spool: SeatSpool | undefined): string {
  if (Buffer.byteLength(text) <= PASTE_LIMIT || spool === undefined || (spool.declaredVersion(message.seat) ?? 0) < SPOOL_GATE_VERSION) return text;
  const id = message.ids[0];
  const nonce = rows.nonceOf(id)!;
  const parts = splitLongMessage(message.body);
  const total = parts.length;
  if (rows.partsOf(id) !== total) rows.markParts(id, total);
  const index = Math.min(message.part ?? 1, total);
  const marker = { id: total === 1 ? id : partId(id, index, total), nonce };
  spool.spool(message.seat, marker, parts[index - 1]!);
  return shortPaste(message, marker, index, total);
}

/** A wake group is one text with one marker per row, but the spool holds one message's text under one marker, so a long group goes a row at a
 *  time: this attempt carries the first row alone, and the rows after it are the next attempts' head, in order. Decided from the attempt's own
 *  text, so the attempt, the blocked-repeat check and the clearing of it all see the same row. A group the seat cannot take as a short paste goes
 *  whole, as before, and a message with no per-row bodies is left as it is. */
function longGroupHead(message: SeatMessage, rows: Pick<HopRows, "nonceOf">, spool: SeatSpool | undefined): SeatMessage {
  if (spool === undefined || (spool.declaredVersion(message.seat) ?? 0) < SPOOL_GATE_VERSION) return message;
  return pasteHead(message, rows);
}

function pasteHead(message: SeatMessage, rows: Pick<HopRows, "nonceOf">): SeatMessage {
  if (message.ids.length === 1 || message.bodies === undefined) return message;
  const whole = markedText(message, rows);
  if (whole === null || Buffer.byteLength(whole) <= PASTE_LIMIT) return message;
  const first = message.bodies[0]!;
  return { ...message, ids: [message.ids[0]], body: first, bodies: [first] };
}

/** The note and the marker, under the label a message for the previous occupant carries on every attempt. */
function shortPaste(message: SeatMessage, marker: SeatMarker, index: number, total: number): string {
  const label = message.body.startsWith(PREVIOUS_OCCUPANT_LABEL) ? `${PREVIOUS_OCCUPANT_LABEL}\n` : "";
  return `${label}${spooledNote(total === 1 ? null : { index, total })}\n${nativeMarker(marker.id, marker.nonce)}`;
}

export interface HopGuard {
  operation<T>(name: string, fn: () => Promise<T>, held?: (target: GuardTarget) => Promise<T>): Promise<T>;
  heldByAnotherLifecycle?(name: string): boolean;
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

/** A typed attempt under the delivery guard. A held seat pauses; a changed target is a reason to come back, never a failure. So does a seat under
 *  someone else's lifecycle lease: a pass that queued for that lease would hold the seat's pass, and the startup or handover inside the lease
 *  could never get its own text to the seat. */
export function guarded(guard: HopGuard, seat: string, fn: () => Promise<LastHopResult>): Promise<LastHopResult> {
  if (guard.heldByAnotherLifecycle?.(seat)) return Promise.resolve({ kind: "paused", reason: "busy" });
  return guard.operation<LastHopResult>(seat, fn, async () => ({ kind: "paused", reason: "guard_held" }))
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === "typing_guard_enabled") return { kind: "paused", reason: "guard_held" } as const;
      if ((error as { code?: string }).code?.startsWith("guard_")) return { kind: "paused", reason: "busy" } as const;
      throw error;
    });
}

/** The seat's terminal and screen, or the pause that reading them came to. */
/** The processes in a terminal's foreground group, led by `pgid`. Empty when it is not the foreground group now, or it cannot be read. */
export type ForegroundGroupOf = (pgid: number) => Promise<readonly ForegroundProgram[]>;

async function readSeat(client: HopClient, seat: string, runtime: SeatRuntime, groupOf?: ForegroundGroupOf): Promise<{ status: string | null; screen: string } | LastHopResult> {
  const terminal = hcTerminalName(seat);
  try {
    const found = await client.call<HcTerminal>("terminal.get", { terminal });
    if (found.state !== "live") return { kind: "paused", reason: "seat_stopped" };
    if (!isSeatAgent(found, runtime, seat)) {
      const leader = found.foreground?.pid;
      const inGroup = runtime !== "pi" && groupOf !== undefined && leader !== undefined && foregroundHoldsAgent(await groupOf(leader), runtime);
      if (!inGroup) return { kind: "paused", reason: "agent_absent" };
    }
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

type SeatRuntime = "claude-code" | "codex" | "pi";

/** A process in the terminal's foreground group: its OS name and its argv[0]. */
export interface ForegroundProgram { readonly name: string; readonly argv0: string }

function isAgentProgram(program: ForegroundProgram, runtime: "claude-code" | "codex"): boolean {
  const names = [program.name, program.argv0].map((name) => name.replace(/^-/, "").split("/").pop() ?? "");
  // Claude's binary can show as a bare version (`2.1.303`, measured on Sparky).
  return runtime === "codex" ? names.includes("codex") : names.includes("claude") || names.some((name) => /^\d+\.\d+\.\d+$/.test(name));
}

/** Is the terminal's foreground this seat's agent, by what hc reports? Answered from real seats (hc 0.1.15 and 0.1.16, Sparky and Mac):
 *   - Pi and OMP: `node <...>/pi-runner.js --session-name <seat> ...`, so the seat itself is proved.
 *   - Codex, and Claude launched the same way: `/bin/sh <...>/openrig-tmux-send-<...>`, our launch script, with the agent its child.
 *   - Claude and Codex otherwise: the program itself, by name or argv[0] alone. An argument is not a program: `vi codex.txt` is `vi`.
 *  False here is not the end: see `foregroundHoldsAgent`. */
export function isSeatAgent(terminal: Pick<HcTerminal, "foreground">, runtime: SeatRuntime, seat: string): boolean {
  const foreground = terminal.foreground;
  if (!foreground) return false;
  const argv = foreground.argv;
  if (runtime === "pi") {
    const session = argv.indexOf("--session-name");
    return session > 0 && argv[session + 1] === seat && argv.some((arg) => /(^|\/)pi-runner\.[cm]?[jt]s$/.test(arg));
  }
  if (/(^|\/)openrig-tmux-send-[^/]*$/.test(argv[1] ?? "")) return true;
  return isAgentProgram({ name: foreground.name, argv0: argv[0] ?? "" }, runtime);
}

/** hc names the foreground group's leader. A sourced launch runs the agent inside a forked subshell, so the leader carries the login shell's own
 *  name and argv while the agent is its child (Sparky: claude pgid 2149701, tpgid 2149701, under a zsh of that pid). So the group is read: is the
 *  agent in it? At a bare prompt the group is the shell alone, and an agent left running in the background is in a group of its own. */
export function foregroundHoldsAgent(group: readonly ForegroundProgram[], runtime: "claude-code" | "codex"): boolean {
  return group.some((program) => isAgentProgram(program, runtime));
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
  spool?: SeatSpool;
  foregroundGroup?: ForegroundGroupOf;
  now?: () => number;
  /** Tests of the on state. Everything else takes `CLAUDE_SPOOL_ROUTE`. */
  spoolRoute?: boolean;
}

/** What a long message's last paste looked like, so a blocked repeat of it can be recognised. Writes nothing. */
function stagedLongPaste(message: SeatMessage, rows: Pick<HopRows, "nonceOf" | "partsOf">): string {
  const id = message.ids[0];
  const total = rows.partsOf(id) ?? 1;
  return shortPaste(message, { id: total === 1 ? id : partId(id, total, total), nonce: rows.nonceOf(id)! }, total, total);
}

/** The socket where a seat is eligible (a person's draft stays untouched, M3), the paste where it is not. `decideClaudeRetry` decides. */
export class ClaudeSeatHop implements LastHop {
  private readonly now: () => number;
  private readonly spoolRoute: boolean;
  constructor(private readonly deps: ClaudeHopDeps) {
    this.now = deps.now ?? Date.now;
    this.spoolRoute = deps.spoolRoute ?? CLAUDE_SPOOL_ROUTE;
  }

  /** The text of a paste this attempt may make, or null when it may make none. Off, the spool is never used, so a paste always carries its body
   *  in the prompt: a group goes a row at a time, and a row over the limit does not go. Startup text alone may paste long: see `isStartupText`. */
  private pasteable(message: SeatMessage): SeatMessage | null {
    if (this.spoolRoute || isStartupText(message.ids[0])) return message;
    const head = pasteHead(message, this.deps.rows);
    return Buffer.byteLength(markedText(head, this.deps.rows)!) <= PASTE_LIMIT ? head : null;
  }

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
    const pasted = this.pasteable(message);
    if (pasted === null) return { kind: "paused", reason: "long_no_socket" };
    return this.paste(pasted, markedText(pasted, this.deps.rows)!);
  }

  private paste(message: SeatMessage, whole: string): Promise<LastHopResult> {
    return guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat, "claude-code", this.deps.foregroundGroup);
      if ("kind" in seat) return seat;
      if (seat.status === "blocked") return { kind: "paused", reason: "blocked" };
      const spool = this.spoolRoute && !isStartupText(message.ids[0]) ? this.deps.spool : undefined;
      const one = longGroupHead(message, this.deps.rows, spool);
      const text = prepareLongPaste(one, one === message ? whole : markedText(one, this.deps.rows)!, this.deps.rows, spool);
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
  async afterReceived(sentMessage: SeatMessage): Promise<void> {
    const message = this.spoolRoute ? longGroupHead(sentMessage, this.deps.rows, this.deps.spool) : pasteHead(sentMessage, this.deps.rows);
    const whole = markedText(message, this.deps.rows);
    if (whole === null) return;
    const text = this.deps.rows.partsOf(message.ids[0]) === null ? whole : stagedLongPaste(message, this.deps.rows);
    await guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat, "claude-code", this.deps.foregroundGroup);
      if ("kind" in seat) return seat;
      const step = decideClaudeRetry({
        text, socketEligible: false, nowMs: this.now(), lastSocketAttemptMs: null, gateSeen: true,
        atRest: seat.status !== null && AT_REST.has(seat.status), composer: readClaudeComposer(seat.screen),
      });
      if (step.kind === "clear_composer") await this.deps.input.sendKeys(message.seat, ["C-c"]);
      return { kind: "sent" };
    });
  }

  forget(seat: string): void { this.deps.spool?.discardSpool(seat); }
}

export interface CodexHopDeps {
  rows: Pick<HopRows, "nonceOf" | "partsOf" | "markParts">;
  guard: HopGuard;
  client: HopClient;
  input: HcHopInput;
  spool?: SeatSpool;
  foregroundGroup?: ForegroundGroupOf;
}

export class CodexSeatHop implements LastHop {
  private readonly hop: CodexPasteHop;
  constructor(private readonly deps: CodexHopDeps) { this.hop = new CodexPasteHop(deps.client, deps.input); }

  attempt(whole: SeatMessage): Promise<LastHopResult> {
    const message = longGroupHead(whole, this.deps.rows, this.deps.spool);
    const text = markedText(message, this.deps.rows);
    if (text === null) return Promise.resolve(unmarked);
    return guarded(this.deps.guard, message.seat, async () => {
      const seat = await readSeat(this.deps.client, message.seat, "codex", this.deps.foregroundGroup);
      if ("kind" in seat) return seat;
      return this.hop.attempt({ ...message, body: prepareLongPaste(message, text, this.deps.rows, this.deps.spool) });
    });
  }

  forget(seat: string): void { this.deps.spool?.discardSpool(seat); }
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
      const seat = await readSeat(this.deps.client, message.seat, "pi");
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
