import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const DESTROY_CONFIRM_TOKEN = "destroy-openrig-state";

export type DestroyScope = "state" | "all";

export interface DestroyRuntimeConfig {
  stateRoot: string;
  dbPath: string;
  transcriptsPath: string;
  daemonHost: string;
  daemonPort: number;
}

export interface DestroyTarget {
  path: string;
  kind: "state_root" | "db_file" | "db_shm" | "db_wal" | "transcripts_dir";
  backupPath?: string;
}

export interface DestroyPlan {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  daemonHost: string;
  daemonPort: number;
  managedTmuxSessions: string[];
  /** Canonical seat names whose binding is `hc` (or that have no binding at all), each killed by terminal. */
  managedHcSeats: string[];
  targets: DestroyTarget[];
  warnings: string[];
}

export interface DestroyResult {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  backupPaths: string[];
  daemonStopped: boolean;
  portCleared: boolean;
  stateRecreated: boolean;
  tmuxKilled: number;
  tmuxMissing: number;
  hcKilled: number;
  hcMissing: number;
  /** Seats whose terminal was named by a different seat's label: left untouched. */
  hcRefused: string[];
  /** Seats whose fate is unknown (core unreachable, no reply, kill not observed). State is left untouched while any. */
  hcUnconfirmed: string[];
  warnings: string[];
}

export interface ListenerInspection {
  kind: "openrig" | "other_http" | "unreachable";
  healthy?: boolean;
  detail?: string;
}

export interface DestroyDeps {
  stopDaemon: () => Promise<void>;
  inspectListener: (host: string, port: number) => Promise<ListenerInspection>;
  findListeningPid: (port: number) => number | null;
  killProcess: (pid: number) => void;
  exists: (path: string) => boolean;
  renamePath: (from: string, to: string) => void;
  removePath: (path: string) => void;
  mkdirp: (path: string) => void;
  listManagedTmuxSessions: (dbPath: string) => string[];
  killTmuxSession: (sessionName: string) => boolean;
  listManagedHcSeats: (dbPath: string) => string[];
  killHcSeat: (seat: string) => Promise<HcSeatOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function normalizePathForPrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function isWithinPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(normalizePathForPrefix(root));
}

function formatTimestamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function buildBackupPath(targetPath: string, exists: (path: string) => boolean, now = new Date()): string {
  const stamp = formatTimestamp(now);
  const base = `${targetPath}.backup-${stamp}`;
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function listManagedSessionNames(dbPath: string, attachmentType: "tmux" | "hc"): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // A node with no binding row reads as 'tmux' (the column default) and falls back to its latest session name. The
    // hc pass also takes those: whichever host ran the seat, a name is only acted on after its own host vouches for it.
    const rows = db.prepare(`
      SELECT DISTINCT
        COALESCE(
          b.tmux_session,
          (
            SELECT s2.session_name
            FROM sessions s2
            WHERE s2.node_id = n.id
            ORDER BY datetime(s2.created_at) DESC, s2.rowid DESC
            LIMIT 1
          )
        ) AS session_name
      FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE COALESCE(b.attachment_type, 'tmux') = 'tmux' AND ? = 'tmux'
         OR COALESCE(b.attachment_type, 'tmux') = 'hc' AND ? = 'hc'
         OR b.id IS NULL AND ? = 'hc'
    `).all(attachmentType, attachmentType, attachmentType) as Array<{ session_name: string | null }>;

    return rows
      .map((row) => row.session_name?.trim() ?? "")
      .filter((name): name is string => Boolean(name))
      .sort();
  } finally {
    db.close();
  }
}

export function listManagedTmuxSessionsFromDb(dbPath: string): string[] {
  return listManagedSessionNames(dbPath, "tmux");
}

/** Seats bound to an hc terminal (migration 121 sets `attachment_type = 'hc'`), plus bindingless nodes. Reads only
 *  columns that exist before 121, so it also runs on a database that was never migrated. */
