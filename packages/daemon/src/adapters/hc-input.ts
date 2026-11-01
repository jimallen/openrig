import { DAEMON_DELIVERY_BOUND_MS } from "../transport-budget.js";
import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { HcAttach, type HcAttachEnd, type HcAttachOpener, type HcAttachment } from "./hc-attach.js";
import type { HcLifecycle } from "./hc-lifecycle.js";
import { hcTerminalName } from "./hc-seat.js";
import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { shellQuote } from "./shell-quote.js";
import { defaultTmuxFileOps, isTypedLineWidgetSafe, type TmuxFileOps, type TmuxResult } from "./tmux.js";

/** The part of the delivery guard an input needs: the serial lease and the synchronous last check before a write. */
export type HcInputGuard = Pick<SeatDeliveryGuard, "input" | "checkInput">;

/** Places a target the guard cannot resolve on its own: HcLifecycle's probe and launch cases, the tmux adapter's `freshProbes` and
 *  `freshManaged`. One rule, kept there. */
export type HcInputAdmission = Pick<HcLifecycle, "needsAdmission" | "admitted">;

/** What to do when the program says it is blocked on a dialog (OSC 7501 `blocked`). `terminal.keys` and a staged paste
 *  carry no blocked refusal of their own (spike 1+2: a key answered a permission dialog), so this module refuses by
 *  default. `allow` is for the callers whose job is to answer: a person typing in the viewer, an audited prompt answer,
 *  a startup step that presses a dialog's option. A program that never reports status cannot be seen blocked. */
export type BlockedPolicy = "refuse" | "allow";

export interface HcInputOptions {
  /** The tmux adapter's deliveryGuard, when the daemon has one. */
  guard?: HcInputGuard;
  /** Without it a metadata probe or an unbound launch stays refused, as a target the guard does not know. */
  admission?: HcInputAdmission;
  fileOps?: TmuxFileOps;
  /** How long a `terminal.send` or `terminal.keys` may take before the outcome reads as unknown. The core waits for a
   *  person to stop typing and has no ceiling (spike 1+2: 212 s seen), so a timeout is never a failure. */
  deliveryTimeoutMs?: number;
  /** First-paint reading, for the program's bracketed-paste mode: quiet time after the last frame, the longest to
   *  collect after the first, and the longest to wait for any. */
  paintSettleMs?: number;
  paintMaxMs?: number;
  paintFirstMs?: number;
}

export interface HcShellCommandOptions {
  /** Type a short, widget-safe, one-line command as it stands instead of staging it. */
  stageIfLong?: boolean;
  /** The staged script replaces its shell (`exec`). */
  execInScript?: boolean;
  /** Source the script in a POSIX pane shell, so rc aliases and functions stay; any other shell runs it with /bin/sh. */
  sourceInPane?: boolean;
}

type Failure = Extract<TmuxResult, { ok: false }>;

export type HcSubmitResult =
  | { ok: true; started: boolean | null; status: string | null; turn: number; wait?: unknown }
  | { ok: false; code: string; message: string };

