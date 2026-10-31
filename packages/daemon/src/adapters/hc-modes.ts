/**
 * The private modes a terminal's program has set, read from its stream, and the rule that follows from them. A file of its own so
 * that hc-capture.ts (which asks whether a history read is safe) and hc-viewer.ts (whose stream tracks the modes) do not import
 * each other.
 *
 * Sources: "spike 3" is spike-hc-3-20261031.md (measured on hc 0.1.15, Linux, stubs); "w14" is what hc-viewer.real.test.ts
 * measured against a private core.
 */

/** The private modes the program has on, as far as the stream has said so. */
export interface TerminalModes {
  /** Alternate screen (47, 1047, 1049): a full-screen app, which keeps no scrollback to read. */
  altScreen: boolean;
  /** Mouse reporting (9, 1000, 1001, 1002, 1003). */
  mouse: boolean;
}

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003]);
const MODE_SEQUENCE = /\x1b(?:\[\?([0-9;]*)([hl])|\[!p|c)/g;
/** An escape sequence cut off by the end of a frame; frames split at arbitrary offsets (spike 3). */
const INCOMPLETE_ESCAPE = /\x1b(?:\[[?!]?[0-9;]*)?$/;
const MAX_ESCAPE = 32;

/** Tracks the private modes a program sets, across frame splits. The first paint opens with a soft reset (`ESC[!p`) and then
 *  states the program's own modes (spike 3, w14), so a reset means "none on until stated". */
export class ModeTracker {
  private alt = false;
  private mouse = false;
  private tail = "";

  feed(bytes: Buffer): void {
    const text = this.tail + bytes.toString("latin1");
    this.tail = "";
    for (const match of text.matchAll(MODE_SEQUENCE)) {
      if (match[1] === undefined) {  // ESC[!p or ESC c: back to the defaults
        this.alt = false;
        this.mouse = false;
        continue;
      }
      const on = match[2] === "h";
      for (const part of match[1].split(";")) {
        const mode = Number(part);
        if (part === "" || !Number.isInteger(mode)) continue;
        if (ALT_SCREEN_MODES.has(mode)) this.alt = on;
        if (MOUSE_MODES.has(mode)) this.mouse = on;
      }
    }
    const cut = INCOMPLETE_ESCAPE.exec(text);
    if (cut && cut[0].length <= MAX_ESCAPE) this.tail = cut[0];
  }

  reset(): void {
    this.alt = false;
    this.mouse = false;
    this.tail = "";
  }

  modes(): TerminalModes {
    return { altScreen: this.alt, mouse: this.mouse };
  }
}

/** `terminal.read` with lines above the screen, on a full-screen app that reports the mouse, injects wheel events into the app
 *  to scroll it (w14, a stub on hc 0.1.15). Measured: 13 events on the first read of an idle app and none on later reads of an
 *  unchanged screen; 13 per read, every read, when the screen changes every 5 s; and 600 to 4,700 per read, each read then
 *  taking 10 s and answering `complete: false`, when it changes every second. An alternate screen without mouse reporting
 *  took none but has no history to read. So a history read is unsafe whenever either mode is on, and must never run on a timer. */
export function fullScreenHistoryReadIsUnsafe(modes: TerminalModes): boolean {
  return modes.altScreen || modes.mouse;
}
