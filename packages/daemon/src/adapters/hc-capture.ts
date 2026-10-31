import { HcAttach, type HcAttachOpener, type HcAttachment } from "./hc-attach.js";
import { HcClient, HcError, HcUnavailableError } from "./hc-client.js";
import { hcTerminalRef, isAbsentFailure, isHcFailure } from "./hc-identity.js";
// hc-viewer.ts imports this module too (its default history reader). Both sides use the other's export only inside a function,
// never while their module evaluates, so either import order works.
import { ModeTracker, fullScreenHistoryReadIsUnsafe, type TerminalModes } from "./hc-viewer.js";
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
 * Where a terminal's private modes come from, for deciding whether a read with history is safe (`fullScreenHistoryReadIsUnsafe`).
 * Null means unknown, and unknown reads as unsafe. It may throw only for a bug, never for an hc failure.
 */
export interface ModeSource {
  modesOf(terminal: string): Promise<TerminalModes | null>;
}

export interface PaintTiming { settleMs: number; maxMs: number; firstMs: number }
const DEFAULT_PAINT: PaintTiming = { settleMs: 40, maxMs: 400, firstMs: 1_500 };
/** An observer attach asks for a size and is given the terminal's own (spike 3), so the ask is nominal. */
const OBSERVER_ASK = { cols: 80, rows: 24 } as const;

/**
 * The modes as an observer's first paint states them: the paint opens with a soft reset and then sets the program's own modes
 * (spike 3, w14). An observer never types and never resizes, so the probe cannot disturb the program. A finished terminal has no
 * program to scroll, so its history is safe to read. A terminal that is not there, a core that cannot be reached, a refusal and a
 * paint that does not come are all unknown.
 */
export class ObserverModeProbe implements ModeSource {
  constructor(private readonly opener: HcAttachOpener, private readonly paint: PaintTiming = DEFAULT_PAINT) {}

  async modesOf(terminal: string): Promise<TerminalModes | null> {
    const tracker = new ModeTracker();
    let seen = false;
    let release: (seen: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => { release = resolve; });
    let quiet: NodeJS.Timeout | null = null;
    let max: NodeJS.Timeout | null = null;
    const first = setTimeout(() => release(false), this.paint.firstMs);
    const stop = (): void => { for (const timer of [first, quiet, max]) if (timer) clearTimeout(timer); release(seen); };
    const onData = (bytes: Buffer): void => {
      tracker.feed(bytes);
      if (!seen) {
        seen = true;
        clearTimeout(first);
        max = setTimeout(() => release(true), this.paint.maxMs);
      }
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => release(true), this.paint.settleMs);
    };
    let attachment: HcAttachment;
    try {
      attachment = await this.opener.open({ terminal, ...OBSERVER_ASK, observe: true }, { onData, onEnd: stop });
    } catch (err) {
      stop();
      if (err instanceof HcError && err.kind === "finished") return { altScreen: false, mouse: false };
      if (isHcFailure(err)) return null;
      throw err;
    }
    try {
      return (await settled) ? tracker.modes() : null;
    } finally {
      stop();
      await attachment.detach(200);
    }
  }
}

/** How long a verdict is believed. A safe one is short: a seat can start a full-screen app at any moment, and a stale "safe" is the
 *  only way a wheel event gets through. An unsafe one is long: believing it too long costs history, not a scrolled app. */
export interface ModeTtl { safeMs: number; unsafeMs: number; unknownMs: number }
export const DEFAULT_MODE_TTL: ModeTtl = { safeMs: 5_000, unsafeMs: 60_000, unknownMs: 2_000 };

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
 *
 * History is read only where it is safe. `terminal.read` with `lines` above 0 on an idle full-screen app that reports the mouse
 * injects wheel events into the app to scroll it (w14: 13 per read; 600 to 4,700 per read, each taking 10 s, when the screen changes
 * every second). The transcript rotation reads 1,000 lines of every seat every 2 to 6 s, and about 49 scrape sites read 20 to 80 lines, so a
 * live seat would be scrolled constantly. So before a read with history, the terminal's modes are looked up (`ModeSource`):
 * - on an alternate screen or with mouse reporting on, or when the modes are unknown, the read asks for the screen only (`lines: 0`);
 *   `capturePaneHistory`, which is meaningless without history, answers null without reading;
 * - the verdict is cached per terminal (`ModeTtl`), so a poll costs a probe at most once per TTL and not once per read, and probes of
 *   one terminal in flight are shared; a read answered `stitched` (hc scrolled the app to read it) marks the terminal unsafe at once.
 * What a caller gets instead is the screen: what the app shows now. What it loses is the rows above the screen, which an alternate-screen
 * app does not keep anyway (`complete` is false) and a mouse-reporting inline app does. Whoever needs more than the screen reads the
 * runtime's own files (Claude, Codex and Pi write their sessions) or the attach stream (HcViewer, every byte).
 */
export class HcCapture {
  private readonly now: () => Date;
  private readonly modes: ModeSource;
  private readonly ttl: ModeTtl;
  private readonly tick: () => number;
  private readonly verdicts = new Map<string, { unsafe: boolean; until: number }>();
  private readonly probing = new Map<string, Promise<boolean>>();

  constructor(
    private readonly client: HcClient = new HcClient(),
    options: { now?: () => Date; modes?: ModeSource; ttl?: ModeTtl; tick?: () => number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.modes = options.modes ?? new ObserverModeProbe(new HcAttach(client.socketPath));
    this.ttl = options.ttl ?? DEFAULT_MODE_TTL;
    this.tick = options.tick ?? Date.now;
  }

  private remember(ref: string, unsafe: boolean, ttlMs: number): void {
    const at = this.tick();
    if (this.verdicts.size >= 512) for (const [key, v] of this.verdicts) if (v.until <= at) this.verdicts.delete(key);  // terminals come and go
    this.verdicts.set(ref, { unsafe, until: at + ttlMs });
  }

  /** True when a read with history above the screen must not be made. Unknown is unsafe. */
  private async historyIsUnsafe(ref: string): Promise<boolean> {
    const cached = this.verdicts.get(ref);
    if (cached && this.tick() < cached.until) return cached.unsafe;
    let probe = this.probing.get(ref);
    if (!probe) {
      probe = (async () => {
        const modes = await this.modes.modesOf(ref);
        const unsafe = modes === null || fullScreenHistoryReadIsUnsafe(modes);
        const ttl = modes === null ? this.ttl.unknownMs : unsafe ? this.ttl.unsafeMs : this.ttl.safeMs;
        this.remember(ref, unsafe, ttl);
        return unsafe;
      })().finally(() => { this.probing.delete(ref); });
      this.probing.set(ref, probe);
    }
    return probe;
  }

  /** One read. Null when the target is not there; hc's refusals and an unreachable core throw. */
  private async read(target: string, lines: number): Promise<ReadResult | null> {
    const ref = hcTerminalRef(target);
    if (ref === null) return null;
    try {
      const asked = lines > 0 && await this.historyIsUnsafe(ref) ? 0 : lines;
      const result = await this.client.call<ReadResult>("terminal.read", { terminal: ref, lines: asked });
      if (result.how === "stitched") this.remember(ref, true, this.ttl.unsafeMs);
      return result;
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
    const ref = hcTerminalRef(paneId);
    if (ref === null) return null;
    try {
      if (await this.historyIsUnsafe(ref)) return null;  // a screen-only read would pass for the whole history
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
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