export interface HcSubmitOptions {
  beforeInput?: () => void;
  /** Type even if the program is blocked (it may answer its dialog). */
  force?: boolean;
  /** Only type if the status is exactly this; hc refuses otherwise and types nothing. */
  ifStatus?: "idle" | "working";
  /** Then wait for the turn this send started. */
  wait?: boolean;
  waitTimeoutSec?: number;
  timeoutMs?: number;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_TYPED_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const TYPED_SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;
const POSIX_SHELLS = ["bash", "zsh", "sh", "dash", "ksh"];

const NAMED_KEYS: Record<string, string> = {
  Enter: "enter", Tab: "tab", BTab: "shift+tab", Escape: "esc", Space: "space", BSpace: "backspace", DC: "delete", IC: "insert",
  Up: "up", Down: "down", Left: "left", Right: "right", Home: "home", End: "end",
  PgUp: "pageup", PageUp: "pageup", PPage: "pageup", PgDn: "pagedown", PageDown: "pagedown", NPage: "pagedown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])),
};
const MODIFIERS: Record<string, string> = { "C-": "ctrl+", "M-": "alt+", "S-": "shift+" };
/** Single characters hc's key set takes as they are (measured on hc 0.1.15; ':', '?', '+', ' ' and non-ASCII are refused). */
const PLAIN_KEY = /^[a-z0-9/.-]$/;

export type KeyMapping = { ok: true; keys: string[] } | { ok: false; key: string };

/** tmux key names to hc's closed set (measured on hc 0.1.15). An uppercase letter is `shift+<letter>`: hc reads a bare
 *  `A` as `a`. A name hc does not take is refused here, before any key is pressed, rather than typed in part. An empty
 *  string presses nothing (the broker's redraw nudge sends two). */
export function mapTmuxKeys(keys: readonly string[]): KeyMapping {
  const mapped: string[] = [];
  for (const key of keys) {
    if (key === "") continue;
    const one = mapTmuxKey(key);
    if (one === null) return { ok: false, key };
    mapped.push(one);
  }
  return { ok: true, keys: mapped };
}

function mapTmuxKey(key: string): string | null {
  const named = NAMED_KEYS[key];
  if (named !== undefined) return named;
  if (/^[A-Z]$/.test(key)) return `shift+${key.toLowerCase()}`;
  if (PLAIN_KEY.test(key)) return key;
  const prefix = key.slice(0, 2);
  const modifier = MODIFIERS[prefix];
  if (modifier === undefined) return null;
  const rest = key.slice(2);
  const base = NAMED_KEYS[rest] ?? (modifier === "ctrl+" && /^[A-Za-z]$/.test(rest) ? rest.toLowerCase() : /^[a-z0-9]$/.test(rest) || rest === "/" || rest === "\\" ? rest : null);
  return base === null ? null : `${modifier}${base}`;
}

/** Whether the program's last first-paint or live bytes left bracketed paste (mode 2004) on. The paint resets modes and
 *  then states the program's own, so no toggle means off; a private-mode sequence may carry several modes. */
export function bracketedPasteOn(painted: string): boolean {
  let on = false;
  for (const match of painted.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    if (match[1]!.split(";").includes("2004")) on = match[2] === "h";
  }
  return on;
}

/** The paste, text and submit calls of the tmux adapter on hc, behind the same method names and `TmuxResult`.
 *  A seat is addressed by its canonical name; its terminal is hcTerminalName(seat). */
/** The shell at a seat's prompt. hc reports the foreground about 365 ms after a start, and until then (or while `env` is still
 *  the program) the launch argv says: `env -u ... <shell> -l`. Without this a launch sent early is typed as `/bin/sh <file>`, and
 *  a `claude` that is an rc alias or function fails with 127. */
export function paneShellOf(terminal: Pick<HcTerminal, "foreground" | "argv">): string {
  const name = (terminal.foreground?.name ?? "").replace(/^-/, "");
  if (name !== "" && name !== "env") return name;
  const argv = terminal.argv;
  const shell = argv[argv.length - 1] === "-l" ? argv[argv.length - 2] : argv[0];
  return (shell ?? "").split("/").pop() ?? "";
}

export class HcInput {
  private readonly fileOps: TmuxFileOps;
  private readonly timing: Required<Pick<HcInputOptions, "deliveryTimeoutMs" | "paintSettleMs" | "paintMaxMs" | "paintFirstMs">>;

  constructor(
    private readonly client: HcClient,
    private readonly attach: HcAttachOpener = new HcAttach(),
    private readonly options: HcInputOptions = {},
  ) {
    this.fileOps = options.fileOps ?? defaultTmuxFileOps();
    this.timing = {
      deliveryTimeoutMs: options.deliveryTimeoutMs ?? DAEMON_DELIVERY_BOUND_MS,
      paintSettleMs: options.paintSettleMs ?? 40,
      paintMaxMs: options.paintMaxMs ?? 400,
      paintFirstMs: options.paintFirstMs ?? 1_500,
    };
  }

