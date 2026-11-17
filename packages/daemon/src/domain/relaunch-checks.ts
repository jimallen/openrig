import { join } from "node:path";
import type { NativeProcessRow } from "./native-process-lineage.js";
import { deriveCanonicalSessionName, deriveSessionName } from "./session-name.js";

/**
 * Relaunch checks (workspaces-o9o.8), in the seat lifecycle context. Invariant, owned by a fresh launch that stops a live occupant:
 *
 *   A launch never stops a seat's occupant while the seat's own work still holds something others wait on (a lease) or still runs beneath
 *   its agent, unless the operator names that check (--despite). A check that cannot be read warns and never refuses, so a broken seat can
 *   still be recovered.
 *
 * And it records what the old occupant last wrote down: the seat's newest handover file. Its time is when the old occupant's own account of
 * its work ends, so what it took after that is handed to the fresh occupant, and the fresh occupant is told where the file is.
 *
 * This module is pure: it judges observations. The leases and the seat's folder come through RelaunchCheckPort, the process table through
 * the daemon's process lister.
 */

/** The checks an operator may override, by name. */
export type RelaunchCheckName = "lease" | "children";
export const RELAUNCH_CHECK_NAMES: readonly RelaunchCheckName[] = ["lease", "children"];

/**
 * The defaults. A seat's spec may name its own handover file and add expected processes (`relaunch_checks`, RelaunchCheckSettings,
 * workspaces-o9o.64); these stay the floor.
 */
export const RELAUNCH_CHECK_DEFAULTS = {
  /** A seat writes its handover into its own folder, often in dated variants (HANDOVER.md, HANDOVER-2026-11-15-1910.md); the newest wins. */
  handoverFile: { prefix: "HANDOVER", suffix: ".md" },
  /**
   * Processes an agent keeps running for its whole life: not unfinished work. Matched on the process's identity only, never on any
   * argument: its executable's name, or the path of the program an interpreter runs (`node <entry>`, `npx <package>`), one path part at a
   * time. `node ./scripts/build --suite mcp-smoke` is a build, whatever its arguments say (verify-qa, o9o.8 finding 1).
   */
  expectedChildren: [
    { kind: "caffeinate", identity: /^caffeinate$/ },
    { kind: "mcp_server", identity: /^(mcp|mcp-server(-[\w.-]+)?|[\w.-]+-mcp(-server)?|@modelcontextprotocol)$/i },
    { kind: "language_server", identity: /^(gopls|rust-analyzer|clangd|sourcekit-lsp|pyright(-langserver)?|pylsp|jdtls|[\w.-]+-language-server|[\w.-]+-langserver|[\w.-]+-lsp)$/i },
  ],
  /** Programs that run another program named by their first non-option argument. */
  interpreters: /^(node|nodejs|bun|deno|python3?|uv|uvx|npx|pnpx|tsx)$/,
  /** What runs between a pane and its agent: shells. */
  shells: /^-?(sh|bash|dash|zsh|fish)$/,
  /**
   * The seat's agent, by runtime (o9o.8 finding 2): the processes that are the agent itself rather than its work. Pi and OMP seats run
   * OpenRig's runner in the pane (`node .../pi-runner.js`, the pane's own process, so it is the agent's top), which spawns the runtime
   * (measured on sparky: a child named `pi`).
   */
  agentProcesses: {
    "claude-code": /^(claude|\.claude-unwrapped|\.claude-wrapped)$/,
    codex: /^codex([-.][\w.-]+)?$/,
    pi: /^pi$/,
    omp: /^omp$/,
  } as Record<string, RegExp>,
} as const;

/**
 * What one seat's checks use: the defaults, or what the seat's spec says (workspaces-o9o.64, the member field `relaunch_checks`). The
 * spec can name the seat's handover file and add processes its agent keeps running; it cannot remove a default.
 */
export interface RelaunchCheckSettings {
  handoverFile: { prefix: string; suffix: string };
  /** Names of processes the agent keeps running, beyond the defaults: matched exactly against a process's executable, argv[0], or a part
   *  of the program an interpreter runs. Never against an argument. */
  ignoreChildren: readonly string[];
  source: "defaults" | "spec";
}

export const DEFAULT_RELAUNCH_CHECK_SETTINGS: RelaunchCheckSettings = {
  handoverFile: { ...RELAUNCH_CHECK_DEFAULTS.handoverFile }, ignoreChildren: [], source: "defaults",
};

