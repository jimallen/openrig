import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import { SEAT_LABEL, hcTerminalName } from "./hc-seat.js";
import type { SessionWindowSnapshot, TmuxPane, TmuxResult, TmuxSession, TmuxWindow } from "./tmux.js";

/** hc addresses (`t7`, or `machine/t7` for a terminal on another machine). The number after `t` is written in base 30: the digits
 *  and the letters `bcdfghjkmnpqrstvwxyz` (no vowels, no `l`), so the 20th terminal of a core is `t1b` and the 1,000th `t1t0`
 *  (measured on a private core, hc 0.1.15: 1,000 addresses, every character inside that alphabet, 801 of them with a letter). Read
 *  as decimal only, every address past `t19` was taken for a seat's name and hashed into a terminal that does not exist.
 *  A seat is never named like one: a seat's hc name is `s-<digest>` and hc refuses a name shaped like an address; a seat's
 *  canonical name (`dev-impl@rig`) has an `@`, and a bare word made only of this alphabet (`tmp`) would be read as an address. */
const ADDRESS = /^(?:[A-Za-z0-9_.-]+\/)?t[0-9bcdfghjkmnpqrstvwxyz]+$/;
const TMUX_ID = /^[%@$]\d+$/;


/**
 * What a tmux-style target means to hc. Callers pass a seat's canonical name (a "session"), a tmux exact form of one
 * (`=name`, `=name:`, `name:0`, `name:0.0`), or the terminal address that replaces a pane id. One terminal is one program,
 * so window 0 and pane 0 are the only ones that exist. Null when the target names nothing hc could hold: a tmux `%3`/`@1`/`$2` id,
 * or window or pane N above 0.
 */
export function hcTerminalRef(target: string): string | null {
  const name = hcTargetName(target);
  if (name === null) return null;
  return ADDRESS.test(name) ? name : hcTerminalName(name);
}

/** The seat name a target spells (tmux exact forms stripped), or null for a tmux id, a window or pane above 0, or nothing.
 *  An address comes back as it is: use `hcSeatName` where only a seat may be named. */
function hcTargetName(target: string): string | null {
  let name = target.startsWith("=") ? target.slice(1) : target;
  const qualified = /^(.+):(\d+)(?:\.(\d+))?$/.exec(name);
  if (qualified) {
    if (qualified[2] !== "0" || (qualified[3] ?? "0") !== "0") return null;
    name = qualified[1]!;
  } else if (name.endsWith(":")) {
    name = name.slice(0, -1);
  }
  if (name === "" || TMUX_ID.test(name)) return null;
  return name;
}

/** The canonical seat name a target spells, or null when it spells an hc address (`t7`, `machine/t7`) or nothing. For a caller
 *  that is not the daemon's own bookkeeping (the terminal WebSocket): an address is never a seat's name, so a target that
 *  reads as one is refused rather than looked up. The caller still checks the terminal's `openrig.seat` label. */
export function hcSeatName(target: string): string | null {
  const name = hcTargetName(target);
  return name === null || ADDRESS.test(name) ? null : name;
}

/**
 * What a target means where the name is exact: an hc address as it is, any other string as a seat's name, hashed exactly as
 * given. No tmux exact form is read (`=name`, `name:0`), so a seat whose name starts with `=` stays itself. Null for a tmux
 * `%3`/`@1`/`$2` id and the empty string. This is how probeSession, createSession and the launch name a seat, and so how
 * HcLifecycle must find the seat it kills or respawns (decision 14: only the readers strip a leading `=`).
 */
export function hcExactTerminalRef(target: string): string | null {
  if (target === "" || TMUX_ID.test(target)) return null;
  return ADDRESS.test(target) ? target : hcTerminalName(target);
}

/** Every failure that is hc's or the socket's, as opposed to a bug in the caller. */
export function isHcFailure(err: unknown): err is HcError | HcUnavailableError | HcOutcomeUnknownError {
  return err instanceof HcError || err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError;
}

/** The terminal is not there: hc said so, as opposed to not being able to ask. */
export function isAbsentFailure(err: unknown): boolean {
  return err instanceof HcError && (err.kind === "not_found" || err.kind === "machine_unknown");
}

