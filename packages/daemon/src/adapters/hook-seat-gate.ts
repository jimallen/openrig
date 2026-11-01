// Seat Messaging, stage S2: the daemon's read of a hook gate, the `SeatGate` port over the seen store. Read only.
//
// Two sources, in order (census, part 2): the seen record, and the marker in the file the prompt lands in. The second is what a hook
// that crashed left behind: the prompt ran with no record. The row's nonce comes in through `nonceOf`, because a marker with any other
// nonce is forged: it confirms nothing, and its own record does not stand in the way of the real one.

import fs from "node:fs";
import type { GateLookup, MessageId, SeatGate } from "../domain/seat-messaging/ports.js";
import { HOOK_GATE_VERSION } from "./hook-gate-version.js";
import type { HookSeenStore } from "./hook-seen-store.js";

export interface HookSeatGateDeps {
  store: HookSeenStore;
  /** The nonce the message's row holds; null when it has none yet, which can confirm nothing. */
  nonceOf: (id: MessageId) => string | null;
  /** The files this seat's prompts land in, when known. */
  transcriptsOf: (seat: string) => string[];
  fileIncludes: (path: string, needle: string) => boolean;
}

export function hookSeatGate(deps: HookSeatGateDeps): SeatGate {
  return {
    version: HOOK_GATE_VERSION,
    lookup: async (seat: string, id: MessageId): Promise<GateLookup> => {
      if (deps.store.declaredVersion(seat) === null) return { kind: "unavailable", cause: "no_gate_declared" };
      const nonce = deps.nonceOf(id);
      if (nonce === null) return { kind: "not_seen" };
      const read = deps.store.read(seat, { id, nonce });
      if (read.kind === "seen") return { kind: "seen", record: { id, recordedAt: read.record.recordedAt, nonce } };
      if (read.kind === "unavailable") return read;
      const needle = `[openrig-msg ${id}:${nonce}]`;
      for (const path of deps.transcriptsOf(seat)) {
        if (deps.fileIncludes(path, needle)) return { kind: "seen", record: { id, recordedAt: fs.statSync(path).mtime.toISOString(), nonce } };
      }
      return { kind: "not_seen" };
    },
  };
}