  /** Stage text in the program's input with no Enter. `bracketed` (default true) is tmux's `paste-buffer -p`: framed as
   *  a paste only when the program has turned bracketed paste on. `bracketed: false` is key input: the bytes as they are. */
  async sendText(target: string, text: string, beforeInput?: () => void, options: { bracketed?: boolean; blocked?: BlockedPolicy } = {}): Promise<TmuxResult> {
    return this.guarded<TmuxResult>(target, async (check) => {
      if (text === "") return { ok: true };
      const terminal = await this.live(target, options.blocked ?? "refuse");
      if ("ok" in terminal) return terminal;
      return this.stage(terminal, text, options.bracketed !== false, () => { check(); beforeInput?.(); });
    });
  }

  /** Press keys named as tmux names them. Keys bypass hc's blocked refusal, so it is made here (see BlockedPolicy). */
  async sendKeys(target: string, keys: string[], beforeInput?: () => void, options: { blocked?: BlockedPolicy } = {}): Promise<TmuxResult> {
    const mapped = mapTmuxKeys(keys);
    if (!mapped.ok) return { ok: false, code: "unsupported_key", message: `hc has no key for ${JSON.stringify(mapped.key)}; nothing was pressed` };
    return this.guarded<TmuxResult>(target, async (check) => {
      if (mapped.keys.length === 0) return { ok: true };
      if ((options.blocked ?? "refuse") === "refuse") {
        const terminal = await this.live(target, "refuse");
        if ("ok" in terminal) return terminal;
      }
      check();
      beforeInput?.();
      await this.client.call("terminal.keys", { terminal: hcTerminalName(target), keys: mapped.keys }, { timeoutMs: this.timing.deliveryTimeoutMs });
      return { ok: true };
    });
  }

  /** Run a POSIX command in the seat's shell. The command travels in a 0600 script that removes itself, so a secret in it
   *  stays out of the pane and the shell's history; only a short `/bin/sh <script>` is typed (a fresh pty can drop input
   *  past 1024 bytes). The paste and the Enter are one `terminal.send`, so no half-typed line is left behind. */
  async sendShellCommand(target: string, command: string, beforeInput?: () => void, options: HcShellCommandOptions = {}): Promise<TmuxResult> {
    return this.guarded<TmuxResult>(target, async (check) => {
      const commandBytes = Buffer.byteLength(command, "utf8");
      let paneShell = "";
      if (options.sourceInPane) {
        const terminal = await this.read(target);
        if ("ok" in terminal) return terminal;
        paneShell = paneShellOf(terminal);
      }
      const sourceInPane = POSIX_SHELLS.includes(paneShell);
      const typedDirect = !!options.stageIfLong && commandBytes <= MAX_TYPED_BYTES && isTypedLineWidgetSafe(command) && !CONTROL_CHARACTER.test(command);
      let path: string | undefined = typedDirect ? undefined : this.fileOps.tmpName();
      let invocation = path ? `${sourceInPane ? "." : "/bin/sh"} ${typedPathArg(path)}` : command;
      if (Buffer.byteLength(invocation, "utf8") > MAX_TYPED_BYTES) {
        if (options.stageIfLong && commandBytes < 1024 && !CONTROL_CHARACTER.test(command)) {
          path = undefined;
          invocation = command;
        } else {
          return { ok: false, code: "launch_path_too_long", message: "Temporary launch-script path exceeds the safe terminal input bound" };
        }
      }
      const staged: string[] = [];
      let consumed = false;
      try {
        if (path) {
          if (sourceInPane) {
            // Sourced in the pane shell, the command keeps its subshell isolation inside the script.
            const commandFile = `${path}.cmd`;
            await this.fileOps.writeFile(commandFile, `/bin/rm -f -- ${shellQuote(commandFile)}\n${command}\n`, { mode: 0o600, flag: "wx" });
            staged.push(commandFile);
            await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n( . ${shellQuote(commandFile)} )\n`, { mode: 0o600, flag: "wx" });
          } else {
            await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n${options.execInScript ? "exec " : ""}${command}\n`, { mode: 0o600, flag: "wx" });
          }
          staged.push(path);
        }
        check();
        beforeInput?.();
        await this.client.call("terminal.send", { terminal: hcTerminalName(target), text: invocation }, { timeoutMs: this.timing.deliveryTimeoutMs });
        consumed = true;  // The receiver now owns removal; unlinking here races shell startup.
        return { ok: true };
      } finally {
        if (!consumed) for (const file of staged) { try { await this.fileOps.unlink(file); } catch { /* best effort */ } }
      }
    });
  }

