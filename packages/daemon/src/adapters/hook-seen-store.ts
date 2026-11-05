// Seat Messaging, stage S2: the seen store of a seat whose gate is a provider hook (census-delivery-guarantees-20261101.md, part 2).
// The relay (activity-relay.cjs) writes it before the agent sees a prompt: one file per message at
// `<home>/state/seat-gates/<seat>/seen/<sha256 of id:nonce>`, created atomically, so a repeat is refused with no daemon. This module is
// the daemon's side, and it knows no runtime: Claude's transcript and Codex's rollout are both a file the marker lands in.
//
// A hook's record and a durable prompt are two facts, and either can exist alone (M5, and a hook that crashes fails open):
//   - record, no prompt: the hook ran and the agent died before persisting. Reconcile clears it, so a resend passes.
//   - prompt, no record: the hook crashed or timed out and the prompt ran. Reconcile records it, so a resend is refused. Not for a long message's
//     short paste: its body comes from the hook, so a crashed hook let only the note run, and the row stays open (`SeatMarker.spooled`).
// Reconcile acts only on a record whose agent process is proven dead: a live agent's transcript lags its hook, always (M5).

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { promptMarkers as markersOfPrompt, seatMarkerKey, type SeatMarker } from "./seat-gate-marker.js";

export const SEEN_RECORD_NAME = /^[a-f0-9]{64}$/;

export interface SeenRecord {
  id: string;
  nonce: string;
  recordedAt: string;
  /** `hook`: the gate recorded it. `transcript`: the hook never did, and reconcile found the prompt. */
  via: "hook" | "transcript";
  agentPid: number | null;
  transcriptPath: string | null;
  /** The prompt was found persisted, so no later reconcile has to look for it. */
  durable: boolean;
  /** A long message's record only (OF-229): the sha256 (hex) of the text the relay put on its stdout. The record is written before the relay has exited, and an agent
   *  takes a hook's output only from a hook that exited, so the record alone does not say the agent has the text. Absent from a record of an older relay. */
  bodySha256?: string;
}

export function seatGateRoot(openrigHome: string): string {
  return nodePath.join(openrigHome, "state", "seat-gates");
}

/** A seat name as one safe folder name: the same rule as the relay's. */
export function seatGateFolder(seat: string): string {
  return encodeURIComponent(seat).replace(/\./g, "%2E");
}

function isSeenRecord(value: unknown): value is SeenRecord {
  const r = value as Partial<SeenRecord> | null;
  return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.nonce === "string" && typeof r.recordedAt === "string";
}

export type SeenRead = { kind: "seen"; record: SeenRecord } | { kind: "not_seen" } | { kind: "unavailable"; cause: string };

export class HookSeenStore {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  private seatDir(seat: string): string { return nodePath.join(this.root, seatGateFolder(seat)); }
  private seenDir(seat: string): string { return nodePath.join(this.seatDir(seat), "seen"); }
  private spoolDir(seat: string): string { return nodePath.join(this.seatDir(seat), "spool"); }
  private recordPath(seat: string, marker: SeatMarker): string {
    return nodePath.join(this.seenDir(seat), createHash("sha256").update(seatMarkerKey(marker)).digest("hex"));
  }

  /** The gate version the seat's relay declared at SessionStart, or null: a seat on an older relay has no gate. */
  declaredVersion(seat: string): number | null {
    try {
      const value = JSON.parse(fs.readFileSync(nodePath.join(this.seatDir(seat), "gate.json"), "utf8")) as { version?: unknown };
      return typeof value.version === "number" ? value.version : null;
    } catch { return null; }
  }

  /** Where the relay said this seat's prompts land: the daemon's way to a Codex rollout whose thread it never learned. */
  declaredTranscript(seat: string): string | null {
    try {
      const value = JSON.parse(fs.readFileSync(nodePath.join(this.seatDir(seat), "gate.json"), "utf8")) as { transcriptPath?: unknown };
      return typeof value.transcriptPath === "string" ? value.transcriptPath : null;
    } catch { return null; }
  }

