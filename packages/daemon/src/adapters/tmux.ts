import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";
import { parentSessionEnvKeys } from "../domain/parent-session-env.js";
import { partitionLaunchEnv, renderSecretEnvScript } from "./tmux-launch-env-channel.js";

export type ExecFn = (cmd: string) => Promise<string>;

interface TmuxShellCommandOptions {
  /** Pi can send commands within the terminal byte bound directly. */
  stageIfLong?: boolean;
  /** A staged single-executable runner must replace the staging shell. */
  execInScript?: boolean;
  /** Preserve rc aliases/functions in POSIX or fish panes; other shells use /bin/sh. */
  sourceInPane?: boolean;
}

/**
 * Argv exec: run the multiplexer WITHOUT a shell (execFile-style — the
 * binary is argv[0], the rest are verbatim arguments, no quoting layer).
 * The daemon wires it on every platform: no shell process per call, and on
 * Windows/psmux no POSIX quoting or `/dev/null` redirections to depend on.
 * When absent every method uses the legacy shell-string path unchanged.
 */
export type ArgvExecFn = (argv: string[]) => Promise<string>;

/**
 * Injectable file/buffer operations for `sendText`.
 * Split out so tests can observe temp-file writes and unique-name generation
 * without touching the real filesystem; production wires node fs + os.tmpdir.
 */
export interface TmuxFileOps {
  writeFile(path: string, content: string, options?: { mode: number; flag: "wx" }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unique temp-file path per call - parallel `rig up` stands up many seats. */
  tmpName(): string;
  /** Unique tmux buffer name per call - a fixed name would collide under concurrency. */
  bufferName(): string;
}

// One source for the staged script's name: the generator (defaultTmuxFileOps) and the matcher
// (isStagedSendScriptPath) are both built from it.
const SEND_SCRIPT_PREFIX = "openrig-tmux-send-";
const SEND_SCRIPT_SUFFIX = ".txt";
const SEND_SCRIPT_NAME = new RegExp(
  `^${SEND_SCRIPT_PREFIX}\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${SEND_SCRIPT_SUFFIX.replace(".", "\\.")}$`,
);

/** Whether `path` names a launch script sendShellCommand staged (an absolute path with the name
 *  defaultTmuxFileOps gives it). The script removes itself first, so this is a name check only. */
export function isStagedSendScriptPath(path: string): boolean {
  return path.startsWith("/") && SEND_SCRIPT_NAME.test(path.split("/").pop() ?? "");
}

// The launch line is TYPED into the pane's interactive shell, where line-editor widgets (autopair,
// abbreviation expanders, vi-mode...) can rewrite it. Typed characters are therefore limited to
// ones no widget treats specially: a path of these characters needs no quotes, and the staged
// script itself carries any parentheses. A path outside the set keeps shell quoting.
const TYPED_SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;
function typedPathArg(path: string): string {
  return TYPED_SAFE_PATH.test(path) ? path : shellQuote(path);
}

// Characters an autopair widget (zsh-autopair and kin) rewrites when typed: it inserts the closer
// for each opener, and a quote overtypes only while it is balanced. A command line that holds none
// of them is unaffected and may be typed as it stands; every other line is staged.
const WIDGET_REWRITTEN = /[()[\]{}"'`]/;
export function isTypedLineWidgetSafe(line: string): boolean {
  return !WIDGET_REWRITTEN.test(line);
}

export function defaultTmuxFileOps(): TmuxFileOps {
  return {
    writeFile: (p, content, options) => fsWriteFile(p, content, { encoding: "utf8", ...options }),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `${SEND_SCRIPT_PREFIX}${process.pid}-${randomUUID()}${SEND_SCRIPT_SUFFIX}`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

export type TmuxResult =
  | { ok: true; warnings?: string[] }
  | { ok: false; code: string; message: string };

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  index: number;
  cwd: string;
  width: number;
  height: number;
  active: boolean;
}

/**
 * Cursor coordinates plus pane geometry, used by the live-terminal seed
 * (OPR.0.4.0.38). Coordinates are zero-based; geometry is the visible pane
 * size. Lifted from the FR-4 seed work so a new subscriber can paint the
 * current screen with the cursor in the right place and no row drift.
 */
export interface TmuxCursorPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An attached tmux client — the human's terminal/CMUX tile. `name` is the
 * client identifier accepted by `switch-client -c` (the client tty by default);
 * `session` is the session the client is CURRENTLY viewing (may be the wrong or
 * a dead view, which is exactly the recovery case OPR.0.4.3.26 retargets).
 */
export interface TmuxClient {
  name: string;
  session: string;
}

/**
 * Result of a classified session probe (OPR.0.5.4.2). `absent` carries
 * positive tmux evidence; `transport_unavailable` means the tmux server could
 * not be reached and session existence was NOT determined — the two are never
 * interchangeable.
 */
/** One `list-windows -a` read (OF-176): every session the server has, and each one's current-window activity. */
export interface SessionWindowSnapshot {
  /** Epoch ms when the read started. */
  at: number;
  /** Every session the listing named. A session absent from it does not exist on the server at that moment. */
  sessions: Set<string>;
  /** Each session's current-window `#{window_activity}` (epoch seconds), when well formed. */
  activity: Map<string, number>;
}

/**
 * Whether a snapshot shows `session` absent from the server. Only a listing that names at least one session is taken as
 * an answer: an empty one (a server with no sessions, or a reply this parser did not recognise) never makes every
 * running seat look gone at once, as the identity reconciler treats zero live sessions as a blip.
 */
export function snapshotLacks(snapshot: SessionWindowSnapshot | null | undefined, session: string): boolean {
  return snapshot != null && snapshot.sessions.size > 0 && !snapshot.sessions.has(session);
}

export type SessionProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "transport_unavailable"; cause: string };

const TMUX_FIELD_SEPARATOR = "|";
/** How old a shared window snapshot a batched capture accepts as its listing (OF-176): one poll tick. */
export const CAPTURE_LISTING_MAX_AGE_MS = 1000;
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
].join(TMUX_FIELD_SEPARATOR);
const WINDOW_FORMAT = [
  "#{window_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{window_active}",
].join(TMUX_FIELD_SEPARATOR);
// tmux 3.6 sanitizes literal control characters in -F output to underscores, and
// tmux 3.3a replaces tabs with underscores, so tab-delimited rows become
// unparseable on those versions. EVERY adapter-owned format uses the printable
// delimiter instead.
const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(TMUX_FIELD_SEPARATOR);
const CLIENT_FORMAT = [
  "#{client_name}",
  "#{client_session}",
].join(TMUX_FIELD_SEPARATOR);
const CURSOR_FORMAT = [
  "#{cursor_x}",
  "#{cursor_y}",
  "#{pane_width}",
  "#{pane_height}",
].join(TMUX_FIELD_SEPARATOR);

function isNoServerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no server running");
}

/** The error tmux reported, without the stdout an exec error carries: in a chain that stdout is the earlier panes'
 *  text, which an agent controls. Errors that kept no stderr classify on their message. */
function tmuxReportedError(err: unknown): unknown {
  const stderr = (err as { execStderr?: unknown } | null)?.execStderr;
  return typeof stderr === "string" ? new Error(stderr) : err;
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session not found") ||
    msg.includes("can't find session") ||
    msg.includes("no current target") ||
    msg.includes("no session");
}

function isPaneAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't find pane") || msg.includes("pane not found") || msg.includes("no such pane");
}

// Post-reboot the tmux socket file at /tmp/tmux-<uid>/<name> is gone, so
// `tmux has-session` exits non-zero with a transport-absent message rather than
// a server/session-absent message. probeSession() classifies this class as
// transport_unavailable — session existence NOT determined, never absence;
// only Reconciler elects to treat that state as detachable, at its own
// cold-start call site (OPR.0.5.4.2). Permission errors must remain rethrown.
function isTmuxTransportAbsentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Fail-closed: never classify a permission/authorization failure as absence.
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(msg)) {
    return false;
  }
  // tmux's socket-transport failure prefix; the parenthetical names the cause.
  //   "error connecting to /private/tmp/tmux-501/default (No such file or directory)"
  //   "error connecting to /private/tmp/tmux-501/default (Connection refused)"
  if (msg.startsWith("error connecting to")) {
    return /No such file or directory|Connection refused/.test(msg);
  }
  // Conservative bare-message variants that still reference a tmux socket path.
  if (/tmux-\d+/.test(msg) && /No such file or directory|Connection refused/.test(msg)) {
    return true;
  }
  return false;
}

function classifyWriteError(err: unknown): TmuxResult {
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message };
  if (!(err instanceof Error)) {
    return { ok: false, code: "unknown", message: String(err) };
  }
  if (err.message.includes("duplicate session")) {
    return { ok: false, code: "duplicate_session", message: err.message };
  }
  if (err.message.includes("can't find session") || err.message.includes("no server running")) {
    return { ok: false, code: "session_not_found", message: err.message };
  }
  return { ok: false, code: "unknown", message: err.message };
}

