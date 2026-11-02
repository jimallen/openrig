/** The hook gate's version, which the relay writes to the seat's `gate.json` at SessionStart. A change to the store's layout bumps it. */
export const HOOK_GATE_VERSION = 2;
/** From this version a seat's hook adds a long message's text from the spool. An older relay would record the short paste and drop the text. */
export const SPOOL_GATE_VERSION = 2;
