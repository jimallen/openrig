import { HcClient, HcUnavailableError } from "./hc-client.js";
import { hcTerminalRef, isAbsentFailure, isHcFailure } from "./hc-identity.js";
import type { PaneCapture } from "./tmux.js";

export type { PaneCapture };

/** What `terminal.read` answers: the screen plus `lines` of history above it, as plain text. */
interface ReadResult { text: string; complete: boolean; how: string; why?: string | null }

/** Reads in flight at once in a batched capture. There is no batched call in hc, so this bounds connections, where the tmux
 *  adapter's CAPTURE_BATCH bounds one chained command. */
export const HC_CAPTURE_BATCH = 24;

/** More history than any terminal keeps (about 570,000 cells: 6,300 rows at 90 columns, 14,000 at 40; spike 3). */
const WHOLE_HISTORY = 10_000_000;

/**
 * Pane text from `terminal.read`, behind the capture methods of the tmux adapter it replaces.
 *
 * What differs from `tmux capture-pane`, measured on hc 0.1.15 (hc-capture.real.test.ts):
 * - Text is plain. There are no escape sequences and no cursor; both need the attach stream (design gap 3). A request for
 *   escapes is answered with null, never with plain text passed off as styled: session-transport.ts reads a faint
 *   suggestion from the styled capture, and null leaves its draft verdict standing.
 * - A soft-wrapped line comes back as one line, as `-J` gives; there is no unjoined form.
 * - A line's trailing spaces are dropped (`-J` keeps them), and trailing blank rows of the screen are dropped.
 * - The screen is the terminal's, 200x120 unless a viewer sets another size, so `lines` of history above it make up to
 *   `lines` + 120 rows.
 * - `lines` counts history above the screen, as tmux's `-S -N` does.
 * - A full-screen app has no history to read: `complete` is false and only the screen comes back. A finished terminal keeps 1,000 history rows.
 */
export class HcCapture {
  private readonly now: () => Date;

  constructor(private readonly client: HcClient = new HcClient(), options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** One read. Null when the target is not there; hc's refusals and an unreachable core throw. */
  private async read(target: string, lines: number): Promise<ReadResult | null> {
    const ref = hcTerminalRef(target);
    if (ref === null) return null;
    try {
      return await this.client.call<ReadResult>("terminal.read", { terminal: ref, lines });
    } catch (err) {
      if (isAbsentFailure(err)) return null;
      throw err;
    }
  }

  /** The tmux adapter returns null for any failed capture; so does this for any failure of hc's or the socket's. */
  private async readOrNull(target: string, lines: number): Promise<ReadResult | null> {
    try {
      return await this.read(target, lines);
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  /** The last `lines` of history and the screen, each line newline-terminated as tmux prints them; null when empty or unreadable. */
  async capturePaneContent(paneId: string, lines: number = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> {
    if (opts?.escapeSequences === true) return null;  // no equivalent: escapes come only from the attach stream
    return terminated((await this.readOrNull(paneId, lines))?.text);
  }

  /** The visible screen only. */
  async capturePaneScreen(paneId: string): Promise<string | null> {
    return terminated((await this.readOrNull(paneId, 0))?.text);
  }

  /** The whole history and screen. Null unless hc says the read is `complete`: a count taken against a partial history would
   *  show an old line as new (seat-restart-in-place.ts counts Account lines against an earlier capture). */
  async capturePaneHistory(paneId: string): Promise<string | null> {
    const result = await this.readOrNull(paneId, WHOLE_HISTORY);
    return result?.complete ? terminated(result.text) : null;
  }

  /**
   * Several seats' text at once, as `capturePanesContent` of the tmux adapter: a Map keyed by the target as given, each entry
   * carrying the time its own chunk was read; `missing` marks a terminal hc says is not there. A read that fails for any other reason
   * leaves its target out, for the caller to read alone. Null when the core cannot be reached and nothing was read.
   */
  async capturePanesContent(targets: string[], lines: number = 20, now: () => Date = this.now): Promise<Map<string, PaneCapture> | null> {
    const out = new Map<string, PaneCapture>();
    let unreachable = false;
    const unique = [...new Set(targets)];
    for (let i = 0; i < unique.length && !unreachable; i += HC_CAPTURE_BATCH) {
      const chunk = unique.slice(i, i + HC_CAPTURE_BATCH);
      const results = await Promise.all(chunk.map(async (target) => {
        try {
          return { target, result: await this.read(target, lines) } as const;
        } catch (err) {
          if (!isHcFailure(err)) throw err;
          return { target, failure: err } as const;
        }
      }));
      const capturedAt = now();  // when THIS chunk's terminals were read, not when the sweep ends
      for (const entry of results) {
        if ("failure" in entry) {
          if (entry.failure instanceof HcUnavailableError) unreachable = true;
        } else if (entry.result === null) {
          out.set(entry.target, { text: null, capturedAt, missing: true });
        } else {
          out.set(entry.target, { text: terminated(entry.result.text), capturedAt });
        }
      }
    }
    return unreachable && out.size === 0 ? null : out;
  }
}

/** tmux prints every line newline-terminated; hc's text carries no final newline. Empty is null, as `output || null`. */
function terminated(text: string | undefined): string | null {
  if (!text) return null;
  return text.endsWith("\n") ? text : `${text}\n`;
}