/** The launch warning when the parent-session identity cleanup could not finish (#771). */
function parentSessionEnvWarning(target: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${target}: could not remove the launching session's identity (for example CLAUDECODE) from this seat's environment, so the seat may still see it: ${reason}`;
}

/** Shell-quote a string using single quotes (POSIX-safe). */
/** One pane's text from a batched capture, with the time its chunk was read (#309 review). `text` is null for a
 *  session that is gone or an empty capture. */
export interface PaneCapture { text: string | null; capturedAt: Date; /** The listing lacked the session. */ missing?: true }

/** The most sessions one batched capture chains (#308). Not a byte bound: a chunk whose output overflows exec's buffer
 *  fails and is split in half. */
export const CAPTURE_BATCH = 24;

function shellQuote(s: string): string {
  // Replace each ' with '"'"' (end quote, double-quote the apostrophe, resume quote)
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * An exact tmux target for a session name. tmux resolves a bare name by prefix when no session has that exact name,
 * so a read or pipe for a session that just ended would act on another (`dev-impl@my-rig` on `dev-impl@my-rig2`).
 * Pane, window and session ids (`%3`, `@1`, `$2`) and `session:window.pane` targets pass through unchanged (tmux
 * turns `:` in a session name into `_`, so a `:` always means an explicit target). A pane or window command gets
 * `=name:` (as the batched capture uses); a session command gets `=name`.
 */
function exactTarget(target: string, kind: "pane" | "window" | "session"): string {
  if (/^[%@$]\d+$/.test(target) || target.includes(":")) return target;
  return kind === "session" ? `=${target}` : `=${target}:`;
}

/** Elements safe to leave bare in a POSIX shell word list. */
/** Name prefix of the scratch variables the `$` measurement writes; swept from a session whenever it is probed or restored. */
const ESCAPE_PROBE_PREFIX = "OPENRIG_TMUX_ESCAPE_PROBE_";
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Join argv for a POSIX shell — the legacy string form. Only used when
 *  no ArgvExecFn is wired. Flags and safe words stay bare (matching the
 *  historical template strings); anything else is single-quoted. The argv
 *  arrays stay the single source of truth for what is EXECUTED on either
 *  path — this join only renders them for a shell. */
function posixJoinArgv(argv: string[]): string {
  return argv.map((a) => (SHELL_SAFE.test(a) ? a : shellQuote(a))).join(" ");
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 4) return null;
  // Only the final three fields are metadata; a literal session name may
  // itself contain the printable separator, just like pane paths/window names.
  const windows = parseInt(parts.at(-3)!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts.slice(0, -3).join(TMUX_FIELD_SEPARATOR),
    windows,
    created: parts.at(-2)!,
    attached: parts.at(-1) === "1",
  };
}

function parseClientLine(line: string): TmuxClient | null {
  // First-separator split keeps any separator inside the session name intact.
  const separator = line.indexOf(TMUX_FIELD_SEPARATOR);
  if (separator <= 0) return null;
  const session = line.slice(separator + 1);
  if (session === "") return null;
  return {
    name: line.slice(0, separator),
    session,
  };
}

function parseWindowLine(line: string): TmuxWindow | null {
  const firstSeparator = line.indexOf(TMUX_FIELD_SEPARATOR);
  const lastSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR);
  const panesSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR, lastSeparator - 1);
  if (firstSeparator < 0 || panesSeparator <= firstSeparator || lastSeparator <= panesSeparator) return null;

  const index = parseInt(line.slice(0, firstSeparator), 10);
  const panes = parseInt(line.slice(panesSeparator + 1, lastSeparator), 10);
  if (isNaN(index) || isNaN(panes)) return null;
  return {
    index,
    name: line.slice(firstSeparator + 1, panesSeparator),
    panes,
    active: line.slice(lastSeparator + 1) === "1",
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 6) return null;
  const index = parseInt(parts[1]!, 10);
  const width = parseInt(parts.at(-3)!, 10);
  const height = parseInt(parts.at(-2)!, 10);
  if (isNaN(index) || isNaN(width) || isNaN(height)) return null;
  return {
    id: parts[0]!,
    index,
    cwd: parts.slice(2, -3).join(TMUX_FIELD_SEPARATOR),
    width,
    height,
    active: parts.at(-1) === "1",
  };
}

function parseLines<T>(output: string, parser: (line: string) => T | null): T[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

export class TmuxAdapter {
  deliveryGuard?: SeatDeliveryGuard;
  /** The latest window listing, shared by the poll loops (OF-176): a read in flight is joined, a recent one reused. */
  private windowSnapshot: { at: number; settled: boolean; value: SessionWindowSnapshot | null; result: Promise<SessionWindowSnapshot | null> } | null = null;
  private readonly freshProbes = new Map<string, string>();
  private readonly freshManaged = new Map<string, {nodeId: string; pane: string}>();

  /** Only the private metadata probe uses this door. Success proves allocation,
   * never authority over a pre-existing or registry-managed target. */
  async createProbeSession(name: string, cwd?: string): Promise<TmuxResult> {
    if (this.deliveryGuard?.maybeTarget(name)) return { ok: false, code: "guard_target_managed", message: "A probe cannot reuse a managed seat." };
    // #188: the create itself reports the new session's id and creation time, the only identity a rollback
    // uses. An id alone is unique only for one server's lifetime.
    let created: { id: string; at: string } | null;
    try {
      const out = await this.exec(`tmux new-session -d -P -F ${shellQuote("#{session_id} #{session_created}")} -s ${shellQuote(name)}${cwd != null ? ` -c ${shellQuote(cwd)}` : ""}`);
      const match = /^(\$\d+) (\d+)$/.exec(out.trim());
      created = match ? { id: match[1]!, at: match[2]! } : null;
    } catch (err) {
      return classifyWriteError(err);
    }
    let message = "New probe pane could not be established; no input written.";
    let pane: string | null = null;
    try {
      const panes = await this.listPanes(name);
      pane = panes.length === 1 ? panes[0]!.id : null;
      // #188: a fresh tmux server reuses pane ids, so a stale seat binding can name the new pane. That
      // probe could not be cleaned up safely later, so it is not used.
      if (pane && this.deliveryGuard?.maybeTarget(pane)) message = "New probe pane is named by a managed record; no input written.";
      else if (pane) { this.freshProbes.set(name, pane); this.freshProbes.set(pane, pane); return { ok: true }; }
    } catch { /* no target proof, no input */ }
    // #188: remove the unusable helper by the id its own create returned, unless a managed record has
    // since claimed its name (a binding naming only the reused pane id, under another session name, is
    // stale: that pane belongs to this session). A name reused by another session has a different id.
    const byPane = pane ? this.deliveryGuard?.maybeTarget(pane) : null;
    if (!created || this.deliveryGuard?.maybeTarget(name) || byPane?.session === name) {
      return { ok: false, code: "guard_target_unknown", message: `${message} The helper session was left in place: its ownership could not be proven.` };
    }
    const removed = await this.removeCreatedSession(name, created);
    if (!removed.ok && removed.code !== "session_not_found") message += ` The helper session was not removed: ${removed.message}`;
    return { ok: false, code: "guard_target_unknown", message };
  }

  /** #188: kill the session this adapter created only while its id still names that session. tmux checks
   *  the name and creation time and kills in one command, so a later server that reuses the id is safe. */
  private async removeCreatedSession(name: string, created: { id: string; at: string }): Promise<TmuxResult> {
    const same = `#{&&:#{==:#{session_name},${name}},#{==:#{session_created},${created.at}}}`;
    try {
      const out = await this.exec(`tmux if-shell -F -t ${shellQuote(created.id)} ${shellQuote(same)} ${shellQuote(`kill-session -t '${created.id}'`)} ${shellQuote("display-message -p kept")}`);
      if (out.includes("kept")) return { ok: false, code: "guard_target_changed", message: `its id ${created.id} no longer names it (it may already be gone); nothing was killed.` };
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void) => Promise<TmuxResult>, allowAbsent = false): Promise<TmuxResult> {
    const guard = this.deliveryGuard;
    if (!guard) return write(target, () => {});
    try {
      const probePane = this.freshProbes.get(target);
      if (probePane && !guard.maybeTarget(target)) {
        const panes = await this.listPanes(target);
        if (panes.length !== 1 || panes[0]!.id !== probePane) throw new Error("Private probe target changed; no input written.");
        // Awaited so a refusal inside the write (#188: the probe kill) returns as a result, not a throw.
        return await write(probePane, () => {});
      }
      const created = this.freshManaged.get(target);
      const identity = created?.nodeId ?? target;
      return await guard.input(identity, async () => {
        const bound = guard.target(identity);
        const fresh = created?.nodeId === bound.nodeId && guard.ownsLifecycle(bound.nodeId);
        let panes: TmuxPane[];
        try { panes = await this.listPanes(fresh ? target : bound.session); }
        catch (error) {
          guard.checkInput(identity);
          const result = classifyWriteError(error);
          // Only termination consumes positive absence. Unknown probe failures
          // still refuse, and guard-on never reaches this observation.
          if (allowAbsent && !result.ok
            && !/permission denied|operation not permitted|EACCES|EPERM/i.test(result.message)) {
            if (result.code === "session_not_found") return result;
            // list-panes reports a missing session as "can't find window" on
            // native tmux. Do not broaden write-error classification: only
            // termination may confirm the bound session's positive absence.
            if (/can't find window/i.test(result.message)) {
              const probe = await this.probeSession(bound.session);
              guard.checkInput(identity);
              if (probe.state === "absent") return { ok: false, code: "session_not_found", message: result.message };
            }
          }
          throw error;
        }
        const pane = fresh ? created.pane : bound.pane;
        if (!pane || panes.length !== 1 || panes[0]!.id !== pane) throw new Error("Managed pane identity unavailable or changed; no input written.");
        // Revalidate registry/occupant after the asynchronous observation. Write
        // to the immutable pane ID, not a session name which could be recycled.
        return guard.input(identity, () => write(pane, () => guard.checkInput(identity)));
      });
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: String((error as Error).message) };
    }
  }


  /** Explicit internal human input; transport HTTP options cannot select this. */
  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.humanInput(target, fn) : fn();
  }

  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.operation(target, fn) : fn();
  }

  constructor(
    private exec: ExecFn,
    private fileOps: TmuxFileOps = defaultTmuxFileOps(),
    private argvExec?: ArgvExecFn,
  ) {}

  /**
   * Run a multiplexer command. `argv` is what is EXECUTED on both paths:
   * elements are verbatim (no quoting layer) when argvExec is wired;
   * otherwise they are POSIX-joined — byte-identical to the legacy
   * template strings for all current call sites (the suite pins them).
   * `legacy` overrides the joined form only where history quoted
   * differently (the `-F "..."` double-quoted formats); pass it ONLY to
   * preserve an exact legacy string, never to smuggle new semantics.
   */
  private async run(argv: string[], legacy?: string): Promise<string> {
    if (this.argvExec) return this.argvExec(argv);
    return this.exec(legacy ?? posixJoinArgv(argv));
  }

  /** Start an empty native terminal server, without inventing a seat/session. */
  async startServer(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    try {
      if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      // tmux -D keeps an empty server alive. Stays on the shell-string path
      // deliberately: detach + stdio redirection have no argv equivalent,
      // and server bootstrap is POSIX-specific (psmux auto-starts its own).
      // Native socket ownership arbitrates
      // concurrent starts; the readback below, not shell exit, proves availability.
      await this.exec("tmux -D </dev/null >/dev/null 2>&1 &");
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      }
      return { ok: false, code: "tmux_unavailable", message: "The terminal server did not become available. Check tmux and its socket permissions." };
    } catch (error) {
      return { ok: false, code: "tmux_unavailable", message: `Terminal server unavailable: ${(error as Error).message}` };
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.run(["tmux", "list-sessions", "-F", SESSION_FORMAT],
        `tmux list-sessions -F "${SESSION_FORMAT}"`);
      return parseLines(output, parseSessionLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.run(["tmux", "list-windows", "-t", sessionName, "-F", WINDOW_FORMAT],
        `tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    // Callers name a session (optionally with a window), or an immutable tmux
    // id. Exact session matching prevents observing a prefix neighbor's pane.
    // A bare leading '=' belongs to the literal session name. Only qualified
    // targets already carry tmux's encoded exact-match syntax.
    const namedTarget = target.includes(":") && target.startsWith("=") ? target : `=${target}`;
    const exactTarget = /^[%$@]\d+$/.test(target) ? target
      : namedTarget.includes(":") ? namedTarget : `${namedTarget}:`;
    try {
      const output = await this.run(["tmux", "list-panes", "-t", exactTarget, "-F", PANE_FORMAT],
        `tmux list-panes -t ${shellQuote(exactTarget)} -F "${PANE_FORMAT}"`);
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * Classified session probe (OPR.0.5.4.2): the three error classes tmux
   * produces are distinct answers, and the adapter must not decide for its
   * callers that a transport failure means absence.
   * - `absent` requires POSITIVE tmux evidence (the can't-find-session class).
   * - `transport_unavailable` is the no-server / socket-gone class: whether
   *   the session exists was NOT determined.
   * - Unexpected probe failures (permission denied, etc.) rethrow so callers
   *   fail closed rather than treating a probe failure as an answer.
   */
  async probeSession(name: string): Promise<SessionProbe> {
    try {
      // Use `tmux has-session` directly for reliable existence check — avoids
      // parsing format-string output from `list-sessions` which can fail when
      // tab delimiters are malformed across tmux versions.
      const target = `=${name}`; // canonical session name, never a prefix lookup
      await this.run(["tmux", "has-session", "-t", target],
        `tmux has-session -t ${shellQuote(target)}`);
      return { state: "present" }; // exit 0 = session exists
    } catch (err) {
      if (isSessionAbsenceError(err)) {
        return { state: "absent" };
      }
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) {
        return { state: "transport_unavailable", cause: (err as Error).message };
      }
      throw err;
    }
  }

  /**
   * Collapsed presence view. Kept for the consumers outside the bound
   * send/capture/nudge/walk resolution path (OPR.0.5.4.2 mini-req 6 — their
   * adoption of the classification is a named follow-on). Callers that must
   * distinguish a transport blip from absence use probeSession().
   */
  async hasSession(name: string): Promise<boolean> {
    const probe = await this.probeSession(name);
    return probe.state === "present";
  }

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const result = await this.createSessionUnchecked(name, cwd, env);
    if (result.ok && this.deliveryGuard && env?.OPENRIG_NODE_ID) {
      try {
        const panes = await this.listPanes(name);
        if (panes.length === 1) this.freshManaged.set(name, {nodeId: env.OPENRIG_NODE_ID, pane: panes[0]!.id});
      } catch { /* no fresh pane proof: subsequent writes remain refused */ }
    }
    return result;
  }

  /** The committed binding now owns identity; this is not filesystem cleanup. */
  finishLaunchBinding(session: string): void { this.freshManaged.delete(session); }

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    // These are the daemon's resolved capture settings, not seat overrides.
    // An empty per-session value prevents the tmux server's inherited values
    // from pinning an old policy over config.json inside a newly launched seat.
    // Explicit seat settings remain authoritative.
    const seatEnv = {
      OPENRIG_TRANSCRIPTS_LINES: "",
      OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "",
      ...env,
    };
    // Credentials (the activity-hook token, provider keys) never ride this
    // command line: a tmux argv is readable through `ps`, and the server that
    // new-session starts keeps it. They reach the session through a 0600 file
    // the server reads, then the first shell is restarted so it starts with them.
    const { argv: argvEnv, file: secretEnv } = partitionLaunchEnv(seatEnv);
    const argv = ["tmux", "new-session", "-d", "-s", name];
    if (cwd != null) argv.push("-c", cwd);
    for (const [k, v] of Object.entries(argvEnv)) argv.push("-e", `${k}=${v}`);
    // The pane new-session itself made: an after-new-session hook may select another window.
    argv.push("-P", "-F", "#{pane_id}");
    const legacyParts = ["tmux", "new-session", "-d", "-s", shellQuote(name)];
    if (cwd != null) legacyParts.push("-c", shellQuote(cwd));
    for (const [k, v] of Object.entries(argvEnv)) legacyParts.push("-e", shellQuote(`${k}=${v}`));
    legacyParts.push("-P", "-F", shellQuote("#{pane_id}"));
    let created: string;
    try {
      created = (await this.run(argv, legacyParts.join(" "))).trim();
    } catch (err) {
      return classifyWriteError(err);
    }
    const hasSecrets = Object.keys(secretEnv).length > 0;
    if (hasSecrets) {
      try {
        await this.deliverSecretEnv(exactTarget(name, "session"), secretEnv);
      } catch (err) {
        // A seat without its credentials must not be left half-launched.
        await this.discardUnlaunchedSession(name);
        return classifyWriteError(err);
      }
    }
    // A tmux server started from a Claude Code session or Herdr pane hands
    // their identity to every new pane. Mark it removed for this session only
    // and restart the fresh pane so its shell starts without it. The session
    // exists either way, so a failure here is a warning, never a failed launch
    // (unless credentials were set: the first shell then lacks them, so the
    // restart is part of delivering them and its failure fails the launch).
    let warnings: string[] | undefined;
    let excluded = false;
    try {
      excluded = await this.excludeParentSessionEnv(exactTarget(name, "session"), Object.keys(seatEnv));
    } catch (err) {
      warnings = [parentSessionEnvWarning(name, err)];
    }
    if (excluded || hasSecrets) {
      try {
        const isPaneId = /^%\d+$/.test(created);
        // Credentials need the restart, so a tmux that printed no pane id gets the session's own pane
        // (a fresh session has just the one); without credentials the restart stays best-effort.
        if (!isPaneId && !hasSecrets) throw new Error(`new-session reported no pane id ("${created}"), so no pane was restarted`);
        const respawn = ["tmux", "respawn-pane", "-k", "-t", isPaneId ? created : exactTarget(name, "pane")];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
      } catch (err) {
        if (hasSecrets) {
          await this.discardUnlaunchedSession(name);
          return classifyWriteError(err);
        }
        warnings = [parentSessionEnvWarning(name, err)];
      }
    }
    return warnings ? { ok: true, warnings } : { ok: true };
  }

  /** Write `secret` into one tmux session's environment without a credential
   * ever appearing in an argv: a 0600 file of `set-environment` lines that the
   * tmux server reads with `source-file`, removed afterwards. Failures carry no
   * file content: tmux echoes script text in some parse errors. */
  private async deliverSecretEnv(sessionTarget: string, secret: Readonly<Record<string, string>>): Promise<void> {
    const script = renderSecretEnvScript(sessionTarget, secret);
    const file = this.fileOps.tmpName();
    let written = false;
    try {
      await this.fileOps.writeFile(file, script, { mode: 0o600, flag: "wx" });
      written = true;
      const argv = ["tmux", "source-file", file];
      await this.run(argv, posixJoinArgv(argv));
    } catch {
      throw new Error("Could not deliver the seat's launch credentials to tmux.");
    } finally {
      if (written) { try { await this.fileOps.unlink(file); } catch { /* best-effort; the file is 0600 and tmux has already read it */ } }
    }
  }

  /** Remove the session this call just created, after its launch failed. */
  private async discardUnlaunchedSession(name: string): Promise<void> {
    try {
      const argv = ["tmux", "kill-session", "-t", exactTarget(name, "session")];
      await this.run(argv, posixJoinArgv(argv));
    } catch { /* nothing more to do; the caller reports the launch failure */ }
  }

  /** Mark the server's inherited parent-session identity as removed in one
   * session's environment, never the server's global one. Explicit seat
   * values stay. Returns whether anything was marked. Throws when the global
   * environment can't be read: the caller can't tell whether the seat inherits
   * an identity, so it reports a warning (the launch still goes ahead). */
  private async excludeParentSessionEnv(sessionTarget: string, keep: readonly string[] = []): Promise<boolean> {
    const global = await this.run(["tmux", "show-environment", "-g"], "tmux show-environment -g");
    const inherited: Record<string, string> = {};
    for (const line of global.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) inherited[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const keys = parentSessionEnvKeys(inherited).filter((key) => !keep.includes(key));
    for (const key of keys) {
      const argv = ["tmux", "set-environment", "-t", sessionTarget, "-r", key];
      await this.run(argv, posixJoinArgv(argv));
    }
    return keys.length > 0;
  }

  /**
   * Bracketed paste by default, at every size. Unbracketed input can be consumed as individual
   * keystrokes by agent TUIs, losing text even below the old 8 KiB cutoff.
   * A file keeps payload bytes out of shell/tmux argv and its size limits.
   *   `-p`  bracket the paste when the receiving application enables that mode.
   *   `-r`  preserve raw LF. tmux's default paste-buffer replaces every LF with
   *         CR, and CR is SUBMIT in the Claude/Codex TUIs - a
   *         default paste of a multi-line pack would submit on every newline.
   *   `-d`  drop the buffer after a successful paste.
   * `options.bracketed: false` omits `-p` for explicit prompt answers: bytes
   * then act as keystrokes, including menu shortcuts and control keys.
   * Any trailing submit stays the caller's separate `sendKeys(["Enter"])`.
   * Cleanup unlinks the temp file in `finally`; if the buffer was loaded but the
   * paste failed (e.g. missing target), an explicit `delete-buffer` runs so no
   * buffer leaks. Unique temp + buffer names per call keep parallel `rig up`
   * seats from colliding.
   */
  async sendText(target: string, text: string, beforeInput?: () => void, options?: { bracketed?: boolean }): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => this.sendTextUnchecked(pane, text, () => { beforeWrite(); beforeInput?.(); }, options?.bracketed));
  }

  private async sendTextUnchecked(target: string, text: string, beforeWrite: () => void, bracketed = true): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    let created = false;
    try {
      await this.fileOps.writeFile(path, text, { mode: 0o600, flag: "wx" });
      created = true;
      await this.run(["tmux", "load-buffer", "-b", buffer, path],
        `tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`);
      bufferLoaded = true;
      beforeWrite();
      // Explicit prompt answers need key input, not bracketed-paste framing.
      // Keep their bytes in the file: tmux command parsing and argv limits must
      // not alter semicolons or reject long answers (#519, #602).
      await this.run(["tmux", "paste-buffer", "-t", target, "-b", buffer, "-d", "-r", ...(bracketed ? ["-p"] : [])],
        `tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r${bracketed ? " -p" : ""}`);
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // paste failed after load - `-d` never ran, so the buffer is still
        // resident. Best-effort delete to avoid leaking it.
        try {
          await this.run(["tmux", "delete-buffer", "-b", buffer],
        `tmux delete-buffer -b ${shellQuote(buffer)}`);
        } catch { /* best-effort cleanup */ }
      }
      return classifyWriteError(err);
    } finally {
      if (created) {
        try {
          await this.fileOps.unlink(path);
        } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * Launch a POSIX command in an empty shell. A newly created pane can still
   * be in canonical input mode: on macOS it silently drops input beyond 1024
   * bytes, even when paste-buffer succeeds. Only a short invocation crosses
   * that boundary; the command's PATH, quoting and arguments travel in a file.
   * The shell removes its private script when consumed (not when pasted).
   * A shell that never consumes the invocation leaves the file for diagnosis.
   */
  async sendShellCommand(target: string, command: string, beforeInput?: () => void, options: TmuxShellCommandOptions = {}): Promise<TmuxResult> {
    // Keep the managed selector for nested paste/Enter checks. A resolved pane
    // ID can also occur in detached bindings after a tmux restart; resolving it
    // again would lose the unambiguous session/node and its existing lease.
    // Each nested write still validates the lease and targets its observed pane.
    return this.guardedInput(target, () => this.sendShellCommandUnchecked(target, command, beforeInput, options));
  }

  private async sendShellCommandUnchecked(target: string, command: string, beforeInput: (() => void) | undefined, options: TmuxShellCommandOptions): Promise<TmuxResult> {
    const commandBytes = Buffer.byteLength(command, "utf8");
    // POSIX shells retain subshell isolation; unknown/unreadable panes use sh.
    const paneShell = options.sourceInPane ? (await this.getPaneCommand(target) ?? "").replace(/^-/, "") : "";
    const sourceInPane = ["bash", "zsh", "sh", "dash", "ksh"].includes(paneShell);
    // A short Pi command is typed as it stands only when no widget rewrites a character of it.
    let path = options.stageIfLong && commandBytes <= 512 && isTypedLineWidgetSafe(command) ? undefined : this.fileOps.tmpName();
    let invocation = path ? sourceInPane ? `. ${typedPathArg(path)}` : `/bin/sh ${typedPathArg(path)}` : command;
    if (path && paneShell === "fish") {
      const quotedPath = shellQuote(path);
      invocation = `/bin/sh ${quotedPath}`;
      // Fish single quotes reinterpret POSIX backslashes. Keep those payloads
      // (and paths) on sh, preserving existing executable launches byte-for-byte.
      if (!command.includes("\\") && !path.includes("\\")) {
        // Probe fixed syntax in the pane before sourcing, not the launch's exit
        // status: even failed cleanup must not turn a later exit into a retry.
        const sourced = `if eval 'OPENRIG_FISH_ASSIGNMENT_PROBE=1 /bin/sh -c :'; source ${quotedPath}; else; /bin/sh ${quotedPath}; end`;
        // Repeating the path must not add a refusal for previously valid TMPDIRs.
        if (Buffer.byteLength(sourced, "utf8") <= 512) invocation = sourced;
      }
    }
    if (Buffer.byteLength(invocation, "utf8") > 512) {
      // Pi commands below the canonical tty limit still fit when staging cannot.
      if (options.stageIfLong && commandBytes < 1024) {
        path = undefined;
        invocation = command;
      } else {
        return { ok: false, code: "launch_path_too_long", message: "Temporary launch-script path exceeds the safe terminal input bound" };
      }
    }
    let created = false;
    let commandFile: string | undefined;
    try {
      if (path) {
        if (sourceInPane) {
          // Sourced in the pane shell, the command keeps its subshell isolation inside the script,
          // not in typed parentheses (an autopair widget rewrote `( . file )`). The command sits in
          // its own file that the subshell sources, so a stray `)` in it is a parse error rather
          // than something that could close the wrapper and run the rest in the pane shell.
          commandFile = `${path}.cmd`;
          await this.fileOps.writeFile(commandFile, `/bin/rm -f -- ${shellQuote(commandFile)}\n${command}\n`, { mode: 0o600, flag: "wx" });
          created = true;
          await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n( . ${shellQuote(commandFile)} )\n`, { mode: 0o600, flag: "wx" });
        } else {
          await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n${options.execInScript ? "exec " : ""}${command}\n`, { mode: 0o600, flag: "wx" });
        }
        created = true;
      }
      const text = beforeInput ? await this.guardedInput(target, (pane, check) => this.sendTextUnchecked(pane, invocation, () => { check(); beforeInput(); }))
        : await this.sendText(target, invocation);
      if (!text.ok) return text;
      const enter = beforeInput ? await this.guardedInput(target, pane => { beforeInput(); return this.sendKeysUnchecked(pane, ["Enter"]); })
        : await this.sendKeys(target, ["Enter"]);
      if (!enter.ok) {
        await this.sendKeys(target, ["C-c"]);
        return enter;
      }
      // The receiver now owns removal. Unlinking here races shell startup.
      created = false;
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    } finally {
      if (created && path) {
        try { await this.fileOps.unlink(path); } catch { /* best-effort cleanup */ }
        if (commandFile) { try { await this.fileOps.unlink(commandFile); } catch { /* best-effort cleanup */ } }
      }
    }
  }

  async sendKeys(target: string, keys: string[], beforeInput?: () => void): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => { beforeWrite(); beforeInput?.(); return this.sendKeysUnchecked(pane, keys); });
  }

  private async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "send-keys", "-t", target, ...keys],
        `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async setWindowOption(target: string, option: string, value: string): Promise<TmuxResult> {
    const window = exactTarget(target, "window");
    try {
      await this.run(["tmux", "set-option", "-w", "-t", window, option, value],
        `tmux set-option -w -t ${shellQuote(window)} ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult> {
    if (!Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: cols must be a positive integer, got ${cols}` };
    }
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: rows must be a positive integer, got ${rows}` };
    }
    try {
      await this.run(["tmux", "resize-window", "-t", exactTarget(target, "window"), "-x", String(cols), "-y", String(rows)]);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async killSession(name: string): Promise<TmuxResult> {
    if (this.deliveryGuard) {
      return this.guardedInput(name, async pane => {
        const stdout = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{session_id}"], `tmux display-message -p -t ${shellQuote(pane)} '#{session_id}'`);
        const sessionId = stdout.trim();
        if (!/^\$\d+$/.test(sessionId)) return { ok: false, code: "guard_target_unknown", message: "Cannot establish immutable session identity; no session killed." };
        const kill = async () => {
          const result = await this.killSessionUnchecked(sessionId);
          if (result.ok) { this.freshProbes.delete(name); this.freshProbes.delete(pane); this.freshManaged.delete(name); }
          return result;
        };
        if (this.freshProbes.get(name) === pane && !this.deliveryGuard!.maybeTarget(name) && !this.deliveryGuard!.maybeTarget(pane)) return kill();
        return this.deliveryGuard!.input(this.freshManaged.get(name)?.nodeId ?? name, kill);
      }, true);
    }
    return this.killSessionUnchecked(name);
  }

  private async killSessionUnchecked(name: string): Promise<TmuxResult> {
    // The guarded path passes the immutable `$N` id, which stays as it is; a bare name is made exact.
    const session = exactTarget(name, "session");
    // Detach first so `detach-on-destroy off` cannot switch views onto another session.
    try {
      await this.run(["tmux", "detach-client", "-s", session],
        `tmux detach-client -s ${shellQuote(session)}`);
    } catch (err) {
      // tmux 3.7 says "no current client" when nothing is attached (and for a missing session, which the kill classifies).
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("no current client")) return classifyWriteError(err);
    }
    try {
      await this.run(["tmux", "kill-session", "-t", session],
        `tmux kill-session -t ${shellQuote(session)}`);
      const pane = this.freshProbes.get(name);
      this.freshProbes.delete(name);
      if (pane) this.freshProbes.delete(pane);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover (plan 411c43de): respawn a pane IN PLACE (reuse the retiree's EXACT pane) so
   *  the successor boots below the predecessor's history — same window, same pane, predecessor scrollback
   *  PRESERVED above the boot. The command is shell-quoted as ONE unit (tmux runs it via the shell).
   *
   *  ⚠ NO `-k`: empirically (tmux 3.6a) `respawn-pane -k` force-kills+respawns atomically and CLEARS the
   *  pane's scrollback — defeating the money-proof. So the cutover terminates the retiree FIRST (graceful
   *  exit + `setRemainOnExit(true)` so the pane survives dead), waits for `isPaneDead`, then calls this
   *  WITHOUT -k on the already-dead pane — which preserves the history. respawn-pane refuses a still-live
   *  pane ("still active"), which is the correct guard: never respawn over a live retiree.
   *
   *  Optional `cwd`/`env` inject the successor's start-directory + OpenRig identity env onto the reused
   *  pane via respawn-pane's `-c`/`-e` flags (tmux ≥3.0), the SAME mechanism createSession uses. Any flags
   *  precede the command, which always stays LAST.
   *
   *  ⚠ KI-14: omitting `command` re-runs the pane's CREATION (or last-respawn) command — which is the
   *  default shell ONLY for panes createSession made. Adopted/hand-recovered panes can carry a full
   *  harness invocation there (`codex … resume <old-token>`), so an undefined respawn silently boots the
   *  OLD context. Callers that need a blank pane must pass an explicit shell (see getDefaultShell). */
  async respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<TmuxResult> {
    return this.guardedInput(paneTarget, pane => this.respawnPaneUnchecked(pane, command, opts));
  }

  private async respawnPaneUnchecked(paneTarget: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = ["tmux", "respawn-pane", "-t", exact];
    if (opts?.cwd != null) argv.push("-c", opts.cwd);
    // Credentials are set in the session environment through a 0600 file (see
    // createSessionUnchecked); the respawned process starts from that environment.
    const { argv: argvEnv, file: secretEnv } = partitionLaunchEnv(opts?.env ?? {});
    for (const [k, v] of Object.entries(argvEnv)) argv.push("-e", `${k}=${v}`);
    // The respawn command is ONE argv unit: tmux runs it via the shell.
    if (command != null && command.length > 0) argv.push(command);
    const legacyRespawn = ["tmux", "respawn-pane", "-t", shellQuote(exact)];
    if (opts?.cwd != null) legacyRespawn.push("-c", shellQuote(opts.cwd));
    for (const [k, v] of Object.entries(argvEnv)) legacyRespawn.push("-e", shellQuote(`${k}=${v}`));
    if (command != null && command.length > 0) legacyRespawn.push(shellQuote(command));
    // The credentials are set in the SESSION environment, which outlives this call: a later window or respawn
    // inherits it. So a respawn that does not happen puts the session environment back as it was (OF-113); the
    // pane itself is untouched either way.
    const secretKeys = Object.keys(secretEnv);
    let before: Map<string, string> | null = null;
    if (secretKeys.length > 0) {
      before = await this.readSessionEnvValues(exact, secretKeys);
      try {
        await this.deliverSecretEnv(exact, secretEnv);
      } catch (err) {
        await this.restoreSessionEnv(exact, secretKeys, before); // a partial delivery may have set some keys
        return classifyWriteError(err); // the pane is untouched
      }
    }
    // The successor starts from the session environment: exclude inherited
    // parent-session identity there first (sessions made before this existed).
    // A failure here is a warning; the respawn goes ahead as it did before.
    let warnings: string[] | undefined;
    try {
      await this.excludeParentSessionEnv(exact, Object.keys(opts?.env ?? {}));
    } catch (err) {
      warnings = [parentSessionEnvWarning(exact, err)];
    }
    try {
      await this.run(argv, legacyRespawn.join(" "));
      return warnings ? { ok: true, warnings } : { ok: true };
    } catch (err) {
      if (secretKeys.length > 0) await this.restoreSessionEnv(exact, secretKeys, before);
      return classifyWriteError(err);
    }
  }

  /** The current values of `keys` in one session's environment (a key the session does not set is absent from the
   *  map), or null when tmux could not be read. Values stay in memory: nothing here logs or returns them to a caller. */
  private async readSessionEnvValues(sessionTarget: string, keys: readonly string[]): Promise<Map<string, string> | null> {
    try {
      const argv = ["tmux", "show-environment", "-t", sessionTarget];
      const out = await this.run(argv, posixJoinArgv(argv));
      const values = new Map<string, string>();
      for (const line of out.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0 && keys.includes(line.slice(0, eq))) values.set(line.slice(0, eq), await this.unescapeShownValue(line.slice(eq + 1), sessionTarget));
      }
      return values;
    } catch {
      return null;
    }
  }

  /** Put `keys` in one session's environment back to `before`: a key it held is set to that value again (through the
   *  credential file, never an argv), a key it did not hold is unset. With no snapshot (`before` null) every key is
   *  unset. Best-effort: the caller is already reporting the failure that made this necessary. */
  private async restoreSessionEnv(sessionTarget: string, keys: readonly string[], before: Map<string, string> | null): Promise<void> {
    await this.sweepEscapeProbeKeys(sessionTarget);
    const held: Record<string, string> = {};
    for (const key of keys) {
      const value = before?.get(key);
      if (value !== undefined) { held[key] = value; continue; }
      try {
        const argv = ["tmux", "set-environment", "-t", sessionTarget, "-u", key];
        await this.run(argv, posixJoinArgv(argv));
      } catch { /* best-effort */ }
    }
    if (Object.keys(held).length > 0) {
      try { await this.deliverSecretEnv(sessionTarget, held); } catch { /* best-effort */ }
    }
  }

  /** Seat-handover cutover: set the pane-scoped `remain-on-exit` so the pane SURVIVES (goes dead, not
   *  destroyed) when the retiree process exits — holding its scrollback for the successor's respawn.
   *  Set to `on` BEFORE the retiree is signalled to exit (else the pane is destroyed on exit and there
   *  is nothing to respawn into). */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      await this.run(["tmux", "set-option", "-p", "-t", exact, "remain-on-exit", on ? "on" : "off"],
        `tmux set-option -p -t ${shellQuote(exact)} remain-on-exit ${on ? "on" : "off"}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's OWN value for an option, without inherited window/global values: the string, null when the
   *  pane sets none, undefined when tmux could not be read. A caller that changes the option for a while
   *  restores exactly this with restorePaneOption. */
  async getPaneLocalOption(paneTarget: string, option: string): Promise<string | null | undefined> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      const output = await this.run(["tmux", "show-options", "-p", "-v", "-t", exact, option],
        `tmux show-options -p -v -t ${shellQuote(exact)} ${shellQuote(option)}`);
      // tmux prints nothing for an unset option and the value plus a newline when set (an empty value prints
      // a bare newline), so only the line ending is removed: the value comes back exactly as it was set.
      return output.length === 0 ? null : output.replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }

  /** Put back what getPaneLocalOption read: set the value, or unset the pane's own value when it had none. */
  async restorePaneOption(paneTarget: string, option: string, value: string | null): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = value === null
      ? ["tmux", "set-option", "-p", "-u", "-t", exact, option]
      : ["tmux", "set-option", "-p", "-t", exact, option, value];
    try {
      await this.run(argv, argv.map((part, index) => index < 2 ? part : shellQuote(part)).join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's whole text, history and visible screen, with wrapped lines joined. Null when unreadable. */
  async capturePaneHistory(paneTarget: string): Promise<string | null> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      return await this.run(["tmux", "capture-pane", "-p", "-J", "-t", exact, "-S", "-", "-E", "-"],
        `tmux capture-pane -p -J -t ${shellQuote(exact)} -S - -E -`);
    } catch {
      return null;
    }
  }

  /** Signal one process by pid. signalPaneProcess signals the pane's root, which in a shell-backed pane is
   *  the shell, not the runtime running under it. Unix `kill`, like signalPaneProcess. */
  async signalPid(pid: number, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, code: "invalid_pid", message: `Refusing to signal pid ${pid}.` };
    try {
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: is the pane's process dead (the retiree exited; the pane held by
   *  remain-on-exit)? A known-missing pane also proves physical cutover; unknown probe errors stay false. */
  async isPaneDead(paneId: string): Promise<boolean> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", exact, "#{pane_dead}"],
        `tmux display-message -p -t ${shellQuote(exact)} "#{pane_dead}"`);
      return output.trim() === "1";
    } catch (error) {
      return isNoServerError(error) || isPaneAbsenceError(error);
    }
  }

  /** Seat-handover cutover: signal the pane's foreground process (the retiree) — `TERM` for the graceful
   *  exit-in-place, `KILL` for the bounded-timeout force fallback. Resolves the pane pid then `kill`s it;
   *  an unresolvable pid is a structured, non-throwing failure.
   *  Stays on the shell-string path deliberately: this is a Unix `kill`,
   *  not a multiplexer command (Windows needs taskkill — named follow-up). */
  async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    return this.guardedInput(paneId, (pane, beforeWrite) => this.signalPaneProcessUnchecked(pane, signal, beforeWrite));
  }

  private async signalPaneProcessUnchecked(paneId: string, signal: "TERM" | "KILL", beforeWrite: () => void): Promise<TmuxResult> {
    const pid = await this.getPanePid(paneId);
    if (pid == null) {
      return { ok: false, code: "pane_pid_unavailable", message: `Could not resolve the pane pid for "${paneId}".` };
    }
    try {
      beforeWrite();
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get the PID of the foreground process in a pane. Returns null if unavailable. */
  async getPanePid(paneId: string): Promise<number | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_pid}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_pid}"`);
      const trimmed = output.trim();
      const parsed = parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /** KI-14: the server's `default-shell` option — what a createSession pane runs when no command is
   *  given. Used to make a respawn EXPLICIT about the blank shell instead of inheriting whatever
   *  command the pane was created with. Returns null if unavailable (caller falls back). */
  async getDefaultShell(): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-gv", "default-shell"]);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Get the current foreground command in a pane. Returns null if unavailable. */
  async getPaneCommand(paneId: string): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_current_command}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_current_command}"`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /**
   * The value a session really holds, from the text `tmux show-environment` printed for it. Some tmux builds add a
   * backslash to a `$` when they print (measured, Ubuntu tmux 3.4-1ubuntu0.1: `a$b` is shown as `a\$b`, `$a` as `\$a`,
   * `a\$b` as `a\\$b`, but `a$`, `a$1`, `a$(b)`, `a$$` and `$` are shown as they are, so the rule depends on the character
   * after the `$`); tmux 3.7c prints the value as it is; upstream 3.4 and 3.5a read as printing it as it is. The build is not
   * told by its version, and the rule is not known for every character, so the answer is MEASURED PER VALUE: each plausible
   * original (the shown text as it is, and the shown text with the extra backslashes taken out under two rules) is put into
   * a scratch variable of the same session through the credential file channel (never an argv), read back, and kept only if
   * tmux prints exactly the text that was shown. The original is the one candidate that round-trips. None, or more than one,
   * means the value cannot be known, and the read REFUSES: a guess hands a seat a wrong credential. The scratch variable
   * is unset again either way. Only `$` is touched; nothing else was ever escaped (measured: backtick, `"`, `\`, `%`, `#`, `~`).
   */
  private async unescapeShownValue(shown: string, sessionTarget: string): Promise<string> {
    if (!shown.includes("$")) return shown;
    const candidates = [...new Set([
      shown,
      shown.replace(/\\(\$[A-Za-z_{])/g, "$1"), // a build that escapes `$` before a name or `{`
      shown.replace(/\\\$/g, "$"), // a build that escapes every `$`
    ])];
    const key = `${ESCAPE_PROBE_PREFIX}${randomUUID().replace(/-/g, "")}`;
    const confirmed: string[] = [];
    // A scratch variable a crashed daemon (or a failed unset) left behind holds a credential candidate outside every key list
    // the restore manages: remove it before writing a new one.
    await this.sweepEscapeProbeKeys(sessionTarget);
    // From here the scratch variable is this probe's own and live: a concurrent probe or restore on the same session
    // must not sweep it away (OF-149). It leaves the set only after its unset has been tried.
    this.liveEscapeProbeKeys.add(key);
    try {
      for (const candidate of candidates) {
        await this.deliverSecretEnv(sessionTarget, { [key]: candidate });
        const show = ["tmux", "show-environment", "-t", sessionTarget, key];
        const printed = (await this.run(show)).replace(/\r?\n$/, "");
        if (printed === `${key}=${shown}`) confirmed.push(candidate);
      }
    } catch {
      throw new Error("Cannot tell how this tmux prints '$' in the session environment.");
    } finally {
      try {
        await this.unsetEscapeProbeKey(sessionTarget, key);
      } finally {
        this.liveEscapeProbeKeys.delete(key);
      }
    }
    if (confirmed.length !== 1) throw new Error("Cannot tell how this tmux prints '$' in the session environment.");
    return confirmed[0]!;
  }

  /** Unset one scratch variable. A failure is named (the key only, never a value) and left for the next sweep. */
  private async unsetEscapeProbeKey(sessionTarget: string, key: string): Promise<void> {
    try {
      const unset = ["tmux", "set-environment", "-t", sessionTarget, "-u", key];
      await this.run(unset);
    } catch {
      console.warn(`[openrig] tmux: could not remove scratch variable ${key} from session ${sessionTarget}; it is removed the next time the session is read or restored`);
    }
  }

  /** Scratch variables of probes that are running now in this process. The sweep leaves them alone: it removes what a failed
   *  unset or a crash left, not what another probe on the same session is still reading back. */
  private readonly liveEscapeProbeKeys = new Set<string>();

  /** Remove every `OPENRIG_TMUX_ESCAPE_PROBE_*` variable from one session that no live probe of this adapter owns: what a failed unset or a crash mid-probe left. Reads
   *  names only (no value is kept or logged); best-effort, because the session may be gone. */
  private async sweepEscapeProbeKeys(sessionTarget: string): Promise<void> {
    let listing: string;
    try {
      listing = await this.run(["tmux", "show-environment", "-t", sessionTarget]);
    } catch {
      return;
    }
    for (const line of listing.split(/\r?\n/)) {
      const name = line.startsWith("-") ? line.slice(1) : line.slice(0, Math.max(line.indexOf("="), 0));
      if (name.startsWith(ESCAPE_PROBE_PREFIX) && /^[A-Za-z0-9_]+$/.test(name) && !this.liveEscapeProbeKeys.has(name)) await this.unsetEscapeProbeKey(sessionTarget, name);
    }
  }

  /** A launch metadata read. Callers must never put credential values in terminal input. */
  async getSessionEnv(session: string, key: string): Promise<string | undefined> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", target, key],
        `tmux show-environment -t ${shellQuote(target)} ${shellQuote(key)}`);
      if (output.trim() === `-${key}`) return undefined;
      if (!output.startsWith(`${key}=`)) throw new Error("Unexpected session environment response.");
      return await this.unescapeShownValue(output.slice(key.length + 1).replace(/\r?\n$/, ""), target);
    } catch (error) {
      if (error instanceof Error && error.message.includes(`unknown variable: ${key}`)) return undefined;
      throw new Error("Cannot read the session's launch environment.");
    }
  }

  /** OPR.0.4.3.28 Part C — usable-presence check for a session-env variable.
   *  Returns whether the var has a nonblank value, NEVER that value, and null
   *  when the session environment cannot be inspected. Listing the environment
   *  distinguishes a genuinely absent var from `tmux show-environment <var>`'s
   *  nonzero lookup exit. */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    const target = exactTarget(sessionName, "session");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", target],
        `tmux show-environment -t ${shellQuote(target)}`);
      const prefix = `${varName}=`;
      return output.split(/\r?\n/).some(
        (line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0,
      );
    } catch {
      return null;
    }
  }

  /** Start pipe-pane to capture terminal output to a file. */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    // Shell-quote the path for safe injection into the pipe-pane command.
    // The entire pipe command is passed as a single argument to tmux,
    // which executes it via sh -c. We use shellQuote on the path.
    // The sink travels as ONE argv unit: the multiplexer runs it via a
    // shell, so its inner quoting stays POSIX here (psmux documents the same
    // `cat >` server-side form for its own path).
    const sink = "cat >> " + shellQuote(outputPath);
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target, sink],
        `tmux pipe-pane -t ${shellQuote(target)} ${shellQuote(sink)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Stop pipe-pane on a session. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target],
        `tmux pipe-pane -t ${shellQuote(target)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Capture pane content (last N lines). Returns null if unavailable. */
  /**
   * Capture many sessions' panes with a few tmux calls instead of one per session (#308). A `list-sessions` runs next
   * to the first chained call and is read only when a chain fails: a target it lacks maps to null (as a failed
   * per-target capture) without a fork. The targets are captured in chunks of CAPTURE_BATCH chained commands (a
   * `display-message` marker, then `capture-pane`), each pane's output delimited by a marker unique to the call, so the
   * text equals what `capturePaneContent` returns. Targets are exact (`=<name>:`): no prefix match, and a name with a
   * "." still resolves. tmux stops a chain at its first failing command, so a failed chunk drops the targets the
   * listing lacks (`missing`) and retries, or is split in half (an oversized output, or a session gone since the
   * listing); a single session that still fails is left OUT of the map, and the caller reads it per target. A server
   * gone since the listing maps the chunk to null without a retry. Any other chain error leaves the chunk out, so the
   * caller reads each pane per target, as an unbatched read does. Null when a chain fails because the server is gone
   * or its socket can't be reached, and tmux can't be listed; a chain that fails for another reason while the listing
   * fails too leaves the chunk to per-target reads. Each entry carries the time its own chunk was read (`capturedAt`), so a slow later
   * chunk can't make an earlier capture look fresh.
   */
  async capturePanesContent(targets: string[], lines: number = 20, now: () => Date = () => new Date()): Promise<Map<string, PaneCapture> | null> {
    // OF-176: when the poll loops' shared window snapshot answered within CAPTURE_LISTING_MAX_AGE_MS, it is the listing
    // (no fork); otherwise a `list-sessions` of its own runs beside the chain, as before.
    const shared = this.peekSessionWindowSnapshot(CAPTURE_LISTING_MAX_AGE_MS);
    const listing = shared && shared.sessions.size > 0 ? Promise.resolve(shared.sessions)
      : this.run(["tmux", "list-sessions", "-F", "#{session_name}"], "tmux list-sessions -F '#{session_name}'")
        .then((output) => new Set(output.split(/\r?\n/).filter(Boolean)), () => null);
    const out = new Map<string, PaneCapture>();
    let unlisted = false;
    /** Capture one chunk with a single chained tmux call into `out`; on failure, retry it without the unlisted targets
     *  or split it in half. */
    const captureChunk = async (chunk: string[]): Promise<void> => {
      const nonce = randomUUID().replace(/-/g, "");
      const mark = (k: number) => `__openrig_capture_${nonce}_${k}__`;
      const argv = ["tmux", ...chunk.flatMap((t, k) => [
        ...(k > 0 ? [";"] : []),
        "display-message", "-p", "-t", `=${t}:`, mark(k), ";", "capture-pane", "-p", "-t", `=${t}:`, "-S", `-${lines}`,
      ])];
      const legacy = "tmux " + chunk.map((t, k) =>
        `display-message -p -t ${shellQuote(`=${t}:`)} ${shellQuote(mark(k))} \\; capture-pane -p -t ${shellQuote(`=${t}:`)} -S -${lines}`,
      ).join(" \\; ");
      let output: string;
      let capturedAt: Date;
      try {
        output = await this.run(argv, legacy);
        capturedAt = now(); // when THIS chunk's panes were read, not when the sweep ends
      } catch (err) {
        const live = await listing;
        if (!live) {
          // A failed listing doesn't show the server is gone; the chain's own error does.
          const cause = tmuxReportedError(err);
          if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) unlisted = true;
          return;
        }
        // The listing answered, so the server was up: the targets it lacks are dropped first.
        const listedAt = now();
        const present: string[] = [];
        for (const t of chunk) {
          if (live.has(t)) present.push(t);
          else out.set(t, { text: null, capturedAt: listedAt, missing: true });
        }
        if (present.length < chunk.length) {
          if (present.length) await captureChunk(present);
          return;
        }
        const cause = tmuxReportedError(err);
        // Every half would fail the same way: the server is gone.
        if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) {
          for (const t of chunk) out.set(t, { text: null, capturedAt: listedAt });
          return;
        }
        // Halving helps only an output that overflowed exec's buffer (wide, colour-dense panes) or a session that
        // vanished since the listing. Any other error would fail every half, so the chunk is left to per-target reads.
        // Node's overflow error is the message's first line; pane text follows it.
        if (!/^.*maxBuffer length exceeded/.test((err as Error).message) && !isSessionAbsenceError(cause) && !isPaneAbsenceError(cause)) {
          return;
        } else if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await Promise.all([captureChunk(chunk.slice(0, half)), captureChunk(chunk.slice(half))]);
        }
        return; // a single session that failed: read per target by the caller
      }
      const segments: Array<string[] | null> = chunk.map(() => null);
      let cur = -1;
      const outLines = output.split("\n");
      if (outLines.length && outLines[outLines.length - 1] === "") outLines.pop(); // the final newline, not a line
      for (const line of outLines) {
        const m = line.startsWith(`__openrig_capture_${nonce}_`) ? /_(\d+)__$/.exec(line) : null;
        if (m && line === mark(Number(m[1]))) {
          cur = Number(m[1]);
          segments[cur] = [];
        } else if (cur >= 0) {
          segments[cur]!.push(line);
        }
      }
      chunk.forEach((t, k) => {
        const seg = segments[k];
        if (seg == null) return; // its marker never printed: read per target
        // capture-pane prints its lines newline-terminated, as the per-target read returns them
        const text = seg.length ? seg.join("\n") + "\n" : "";
        out.set(t, { text: text === "" ? null : text, capturedAt });
      });
    };
    const unique = [...new Set(targets)];
    for (let i = 0; i < unique.length && !unlisted; i += CAPTURE_BATCH) await captureChunk(unique.slice(i, i + CAPTURE_BATCH));
    return unlisted && out.size === 0 ? null : out;
  }

  async capturePaneContent(paneId: string, lines: number = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    // `-e` keeps text styling, such as the faint rendering of a suggestion.
    const styled = opts?.escapeSequences === true;
    // Verification can recover mid-word soft wraps without erasing logical newlines.
    const joined = opts?.joinWrappedLines === true;
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", ...(styled ? ["-e"] : []), ...(joined ? ["-J"] : []), "-t", target, "-S", `-${lines}`],
        `tmux capture-pane -p${styled ? " -e" : ""}${joined ? " -J" : ""} -t ${shellQuote(target)} -S -${lines}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Capture the currently VISIBLE pane screen (no scrollback). Returns null if
   * unavailable. The live-terminal seed (OPR.0.4.0.38) must use the visible
   * screen, NOT `-S -<lines>` scrollback: scrollback reintroduces the row drift
   * the absolute-paint seed exists to eliminate.
   */
  async capturePaneScreen(paneId: string): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", "-t", target],
        `tmux capture-pane -p -t ${shellQuote(target)}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current cursor coordinates and pane geometry. Coordinates are
   * zero-based. Returns null if unavailable or if tmux yields non-finite /
   * out-of-range values (x<0, y<0, width<1, height<1) so a bad read never
   * produces a garbage seed.
   */
  async getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", exact, CURSOR_FORMAT],
        `tmux display-message -p -t ${shellQuote(exact)} "${CURSOR_FORMAT}"`,
      );
      const [xRaw, yRaw, widthRaw, heightRaw] = output.trim().split(TMUX_FIELD_SEPARATOR);
      const x = Number.parseInt(xRaw ?? "", 10);
      const y = Number.parseInt(yRaw ?? "", 10);
      const width = Number.parseInt(widthRaw ?? "", 10);
      const height = Number.parseInt(heightRaw ?? "", 10);
      if (![x, y, width, height].every(Number.isFinite)) return null;
      if (x < 0 || y < 0 || width < 1 || height < 1) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * Set a SESSION-scoped option via `set-option -t <session>` (OPR.0.4.6.02
   * N1 JSDoc fix, arch): this is the GENERIC session-scope writer — it takes
   * ANY session option, not only `@`-prefixed user options (it is how the
   * launcher sets built-in session options like `mouse` and `status`). For
   * SERVER-scope options use `setServerOption` (`set-option -s`); the two
   * scopes are never crossed (guard b2).
   */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "set-option", "-t", exact, key, value],
        `tmux set-option -t ${shellQuote(exact)} ${shellQuote(key)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1 (guard b2): set a SERVER-scoped option via
   * `set-option -s <option> <value>` — the daemon configuring its OWN tmux
   * server (NOT a live-flip of anyone's session). NEVER targets a session
   * (`-t`): server scope and session scope are distinct and never crossed.
   * Used for `set-clipboard` / `copy-command`.
   */
  async setServerOption(option: string, value: string): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "set-option", "-s", option, value],
        `tmux set-option -s ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1: read a SERVER-scoped option value via
   * `show-options -sv <option>` (the `-s` server-scope reader — mirrors
   * `setServerOption`). Returns null if unset or on error. For tests/proof.
   */
  async showServerOption(option: string): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-sv", option],
        `tmux show-options -sv ${shellQuote(option)}`);
      const v = output.trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** Get a session-scoped user option value. Returns null if not set or error. */
  /** a2: a session's user option (`@name`), keeping "unset" apart from "could not be read" (getSessionOption folds both
   *  into null). Measured on tmux 3.4 (adopted-marker-real-tmux.test.ts): `show-option -v` answers an unset user option
   *  with "invalid option: <key>" and a missing session with "no such session"; `show-option -q` and `display-message`
   *  both answer a missing session with exit 0 and no output, so neither can tell it from an unset option. */
  async readSessionOption(sessionName: string, key: string): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
    const exact = exactTarget(sessionName, "pane");
    try {
      const output = await this.run(["tmux", "show-option", "-v", "-t", exact, key],
        `tmux show-option -v -t ${shellQuote(exact)} ${shellQuote(key)}`);
      return { ok: true, value: output.trim() || null };
    } catch (err) {
      const reported = tmuxReportedError(err);
      const text = reported instanceof Error ? reported.message : String(reported);
      if (text.includes(`invalid option: ${key}`)) return { ok: true, value: null };
      return { ok: false, error: text.trim() };
    }
  }

  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      const output = await this.run(["tmux", "show-option", "-v", "-t", exact, key],
        `tmux show-option -v -t ${shellQuote(exact)} ${shellQuote(key)}`);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
  /**
   * Slice 15 — read the timestamp (Unix epoch seconds) of the last
   * activity on the pane's window. The daemon's SeatActivityService
   * compares this against the configured silence window: if the
   * timestamp is within the window the seat is `terminal-active`,
   * otherwise it's silent past the threshold.
   *
   * Why not `pane_silence_flag`: tmux 3.6a was observed to return a
   * blank value for `#{pane_silence_flag}` during slice 15 dogfood
   * (sticky-alert behavior + version-dependent emit semantics), so
   * we cannot rely on it as the primary signal. `#{window_activity}`
   * is reliably populated (the runtime updates it whenever the
   * window receives output) and is the timestamp the tmux status-line
   * activity indicators use themselves.
   *
   * Returns:
   *   - a Unix-epoch-seconds integer when the runtime exposed the value
   *   - `null` when the target is missing OR the value is unparseable
   *     (consumers treat null as "no signal", distinct from "idle").
   */
  /** Every session's current-window `#{window_activity}` in ONE tmux call, keyed by session name: the same value
   *  `readPaneLastActivity(<session name>)` reads (display-message -t <session> resolves to the session's current
   *  window). Only well-formed timestamps are included, so a missing key means "read it the per-target way". Null when
   *  tmux can't be read at all. The session name is the LAST field, so a separator inside it stays intact. A fresh read
   *  (a read already in flight is joined); it also becomes the shared snapshot. */
  async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    return (await this.readSessionWindowSnapshot(0))?.activity ?? null;
  }

  /**
   * OF-176: the poll loops share one `list-windows -a` per tick instead of each listing (and then reading each seat) on
   * its own. Returns the latest read when it started less than `maxAgeMs` ago, joins a read in flight, and otherwise
   * reads now. A failed read is not kept, so the next caller reads again. Null when tmux can't be read at all.
   */
  async readSessionWindowSnapshot(maxAgeMs = 0): Promise<SessionWindowSnapshot | null> {
    const now = Date.now();
    const current = this.windowSnapshot;
    if (current && (!current.settled || now - current.at < maxAgeMs)) return current.result;
    const entry: { at: number; settled: boolean; value: SessionWindowSnapshot | null; result: Promise<SessionWindowSnapshot | null> } =
      { at: now, settled: false, value: null, result: this.readWindowListing(now) };
    this.windowSnapshot = entry;
    void entry.result.then((snapshot) => {
      entry.settled = true;
      entry.value = snapshot;
      if (snapshot === null && this.windowSnapshot === entry) this.windowSnapshot = null;
    });
    return entry.result;
  }

  /** The shared snapshot when one has already answered and started less than `maxAgeMs` ago; otherwise null. Never reads. */
  peekSessionWindowSnapshot(maxAgeMs: number): SessionWindowSnapshot | null {
    const current = this.windowSnapshot;
    return current && current.settled && Date.now() - current.at < maxAgeMs ? current.value : null;
  }

  private async readWindowListing(at: number): Promise<SessionWindowSnapshot | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const sessions = new Set<string>();
      const activity = new Map<string, number>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first < 0 || second < 0) continue;
        const active = line.slice(0, first), stamp = line.slice(first + 1, second).trim(), session = line.slice(second + 1);
        if (!session) continue;
        sessions.add(session);
        if (active !== "1" || !/^\d+$/.test(stamp)) continue;
        const n = Number(stamp);
        if (Number.isFinite(n) && n > 0) activity.set(session, n);
      }
      return { at, sessions, activity };
    } catch {
      return null;
    }
  }

  /** Every pane's pid and current command in ONE tmux call, keyed by pane id (%N): the values `getPanePid` /
   *  `getPaneCommand` read per pane. Panes without a valid pid are left out (read those per pane). Null when tmux can't
   *  be read at all. The command is the LAST field, so a separator inside it stays intact. */
  async readAllPaneProcesses(): Promise<Map<string, { pid: number; command: string | null }> | null> {
    try {
      const format = ["#{pane_id}", "#{pane_pid}", "#{pane_current_command}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-panes", "-a", "-F", format], `tmux list-panes -a -F '${format}'`);
      const out = new Map<string, { pid: number; command: string | null }>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first <= 0 || second < 0) continue;
        const id = line.slice(0, first), pid = parseInt(line.slice(first + 1, second).trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        out.set(id, { pid, command: line.slice(second + 1).trim() || null });
      }
      return out;
    } catch {
      return null;
    }
  }

  async readPaneLastActivity(paneId: string): Promise<number | null> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", exact, "#{window_activity}"],
        `tmux display-message -p -t ${shellQuote(exact)} '#{window_activity}'`,
      );
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    } catch {
      return null;
    }
  }

  /**
   * OPR.0.4.3.26 — list the tmux clients (human terminals / CMUX tiles) attached
   * to the server. VIEW-ONLY probe: it never mutates routing, bindings, or
   * sessions. Mirrors the read/parse/error-swallow shape of `listSessions`:
   * a "no server running" / socket-absent server yields `[]` (no attachable
   * client) so the caller emits an honest "attach first" error rather than
   * crashing. Unexpected failures (permission, etc.) rethrow.
   */
  async listClients(): Promise<TmuxClient[]> {
    try {
      const output = await this.run(["tmux", "list-clients", "-F", CLIENT_FORMAT],
        `tmux list-clients -F "${CLIENT_FORMAT}"`);
      return parseLines(output, parseClientLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * OPR.0.4.3.26 — retarget an already-attached client's VIEW to `target`
   * (`<session>` or `<session>:<window>`). This is the whole point of the
   * seat-recovery slice: it changes only what a client SEES; it never creates,
   * kills, or rebinds a session and never touches OpenRig routing/identity.
   */
  async switchClient(client: string, target: string): Promise<TmuxResult> {
    const exact = exactTarget(target, "session");
    try {
      await this.run(["tmux", "switch-client", "-c", client, "-t", exact],
        `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(exact)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }
}