/** A handover file pattern: one "*", no "/" (a file in the seat's own folder). */
const HANDOVER_PATTERN = /^([^/*]*)\*([^/*]*)$/;
/** A process name: letters, digits and @ . _ + - only, 1 to 64 of them. */
const CHILD_NAME = /^[A-Za-z0-9@._+-]{1,64}$/;
const SETTINGS_KEYS = new Set(["handover_file", "ignore_children"]);

/** The seat's settings from its spec's `relaunch_checks` (absent: the defaults), or every error with its path under `at`. */
export function relaunchCheckSettingsFrom(value: unknown, at: string): { ok: true; settings: RelaunchCheckSettings } | { ok: false; errors: string[] } {
  if (value === undefined) return { ok: true, settings: DEFAULT_RELAUNCH_CHECK_SETTINGS };
  const path = `${at}.relaunch_checks`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: [`${path}: must be a mapping with handover_file and/or ignore_children`] };
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(record)) {
    if (!SETTINGS_KEYS.has(key)) errors.push(`${path}.${key}: unknown key (allowed: handover_file, ignore_children)`);
  }
  let handoverFile = DEFAULT_RELAUNCH_CHECK_SETTINGS.handoverFile;
  if (record["handover_file"] !== undefined) {
    const pattern = typeof record["handover_file"] === "string" ? HANDOVER_PATTERN.exec(record["handover_file"]) : null;
    if (!pattern) errors.push(`${path}.handover_file: a file name in the seat's folder with exactly one "*" and no "/", such as "HANDOVER*.md"`);
    else handoverFile = { prefix: pattern[1]!, suffix: pattern[2]! };
  }
  let ignoreChildren: string[] = [];
  if (record["ignore_children"] !== undefined) {
    const names = record["ignore_children"];
    if (!Array.isArray(names)) errors.push(`${path}.ignore_children: must be a list of process names`);
    else {
      names.forEach((name, i) => {
        if (typeof name !== "string" || !CHILD_NAME.test(name)) errors.push(`${path}.ignore_children[${i}]: a process name (letters, digits, @ . _ + -; 1-64), not a path or a pattern`);
      });
      ignoreChildren = names.filter((name): name is string => typeof name === "string");
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings: { handoverFile, ignoreChildren, source: "spec" } };
}

/**
 * A lease a seat's own work registered (rig seat lease), as observed. `alive`: its holder is the process that registered it (same pid and
 * same start time). `gone`: no such process, or another process now has its pid. `unknown`: the pid is in use, but whether it is the same
 * process cannot be told (no start time was recorded, or none can be read now); never counted as alive (o9o.8 finding 3).
 */
export interface SeatLeaseObservation { holder: string; pid: number; reason?: string; liveness: "alive" | "gone" | "unknown" }

/** Outbound port: what the checks read from the world, other than the process table. */
export interface RelaunchCheckPort {
  /** The seat's registered leases. Throws when they cannot be read. */
  leases(seat: string): SeatLeaseObservation[];
  /** The files directly in a folder, with their modification times (ISO). Throws when the folder cannot be read. */
  folderFiles(dir: string): Array<{ name: string; modifiedAt: string }>;
}

/** Outbound port: where `rig seat lease` registers and releases a seat's leases. */
export interface SeatLeaseRegistry {
  acquire(seat: string, lease: { holder: string; pid: number; reason?: string }):
    | { ok: true; lease: { holder: string; pid: number; reason?: string; registeredAt: string } }
    | { ok: false; code: "invalid_lease_holder" | "invalid_lease_pid"; message: string };
  /** True when the holder's lease was there and is now gone. */
  release(seat: string, holder: string): boolean;
}

export interface ProcessSummary { pid: number; name: string; command: string }

export type LeaseCheck =
  | { verdict: "clear"; stale: Array<{ holder: string; pid: number }> }
  | { verdict: "held"; held: Array<{ holder: string; pid: number; reason?: string }>; stale: Array<{ holder: string; pid: number }>; overridden: boolean }
  | { verdict: "unknown"; cause: string; stale?: Array<{ holder: string; pid: number }> };

export type ChildrenCheck =
  | { verdict: "clear"; ignored: Array<ProcessSummary & { kind: string }> }
  | { verdict: "held"; held: ProcessSummary[]; ignored: Array<ProcessSummary & { kind: string }>; overridden: boolean }
  | { verdict: "unknown"; cause: string }
  /** workspaces-o9o.71: the seat has no live pane, so no agent is running anything to judge. Not a warning. */
  | { verdict: "not_applicable"; cause: string };

export interface RelaunchChecks {
  lease: LeaseCheck;
  children: ChildrenCheck;
  /** workspaces-o9o.64: whose settings judged them, the defaults or the seat's spec. */
  settings?: RelaunchCheckSettings["source"];
}

export function judgeLeases(read: () => SeatLeaseObservation[], despite: readonly RelaunchCheckName[]): LeaseCheck {
  let leases: SeatLeaseObservation[];
  try {
    leases = read();
  } catch (err) {
    return { verdict: "unknown", cause: `the seat's leases could not be read: ${(err as Error).message}` };
  }
  const stale = leases.filter((lease) => lease.liveness === "gone").map(({ holder, pid }) => ({ holder, pid }));
  const held = leases.filter((lease) => lease.liveness === "alive").map(({ holder, pid, reason }) => ({ holder, pid, ...(reason ? { reason } : {}) }));
  if (held.length > 0) return { verdict: "held", held, stale, overridden: despite.includes("lease") };
  const unsure = leases.filter((lease) => lease.liveness === "unknown");
  if (unsure.length > 0) {
    return { verdict: "unknown", stale,
      cause: `whether ${unsure.map((l) => `${l.holder} (pid ${l.pid})`).join(", ")} still holds its lease cannot be told: the pid is in use, but its process's start time cannot be matched to the one recorded` };
  }
  return { verdict: "clear", stale };
}

function executableOf(row: NativeProcessRow): string {
  const name = row.executableName ?? row.command.trim().split(/\s+/)[0] ?? "";
  return name.split("/").pop() ?? name;
}

function summary(row: NativeProcessRow): ProcessSummary {
  return { pid: row.pid, name: executableOf(row), command: row.command };
}

/** The names a process is known by: its executable, its argv[0], and for an interpreter, each part of the path of the program it runs. */
function identityNames(row: NativeProcessRow): string[] {
  const argv = row.command.trim().split(/\s+/);
  const base = (path: string) => path.split("/").pop() ?? path;
  const names = [executableOf(row), base(argv[0] ?? "")];
  if (RELAUNCH_CHECK_DEFAULTS.interpreters.test(names[0]!) || RELAUNCH_CHECK_DEFAULTS.interpreters.test(names[1]!)) {
    let i = 1;
    // Skip options and an option's value where the interpreter's own syntax gives it one (node --import tsx, uv run, npx -y).
    while (i < argv.length && (argv[i]!.startsWith("-") || argv[i] === "run" || argv[i - 1] === "--import" || argv[i - 1] === "-r")) i += 1;
    const program = argv[i];
    if (program) names.push(...program.split("/").filter((part) => part !== "" && part !== "." && part !== ".."));
  }
  return names.filter((name) => name !== "");
}

function expectedKind(row: NativeProcessRow, settings: RelaunchCheckSettings): string | null {
  const names = identityNames(row);
  if (settings.ignoreChildren.length > 0 && names.some((name) => settings.ignoreChildren.includes(name))) return "seat_spec";
  for (const expected of RELAUNCH_CHECK_DEFAULTS.expectedChildren) {
    if (names.some((name) => expected.identity.test(name))) return expected.kind;
  }
  return null;
}

/** Whether a process is the seat's runtime itself (Claude, Codex, Pi, OMP). */
function isAgentProcess(row: NativeProcessRow, runtime: string | null): boolean {
  const own = runtime ? RELAUNCH_CHECK_DEFAULTS.agentProcesses[runtime] : undefined;
  return own !== undefined && identityNames(row).some((name) => own.test(name));
}

/**
 * The agent's children: every process beneath the seat's agent. The agent is the first process at or below the pane's own process that is
 * not a shell (a shell wrapping the agent is not the agent's work). Beneath it, these are the agent itself, not its work: a process that is
 * the seat's runtime (`runtime`: Claude, Codex, Pi or OMP), and one re-running the agent's own executable
 * unless that executable is an interpreter such as node (a Pi seat's runner is node; a node build beneath it is work). `panePid` null, or a
 * process table without the pane's process, cannot be judged.
 */
export function judgeChildren(processes: NativeProcessRow[] | null, panePid: number | null, despite: readonly RelaunchCheckName[], runtime: string | null = null,
  settings: RelaunchCheckSettings = DEFAULT_RELAUNCH_CHECK_SETTINGS): ChildrenCheck {
  if (panePid === null) return { verdict: "unknown", cause: "the seat's pane process could not be read" };
  if (!processes || !processes.some((row) => row.pid === panePid)) return { verdict: "unknown", cause: "the process table does not show the seat's pane process" };
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const row of processes) {
    if (row.pid === row.ppid) continue;
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row); else byParent.set(row.ppid, [row]);
  }
  // The agent: breadth-first from the pane's process, the first that is not a shell.
  let agent: NativeProcessRow | null = null;
  const queue = processes.filter((row) => row.pid === panePid);
  const seen = new Set<number>();
  while (queue.length > 0 && !agent) {
    const next = queue.shift()!;
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    if (RELAUNCH_CHECK_DEFAULTS.shells.test(executableOf(next))) queue.push(...(byParent.get(next.pid) ?? []));
    else agent = next;
  }
  if (!agent) return { verdict: "clear", ignored: [] };
  const agentExecutable = RELAUNCH_CHECK_DEFAULTS.interpreters.test(executableOf(agent)) ? null : executableOf(agent);
  const held: ProcessSummary[] = [];
  const ignored: Array<ProcessSummary & { kind: string }> = [];
  const below = [...(byParent.get(agent.pid) ?? [])];
  const visited = new Set<number>([agent.pid]);
  while (below.length > 0) {
    const row = below.shift()!;
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    if (executableOf(row) === agentExecutable || isAgentProcess(row, runtime)) {
      below.push(...(byParent.get(row.pid) ?? []));
      continue;
    }
    const kind = expectedKind(row, settings);
    if (kind) {
      ignored.push({ ...summary(row), kind });
      continue;
    }
    // An unexpected child is reported once, with everything beneath it as part of it.
    held.push(summary(row));
  }
  return held.length === 0 ? { verdict: "clear", ignored } : { verdict: "held", held, ignored, overridden: despite.includes("children") };
}

