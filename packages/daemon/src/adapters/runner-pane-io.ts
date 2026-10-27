// pda runtime L0 (pda-runtime-design-9l Rev 2, "Input framing"): the pane-input editor and the activity
// endpoint lookup shared by every pane-hosted runner. Extracted from pi-runner.ts unchanged; pi-runner.ts
// imports and re-exports both, so the Pi and OMP runners behave byte-for-byte as before.
//
// Three options exist for runners that are not Pi:
//   - `label`: the "[<label>]" prefix of the editor's own pane lines (default "pi-runner").
//   - `onInterrupt`: what Ctrl-C does after it clears the line. The default prints "input cleared" and
//     submits "/abort", which is Pi's interrupt. A pda runner must never stop its agent, so it passes its own.
//   - `interruptInsidePaste`: "interrupt" (default, Pi's behaviour) treats an ETX byte anywhere as Ctrl-C,
//     even inside a bracketed paste. "content" keeps an ETX between ESC[200~ and ESC[201~ as pasted text: a
//     paste is content, never a key. The review measured the default splitting one paste into
//     ["/abort", "one", "line two"]. In that mode a paste whose closing marker never arrives swallows Ctrl-C and
//     Enter, so the editor says so on the pane once the paste has stayed open for `PASTE_OPEN_HINT_MS` (OF-119).
//
// Only node builtins and local runner helpers are imported, so a compiled runner entry stays runnable as
// `node <dist>/adapters/<runner>.js` with no daemon dependencies.

import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { formatDaemonHostForUrl } from "./daemon-url.js";

// Canonical TTY buffers can overflow before Node sees even the paste terminator.
// Use Node's line editor in raw mode, with only paste framing handled here.
export const MAX_RUNNER_INPUT_BYTES = 1024 * 1024;
/** OF-119: how long a bracketed paste may stay open before the editor tells the operator what holds Ctrl-C and Enter,
 *  and (OF-148) before the runner records `pasteOpen` so `rig send` refuses. A terminal or tmux delivers a paste in one
 *  write, so an open paste after this long has lost its closing marker. OF-151: 2 s, down from 10 s, to shorten the
 *  window in which a send after a lost marker is not refused. The largest paste the editor accepts (1 MiB) was fed through
 *  this editor in 16 KiB writes in about 30 ms (measured, in-process, not through a pty), so 2 s leaves a wide margin for
 *  tmux and the pty to deliver it. A genuine paste slower than 2 s (a slow link) is flagged open, and when it then closes
 *  its text is on the line, so OF-153 sets `pasteLeftover`: `rig send` is refused until the line is submitted or cleared
 *  (Ctrl-C), and a retry does not clear it. */
export const PASTE_OPEN_HINT_MS = 2_000;

export interface RunnerInputOptions {
  /** The "[<label>]" prefix of the editor's own pane lines. Default "pi-runner". */
  label?: string;
  /** Runs after Ctrl-C clears the line. Default: print "input cleared" and submit "/abort" (Pi's interrupt). */
  onInterrupt?: () => void;
  /** "interrupt" (default): ETX is Ctrl-C everywhere. "content": ETX inside a bracketed paste is pasted text. */
  interruptInsidePaste?: "interrupt" | "content";
  /** OF-119: the open-paste hint delay (default PASTE_OPEN_HINT_MS). Used only in "content" mode, where Ctrl-C cannot end a paste. */
  pasteOpenHintMs?: number;
  /** OF-148: told when a bracketed paste has stayed open past the hint delay (true) and when it ends by any road: its
   *  closing marker, an Esc-then-[201~ typed by hand, or the editor closing (false). Fired only on those two edges, so a
   *  paste that closes in time reports nothing. Used only in "content" mode, with the hint. The runner records it in its
   *  sidecar so `rig send` can refuse instead of delivering text the open paste would swallow. */
  onPasteOpenChange?: (open: boolean) => void;
  /** OF-153: told when the editor line starts to hold text that came from a paste which had been flagged open (the hint
   *  fired, so the operator closed it by hand or its marker arrived late) and has since closed without the line being
   *  cleared (true), and when that line is emptied by any road: Ctrl-C, a submit, backspacing it empty, or the editor
   *  closing (false). Edge-only. Ordinary typing and a paste that closed in time never report: only a recovered lost
   *  paste does. The runner records it in its sidecar so `rig send` refuses instead of appending to the stale text. */
  onPasteLeftoverChange?: (held: boolean) => void;
}

