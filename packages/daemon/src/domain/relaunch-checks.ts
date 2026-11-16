import { join } from "node:path";
import type { NativeProcessRow } from "./native-process-lineage.js";

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
 * The defaults. One place, so that a per-seat source (a spec field) can later supply its own values instead (follow-up to o9o.8; CoS,
 * 2026-11-16: fixed defaults until someone needs the override).
 */
export const RELAUNCH_CHECK_DEFAULTS = {
  /** A seat writes its handover into its own folder, often in dated variants (HANDOVER.md, HANDOVER-2026-11-15-1910.md); the newest wins. */
  handoverFile: { prefix: "HANDOVER", suffix: ".md" },
  /** Processes an agent keeps running for its whole life: not unfinished work. Matched on the executable name or the argv. */
  expectedChildren: [
    { kind: "caffeinate", executable: /^caffeinate$/, argv: null },
    { kind: "mcp_server", executable: null, argv: /mcp/i },
    { kind: "language_server", executable: /^(gopls|rust-analyzer|clangd|sourcekit-lsp|pyright|pylsp|jdtls)$/, argv: /language-?server|langserver|\blsp\b|pyright|gopls|rust-analyzer|clangd|sourcekit-lsp/i },
  ],
  /** What runs between a pane and its agent: shells and the launch scripts OpenRig stages. */
  shells: /^-?(sh|bash|dash|zsh|fish)$/,
} as const;

/** A lease a seat's own work registered (rig seat lease), as observed: whether its holder process is still alive. */
export interface SeatLeaseObservation { holder: string; pid: number; reason?: string; alive: boolean }

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
  | { verdict: "unknown"; cause: string };

export type ChildrenCheck =
  | { verdict: "clear"; ignored: Array<ProcessSummary & { kind: string }> }
  | { verdict: "held"; held: ProcessSummary[]; ignored: Array<ProcessSummary & { kind: string }>; overridden: boolean }
  | { verdict: "unknown"; cause: string };

export interface RelaunchChecks { lease: LeaseCheck; children: ChildrenCheck }

export function judgeLeases(read: () => SeatLeaseObservation[], despite: readonly RelaunchCheckName[]): LeaseCheck {
  let leases: SeatLeaseObservation[];
  try {
    leases = read();
  } catch (err) {
    return { verdict: "unknown", cause: `the seat's leases could not be read: ${(err as Error).message}` };
  }
  const stale = leases.filter((lease) => !lease.alive).map(({ holder, pid }) => ({ holder, pid }));
  const held = leases.filter((lease) => lease.alive).map(({ holder, pid, reason }) => ({ holder, pid, ...(reason ? { reason } : {}) }));
  return held.length === 0 ? { verdict: "clear", stale } : { verdict: "held", held, stale, overridden: despite.includes("lease") };
}

function executableOf(row: NativeProcessRow): string {
  const name = row.executableName ?? row.command.trim().split(/\s+/)[0] ?? "";
  return name.split("/").pop() ?? name;
}

function summary(row: NativeProcessRow): ProcessSummary {
  return { pid: row.pid, name: executableOf(row), command: row.command };
}

function expectedKind(row: NativeProcessRow): string | null {
  const executable = executableOf(row);
  for (const expected of RELAUNCH_CHECK_DEFAULTS.expectedChildren) {
    if ((expected.executable && expected.executable.test(executable)) || (expected.argv && expected.argv.test(row.command))) return expected.kind;
  }
  return null;
}

/**
 * The agent's children: every process beneath the seat's agent. The agent is the first process at or below the pane's own process that is
 * not a shell (a shell wrapping the agent is not the agent's work). Processes running the agent's own executable beneath it (a launcher
 * re-executing the runtime) are the agent itself. `panePid` null, or a process table without the pane's process, cannot be judged.
 */
export function judgeChildren(processes: NativeProcessRow[] | null, panePid: number | null, despite: readonly RelaunchCheckName[]): ChildrenCheck {
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
  const agentExecutable = executableOf(agent);
  const held: ProcessSummary[] = [];
  const ignored: Array<ProcessSummary & { kind: string }> = [];
  const below = [...(byParent.get(agent.pid) ?? [])];
  const visited = new Set<number>([agent.pid]);
  while (below.length > 0) {
    const row = below.shift()!;
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    if (executableOf(row) === agentExecutable) {
      below.push(...(byParent.get(row.pid) ?? []));
      continue;
    }
    const kind = expectedKind(row);
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
export function newestHandoverFile(dir: string, port: RelaunchCheckPort): { path: string; modifiedAt: string } | null {
  const { prefix, suffix } = RELAUNCH_CHECK_DEFAULTS.handoverFile;
  let newest: { path: string; modifiedAt: string } | null = null;
  for (const file of port.folderFiles(dir)) {
    if (!file.name.startsWith(prefix) || !file.name.endsWith(suffix)) continue;
    if (!newest || file.modifiedAt > newest.modifiedAt) newest = { path: join(dir, file.name), modifiedAt: file.modifiedAt };
  }
  return newest;
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