// --- tmux session options and the session environment, held as labels --------------------------------------------------

/** A tmux user option `@name` is the label `openrig.opt.name`. Label keys are free text but for `=` and the empty key
 *  (measured on hc 0.1.15: keys to 64 KiB and values to 4 MB were accepted), so any `@` option fits. */
export const OPTION_LABEL_PREFIX = "openrig.opt.";
const OPTION_KEY = /^@[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The label for a tmux user option, or null for a key that is not a user option (`mouse`, `status`: tmux built-ins hc has no counterpart for). */
export function optionLabelKey(key: string): string | null {
  return OPTION_KEY.test(key) ? `${OPTION_LABEL_PREFIX}${key.slice(1)}` : null;
}

/** hc has no way to read a terminal's launch environment back. What the daemon reads of it (`getSessionEnv`) is written at launch as
 *  labels under this prefix, and only for the names in SESSION_ENV_VALUE_KEYS: a label is shown by `hc ls` and the app, and rides
 *  every `terminal.list` reply, so it never holds a credential. */
export const SESSION_ENV_LABEL_PREFIX = "openrig.env.";
/** Presence only, for names whose value must not be a label (a token): `hasSessionEnv` asks no more than this. */
export const SESSION_ENV_PRESENT_PREFIX = "openrig.envset.";
/** The launch values the daemon reads back today: seat-launch-environment.ts and seat-restart-in-place.ts. */
export const SESSION_ENV_VALUE_KEYS = ["OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION", "CODEX_HOME"] as const;
/** The names whose presence the activity-hook check asks about (session-transport.ts), value never read. */
export const SESSION_ENV_PRESENCE_KEYS = [
  "OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT", "OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN", "RIGGED_RUNTIME",
] as const;

/** The labels a launch writes so the session environment can be read back: values for the identity names, a presence mark for the
 *  rest. A blank value is no value (an hc label with an empty value is a removed label). */
export function sessionEnvLabels(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const key of SESSION_ENV_VALUE_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") labels[`${SESSION_ENV_LABEL_PREFIX}${key}`] = value;
  }
  for (const key of [...SESSION_ENV_PRESENCE_KEYS, ...SESSION_ENV_VALUE_KEYS]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") labels[`${SESSION_ENV_PRESENT_PREFIX}${key}`] = "1";
  }
  return labels;
}

// --- the activity clock -----------------------------------------------------------------------------------------------

/**
 * Epoch seconds of a terminal's last output, or null for no signal (the tmux `#{window_activity}`). hc has no such clock
 * (spike 3, and measured again here: `status_ms` moves only when the program's reported state changes, `turn` only when it leaves
 * `working`, and a plain program reports neither), so nothing is wired by default and every snapshot has an empty `activity`.
 * Consumers read a missing entry as "no signal", never as idle (transcript-rotation.ts keeps its full cadence;
 * seat-activity-service.ts reports no activity). The choice of source is a product call, and is made by passing one here.
 */
export type ActivityClock = (terminal: HcTerminal) => number | null;

export interface HcIdentityOptions {
  activity?: ActivityClock;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
}

interface SnapshotEntry { at: number; settled: boolean; result: Promise<SessionWindowSnapshot | null> }

/**
 * Pane identity, listing and options for seats held as hc terminals, behind the method names and return types of the tmux
 * adapter they replace. One terminal is one program: a seat is one session with one window with one pane, and its pane id is its terminal address.
 * A terminal is a seat only if it carries the `openrig.seat` label.
 *
 * Reaching the core and hearing it are kept apart, as in HcHost.probeSession: a listing the core could not give is a throw
 * (never the empty list a tmux server with no sessions gives), because an unreachable core must never read as gone.
 */
export class HcIdentity {
  private snapshot: SnapshotEntry | null = null;
  private readonly now: () => number;

