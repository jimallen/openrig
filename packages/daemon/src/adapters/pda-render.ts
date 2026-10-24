// pda runtime L1b (pda-runtime-design-9l Rev 2, "Rendering and sanitising", "Token handling" 5): everything the
// pda-runner may write to its pane goes through the `PdaPane` in this file.
//
// The pane is the one surface where agent text and FULL tool output may appear (Jim's J-2: an accepted
// residual with a named audience). So the order of operations on every string is fixed, and a pane writer that
// takes a raw string has no other door:
//   1. `sanitizeForPane` (L0): escape sequences, controls, bidi controls out;
//   2. exact-value redaction of the secrets the runner HOLDS (the pda bearer, the activity hook token);
//   3. the write, and after each output batch the runner's own `ESC[?2004h` (bracketed paste stays on).
// Nothing else is pattern-redacted: a pattern redactor would be a false assurance (R13).
//
// Streamed text (`text_delta`) is sanitised per delta and then passed through a tail buffer that keeps the last
// (longest secret - 1) characters back until the next delta or the end of the message, so a secret split across
// two deltas is still caught.
//
// Also here: the one normaliser from pda's entry records and message changes to the few facts the renderer needs
// (`entryView`, `messageChangesOf`, `idText`). Their shapes follow pi-durable 1.3.0's declarations, cited there.

import { sanitizeForPane } from "./pda-runner-protocol.js";

// ── Secrets the runner holds ─────────────────────────────────────────────────

export interface PdaSecret { value: string; marker: string }
export { PDA_TOKEN_MARKER } from "./pda-client.js";
export const HOOK_TOKEN_MARKER = "[redacted:openrig-hook-token]";

/** Exact-value redaction with a tail buffer for streamed text. `secrets` is read at every call, so a rotated
 *  bearer is covered as soon as it has been read (older bearers stay in the list for the process lifetime). */
export class PdaRedactor {
  private tail = "";
  constructor(private readonly secrets: () => readonly PdaSecret[]) {}

  private active(): PdaSecret[] {
    return this.secrets().filter((s) => s.value.length > 0).sort((a, b) => b.value.length - a.value.length);
  }

  private replaceAll(text: string, secrets: readonly PdaSecret[]): string {
    let out = text;
    for (const s of secrets) out = out.split(s.value).join(s.marker);
    return out;
  }

  /** Redact a whole, already sanitised string. */
  redact(text: string): string {
    return this.replaceAll(text, this.active());
  }

  /** Streaming: returns the part that is safe to emit now. The last (longest secret - 1) characters are held. */
  push(text: string): string {
    const secrets = this.active();
    const joined = this.replaceAll(this.tail + text, secrets);
    const hold = secrets.reduce((m, s) => Math.max(m, s.value.length - 1), 0);
    let cut = Math.max(0, joined.length - hold);
    // Never cut between the two halves of a surrogate pair.
    if (cut > 0 && cut < joined.length) {
      const code = joined.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    this.tail = joined.slice(cut);
    return joined.slice(0, cut);
  }

  /** The end of a streamed message: release the held tail, redacted. */
  flush(): string {
    const out = this.replaceAll(this.tail, this.active());
    this.tail = "";
    return out;
  }

  get holding(): boolean { return this.tail.length > 0; }
}

// ── The pane ─────────────────────────────────────────────────────────────────

export const BRACKETED_PASTE_ON = "\u001b[?2004h";

export class PdaPane {
  private lineOpen = false;
  private wrote = false;
  readonly redactor: PdaRedactor;

  constructor(private readonly write: (text: string) => void, secrets: () => readonly PdaSecret[]) {
    this.redactor = new PdaRedactor(secrets);
  }

  private emit(text: string): void {
    if (text.length === 0) return;
    this.write(text);
    this.wrote = true;
  }

  /** True while streamed text sits on an unfinished line. */
  get inLine(): boolean { return this.lineOpen; }

  /** Finish a streamed line: release the held tail and end the line. */
  closeLine(): void {
    const rest = this.redactor.flush();
    if (rest.length > 0) { this.emit(rest); this.lineOpen = true; }
    if (this.lineOpen) { this.emit("\n"); this.lineOpen = false; }
  }

  /** One full line (sanitised, redacted). Any streamed line in progress is finished first. */
  line(text: string): void {
    this.closeLine();
    this.emit(`${this.redactor.redact(sanitizeForPane(text))}\n`);
  }

  /** A multi-line body, every line behind `prefix` (the first behind `first` when given). Sanitised and
   *  redacted as ONE string, so a secret that spans a line break is still caught. */
  block(text: string, prefix: string, first: string = prefix): void {
    this.closeLine();
    const safe = this.redactor.redact(sanitizeForPane(text)).replace(/\n$/, "");
    const lines = safe.split("\n");
    this.emit(lines.map((l, i) => `${i === 0 ? first : prefix}${l}\n`).join(""));
  }

