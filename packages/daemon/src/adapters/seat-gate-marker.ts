// Seat Messaging, stage S2 (census-delivery-guarantees-20261101.md, part 2): the marker a message carries to a seat's gate. One format
// for every runtime: `[openrig-msg <id>:<nonce>]` on its own line at the end of the block, one per row of a wake group, the same bytes
// `nativeMarker` writes (domain/claude-native-inbox.ts; seat-gate-marker.test.ts holds the two together). Pure, and imports nothing
// from the daemon, because the pane-hosted runners load it.
//
// A marker is a claim, not a proof: a runner cannot tell a real nonce from a forged one, only the daemon holds it. So a gate treats
// (id, nonce) as the identity. A forged pair is then a different message: it can neither confirm the real id nor stand in the way of it.

export interface SeatMarker {
  id: string;
  nonce: string;
  /** This prompt is a long message's short paste: its text came from the hook, so the prompt alone proves nothing (see `spooledNote`). */
  spooled?: boolean;
}

/** Written to a runner's sidecar: the gate this runner carries. Absent from a runner older than S2, which has none. */
export const SEAT_GATE_VERSION = 1;

const MARKER_LINE = /^\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\]$/;

export function seatMarkerKey(marker: SeatMarker): string {
  return `${marker.id}:${marker.nonce}`;
}

/** What a provider wraps a prompt in, closing after the marker: Claude's socket envelope and its multi-line paste (s0 M3). */
const WRAPPER_CLOSE = /^<\/(?:cross-session-message|pasted_content(?: id="[^"]*")?)>$/;

/** The markers a prompt carries: its trailing lines only, read through a closing wrapper. A marker quoted anywhere else is that message's
 *  text, by a person or a model, and confirms and blocks nothing. activity-relay.cjs holds the same rule, in CommonJS. */
export function trailingMarkers(prompt: string): SeatMarker[] {
  const lines = prompt.split("\n").map((line) => line.replace(/\r$/, ""));
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.trim() === "" || WRAPPER_CLOSE.test(lines[end - 1]!.trim()))) end -= 1;
  const markers: SeatMarker[] = [];
  while (end > 0) {
    const match = MARKER_LINE.exec(lines[end - 1]!.trim());
    if (!match) break;
    markers.unshift({ id: match[1]!, nonce: match[2]! });
    end -= 1;
  }
  return markers;
}

/** The line above the marker of a long message's short paste. Its body is not in the prompt: the gate hook adds it as `additionalContext`, from
 *  the seat's spool. activity-relay.cjs reads the same line. A hook that crashed let that prompt run with no body, so such a prompt in a
 *  transcript is no proof of arrival, and only the hook's own record is. */
export function spooledNote(part: { index: number; total: number } | null): string {
  return `OpenRig: long message${part === null ? "" : `, part ${part.index} of ${part.total}`}. Its text comes with this prompt as additional context. If you do not see it, OpenRig sends it again.`;
}
const SPOOLED_NOTE = /^OpenRig: long message(?:, part \d+ of \d+)?\. Its text comes with this prompt as additional context\. If you do not see it, OpenRig sends it again\.$/;

/** `trailingMarkers`, each saying whether its prompt is a long message's short paste. A record of a prompt uses this one. */
export function promptMarkers(prompt: string): SeatMarker[] {
  const markers = trailingMarkers(prompt);
  if (markers.length !== 1) return markers;
  const lines = prompt.split("\n").map((line) => line.replace(/\r$/, "").trim());
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === "" || WRAPPER_CLOSE.test(lines[end - 1]!))) end -= 1;
  return SPOOLED_NOTE.test(lines[end - 2] ?? "") ? [{ ...markers[0]!, spooled: true }] : markers;
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