/** The seat's newest handover file, by modification time, or null. Throws as the port does. */
export function newestHandoverFile(dir: string, port: RelaunchCheckPort, settings: RelaunchCheckSettings = DEFAULT_RELAUNCH_CHECK_SETTINGS): { path: string; modifiedAt: string } | null {
  const { prefix, suffix } = settings.handoverFile;
  let newest: { path: string; modifiedAt: string } | null = null;
  for (const file of port.folderFiles(dir)) {
    if (!file.name.startsWith(prefix) || !file.name.endsWith(suffix)) continue;
    if (!newest || file.modifiedAt > newest.modifiedAt) newest = { path: join(dir, file.name), modifiedAt: file.modifiedAt };
  }
  return newest;
}

/**
 * The handover the retiring occupant wrote: the seat's newest handover file, used only when it was written during that occupant's
 * tenure (o9o.8 finding 4). A file from an earlier tenure, or one whose tenure cannot be placed, is named in a warning and not used, so
 * messages from before this tenure are never re-delivered. Throws as the port does (the caller warns, o9o.8 finding 5).
 */
export function retiringOccupantHandover(dir: string, port: RelaunchCheckPort, tenureStartedAt: string | null,
  settings: RelaunchCheckSettings = DEFAULT_RELAUNCH_CHECK_SETTINGS): { file: { path: string; modifiedAt: string } | null; warning?: string } {
  const newest = newestHandoverFile(dir, port, settings);
  if (!newest) return { file: null };
  if (tenureStartedAt === null) {
    return { file: null, warning: `${newest.path} was not used: when the retiring occupant's tenure began is not recorded, so the file cannot be shown to be its own.` };
  }
  if (newest.modifiedAt < tenureStartedAt) {
    return { file: null, warning: `${newest.path} was not used: it was last written at ${newest.modifiedAt}, before the retiring occupant's tenure began (${tenureStartedAt}).` };
  }
  return { file: newest };
}

