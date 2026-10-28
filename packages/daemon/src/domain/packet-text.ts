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

/**
 * Text OpenRig itself types into an agent's pane at startup (OF-169, Jim 2026-10-28, "Strip controls, keep tab/newline"):
 * startup files, identity / challenge / preload prompts and action values. It is operator- or system-authored prose
 * pasted into a bracketed paste, so a control character in it is never wanted. Same class as `inertPacketText`, except
 * TAB, LF and CR survive (a startup file is multi-line and may be indented): every other C0 control, DEL and every C1
 * control is removed. That removes ESC and the 8-bit CSI, so it also removes every paste-end sequence (OF-160), and no
 * removal can join two neighbours into a new control. `rig send` is deliberately not this: a person's message is
 * refused for the paste-end marker only (`containsPasteTerminator`).
 */
const STARTUP_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function inertStartupText(text: string): string {
  return text.replace(STARTUP_CONTROLS, "");
}

/**
 * The sequences that END a bracketed paste: `CSI 201 ~`, where CSI is `ESC[` or the 8-bit `U+009B`. tmux frames a
 * pasted buffer with its own `ESC[200~` ... `ESC[201~` and leaves the inside alone, so text that carries one of these
 * closes the paste early and the rest arrives as typed keys (a shell runs it on the next Enter). A message sent to a
 * seat is prose, never a terminal command, so `rig send` refuses it (`containsPasteTerminator`) and the terminal
 * broker's bracketed paste removes it (`stripPasteTerminators`). Only these sequences are touched: other bytes, and
 * unbracketed key input, are not this module's business.
 *
 * Variant spellings (a5, y4 review F5). The canonical end marker is exactly `ESC[201~` (xterm ctlseqs, "Bracketed Paste
 * Mode"), and tmux ends its own paste framing with exactly that string. What ends a paste inside the pane, though, is the
 * application's input parser, which this repo cannot see for Claude Code or Codex (not measured). ECMA-48 parsers read a
 * CSI parameter as a number, so `ESC[0201~` is 201 to them, and a parser that takes the first parameter of
 * `ESC[201;1~` reads 201 too. Whether any shipped TUI ends a paste on those spellings is not established, so the rule is
 * the conservative one: a CSI whose first parameter reads as 201 (leading zeros allowed, further `;` or `:` parameters
 * allowed) and whose final byte is `~` is a paste end, for all three rules (refuse, strip, broker). The cost is a
 * message that carries a raw ESC or U+009B in that exact shape; no prose has one. Not matched, on purpose: a different
 * first parameter (`ESC[2010~`, `ESC[20~`), a private marker (`ESC[?201~`) and the printable residue `[201~`.
 */
const PASTE_END_SOURCE = "(?:\\u001b\\[|\\u009b)0*201(?:[;:][0-9;:]*)?~";
const PASTE_TERMINATOR = new RegExp(PASTE_END_SOURCE);
const PASTE_TERMINATORS = new RegExp(PASTE_END_SOURCE, "g");

export function containsPasteTerminator(text: string): boolean {
  return PASTE_TERMINATOR.test(text);
}

/** Remove every paste terminator. Repeats until none is left: removing one can join its neighbours into a new one
 *  (`ESC[2` + `ESC[201~` + `01~`). */
export function stripPasteTerminators(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(PASTE_TERMINATORS, "");
    if (next === current) return next;
    current = next;
  }
}