  /** Holds a long message's text for the seat's gate hook, under its (id, nonce). Whole and on disk before this returns, so it is there before a
   *  byte of the paste. A seat has one message in flight, so anything older goes: the spool never grows. */
  spool(seat: string, marker: SeatMarker, text: string): void {
    const dir = this.spoolDir(seat);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(seatMarkerKey(marker)).digest("hex");
    const tmp = nodePath.join(dir, `.${name}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, nodePath.join(dir, name));
    for (const other of fs.readdirSync(dir)) if (other !== name) fs.rmSync(nodePath.join(dir, other), { force: true });
  }

  /** The message left the seat: its text does not stay on disk. */
  discardSpool(seat: string): void {
    fs.rmSync(this.spoolDir(seat), { recursive: true, force: true });
  }

  /** The record of this exact (id, nonce). The file's contents are compared too: a name only says what was asked for. */
  read(seat: string, marker: SeatMarker): SeenRead {
    let text: string;
    try {
      text = fs.readFileSync(this.recordPath(seat, marker), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? { kind: "not_seen" } : { kind: "unavailable", cause: code ?? "unreadable" };
    }
    try {
      const record = JSON.parse(text) as unknown;
      if (isSeenRecord(record)) return record.id === marker.id && record.nonce === marker.nonce ? { kind: "seen", record } : { kind: "not_seen" };
    } catch { /* below */ }
    return { kind: "unavailable", cause: "malformed_record" };
  }

  list(seat: string): SeenRecord[] {
    let names: string[];
    try { names = fs.readdirSync(this.seenDir(seat)); } catch { return []; }
    return names.filter((name) => SEEN_RECORD_NAME.test(name)).flatMap((name) => {
      try {
        const record = JSON.parse(fs.readFileSync(nodePath.join(this.seenDir(seat), name), "utf8")) as unknown;
        return isSeenRecord(record) ? [record] : [];
      } catch { return []; }
    });
  }

  private replace(seat: string, record: SeenRecord): void {
    const path = this.recordPath(seat, record);
    const tmp = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, path);
  }

  /** The prompt was found persisted: a repeat is refused from now on, whatever the hook did. */
  markReceived(seat: string, marker: SeatMarker): void {
    const prior = this.read(seat, marker);
    fs.mkdirSync(this.seenDir(seat), { recursive: true, mode: 0o700 });
    this.replace(seat, prior.kind === "seen" ? { ...prior.record, durable: true }
      : { id: marker.id, nonce: marker.nonce, recordedAt: this.now().toISOString(), via: "transcript", agentPid: null, transcriptPath: null, durable: true });
  }

  /** The agent never took it: a resend may pass. */
  clear(seat: string, marker: SeatMarker): void {
    fs.rmSync(this.recordPath(seat, marker), { force: true });
  }
}

/** Claude stamps a message from another session `origin.kind: "peer"` and adds one paragraph of its own after the prompt's text, past the
 *  wrapper when there is one (362 of 362 real records, Mac and Sparky, Claude 2.1.310 to 2.1.316; the hook's `prompt` has no such paragraph).
 *  So a peer record is read again without its last paragraph, whatever that paragraph says. A person's prompt has no such leeway: text after
 *  a marker means the marker was quoted. */
function promptMarkers(text: string, peer: boolean): SeatMarker[] {
  const markers = markersOfPrompt(text);
  if (markers.length > 0 || !peer) return markers;
  const cut = text.lastIndexOf("\n\n");
  return cut < 0 ? [] : markersOfPrompt(text.slice(0, cut));
}

/** The markers of the prompts Claude took. Only two records mean that (key census of real transcripts, Claude 2.1.310 to 2.1.316): a `user`
 *  record, and an `attachment` of type `queued_command`, which is how a message taken mid-turn lands. `queue-operation`, `api-request-blob`
 *  and the rest hold the same text and prove nothing: an enqueue line is written when a message is queued, before the hook, while it is
 *  only in Claude's memory. A tool result quoting a marker is not a prompt either. */
function claudeRecordMarkers(line: string): SeatMarker[] {
  let record: { type?: unknown; isSidechain?: unknown; origin?: { kind?: unknown } | null; message?: { role?: unknown; content?: unknown }; attachment?: { type?: unknown; prompt?: unknown } };
  try { record = JSON.parse(line) as typeof record; } catch { return []; }
  if (record.isSidechain === true) return [];
  if (record.type === "attachment") return record.attachment?.type === "queued_command" && typeof record.attachment.prompt === "string" ? markersOfPrompt(record.attachment.prompt) : [];
  if (record.type !== "user" || record.message?.role !== "user") return [];
  const { content } = record.message;
  const peer = record.origin?.kind === "peer";
  if (typeof content === "string") return promptMarkers(content, peer);
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type?: unknown; text?: unknown } | null>).flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? promptMarkers(part.text, peer) : []));
}

/** Every prompt's marker in a Claude transcript, read in chunks, whole lines only: a torn last line is a prompt not yet durable. An empty set
 *  when the file does not exist (the agent writes it with the first prompt, M5), null when it cannot be read, which proves nothing. */
export function transcriptMarkers(path: string, chunkBytes = 4 * 1024 * 1024): Map<string, SeatMarker> | null {
  const found = new Map<string, SeatMarker>();
  let fd: number;
  try { fd = fs.openSync(path, "r"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? found : null;
  }
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let tail = "";
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, chunkBytes, null);
      if (read === 0) return found;
      const lines = (tail + buffer.toString("latin1", 0, read)).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes("[openrig-msg ")) continue;
        for (const marker of claudeRecordMarkers(line)) found.set(seatMarkerKey(marker), marker);
      }
    }
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** Is this exact marker in a prompt Claude took? Null when the file cannot be read. */
export function transcriptHasPrompt(path: string, needle: string): boolean | null {
  const found = transcriptMarkers(path);
  if (found === null) return null;
  const key = /^\[openrig-msg (.+)\]$/.exec(needle)?.[1];
  const marker = key === undefined ? undefined : found.get(key);
  return marker !== undefined && marker.spooled !== true;
}

export interface SeenReconcile { received: SeatMarker[]; cleared: SeatMarker[]; unsettled: SeatMarker[] }

/** Settles a seat's store against the files its prompts land in. `transcripts` are the files every prompt of this seat may be in; a
 *  record's own file is searched too. Safe to run repeatedly. A record stays when its process may be alive, when no process is named,
 *  or when a file could not be read: clearing on doubt could double a message. */
export function reconcileSeen(input: {
  store: HookSeenStore; seat: string; transcripts: readonly (string | null | undefined)[];
  processAlive: (pid: number) => boolean; markers?: (path: string) => Map<string, SeatMarker> | null;
  /** The caller has proved the seat's agent gone, as a seat restart has. A runtime whose hook names no pid (Codex) relies on this. */
  agentGone?: boolean;
  /** The sha256 of every text the agent was given as context, in a file: null when it cannot be read. Given, a record that names its text (`bodySha256`) and whose
   *  file holds the note but not the text is cleared, not settled: the relay was killed after its record, and the agent never had the text. */
  bodies?: (path: string) => Set<string> | null;
}): SeenReconcile {
  const read = input.markers ?? transcriptMarkers;
  const records = input.store.list(input.seat);
  const paths = new Set<string>();
  for (const path of input.transcripts) if (path) paths.add(path);
  for (const record of records) if (record.transcriptPath) paths.add(record.transcriptPath);
  const present = new Map<string, SeatMarker>();
  let complete = true;
  const bodies = new Set<string>();
  let bodiesKnown = input.bodies !== undefined;
  for (const path of paths) {
    const found = read(path);
    if (found === null) { complete = false; bodiesKnown = false; continue; }
    for (const [key, marker] of found) present.set(key, marker);
    const given = input.bodies?.(path);
    if (given === null) bodiesKnown = false;
    else for (const sha of given ?? []) bodies.add(sha);
  }
  const held = new Map(records.map((record) => [seatMarkerKey(record), record]));
  const result: SeenReconcile = { received: [], cleared: [], unsettled: [] };
  for (const [key, marker] of present) {
    const record = held.get(key);
    if (record?.durable) continue;
    if (!record && marker.spooled) continue;  // the hook never ran, so its body never reached the agent
    if (record?.bodySha256 !== undefined && marker.spooled && input.bodies !== undefined) {
      // The record and the note are here; is the text? Unknown (a file unreadable) settles nothing. Known and missing: the relay was killed after its record.
      if (!bodiesKnown) { result.unsettled.push({ id: record.id, nonce: record.nonce }); continue; }
      if (!bodies.has(record.bodySha256)) { input.store.clear(input.seat, record); result.cleared.push({ id: record.id, nonce: record.nonce }); continue; }
    }
    input.store.markReceived(input.seat, marker);
    if (!record) result.received.push(marker);
  }
  for (const record of records) {
    const marker = { id: record.id, nonce: record.nonce };
    if (record.durable || present.has(seatMarkerKey(marker))) continue;
    if (input.agentGone !== true && (record.agentPid === null || input.processAlive(record.agentPid))) continue;
    if (!complete || paths.size === 0) { result.unsettled.push(marker); continue; }
    input.store.clear(input.seat, marker);
    result.cleared.push(marker);
  }
  return result;
}

/** The inbox's view of a seat's gate. `processAlive` answers for a pid; a recycled pid only delays a clear, which is the safe way round. */
export function nativeSeatGate(store: HookSeenStore, processAlive: (pid: number) => boolean) {
  return {
    reconcile: (seat: string, transcripts: Array<string | null>) => reconcileSeen({ store, seat, transcripts, processAlive }),
    seenBy: (seat: string, marker: SeatMarker) => {
      const read = store.read(seat, marker);
      return read.kind === "seen" ? { agentPid: read.record.agentPid, durable: read.record.durable } : null;
    },
    markReceived: (seat: string, marker: SeatMarker) => store.markReceived(seat, marker),
  };
}
