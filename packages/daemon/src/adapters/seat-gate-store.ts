// Seat Messaging, stage S2: the Pi and OMP gate's durable store, `seat-gate.log` in the seat's state directory. Append-only JSON lines,
// each fsync'd before the step it guards.
//   intent   this block is about to go to the agent; fsync'd BEFORE the RPC write
//   seen     the agent has it: its message_start, Pi's `handled` reply, or the session file on restart
//   cleared  it did not: Pi refused it, or a restart found no trace of it, so a resend may pass
// What a message's state is, by the last line naming it: nothing or `cleared`, a resend passes; `intent`, it is in flight and a repeat
// is dropped; `seen`, a repeat is dropped for good. A kill between any two steps leaves one of those, and a restart settles every
// `intent` against the session file before the first new block (RunnerCore). The log holds hashes, never a message body.
//
// A failed append may leave torn bytes at the end of the file, so the store refuses every later `admit` until it is reopened, which cuts
// a torn tail. The log is never compacted: a repeat is refused for as long as the seat's state lives (about 200 bytes per message).
//
// Only node builtins: the pane-hosted runner loads this.

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { seatMarkerKey, type SeatMarker } from "./seat-gate-marker.js";

export function seatGateLogPath(seatRoot: string): string {
  return nodePath.join(seatRoot, "seat-gate.log");
}

/** The session file a message landed in, and where the file ended before it was sent. */
export interface GateIntent {
  markers: SeatMarker[];
  textSha: string;
  sessionFile: string | null;
  sessionOffset: number;
}

type GateRecord =
  | ({ op: "intent"; at: string } & GateIntent)
  | { op: "seen"; markers: SeatMarker[]; via: string; at: string }
  | { op: "cleared"; markers: SeatMarker[]; via: string; at: string };

export function gateTextSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseRecord(line: string): GateRecord | null {
  try {
    const value = JSON.parse(line) as Partial<GateRecord> | null;
    if (value === null || typeof value !== "object" || !Array.isArray(value.markers)) return null;
    return value.op === "intent" || value.op === "seen" || value.op === "cleared" ? value as GateRecord : null;
  } catch { return null; }
}

/** The last state of every (id, nonce) in a log's text, and the intents still open, oldest first. A torn last line is no line. */
function replay(text: string): { state: Map<string, "intent" | "seen">; open: GateIntent[]; seenAt: Map<string, string> } {
  const state = new Map<string, "intent" | "seen">();
  const seenAt = new Map<string, string>();
  let open: GateIntent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (!record) continue;
    const keys = new Set(record.markers.map(seatMarkerKey));
    if (record.op === "intent") {
      open.push({ markers: record.markers, textSha: record.textSha, sessionFile: record.sessionFile, sessionOffset: record.sessionOffset });
      for (const key of keys) state.set(key, "intent");
      continue;
    }
    open = open.filter((intent) => !intent.markers.some((m) => keys.has(seatMarkerKey(m))));
    for (const key of keys) {
      if (record.op === "seen") { state.set(key, "seen"); seenAt.set(key, record.at); } else state.delete(key);
    }
  }
  return { state, open, seenAt };
}

/** When a log's text says this (id, nonce) reached the agent, or null. The daemon's reading of the store; nothing here writes. */
export function gateLogRecord(text: string, marker: SeatMarker): { at: string } | null {
  const at = replay(text).seenAt.get(seatMarkerKey(marker));
  return at === undefined ? null : { at };
}

/** The sha of every user message in a Pi session file past `offset`, oldest first: [] when the file does not exist (Pi writes it with
 *  the first message), null when it cannot be read (the answer is then unknown, not "absent"). Only whole lines count. */
export function sessionUserTextShas(sessionFile: string, offset: number): string[] | null {
  let bytes: Buffer;
  try {
    const whole = fs.readFileSync(sessionFile);
    bytes = whole.subarray(Math.min(offset, whole.length));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const text = bytes.toString("utf8");
  const shas: string[] = [];
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const body = userMessageText(entry.message);
      if (body !== null) shas.push(gateTextSha(body));
    } catch { /* not an entry: a line the offset cut, or noise */ }
  }
  return shas;
}

/** The text of a Pi user message, whose content is a string or a list of blocks (docs/message-types.md); null when it holds none. */
export function userMessageText(message: { content?: unknown } | undefined): string | null {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    const block = part as { type?: unknown; text?: unknown } | null;
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  return parts.length > 0 ? parts.join("") : null;
}

