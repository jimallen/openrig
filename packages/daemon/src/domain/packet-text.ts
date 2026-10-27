/**
 * Text a handover packet types into a successor's pane (`TmuxAdapter.sendText`, bracketed paste).
 *
 * A packet is prose that carries other people's bytes: the reason an operator typed, names, the predecessor's captured
 * screen, and exchanges replayed from its provider record. tmux pastes the buffer between its own `ESC[200~` and
 * `ESC[201~` and does not touch what is inside (measured, tmux 3.4: a buffer holding `ESC[201~` reaches the pane
 * with that sequence intact, so the paste ends early and the rest arrives as typed keys; and if the pane is a shell, the
 * `Enter` that follows runs it). A control character in a packet is never wanted, so none is delivered: every C0
 * control except newline and tab, DEL and every C1 control (including the 8-bit CSI that stands for `ESC[`) is removed.
 * The printable residue of a removed sequence (`[201~`) is harmless text.
 */
const PACKET_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function inertPacketText(text: string): string {
  return text.replace(PACKET_CONTROLS, "");
}
