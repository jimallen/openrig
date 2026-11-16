import { redactTranscriptContent } from "../transcript-redaction.js";
import { carryOriginOf } from "./message-store.js";

// workspaces-o9o.9 — what waits for a seat, row by row. Since d0303ca8 `rig send` tells a sender "N queued (seat busy)", and nothing
// listed those rows: `rig seat held-messages` lists only what the typing guard retains. An operator deciding whether to relaunch a seat
// could not see what was waiting for it. This is the one reading of a seat's open rows (the ones the pump still owes a delivery), in the
// order the pump takes them. It decides nothing and changes nothing.

/** One open row as the store holds it. `recordedAt` is the row's dispatch time, as the store stamped it. */
export interface QueuedRow {
  id: string;
  sender: string;
  recordedAt: string;
  state: "accepted" | "attempting";
  attempts: number;
  lane: number;
  pauseReason: string | null;
  lastRefusal: string | null;
  nextAttemptAt: string | null;
  /** Set when the row was first sent to an earlier occupant of the seat: it goes to this one as a re-delivery. */
  previousOccupant: string | null;
  body: string;
}

/** The outbound port: the open rows of one seat, as the store keeps them. */
export interface QueuedMessageReader {
  /** The seat's open rows in the pump's order (lowest lane first, then oldest first), at most `limit`, and how many there are in all. */
  openRowsFor(seat: string, limit: number): { rows: QueuedRow[]; total: number };
  /** Whether this host knows a session by this exact name. A far seat may have none here and still have rows. */
  knownSeat(seat: string): boolean;
  /** The stored body of the message with this id, whatever its state, or null when no such row is kept. */
  bodyOf(id: string): string | null;
}

/** How long a preview may be, in characters, after redaction. */
export const QUEUED_PREVIEW_CHARS = 120;

export interface QueuedMessage extends Omit<QueuedRow, "body"> {
  /** Set on a relaunch's re-delivery row (workspaces-o9o.7, `carryOriginOf`): the id of the message the previous occupant took. */
  redeliveryOf: string | null;
  /** The body, redacted by the transcript policy and then cut: redaction sees the whole body, so a cut can never split a secret past it.
   *  A re-delivery row previews the ORIGINAL message's body, since its own opens with o9o.7's re-delivery label; when the original row is no
   *  longer kept, it previews its own body. */
  preview: string;
  /** The row's whole body (as it will be delivered) in UTF-8 bytes, so a short preview of a long message reads as short. */
  bodyBytes: number;
}

export interface QueuedListing {
  seat: string;
  knownSeat: boolean;
  total: number;
  /** The policy each preview went through. */
  redaction: "transcript";
  items: QueuedMessage[];
}

export function previewOf(body: string): string {
  const flat = redactTranscriptContent(body).replace(/\s+/g, " ").trim();
  return flat.length <= QUEUED_PREVIEW_CHARS ? flat : `${flat.slice(0, QUEUED_PREVIEW_CHARS - 1)}…`;
}

/** The use case: list what waits for `seat`. */
export function listQueued(reader: QueuedMessageReader, seat: string, limit: number): QueuedListing {
  const { rows, total } = reader.openRowsFor(seat, limit);
  return {
    seat, knownSeat: reader.knownSeat(seat), total, redaction: "transcript",
    items: rows.map(({ body, ...row }) => {
      const redeliveryOf = carryOriginOf(row.id);
      const shown = redeliveryOf === null ? body : reader.bodyOf(redeliveryOf) ?? body;
      return { ...row, redeliveryOf, preview: previewOf(shown), bodyBytes: Buffer.byteLength(body, "utf8") };
    }),
  };
}

/** The command a sender is pointed at to see the rows behind a "queued" count. `word` quotes the seat name for a shell. */
export function queuedListCommand(seat: string, word: (value: string) => string): string {
  return `rig seat queued ${word(seat)}`;
}