export class SeatGateStore {
  private state = new Map<string, "intent" | "seen">();
  private intents: GateIntent[] = [];
  private poisoned = false;

  private constructor(private readonly path: string, private readonly now: () => string) {}

  /** Load the log, cutting a torn last line so the next append starts clean. A log that cannot be read leaves a store that refuses
   *  every marked block: dropping out of the gate would hand the agent its markers and its repeats. */
  static open(path: string, now: () => string = () => new Date().toISOString()): SeatGateStore {
    const store = new SeatGateStore(path, now);
    try {
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      fs.closeSync(fs.openSync(path, "a", 0o600));  // the file exists from here, so a reader can tell "nothing yet" from "cannot read"
      const text = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
      const whole = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
      if (whole !== Buffer.byteLength(text)) fs.truncateSync(path, whole);
      const { state, open } = replay(text.slice(0, text.lastIndexOf("\n") + 1));
      store.state = state;
      store.intents = open;
    } catch { store.poisoned = true; }
    return store;
  }

  /** The intents no record has settled yet, oldest first. */
  get open(): readonly GateIntent[] { return this.intents; }

  private append(record: GateRecord): void {
    if (this.poisoned) throw new Error("seat gate: an earlier append failed; restart the runner to repair the log");
    try {
      const fd = fs.openSync(this.path, "a", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } catch (err) {
      this.poisoned = true;
      throw err;
    }
  }

  /** The gate: durable intent for the markers not met before, or null when there are none, so the block is a repeat. A block with one
   *  new marker in a wake group passes, as a native wake does. Throws when the intent could not be made durable: nothing may be sent. */
  admit(markers: readonly SeatMarker[], text: string, sessionFile: string | null): GateIntent | null {
    const fresh = markers.filter((marker) => !this.state.has(seatMarkerKey(marker)));
    if (fresh.length === 0) return null;
    let sessionOffset = 0;
    try { sessionOffset = sessionFile === null ? 0 : fs.statSync(sessionFile).size; } catch { /* not written yet */ }
    const intent: GateIntent = { markers: fresh, textSha: gateTextSha(text), sessionFile, sessionOffset };
    this.append({ op: "intent", at: this.now(), ...intent });
    this.intents.push(intent);
    for (const marker of fresh) this.state.set(seatMarkerKey(marker), "intent");
    return intent;
  }

  /** The agent has it. The in-memory state moves even when the append fails: the restart's reconcile recovers the record from the
   *  session file, and until then this runner keeps refusing the repeat. */
  seen(intent: GateIntent, via: string): void {
    if (!this.intents.includes(intent)) return;
    this.intents = this.intents.filter((open) => open !== intent);
    for (const marker of intent.markers) this.state.set(seatMarkerKey(marker), "seen");
    this.append({ op: "seen", markers: intent.markers, via, at: this.now() });
  }

  /** The oldest open intent with this text has reached the agent. */
  seenByText(text: string, via: string): void {
    const sha = gateTextSha(text);
    const intent = this.intents.find((open) => open.textSha === sha);
    if (intent) this.seen(intent, via);
  }

  /** It did not reach the agent: a resend may pass. */
  clear(intent: GateIntent, via: string): void {
    if (!this.intents.includes(intent)) return;
    this.intents = this.intents.filter((open) => open !== intent);
    for (const marker of intent.markers) this.state.delete(seatMarkerKey(marker));
    this.append({ op: "cleared", markers: intent.markers, via, at: this.now() });
  }

  /** Settle what a killed runner left open, against the session file each intent named: found past its offset, the agent has it; not
   *  found, a resend may pass. Identical texts are matched oldest first, one session line each. An unreadable file settles nothing:
   *  the id stays in flight until a later start can read it, because clearing it could double the message. Returns how many stayed. */
  reconcile(read: (sessionFile: string, offset: number) => string[] | null = sessionUserTextShas): number {
    let unsettled = 0;
    const consumed = new Map<string, number>();
    for (const intent of [...this.intents]) {
      const shas = intent.sessionFile === null ? [] : read(intent.sessionFile, intent.sessionOffset);
      if (shas === null) { unsettled += 1; continue; }
      const key = `${intent.sessionFile}\0${intent.sessionOffset}\0${intent.textSha}`;
      const prior = shas.filter((sha) => sha === intent.textSha).length - (consumed.get(key) ?? 0);
      if (prior > 0) {
        consumed.set(key, (consumed.get(key) ?? 0) + 1);
        this.seen(intent, "session_file");
      } else {
        this.clear(intent, "restart_not_in_session");
      }
    }
    return unsettled;
  }
}