/** A held check the operator did not override. */
export function blockingChecks(checks: RelaunchChecks): RelaunchCheckName[] {
  const blocking: RelaunchCheckName[] = [];
  if (checks.lease.verdict === "held" && !checks.lease.overridden) blocking.push("lease");
  if (checks.children.verdict === "held" && !checks.children.overridden) blocking.push("children");
  return blocking;
}

/** What the operator reads when a launch is refused, one line per held check. */
export function describeHeld(checks: RelaunchChecks, seat: string): string {
  const lines: string[] = [];
  if (checks.lease.verdict === "held" && !checks.lease.overridden) {
    lines.push(`${seat} holds ${checks.lease.held.length === 1 ? "a lease" : "leases"}: ${checks.lease.held.map((l) => `${l.holder} (pid ${l.pid}${l.reason ? `, ${l.reason}` : ""})`).join(", ")}.`);
  }
  if (checks.children.verdict === "held" && !checks.children.overridden) {
    lines.push(`${seat}'s agent is still running: ${checks.children.held.map((p) => `${p.name} (pid ${p.pid})`).join(", ")}.`);
  }
  return lines.join(" ");
}

/** Warnings for checks that could not be read, or were overridden. */
export function checkWarnings(checks: RelaunchChecks): string[] {
  const warnings: string[] = [];
  if (checks.lease.verdict === "unknown") warnings.push(`Relaunch check lease not run: ${checks.lease.cause}.`);
  if (checks.children.verdict === "unknown") warnings.push(`Relaunch check children not run: ${checks.children.cause}.`);
  if (checks.lease.verdict === "held" && checks.lease.overridden) warnings.push(`Launched despite the seat's leases: ${checks.lease.held.map((l) => `${l.holder} (pid ${l.pid})`).join(", ")}.`);
  if (checks.children.verdict === "held" && checks.children.overridden) warnings.push(`Launched despite processes under the seat's agent: ${checks.children.held.map((p) => `${p.name} (pid ${p.pid})`).join(", ")}; they keep running.`);
  if (checks.lease.verdict !== "unknown" && checks.lease.stale.length > 0) warnings.push(`Stale leases ignored (their holder process is gone): ${checks.lease.stale.map((l) => `${l.holder} (pid ${l.pid})`).join(", ")}.`);
  return warnings;
}