  /** The submit path: paste the text and press Enter as one `terminal.send`. hc waits until nobody has typed for ~3 s and
   *  has no ceiling, so a timeout here is `delivery_outcome_unknown`: the send is queued and survives this client, and
   *  must be verified, never resent blind. A blocked program is refused by hc itself unless `force`. */
  async submitText(target: string, text: string, options: HcSubmitOptions = {}): Promise<HcSubmitResult> {
    const timeoutMs = options.timeoutMs ?? this.timing.deliveryTimeoutMs + (options.wait ? (options.waitTimeoutSec ?? 180) * 1000 : 0);
    return this.guarded<HcSubmitResult>(target, async (check) => {
      check();
      options.beforeInput?.();
      const sent = await this.client.call<{ started?: boolean | null; status?: string | null; turn: number; wait?: unknown }>("terminal.send", {
        terminal: hcTerminalName(target), text,
        ...(options.force ? { force: true } : {}), ...(options.ifStatus ? { if: options.ifStatus } : {}),
        ...(options.wait ? { wait: true, ...(options.waitTimeoutSec !== undefined ? { timeout: options.waitTimeoutSec } : {}) } : {}),
      }, { timeoutMs });
      return { ok: true, started: sent.started ?? null, status: sent.status ?? null, turn: sent.turn, ...(sent.wait !== undefined && sent.wait !== null ? { wait: sent.wait } : {}) };
    });
  }

  // ---- internals

  private async guarded<T>(target: string, op: (check: () => void) => Promise<T | Failure>): Promise<T | Failure> {
    const guard = this.options.guard;
    try {
      if (!guard) return await op(() => {});
      const admission = this.options.admission;
      if (admission?.needsAdmission(target)) return await admission.admitted<T | Failure>(target, op, { madeHere: true });
      return await guard.input(target, () => op(() => guard.checkInput(target)));
    } catch (err) {
      return classify(err);
    }
  }

  /** The terminal, or the refusal: finished reads as gone, and blocked per policy. */
  private async live(target: string, blocked: BlockedPolicy): Promise<HcTerminal | Failure> {
    const terminal = await this.read(target);
    if ("ok" in terminal) return terminal;
    if (blocked === "refuse" && terminal.status?.state === "blocked") {
      const kind = terminal.status.kind ? ` (${terminal.status.kind})` : "";
      return { ok: false, code: "seat_blocked", message: `${target} is blocked on a dialog${kind}; typing could answer it. Nothing was written.` };
    }
    return terminal;
  }

  private async read(target: string): Promise<HcTerminal | Failure> {
    try {
      const terminal = await this.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(target) });
      if (terminal.state !== "live") return { ok: false, code: "session_not_found", message: `${target} has finished (${terminal.reason ?? "no reason given"}); nothing was written.` };
      return terminal;
    } catch (err) {
      return classify(err);
    }
  }

  /** Attach as a writer at the terminal's own size (a different size resizes the person's TUI twice, spike 1+2), read
   *  the first paint for the bracketed-paste mode, write, and detach with the core's answer in hand. */
  private async stage(terminal: HcTerminal, text: string, bracketed: boolean, beforeWrite: () => void): Promise<TmuxResult> {
    const painted = new Paint(this.timing);
    const state: { ended: HcAttachEnd | null } = { ended: null };
    let attachment: HcAttachment;
    try {
      attachment = await this.attach.open(
        { terminal: terminal.address, cols: terminal.cols, rows: terminal.rows },
        { onData: (bytes) => painted.add(bytes), onEnd: (end) => { state.ended = end; painted.stop(); } },
      );
    } catch (err) {
      painted.stop();
      // An attach types nothing: whatever went wrong, nothing was delivered.
      if (err instanceof HcOutcomeUnknownError) return { ok: false, code: "transport_unavailable", message: `no reply attaching to ${terminal.address}; nothing was written` };
      return classify(err);
    }
    let written = false;
    try {
      let payload = text;
      if (bracketed) {
        if (!(await painted.settled())) return { ok: false, code: "paste_mode_unknown", message: `${terminal.address} painted nothing, so its paste mode is unknown; nothing was written` };
        if (bracketedPasteOn(painted.text())) {
          if (text.includes(PASTE_END)) return { ok: false, code: "paste_terminator", message: "The text holds a paste-end sequence, which would close the paste early; nothing was written" };
          payload = `${PASTE_START}${text}${PASTE_END}`;
        }
      }
      if (state.ended) return { ok: false, code: "session_not_found", message: `${terminal.address} ended before the write` };
      beforeWrite();
      written = true;
      attachment.write(payload);
      const end = await attachment.detach();
      if (end.reason === "detached") return { ok: true };
      if (end.reason === "program_ended") return { ok: false, code: "session_not_found", message: `${terminal.address} ended while the text was written` };
      // The core never said it read what was written: neither a failure nor a success.
      return { ok: false, code: "delivery_outcome_unknown", message: `the core did not confirm the write to ${terminal.address}; verify before sending again` };
    } catch (err) {
      return written ? { ok: false, code: "delivery_outcome_unknown", message: `writing to ${terminal.address} failed part way; verify before sending again` } : classify(err);
    } finally {
      painted.stop();
      await attachment.detach();
    }
  }
}