  constructor(private readonly client: HcClient = new HcClient(), private readonly options: HcIdentityOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The terminal a target names, or null when it positively is not there. An unreachable core throws. */
  private async find(target: string): Promise<HcTerminal | null> {
    const ref = hcTerminalRef(target);
    if (ref === null) return null;
    try {
      return await this.client.call<HcTerminal>("terminal.get", { terminal: ref });
    } catch (err) {
      if (isAbsentFailure(err)) return null;
      throw err;
    }
  }

  private async listLive(): Promise<HcTerminal[]> {
    return (await this.client.call<{ terminals: HcTerminal[] }>("terminal.list", {})).terminals;
  }

  // --- listing ---------------------------------------------------------------------------------------------------------

  async listSessions(): Promise<TmuxSession[]> {
    return (await this.listLive()).filter(isSeat).map((terminal): TmuxSession => ({
      name: terminal.labels[SEAT_LABEL]!,
      windows: 1,
      created: String(Math.floor(terminal.created_ms / 1000)),
      attached: false,  // hc does not say whether a viewer is attached
    }));
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    const terminal = await this.find(sessionName);
    if (!terminal || terminal.state !== "live") return [];
    return [{ index: 0, name: terminal.labels[SEAT_LABEL] ?? terminal.name ?? terminal.address, panes: 1, active: true }];
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    const terminal = await this.find(target);
    if (!terminal || terminal.state !== "live") return [];
    return [{ id: terminal.address, index: 0, cwd: terminal.foreground?.cwd ?? terminal.cwd, width: terminal.cols, height: terminal.rows, active: true }];
  }

  // --- pane identity ---------------------------------------------------------------------------------------------------

  /** The pid of the terminal's own process (with a shell wrapper that execs, the shell). Null when it is gone or cannot be asked. */
  async getPanePid(paneId: string): Promise<number | null> {
    try {
      const terminal = await this.find(paneId);
      return terminal && terminal.state === "live" && terminal.pid != null && terminal.pid > 0 ? terminal.pid : null;
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  /** The name the OS gives the foreground process (hc `foreground.name`; tmux `pane_current_command`). */
  async getPaneCommand(paneId: string): Promise<string | null> {
    try {
      const terminal = await this.find(paneId);
      return terminal && terminal.state === "live" ? terminal.foreground?.name.trim() || null : null;
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  /** Whether the terminal's program has ended. A terminal that is not there at all also proves the cutover (as for tmux); a
   *  core that cannot be asked proves nothing, so it is not dead. */
  async isPaneDead(paneId: string): Promise<boolean> {
    try {
      const terminal = await this.find(paneId);
      return terminal === null || terminal.state === "finished";
    } catch (err) {
      if (isHcFailure(err)) return false;
      throw err;
    }
  }

  /** Every live terminal's pid and foreground name in one call, keyed by address. Null when the core cannot be read. */
  async readAllPaneProcesses(): Promise<Map<string, { pid: number; command: string | null }> | null> {
    try {
      const out = new Map<string, { pid: number; command: string | null }>();
      for (const terminal of await this.listLive()) {
        if (terminal.pid == null || terminal.pid <= 0) continue;
        out.set(terminal.address, { pid: terminal.pid, command: terminal.foreground?.name.trim() || null });
      }
      return out;
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  // --- the window snapshot and activity -------------------------------------------------------------------------------

  /** Every seat the core has, and each one's activity when a clock was given. Reuses a read that started less than `maxAgeMs` ago and
   *  joins one in flight; a failed read is not kept. Null when the core cannot be read. */
  async readSessionWindowSnapshot(maxAgeMs = 0): Promise<SessionWindowSnapshot | null> {
    const now = this.now();
    const current = this.snapshot;
    if (current && (!current.settled || now - current.at < maxAgeMs)) return current.result;
    const entry: SnapshotEntry = { at: now, settled: false, result: this.readListing(now) };
    this.snapshot = entry;
    void entry.result.then((value) => {
      entry.settled = true;
      if (value === null && this.snapshot === entry) this.snapshot = null;
    });
    return entry.result;
  }

  async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    return (await this.readSessionWindowSnapshot(0))?.activity ?? null;
  }

  /** One seat's last activity in epoch seconds; null is "no signal", which is not idle. */
  async readPaneLastActivity(paneId: string): Promise<number | null> {
    try {
      const terminal = await this.find(paneId);
      return terminal && terminal.state === "live" ? this.stamp(terminal) : null;
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  private stamp(terminal: HcTerminal): number | null {
    const seconds = this.options.activity?.(terminal);
    return seconds != null && Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
  }

  private async readListing(at: number): Promise<SessionWindowSnapshot | null> {
    try {
      const sessions = new Set<string>();
      const activity = new Map<string, number>();
      const targets = new Map<string, string>();
      for (const terminal of (await this.listLive()).filter(isSeat)) {
        const session = terminal.labels[SEAT_LABEL]!;
        sessions.add(session);
        targets.set(session, terminal.address);
        const seconds = this.stamp(terminal);
        if (seconds !== null) activity.set(session, seconds);
      }
      return { at, sessions, activity, targets };
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }

  // --- options and the session environment ----------------------------------------------------------------------------

  /** Sets a tmux user option (`@name`) as a label. An empty value removes it, as hc does and as rig-lifecycle-service.ts relies on to clear
   *  `@rigged_*`. Built-in tmux options (`mouse`, `status`) have no hc counterpart and are refused. The value is never echoed. */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    const label = optionLabelKey(key);
    if (label === null) return { ok: false, code: "unsupported_option", message: `Option ${JSON.stringify(key)} is not a user option (@name); hc has no session options.` };
    const ref = hcTerminalRef(sessionName);
    if (ref === null) return { ok: false, code: "session_not_found", message: `can't find session: ${sessionName}` };
    try {
      await this.client.call("terminal.label", { terminal: ref, labels: { [label]: value } });
      return { ok: true };
    } catch (err) {
      if (isAbsentFailure(err)) return { ok: false, code: "session_not_found", message: `can't find session: ${sessionName}` };
      if (err instanceof HcUnavailableError) return { ok: false, code: "transport_unavailable", message: `hc core unavailable: ${sessionName}` };
      if (err instanceof HcOutcomeUnknownError) return { ok: false, code: "write_outcome_unknown", message: `no reply setting ${key} on ${sessionName}: read it back before setting it again` };
      if (err instanceof HcError) return { ok: false, code: "unknown", message: `hc refused ${key} on ${sessionName}: ${err.kind}` };
      throw err;
    }
  }

  /** A user option's value, keeping "unset" (ok, null) apart from "could not be read" (not ok). */
  async readSessionOption(sessionName: string, key: string): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
    const label = optionLabelKey(key);
    if (label === null) return { ok: false, error: `invalid option: ${key}` };
    try {
      const terminal = await this.find(sessionName);
      if (terminal === null) return { ok: false, error: `can't find session: ${sessionName}` };
      return { ok: true, value: terminal.labels[label] || null };
    } catch (err) {
      if (isHcFailure(err)) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Null when unset or on any error. */
  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    const read = await this.readSessionOption(sessionName, key);
    return read.ok ? read.value : null;
  }

  /** A launch metadata read: the value the launch recorded under `openrig.env.<key>`, undefined when it recorded none. */
  async getSessionEnv(session: string, key: string): Promise<string | undefined> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    let terminal: HcTerminal | null;
    try {
      terminal = await this.find(session);
    } catch (err) {
      if (isHcFailure(err)) throw new Error("Cannot read the session's launch environment.");
      throw err;
    }
    if (terminal === null) throw new Error("Cannot read the session's launch environment.");
    return terminal.labels[`${SESSION_ENV_LABEL_PREFIX}${key}`] || undefined;
  }

  /** Whether the launch recorded a nonblank value for the name, never the value; null when it cannot be asked. */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    try {
      const terminal = await this.find(sessionName);
      if (terminal === null) return null;
      return Boolean(terminal.labels[`${SESSION_ENV_LABEL_PREFIX}${varName}`]?.trim() || terminal.labels[`${SESSION_ENV_PRESENT_PREFIX}${varName}`]);
    } catch (err) {
      if (isHcFailure(err)) return null;
      throw err;
    }
  }
}

function isSeat(terminal: HcTerminal): boolean {
  return Boolean(terminal.labels[SEAT_LABEL]);
}