/** The name a seat's leases are kept under: the one `rig seat lease` registers (its canonical session name for a `pod.member` id). */
export function seatLeaseName(rigName: string, logicalId: string): string {
  const dot = logicalId.indexOf(".");
  return dot > 0 && dot < logicalId.length - 1
    ? deriveCanonicalSessionName(logicalId.slice(0, dot), logicalId.slice(dot + 1), rigName)
    : deriveSessionName(rigName, logicalId);
}

/**
 * workspaces-o9o.71: the one judgement of a held lease for a seat a restore starts fresh (it does not resume), used by the restore and
 * by its plan, so the two agree. `refusal`: the seat is not started, and this says why and how to start it anyway. `warning`: the leases
 * could not be read, so the seat is started and the restore says so. null: nothing is held.
 */
export function freshSeatLeaseRefusal(leasesOf: (seat: string) => SeatLeaseObservation[], rigName: string, logicalId: string):
  { refusal: string } | { warning: string } | null {
  const seat = seatLeaseName(rigName, logicalId);
  const lease = judgeLeases(() => leasesOf(seat), []);
  if (lease.verdict === "held") {
    return { refusal: `relaunch_check_held: ${logicalId} was not started: ${describeHeld({ lease, children: { verdict: "not_applicable", cause: "not judged by restore" } }, seat)} `
      + `Let the work finish, or start it anyway with rig seat launch ${seat} --fresh --despite lease --reason "<why>".` };
  }
  if (lease.verdict === "unknown") return { warning: `Node ${logicalId}: its leases were not judged: ${lease.cause}` };
  return null;
}

/**
 * workspaces-o9o.64: a seat's relaunch_checks are read at launch from the rig's RECORDED spec source, never from a member fragment, so a
 * route that takes a fragment and records no spec (expansion, add-member) refuses the field by name rather than drop it in silence. Either
 * spelling counts. Returns the refusal, or null when no member carries the field.
 */
export function fragmentRelaunchChecksRefusal(members: unknown, route: string): string | null {
  const carriers = (Array.isArray(members) ? members : [members]).filter((m): m is Record<string, unknown> =>
    typeof m === "object" && m !== null && ("relaunch_checks" in m || "relaunchChecks" in m));
  if (carriers.length === 0) return null;
  const ids = carriers.map((m) => (typeof m["id"] === "string" ? m["id"] : "?")).join(", ");
  return `relaunch_checks cannot be added by ${route} (member ${ids}): declare it in the rig's recorded spec, which the relaunch checks read at each launch`;
}
