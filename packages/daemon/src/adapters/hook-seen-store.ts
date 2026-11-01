// Seat Messaging, stage S2: the seen store of a seat whose gate is a provider hook (census-delivery-guarantees-20261101.md, part 2).
// The relay (activity-relay.cjs) writes it before the agent sees a prompt: one file per message at
// `<home>/state/seat-gates/<seat>/seen/<sha256 of id:nonce>`, created atomically, so a repeat is refused with no daemon. This module is
// the daemon's side, and it knows no runtime: Claude's transcript and Codex's rollout are both a file the marker lands in.
//
// A hook's record and a durable prompt are two facts, and either can exist alone (M5, and a hook that crashes fails open):
//   - record, no prompt: the hook ran and the agent died before persisting. Reconcile clears it, so a resend passes.
//   - prompt, no record: the hook crashed or timed out and the prompt ran. Reconcile records it, so a resend is refused.
// Reconcile acts only on a record whose agent process is proven dead: a live agent's transcript lags its hook, always (M5).

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { NATIVE_MARKER_RE } from "../domain/claude-native-inbox.js";
import { seatMarkerKey, type SeatMarker } from "./seat-gate-marker.js";

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

/** Every marker in a transcript or rollout, read in chunks with an overlap so none is split: an empty set when the file does not exist
 *  (the agent writes it with the first prompt, M5), null when it cannot be read, which proves nothing either way. */
export function transcriptMarkers(path: string, chunkBytes = 4 * 1024 * 1024): Map<string, SeatMarker> | null {
  const overlap = 256;
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
      const text = tail + buffer.toString("latin1", 0, read);
      for (const match of text.matchAll(NATIVE_MARKER_RE)) {
        const marker = { id: match[1]!, nonce: match[2]! };
        found.set(seatMarkerKey(marker), marker);
      }
      tail = text.slice(-overlap);
    }
  } catch { return null; } finally { fs.closeSync(fd); }
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
}): SeenReconcile {
  const read = input.markers ?? transcriptMarkers;
  const records = input.store.list(input.seat);
  const paths = new Set<string>();
  for (const path of input.transcripts) if (path) paths.add(path);
  for (const record of records) if (record.transcriptPath) paths.add(record.transcriptPath);
  const present = new Map<string, SeatMarker>();
  let complete = true;
  for (const path of paths) {
    const found = read(path);
    if (found === null) { complete = false; continue; }
    for (const [key, marker] of found) present.set(key, marker);
  }
  const held = new Map(records.map((record) => [seatMarkerKey(record), record]));
  const result: SeenReconcile = { received: [], cleared: [], unsettled: [] };
  for (const [key, marker] of present) {
    const record = held.get(key);
    if (record?.durable) continue;
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