function typedPathArg(path: string): string {
  return TYPED_SAFE_PATH.test(path) ? path : shellQuote(path);
}

/** The first paint of an attach: collected until it has been quiet for `paintSettleMs`, capped at `paintMaxMs` after its
 *  first frame; `settled()` is false if no frame came in `paintFirstMs`. */
class Paint {
  private chunks: Buffer[] = [];
  private first: NodeJS.Timeout | null = null;
  private quiet: NodeJS.Timeout | null = null;
  private max: NodeJS.Timeout | null = null;
  private seen = false;
  private release!: (seen: boolean) => void;
  private readonly done = new Promise<boolean>((resolve) => { this.release = resolve; });

  constructor(private readonly timing: { paintSettleMs: number; paintMaxMs: number; paintFirstMs: number }) {
    this.first = setTimeout(() => this.release(false), timing.paintFirstMs);
  }

  add(bytes: Buffer): void {
    this.chunks.push(bytes);
    if (!this.seen) {
      this.seen = true;
      if (this.first) clearTimeout(this.first);
      this.max = setTimeout(() => this.release(true), this.timing.paintMaxMs);
    }
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.release(true), this.timing.paintSettleMs);
  }

  settled(): Promise<boolean> { return this.done; }

  text(): string { return Buffer.concat(this.chunks).toString("latin1"); }

  stop(): void {
    for (const timer of [this.first, this.quiet, this.max]) if (timer) clearTimeout(timer);
    this.release(this.seen);
  }
}

/** A refusal or failure as a TmuxResult. The core's text is not echoed (a call may carry a seat's credentials): its
 *  stable `kind` is. */
function classify(err: unknown): Failure {
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message };
  if (err instanceof HcError) {
    switch (err.kind) {
      case "not_found": case "finished": return { ok: false, code: "session_not_found", message: `hc: ${err.kind}; nothing was written` };
      case "blocked": return { ok: false, code: "seat_blocked", message: `hc refused: the program is blocked on a dialog${err.hint ? ` (${err.hint})` : ""}; nothing was typed` };
      case "status_mismatch": return { ok: false, code: "status_mismatch", message: "hc refused: the program's status is not the one required; nothing was typed" };
      case "unavailable": return { ok: false, code: "transport_unavailable", message: "hc: the terminal is unavailable; nothing was written" };
      case "unsupported_generation": return { ok: false, code: "transport_unavailable", message: "hc core speaks another protocol generation" };
      default: return { ok: false, code: "unknown", message: `hc refused: ${err.kind}` };
    }
  }
  if (err instanceof HcUnavailableError) return { ok: false, code: "transport_unavailable", message: "hc core unavailable; nothing was written" };
  if (err instanceof HcOutcomeUnknownError) {
    return { ok: false, code: "delivery_outcome_unknown", message: `${err.method}: no reply from the core; it may still deliver, so verify before sending again` };
  }
  return { ok: false, code: (err as { code?: string }).code ?? "unknown", message: err instanceof Error ? err.message : String(err) };
}
