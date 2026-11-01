// Seat Messaging, stage S2 (census-delivery-guarantees-20261101.md, part 2): the marker a message carries to a seat's gate. One format
// for every runtime: `[openrig-msg <id>:<nonce>]` on its own line at the end of the block, one per row of a wake group, the same bytes
// `nativeMarker` writes (domain/claude-native-inbox.ts; seat-gate-marker.test.ts holds the two together). Pure, and imports nothing
// from the daemon, because the pane-hosted runners load it.
//
// A marker is a claim, not a proof: a runner cannot tell a real nonce from a forged one, only the daemon holds it. So a gate treats
// (id, nonce) as the identity. A forged pair is then a different message: it can neither confirm the real id nor stand in the way of it.

export interface SeatMarker { id: string; nonce: string }

/** Written to a runner's sidecar: the gate this runner carries. Absent from a runner older than S2, which has none. */
export const SEAT_GATE_VERSION = 1;

const MARKER_LINE = /^\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\]$/;

export function seatMarkerKey(marker: SeatMarker): string {
  return `${marker.id}:${marker.nonce}`;
}

/** The text a gate passes on, and the markers it found. Only the block's trailing lines count: a marker quoted inside a message is
 *  that message's text, and stays. A block with no trailing marker comes back whole, `markers` empty. */
export function splitMarkedBlock(block: string): { text: string; markers: SeatMarker[] } {
  const lines = block.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  const markers: SeatMarker[] = [];
  let start = end;
  while (start > 0) {
    const match = MARKER_LINE.exec(lines[start - 1]!.replace(/\r$/, ""));
    if (!match) break;
    markers.unshift({ id: match[1]!, nonce: match[2]! });
    start -= 1;
  }
  if (markers.length === 0) return { text: block, markers };
  while (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  return { text: lines.slice(0, start).join("\n"), markers };
}