export function listManagedHcSeatsFromDb(dbPath: string): string[] {
  return listManagedSessionNames(dbPath, "hc");
}

export function buildDestroyPlan(
  scope: DestroyScope,
  backup: boolean,
  config: DestroyRuntimeConfig,
  deps: Pick<DestroyDeps, "exists" | "listManagedTmuxSessions" | "listManagedHcSeats" | "now">
): DestroyPlan {
  const warnings: string[] = [];
  const targets: DestroyTarget[] = [];

  const stateRootExists = deps.exists(config.stateRoot);
  targets.push({
    path: config.stateRoot,
    kind: "state_root",
    ...(backup && stateRootExists ? { backupPath: buildBackupPath(config.stateRoot, deps.exists, deps.now()) } : {}),
  });

  const addExternalTarget = (path: string, kind: DestroyTarget["kind"]) => {
    if (!deps.exists(path)) return;
    if (isWithinPath(path, config.stateRoot)) return;
    targets.push({
      path,
      kind,
      ...(backup ? { backupPath: buildBackupPath(path, deps.exists, deps.now()) } : {}),
    });
    warnings.push(`${kind} is outside state root and will be ${backup ? "backed up separately" : "deleted separately"}: ${path}`);
  };

  addExternalTarget(config.dbPath, "db_file");
  addExternalTarget(`${config.dbPath}-shm`, "db_shm");
  addExternalTarget(`${config.dbPath}-wal`, "db_wal");
  addExternalTarget(config.transcriptsPath, "transcripts_dir");

  let managedTmuxSessions: string[] = [];
  let managedHcSeats: string[] = [];
  if (scope === "all" && deps.exists(config.dbPath)) {
    try {
      managedTmuxSessions = deps.listManagedTmuxSessions(config.dbPath);
    } catch (err) {
      warnings.push(`Failed to enumerate managed tmux sessions from ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      managedHcSeats = deps.listManagedHcSeats(config.dbPath);
    } catch (err) {
      warnings.push(`Failed to enumerate managed hc seats from ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    scope,
    backup,
    stateRoot: config.stateRoot,
    daemonHost: config.daemonHost,
    daemonPort: config.daemonPort,
    managedTmuxSessions,
    managedHcSeats,
    targets,
    warnings,
  };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0";
}

export async function executeDestroy(plan: DestroyPlan, deps: DestroyDeps): Promise<DestroyResult> {
  const warnings = [...plan.warnings];
  const backupPaths: string[] = [];
  let stateRecreated = false;

  try {
    await deps.stopDaemon();
  } catch (err) {
    warnings.push(`stopDaemon failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let daemonStopped = false;
  let portCleared = false;

  if (isLocalHost(plan.daemonHost)) {
    const before = await deps.inspectListener(plan.daemonHost, plan.daemonPort);
    if (before.kind === "openrig") {
      const listenerPid = deps.findListeningPid(plan.daemonPort);
      if (listenerPid !== null) {
        try {
          deps.killProcess(listenerPid);
        } catch (err) {
          warnings.push(`Failed to terminate listener pid ${listenerPid}: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await deps.inspectListener(plan.daemonHost, plan.daemonPort)).kind === "unreachable") break;
          await deps.sleep(100);
        }
      } else {
        warnings.push(`OpenRig responded on port ${plan.daemonPort}, but no listener pid was found.`);
      }
    } else if (before.kind === "other_http") {
      warnings.push(`Port ${plan.daemonPort} is occupied by a live non-OpenRig HTTP listener. State was left untouched.`);
    }

    const after = await deps.inspectListener(plan.daemonHost, plan.daemonPort);
    portCleared = after.kind === "unreachable";
    daemonStopped = portCleared;
  } else {
    warnings.push(`Daemon host ${plan.daemonHost} is not local. rig destroy only operates on local daemon targets; state was left untouched.`);
  }

  if (!portCleared) {
    return {
      scope: plan.scope,
      backup: plan.backup,
      stateRoot: plan.stateRoot,
      backupPaths,
      daemonStopped,
      portCleared,
      stateRecreated,
      tmuxKilled: 0,
      tmuxMissing: 0,
      hcKilled: 0,
      hcMissing: 0,
      hcRefused: [],
      hcUnconfirmed: [],
      warnings,
    };
  }

  let tmuxKilled = 0;
  let tmuxMissing = 0;
  let hcKilled = 0;
  let hcMissing = 0;
  const hcRefused: string[] = [];
  const hcUnconfirmed: string[] = [];
  if (plan.scope === "all") {
    for (const sessionName of plan.managedTmuxSessions) {
      if (deps.killTmuxSession(sessionName)) tmuxKilled += 1;
      else tmuxMissing += 1;
    }
    for (const seat of plan.managedHcSeats) {
      // One seat's trouble never stops the next: every reachable seat is still ended.
      let outcome: HcSeatOutcome;
      try {
        outcome = await deps.killHcSeat(seat);
      } catch {
        outcome = "unconfirmed";
      }
      if (outcome === "killed") hcKilled += 1;
      else if (outcome === "missing") hcMissing += 1;
      else if (outcome === "refused") hcRefused.push(seat);
      else hcUnconfirmed.push(seat);
    }
  }

  // An unreachable core is not "the seat is gone". The state still names the seats; deleting it would orphan them
  // with nothing left to say which terminals were ours. Stop here, state untouched, so the run can be repeated.
  if (hcUnconfirmed.length > 0) {
    warnings.push(
      `Could not confirm ${hcUnconfirmed.length} hc seat${hcUnconfirmed.length === 1 ? "" : "s"} ended (${hcUnconfirmed.join(", ")}): the hc core was unreachable, did not answer, or the seat did not finish. State was left untouched. Start the core and repeat, or use --state to leave seats alone.`
    );
  }
  for (const seat of hcRefused) {
    warnings.push(`The hc terminal named for seat ${seat} carries a different seat label; it was left untouched.`);
  }
  if (hcUnconfirmed.length > 0) {
    return {
      scope: plan.scope,
      backup: plan.backup,
      stateRoot: plan.stateRoot,
      backupPaths,
      daemonStopped,
      portCleared,
      stateRecreated,
      tmuxKilled,
      tmuxMissing,
      hcKilled,
      hcMissing,
      hcRefused,
      hcUnconfirmed,
      warnings,
    };
  }

  for (const target of plan.targets) {
    if (!deps.exists(target.path)) continue;
    if (plan.backup && target.backupPath) {
      deps.renamePath(target.path, target.backupPath);
      backupPaths.push(target.backupPath);
    } else {
      deps.removePath(target.path);
    }
  }

  deps.mkdirp(plan.stateRoot);
  stateRecreated = true;

  return {
    scope: plan.scope,
    backup: plan.backup,
    stateRoot: plan.stateRoot,
    backupPaths,
    daemonStopped,
    portCleared,
    stateRecreated,
    tmuxKilled,
    tmuxMissing,
    hcKilled,
    hcMissing,
    hcRefused,
    hcUnconfirmed,
    warnings,
  };
}

