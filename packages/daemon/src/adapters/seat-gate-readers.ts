// Seat Messaging, stage S2: the daemon's read of the Pi and OMP gate, the `SeatGate` port over seat-gate.log. Read only: the runner owns
// the log. A pda seat has no gate.
//
// A forged marker leaves a `seen` line under its own nonce, so an id can have several lines and only the row's nonce says which is real.
// The port's `lookup` takes no nonce, so the row's nonce comes in through `nonceOf`: a seat confirms an id only under that nonce.

import fs from "node:fs";
import type { GateLookup, MessageId, SeatGate } from "../domain/seat-messaging/ports.js";
import { piSeatPaths } from "./pi-runner-protocol.js";
import { SEAT_GATE_VERSION } from "./seat-gate-marker.js";
import { gateLogRecord, seatGateLogPath } from "./seat-gate-store.js";

export interface PiSeatGateDeps {
  /** The Pi or OMP state root the seat's runner was launched with. */
  stateRoot: string;
  /** The nonce the message's row holds; null when it has none yet, which can confirm nothing. */
  nonceOf: (id: MessageId) => string | null;
}

export function piSeatGate(deps: PiSeatGateDeps): SeatGate {
  return {
    version: SEAT_GATE_VERSION,
    lookup: async (seat: string, id: MessageId): Promise<GateLookup> => {
      let text: string;
      try {
        text = fs.readFileSync(seatGateLogPath(piSeatPaths(deps.stateRoot, seat).seatRoot), "utf8");
      } catch (err) {
        // No log yet: nothing has been marked at this seat, so nothing has arrived. Unavailable here would be a deadlock, because the first
        // marked block is what writes a log from an older runner, and the pump sends nothing while a gate cannot be read.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not_seen" };
        return { kind: "unavailable", cause: (err as NodeJS.ErrnoException).code ?? "unreadable" };
      }
      const nonce = deps.nonceOf(id);
      const record = nonce === null ? null : gateLogRecord(text, { id, nonce });
      return record === null ? { kind: "not_seen" } : { kind: "seen", record: { id, recordedAt: record.at, nonce } };
    },
  };
}
