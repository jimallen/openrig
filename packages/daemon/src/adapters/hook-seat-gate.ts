// Seat Messaging, stage S2: the daemon's read of a hook gate, the `SeatGate` port over the seen store. Read only, but for one clear (below).
//
// Two sources, in order (census, part 2): the seen record, and the marker in the file the prompt lands in. The second is what a hook
// that crashed left behind: the prompt ran with no record. The row's nonce comes in through `nonceOf`, because a marker with any other
// nonce is forged: it confirms nothing, and its own record does not stand in the way of the real one.
//
// A long message's record is not enough alone (OF-229). The relay writes it before it has exited, and an agent takes a hook's output only from a hook
// that exited: killed after its record, the relay leaves a record and the agent without the text. So a record that names its text (`bodySha256`) reads as
// seen only once the agent's own file holds that text. Until then the gate is unavailable (the file may lag the hook); past `bodyGraceMs` from the record
// it is a record of nothing, and is cleared, so the next attempt passes the relay again and carries the text. A second copy is the safe way round.

import fs from "node:fs";
import type { GateLookup, MessageId, SeatGate } from "../domain/seat-messaging/ports.js";
import { HOOK_GATE_VERSION } from "./hook-gate-version.js";
import type { HookSeenStore, SeenRecord } from "./hook-seen-store.js";

export interface HookSeatGateDeps {
  store: HookSeenStore;
  /** The nonce the message's row holds; null when it has none yet, which can confirm nothing. */
  nonceOf: (id: MessageId) => string | null;
  /** The files this seat's prompts land in, when known. */
  transcriptsOf: (seat: string) => string[];
  /** null: the file could not be read, which proves nothing either way. */
  fileIncludes: (path: string, needle: string) => boolean | null;
  /** Given, a record that names its text is believed only when this says the file holds it. null: the file cannot be read. Claude's gate gives none. */
  bodyOnFile?: (path: string, bodySha256: string) => boolean | null;
  /** How long the agent's file may lag a record before the text is taken as lost. Default `BODY_GRACE_MS`. */
  bodyGraceMs?: number;
  now?: () => number;
  /** How many times a part's record may be cleared and the part sent again for want of its text on file, before the gate stops (default `MAX_UNCONFIRMED_RESENDS`). */
  maxResends?: number;
}

/** OF-243. A rollout path that is wrong for good would clear the record, and send the part, every grace period for ever. Three: each resend is one more
 *  9000-byte copy in the agent's conversation, and a relay that is killed inside its 7 ms window three attempts running does not happen by chance, so
 *  a part still missing from the file after three is a file we cannot read the way we think we can. Then the record stands, as it did before the text
 *  was checked, and `rig health` says so. */
export const MAX_UNCONFIRMED_RESENDS = 3;

/** Longer than the hook's own timeout (5 s) and the time Codex takes to put its context on file. A text that shows up later than this is delivered twice, never lost. */
export const BODY_GRACE_MS = 30_000;

export function hookSeatGate(deps: HookSeatGateDeps): SeatGate {
  const now = deps.now ?? Date.now;
  /** null: the record stands. Otherwise what the gate says instead. */
  const bodyUnconfirmed = (seat: string, id: MessageId, nonce: string, record: SeenRecord): GateLookup | null => {
    if (record.bodySha256 === undefined || record.durable || deps.bodyOnFile === undefined) return null;
    const paths = new Set(deps.transcriptsOf(seat));
    if (record.transcriptPath) paths.add(record.transcriptPath);
    if (paths.size === 0) return null;  // no file to look in: nothing can be told, and the record is all there is
    let unreadable = false;
    for (const path of paths) {
      const held = deps.bodyOnFile(path, record.bodySha256);
      if (held === true) return null;
      if (held === null) unreadable = true;
    }
    const age = now() - Date.parse(record.recordedAt);
    const lapsed = Number.isFinite(age) && age >= (deps.bodyGraceMs ?? BODY_GRACE_MS);
    if (unreadable) {
      // A file that stays unreadable proves nothing either way, and `unavailable` holds the seat's whole lane (OF-212), so it is bounded: from the grace on, the
      // record stands as it did before the text was checked. Clearing it instead would resend a copy every grace period for as long as the file stays unreadable.
      return lapsed ? null : { kind: "unavailable", cause: "transcript_unreadable" };
    }
    if (lapsed) {
      const marker = { id, nonce };
      if (deps.store.resentOf(seat, marker) >= (deps.maxResends ?? MAX_UNCONFIRMED_RESENDS)) {
        deps.store.giveUp(seat, marker);
        return null;
      }
      deps.store.noteResent(seat, marker);
      deps.store.clear(seat, marker);
      return { kind: "not_seen" };
    }
    return { kind: "unavailable", cause: "body_unconfirmed" };
  };
  return {
    version: HOOK_GATE_VERSION,
    lookup: async (seat: string, id: MessageId, row: MessageId = id): Promise<GateLookup> => {
      if (deps.store.declaredVersion(seat) === null) return { kind: "unavailable", cause: "no_gate_declared" };
      const nonce = deps.nonceOf(row);
      if (nonce === null) return { kind: "not_seen" };
      const read = deps.store.read(seat, { id, nonce });
      if (read.kind === "seen") {
        return bodyUnconfirmed(seat, id, nonce, read.record) ?? { kind: "seen", record: { id, recordedAt: read.record.recordedAt, nonce } };
      }
      if (read.kind === "unavailable") return read;
      const needle = `[openrig-msg ${id}:${nonce}]`;
      for (const path of deps.transcriptsOf(seat)) {
        const included = deps.fileIncludes(path, needle);
        if (included === null) return { kind: "unavailable", cause: "transcript_unreadable" };
        if (included) return { kind: "seen", record: { id, recordedAt: fs.statSync(path).mtime.toISOString(), nonce } };
      }
      return { kind: "not_seen" };
    },
  };
}