export function findListeningPidWithLsof(port: number): number | null {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
    if (!output) return null;
    const first = output.split(/\s+/)[0]?.trim();
    if (!first) return null;
    const pid = parseInt(first, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function killTmuxSessionWithCli(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---- hc seats --------------------------------------------------------------------------------------------------
// The CLI cannot import the daemon's hc client (the daemon package exports no such surface), so this is the minimum
// of it: one short-lived connection per call, `hello` at generation 1, then one request. Keep in step with
// packages/daemon/src/adapters/hc-client.ts and hc-host.ts (`SEAT_LABEL`, `hcTerminalName`).

const HC_GENERATION = 1;
const HC_SEAT_LABEL = "openrig.seat";
const HC_TIMEOUT_MS = 10_000;

/** The outcome of ending one seat's hc terminal. Only `killed` and `missing` are positive evidence the seat is gone. */
export type HcSeatOutcome = "killed" | "missing" | "refused" | "unconfirmed";

export interface HcTerminalFacts {
  address: string;
  labels?: Record<string, string>;
  state?: string;
  reason?: string | null;
}

/** Nothing reached the core, or it did not answer: the seat's fate is unknown. */
export class HcDestroyUnavailableError extends Error {}
/** The core answered with a refusal; `kind` is hc's stable word (`not_found`, ...). */
export class HcDestroyRefusedError extends Error {
  constructor(message: string, readonly kind: string) {
    super(message);
  }
}

export type HcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function hcSeatTerminalName(seat: string): string {
  return `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;
}

export function resolveHcSocketPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const session = env.HC_SESSION || "default";
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`);
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(state, "herdr-core", session, `${session}.sock`);
}

/** Ends one seat's terminal, and only a terminal that carries that seat's label. Goes by terminal, by address: it never
 *  closes an app tab or space, which would end every terminal in it (design section 5). */
export async function killHcSeat(seat: string, call: HcCall): Promise<HcSeatOutcome> {
  let found: HcTerminalFacts;
  try {
    found = (await call("terminal.get", { terminal: hcSeatTerminalName(seat) })) as HcTerminalFacts;
  } catch (err) {
    if (err instanceof HcDestroyRefusedError && err.kind === "not_found") return "missing";
    return "unconfirmed";
  }
  if (found.labels?.[HC_SEAT_LABEL] !== seat) return "refused";
  if (found.state === "finished") return found.reason === "spawn_pending" ? "unconfirmed" : "missing";
  try {
    const after = (await call("terminal.kill", { terminal: found.address })) as HcTerminalFacts;
    return after.state === "finished" ? "killed" : "unconfirmed";
  } catch (err) {
    if (err instanceof HcDestroyRefusedError && err.kind === "not_found") return "missing";
    return "unconfirmed";
  }
}

/** One request on its own connection, after a `hello` at this build's generation. */
export function hcCallOverSocket(socketPath: string, timeoutMs = HC_TIMEOUT_MS): HcCall {
  return (method, params) => new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let step: "connect" | "hello" | "request" = "connect";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const fail = (why: string) => finish(() => reject(new HcDestroyUnavailableError(`hc core: ${why}`)));
    const timer = setTimeout(() => fail(`no reply in ${timeoutMs} ms`), timeoutMs);
    const send = (id: number, name: string, p: Record<string, unknown>) =>
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: name, params: p })}\n`);
    socket.once("connect", () => { step = "hello"; send(1, "hello", { generation: HC_GENERATION, framed: false }); });
    socket.on("error", (err) => fail(step === "connect" ? `not reachable (${err.message})` : err.message));
    socket.on("close", () => fail("closed the connection"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let reply: { id?: number; result?: unknown; error?: { message: string; data?: { kind?: string } } };
        try { reply = JSON.parse(line); } catch { fail("sent a line that is not JSON"); return; }
        if (reply.id === 1 && step === "hello") {
          if (reply.error) { fail(`refused hello (${reply.error.data?.kind ?? "unknown"})`); return; }
          if ((reply.result as { generation?: number } | undefined)?.generation !== HC_GENERATION) { fail("speaks another protocol generation"); return; }
          step = "request";
          send(2, method, params);
        } else if (reply.id === 2 && step === "request") {
          if (reply.error) finish(() => reject(new HcDestroyRefusedError(reply.error!.message, reply.error!.data?.kind ?? "unknown")));
          else finish(() => resolve(reply.result));
        }
      }
    });
  });
}

export function killHcSeatWithCore(seat: string): Promise<HcSeatOutcome> {
  return killHcSeat(seat, hcCallOverSocket(resolveHcSocketPath()));
}
