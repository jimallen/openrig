// Seat Messaging, stage S2: the `LastHop` of a Codex seat, one attempt at getting a marked message into the prompt. Repeating an
// attempt is safe because the gate drops a repeat, so this never works out what became of an earlier one: it reads the composer once.
//
// A core restart between the paste and the Enter leaves the text staged, and a second paste would put a second copy behind it. s0 M8
// measured the window (0.2 to 0.4 s) and that Enter alone completes it with one turn. So a staged copy of THIS message gets Enter
// only. Whether it is this message cannot rest on the marker: a paste over about 1000 characters collapses to
// `› [Pasted Content 1610 chars]`, marker hidden (s0 M4). That placeholder is matched by the message's length instead.
//
// Anything else in the composer is a person's draft, or something unknown. Enter would submit it and a paste would join it, so the
// attempt pauses. An attempt never clears the composer.

import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-host.js";
import type { LastHop, LastHopResult, SeatMessage } from "../domain/seat-messaging/ports.js";

const PROMPT_LINE = /^\s*› ?(.*)$/;
/** Codex's empty composer (0.166.0, s0 M4). */
const EMPTY_COMPOSER = "Ask Codex to do anything";
const COLLAPSED_PASTE = /^\[Pasted Content (\d+) chars\]$/;
const AT_REST = new Set(["idle", "done"]);

export type ComposerRead =
  | { kind: "empty" }
  | { kind: "text"; lines: string[] }
  /** No composer on the screen: nothing can be said about what is staged. */
  | { kind: "unreadable" };

/** The composer is the screen's last `›` block: that line and the indented lines under it, down to the footer's first line. */
export function readCodexComposer(screen: string): ComposerRead {
  const lines = screen.replace(/\n+$/, "").split("\n");
  let start = lines.length - 1;
  while (start >= 0 && !PROMPT_LINE.test(lines[start]!)) start -= 1;
  if (start < 0) return { kind: "unreadable" };
  const first = PROMPT_LINE.exec(lines[start]!)![1]!.trimEnd();
  if (first === EMPTY_COMPOSER) return { kind: "empty" };
  const block = [first];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.includes(" · ") || !line.startsWith("  ")) break;
    block.push(line.trim());
  }
  return first === "" && block.length === 1 ? { kind: "empty" } : { kind: "text", lines: block };
}

function lastMarkerLine(body: string): string | null {
  const line = body.trimEnd().split("\n").pop() ?? "";
  return line.startsWith("[openrig-msg ") ? line : null;
}

/** Is what is staged this message? A visible copy shows its marker, a collapsed one its length. Codex's count of a non-ASCII paste
 *  is unmeasured, so each count the text has is accepted. */
export function composerHoldsMessage(lines: readonly string[], body: string): boolean {
  const marker = lastMarkerLine(body);
  if (marker !== null && lines.some((line) => line.trim() === marker)) return true;
  if (lines.length !== 1) return false;
  const collapsed = COLLAPSED_PASTE.exec(lines[0]!);
  if (!collapsed) return false;
  const shown = Number(collapsed[1]);
  return shown === body.length || shown === [...body].length || shown === Buffer.byteLength(body);
}

export type StagedDecision = "paste" | "enter_only" | "hold";

export function decideStagedAttempt(composer: ComposerRead, body: string): StagedDecision {
  if (composer.kind === "empty") return "paste";
  if (composer.kind === "unreadable") return "hold";
  return composerHoldsMessage(composer.lines, body) ? "enter_only" : "hold";
}

export interface CodexPasteInput {
  /** The paste and the Enter, as one core call. */
  submitText(seat: string, text: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  sendKeys(seat: string, keys: string[]): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

export class CodexPasteHop implements LastHop {
  constructor(private readonly client: Pick<HcClient, "call">, private readonly input: CodexPasteInput) {}

  async attempt(message: SeatMessage): Promise<LastHopResult> {
    const terminal = hcTerminalName(message.seat);
    let screen: string;
    let seat: HcTerminal;
    try {
      seat = await this.client.call<HcTerminal>("terminal.get", { terminal });
      if (seat.state !== "live") return { kind: "paused", reason: "seat_stopped" };
      screen = (await this.client.call<{ text: string }>("terminal.read", { terminal, lines: 200 })).text;
    } catch (err) {
      if (err instanceof HcError && err.kind === "not_found") return { kind: "paused", reason: "seat_stopped" };
      if (err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) return { kind: "paused", reason: "seat_stopped" };
      throw err;
    }
    const status = seat.status?.state ?? null;
    if (status === "blocked") return { kind: "paused", reason: "blocked" };
    if (status === null || !AT_REST.has(status)) return { kind: "paused", reason: "busy" };

    const decision = decideStagedAttempt(readCodexComposer(screen), message.body);
    if (decision === "hold") return { kind: "paused", reason: "guard_held" };
    const sent = decision === "enter_only" ? await this.input.sendKeys(message.seat, ["Enter"]) : await this.input.submitText(message.seat, message.body);
    if (sent.ok) return { kind: "sent" };
    // The gate is what says whether it landed. Only a refusal the core gave outright is a reason not to come back.
    return sent.code === "seat_blocked" ? { kind: "paused", reason: "blocked" } : { kind: "refused", reason: sent.code };
  }
}
