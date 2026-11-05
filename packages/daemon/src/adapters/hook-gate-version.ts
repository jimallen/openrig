/** The hook gate's version, which the relay writes to the seat's `gate.json` at SessionStart. A change to the store's layout bumps it. */
export const HOOK_GATE_VERSION = 3;
/** From this version a seat's hook adds a long message's text from the spool. An older relay would record the short paste and drop the text. */
export const SPOOL_GATE_VERSION = 2;
/** From this version the seat's relay reads a resend's note, which says ", resent: not confirmed on file" (OF-243). A relay of version 2 does not: it lets the
 *  labelled prompt through as an ordinary one, with no text, and records it with no `bodySha256`, so the row would read received and the text would be lost. A seat
 *  that declared less than this gets the unlabelled resend, which every relay reads. */
export const RESEND_LABEL_GATE_VERSION = 3;