  /** Streamed text. Sanitised per delta, then through the tail buffer. */
  append(delta: string): void {
    const out = this.redactor.push(sanitizeForPane(delta));
    if (out.length > 0) {
      this.emit(out);
      this.lineOpen = !out.endsWith("\n");
    } else if (this.redactor.holding) {
      this.lineOpen = true; // text is pending in the tail buffer; the line must be closed later
    }
  }

  /** End of an output batch: re-assert bracketed paste. The only escape the runner emits itself. Defence in
   *  depth: the sanitiser is the control, this makes an unsanitised path last at most one batch. */
  endBatch(): void {
    if (!this.wrote) return;
    this.wrote = false;
    this.write(BRACKETED_PASTE_ON);
  }
}

// ── Entry and event normalisation ────────────────────────────────────────────
// pda's wire shapes, read at the source (pi-durable 1.3.0 `dist/harness/events.d.ts`, `dist/types.d.ts`,
// `pi-ai/dist/types.d.ts`; pda `client/pda.mjs`, which renders the same stream):
//   - EntryId, SubmissionId and ConversationId are NUMBERS (types.d.ts:18-21). `idText` makes them text, once, here;
//     everything the runner stores or compares (sidecar, own-submissions, the rendered-id set) is text.
//   - an EntryRecord is `{id, conversationId, kind, model?: Message[], data?, ...}` (types.d.ts:290-305). It carries
//     NO requestId and NO submissionId: ownership of a user entry comes from the SubmissionRecord that names it
//     (`record.entry`, types.d.ts:336-366), see `pda-runner.ts`.
//   - `model[0]` is a pi-ai message (types.d.ts of pi-ai:357-428): user {content: string | parts}, assistant {content:
//     text | thinking | toolCall parts, errorMessage?}, toolResult {toolCallId, isError, content: parts}.
//   - `message_update` is `{usage, changes: MessageChange[]}` (events.d.ts:81-84, 14-34): streamed text is the
//     `text_delta` changes; a `text_start` block can carry initial text; `block` and `message` replace what was
//     streamed, so the reply can only be shown whole at `message_end`.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** An id as text: pda's numeric ids (non-negative safe integers), or a non-empty string. Anything else is no id. */
export function idText(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return str(v);
}

/** The text of a message content: a string, or the `text` parts of a content array. Thinking is never text. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObj(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export interface PdaEntryView {
  id: string | null;
  role: "user" | "assistant" | "toolResult" | "other";
  /** Text parts only. */
  text: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  toolCallId: string | null;
  isError: boolean;
  /** An assistant message's `errorMessage` (a failed generation). */
  errorMessage: string | null;
  /** Entry kind markers such as `pi.reset` and `pi.compaction`. */
  kind: string | null;
}

/** pda's `EntryRecord`: `id`, `kind`, and `model[0]`, a pi-ai message with `role` and `content`. */
export function entryView(entry: unknown): PdaEntryView | null {
  if (!isObj(entry)) return null;
  const msg = Array.isArray(entry.model) && isObj(entry.model[0]) ? entry.model[0] : {};
  const rawRole = msg.role;
  const role = rawRole === "user" || rawRole === "assistant" || rawRole === "toolResult" ? rawRole : "other";
  const toolCalls: PdaEntryView["toolCalls"] = [];
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (isObj(part) && part.type === "toolCall" && typeof part.name === "string") toolCalls.push({ name: part.name, args: part.arguments });
    }
  }
  return {
    id: idText(entry.id),
    role,
    text: contentText(msg.content),
    toolCalls,
    toolCallId: str(msg.toolCallId),
    isError: msg.isError === true,
    errorMessage: str(msg.errorMessage),
    kind: str(entry.kind),
  };
}

/** What a `message_update` adds to the pane. `text` is the streamed text (text_delta changes, and the initial text
 *  of a text_start block). `whole` is true when a change replaced what was streamed (a `block` or a `message`), so
 *  the reply can only be trusted whole at message_end. Null when the event carries no `changes` array. */
export function messageChangesOf(event: Record<string, unknown>): { text: string; whole: boolean } | null {
  const changes = event.changes;
  if (!Array.isArray(changes)) return null;
  let text = "";
  let whole = false;
  for (const change of changes) {
    if (!isObj(change)) continue;
    if (change.type === "text_delta" && typeof change.delta === "string") text += change.delta;
    else if (change.type === "text_start" && isObj(change.block) && change.block.type === "text" && typeof change.block.text === "string") text += change.block.text;
    else if (change.type === "block" || change.type === "message") whole = true;
  }
  return { text, whole };
}

/** The text a `message_start` partial already holds (a streamed answer starts with its first partial). */
export function partialText(message: unknown): string {
  return isObj(message) && message.role === "assistant" ? contentText(message.content) : "";
}

/** The first line of a tool's arguments, at most `max` characters: enough to see WHICH call, never the lot. */
export function argsFirstLine(args: unknown, max = 160): string {
  let text: string;
  if (typeof args === "string") text = args;
  else {
    try { text = JSON.stringify(args) ?? ""; } catch { text = ""; }
  }
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > max ? first.slice(0, max) : first;
}