export function createRunnerInput(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  onSubmit: (block: string) => void,
  options: RunnerInputOptions = {},
): readline.Interface {
  const label = options.label ?? "pi-runner";
  const etxInPasteIsContent = options.interruptInsidePaste === "content";
  const reject = () => output.write(
    `[${label}] input rejected: maximum 1048576 UTF-8 bytes; send a smaller message. Ctrl-C clears unfinished input.\n`,
  );
  const submit = (block: string) => {
    if (Buffer.byteLength(block) > MAX_RUNNER_INPUT_BYTES) reject();
    else if (block.trim()) onSubmit(block);
  };
  // A pipe has no kernel line limit or terminal editing; each line is a message.
  if (!input.isTTY || !output.isTTY) {
    return readline.createInterface({ input, crlfDelay: Infinity }).on("line", submit);
  }

  const keys = new PassThrough();
  const editor = readline.createInterface({
    input: keys, output, terminal: true, prompt: "", historySize: 0, crlfDelay: Infinity,
  });
  // Node forces dumb-terminal mode without editing if TERM=dumb. When terminal: true
  // was requested, remove the dumb-mode override so VT100 line editing is preserved.
  if (Object.prototype.hasOwnProperty.call(editor, "_ttyWrite")) {
    delete (editor as any)._ttyWrite;
  }
  const decoder = new StringDecoder("utf8");
  // OF-119: in "content" mode an unclosed paste holds Ctrl-C and Enter as text, so after a while say how to get out.
  let pasteHint: ReturnType<typeof setTimeout> | null = null;
  // OF-148: whether the owner was last told "open". The report follows the hint (an open paste past the delay), so a
  // paste still arriving, or just closed in the pane, never reads as lost to a `rig send` racing it.
  let pasteOpenReported = false;
  const reportPasteOpen = (open: boolean) => {
    if (pasteOpenReported === open) return;
    pasteOpenReported = open;
    try { options.onPasteOpenChange?.(open); } catch { /* a sidecar write failing must not break the editor */ }
  };
  // OF-153: whether the owner was last told the line holds a recovered lost paste.
  let pasteLeftoverReported = false;
  const reportPasteLeftover = (held: boolean) => {
    if (pasteLeftoverReported === held) return;
    pasteLeftoverReported = held;
    try { options.onPasteLeftoverChange?.(held); } catch { /* a sidecar write failing must not break the editor */ }
  };
  const armPasteHint = () => {
    if (!etxInPasteIsContent) return;
    pasteHint = setTimeout(() => {
      pasteHint = null;
      reportPasteOpen(true);
      output.write(`\n[${label}] paste still open (its end marker has not arrived): Ctrl-C and Enter are pasted text until it closes. Paste anything, or type Esc then [201~, to close it. Ctrl-C after that clears the line${options.onInterrupt ? "" : " and aborts the current turn"}.\n`);
    }, options.pasteOpenHintMs ?? PASTE_OPEN_HINT_MS);
    pasteHint.unref?.();
  };
  const disarmPasteHint = () => {
    if (pasteHint) { clearTimeout(pasteHint); pasteHint = null; }
    reportPasteOpen(false);
  };
  let pending = "";
  let paste: string | null = null;
  let pasteBytes = 0;
  let discarded = false;
  const setLine = (line: string, cursor: number) => {
    // Node documents changing rl.line together with rl.cursor. The installed
    // typings mark them readonly, so assign this pair through one explicit seam.
    Object.assign(editor, { line, cursor });
    editor.prompt(true);
  };
  const clear = () => setLine("", 0);
  const consume = (text: string) => {
    if (paste === null) {
      keys.write(text);
    } else if (!discarded) {
      pasteBytes += Buffer.byteLength(text);
      if (pasteBytes > MAX_RUNNER_INPUT_BYTES) {
        paste = "";
        discarded = true;
        clear();
        reject();
      } else paste += text;
    }
  };
  // OF-153: the recovered paste's text has left the line (Ctrl-C, a submit, or backspaced away): nothing is left to append to.
  const settleLeftover = () => { if (pasteLeftoverReported && editor.line.length === 0) reportPasteLeftover(false); };
  const receive = (chunk: Buffer) => {
    pending += decoder.write(chunk);
    while (pending) {
      const marker = paste === null ? "\u001b[200~" : "\u001b[201~";
      const boundary = pending.indexOf(marker);
      // Inside a paste in "content" mode, ETX is text: only the closing marker ends the paste.
      const interrupt = paste !== null && etxInPasteIsContent ? -1 : pending.indexOf("\u0003");
      const at = boundary < 0 ? interrupt : interrupt < 0 ? boundary : Math.min(boundary, interrupt);
      if (at < 0) {
        // Retain only a possible split marker; normal editing keys go to Node.
        let tail = Math.min(marker.length - 1, pending.length);
        while (tail && !marker.startsWith(pending.slice(-tail))) tail--;
        consume(pending.slice(0, pending.length - tail));
        pending = pending.slice(pending.length - tail);
        break;
      }
      consume(pending.slice(0, at));
      pending = pending.slice(at + (at === interrupt ? 1 : marker.length));
      if (at === interrupt) {
        disarmPasteHint();
        paste = null;
        discarded = false;
        clear();
        if (options.onInterrupt) options.onInterrupt();
        else {
          output.write(`\n[${label}] input cleared\n`);
          onSubmit("/abort");
        }
      } else if (paste === null) {
        paste = "";
        pasteBytes = 0;
        discarded = false;
        armPasteHint();
      } else {
        // OF-153: a paste that had been reported open (the hint fired) was recovered by hand or arrived late. Its text goes
        // into the line like any paste, but the operator may not notice it is there, so the next `rig send` would be
        // appended to it. Leftover is reported BEFORE the open flag is cleared: the sidecar never shows neither.
        const recoveredLostPaste = pasteOpenReported;
        if (!discarded) {
          const line = editor.line.slice(0, editor.cursor) + paste + editor.line.slice(editor.cursor);
          if (Buffer.byteLength(line) > MAX_RUNNER_INPUT_BYTES) { clear(); reject(); }
          else {
            // rl.write(text) treats pasted newlines as submits. These public
            // editing fields insert the whole literal paste without submitting.
            setLine(line, editor.cursor + paste.length);
            if (recoveredLostPaste && paste.length > 0) reportPasteLeftover(true);
          }
        }
        disarmPasteHint();
        paste = null;
      }
    }
  };
  const wasRaw = input.isRaw;
  const end = () => editor.close();
  input.setRawMode(true);
  output.write("\u001b[?2004h");
  const onData = (chunk: Buffer) => { receive(chunk); settleLeftover(); };
  input.on("data", onData);
  input.once("end", end);
  editor.on("line", submit);
  editor.once("close", () => {
    disarmPasteHint();
    reportPasteLeftover(false);
    input.removeListener("data", onData);
    input.removeListener("end", end);
    input.setRawMode(wasRaw);
    input.pause();
    keys.destroy();
    output.write("\u001b[?2004l");
  });
  return editor;
}

/** Where a runner posts activity: OPENRIG_URL (or OPENRIG_HOST/OPENRIG_PORT) and OPENRIG_ACTIVITY_HOOK_TOKEN,
 *  falling back to `<OPENRIG_HOME>/activity-endpoint.json`. Null when either half is missing. */
export function resolveActivityEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | null {
  let baseUrl = env.OPENRIG_URL?.trim() || null;
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() || null;
  if (!baseUrl && env.OPENRIG_PORT) {
    const rawHost = env.OPENRIG_HOST?.trim() || "127.0.0.1";
    baseUrl = `http://${formatDaemonHostForUrl(rawHost)}:${env.OPENRIG_PORT.trim()}`;
  }
  if (!baseUrl || !token) {
    try {
      const home = env.OPENRIG_HOME?.trim() || nodePath.join(process.env.HOME ?? "", ".openrig");
      const parsed = JSON.parse(fs.readFileSync(nodePath.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string") token = parsed.token;
    } catch {
      // absent/malformed — activity POSTs no-op; the sidecar + mirror still work.
    }
  }
  return baseUrl && token ? { baseUrl, token } : null;
}
