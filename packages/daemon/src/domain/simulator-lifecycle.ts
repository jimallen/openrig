// OF-208 — iOS simulator lifecycle for rig seats.
//
// Rig seats create iOS simulators (`xcrun simctl create`, from the seat's own shell) and nothing removes them; they
// reached 331.5 GB. Jim's decision: erase a seat's simulators (a) when the seat or rig is removed and (b) when a
// SHUT DOWN one is bigger than a size cap. Design and evidence: of208-design.md.
//
// Hard rules, enforced at the erase call and not only in the planner:
//   - a device is touched only when simctl reports it `Shutdown` (and `isAvailable`) in a list read immediately before the erase;
//   - a device no seat can be named for, or that more than one seat could own, is never touched;
//   - every erase is an event with udid, name, size and reason;
//   - simctl absent or failing does nothing and never throws into a caller.
//
// Attribution: a device carries no creator (device.plist has name, type, runtime only; launchd_sim and
// CoreSimulatorService have ppid 1), so a seat owns a device by the name convention: the device name starts with the
// seat's member token (last dot-segment of its logical id, lower-cased) and a dash. See `seatToken`/`nameIsForSeat`.
//
// Which seats take part (pinned in test/simulator-lifecycle.test.ts):
//   - ownership and ambiguity are judged against the nodes of rigs that are NOT archived and NOT the kernel. A STOPPED
//     rig takes part: its seats still own their devices. An archived rig does not: `rig down --fresh` and archived
//     duplicates leave a same-named archived copy of every live rig, and counting those would make every device of a
//     recreated rig ambiguous for good. The kernel does not: its member tokens are generic (lead, worker, agent, ...), so a
//     hand-made `worker-test` would be "a kernel seat's".
//   - a removal acts for the seats that were removed from any non-kernel rig (an archived rig being deleted included); a
//     kernel seat's removal erases nothing.
//
// Real simctl is OFF unless the real launch path turns it on (`enableRealSimctl`, from index.ts, only when
// `realSimctlAllowed`): a service built any other way (createDaemon in a test child, a scenario daemon with a private
// OPENRIG_HOME, an in-process harness) has no exec, runs nothing, and starts no timer.

import { execFile } from "node:child_process";
import { join as joinPath, resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";

/** Runs `xcrun simctl <args>` and resolves with stdout; rejects on any failure (absent xcrun, non-zero exit, timeout). */
export type SimctlExec = (args: string[]) => Promise<string>;

export const SIMULATOR_SIZE_CAP_DEFAULT_GB = 20;
/** 1 GB = 1024^3 bytes. */
export const BYTES_PER_GB = 1024 ** 3;
/** The reserved name of the kernel rig (project-rig.ts reserves it). */
const KERNEL_RIG_NAME = "kernel";
export const SIMULATOR_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type SimulatorEraseReason = "seat_removed" | "rig_deleted" | "over_size_cap";

/** A seat whose row is being, or has just been, deleted. Read BEFORE the delete. */
export interface RemovedSeat {
  rigId: string;
  nodeId: string;
  logicalId: string;
}

export interface SimulatorDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  /** `dataPathSize` from `simctl list devices -j` (logical bytes); null when simctl gave none. */
  sizeBytes: number | null;
}

export interface SimulatorOutcome {
  udid: string;
  name: string;
  action: "erased" | "skipped" | "failed";
  /** For a skip: why. For an erase or failure: the erase reason. */
  reason: string;
  sizeBytes: number | null;
}

export interface SimulatorRunResult {
  /** "unavailable": simctl absent, failing or unparseable; "disabled": the cap is 0 or real simctl is not enabled in this process. Nothing was done in either case. */
  status: "ok" | "unavailable" | "disabled";
  outcomes: SimulatorOutcome[];
}

interface NodeRow {
  nodeId: string;
  rigId: string;
  logicalId: string;
}

export function seatToken(logicalId: string): string {
  const last = logicalId.split(".").pop() ?? "";
  return last.trim().toLowerCase();
}

export function nameIsForSeat(deviceName: string, logicalId: string): boolean {
  const token = seatToken(logicalId);
  return token.length > 0 && deviceName.toLowerCase().startsWith(`${token}-`);
}

/**
 * Whether THIS process may run the real `xcrun simctl`: only the daemon of the user's own default state directory
 * (`<account home>/.openrig`), never under a test runner. `userHome` is the account's home from the OS, not `$HOME`, so a
 * harness that re-points HOME at a scratch directory is not mistaken for the real user; a private OPENRIG_HOME (every
 * scenario/hermetic daemon) never matches. Fail-closed: a real daemon on a custom OPENRIG_HOME gets no simulator cleanup.
 */
export function realSimctlAllowed(input: { env: Record<string, string | undefined>; userHome: string; openrigHome: string }): boolean {
  if (input.env["VITEST"] !== undefined || input.env["NODE_ENV"] === "test") return false;
  if (!input.userHome || !input.openrigHome) return false;
  return resolvePath(input.openrigHome) === resolvePath(joinPath(input.userHome, ".openrig"));
}

export function realSimctlExec(args: string[]): Promise<string> {
  const timeout = args[0] === "erase" ? 120_000 : 20_000;
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["simctl", ...args], { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

export function parseSimctlDevices(stdout: string): SimulatorDevice[] {
  const parsed = JSON.parse(stdout) as { devices?: Record<string, unknown> };
  if (!parsed || typeof parsed.devices !== "object" || parsed.devices === null) throw new Error("simctl list: no devices map");
  const out: SimulatorDevice[] = [];
  for (const group of Object.values(parsed.devices)) {
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      const d = raw as Record<string, unknown>;
      if (typeof d["udid"] !== "string" || typeof d["name"] !== "string" || typeof d["state"] !== "string") continue;
      const size = d["dataPathSize"];
      out.push({
        udid: d["udid"],
        name: d["name"],
        state: d["state"],
        isAvailable: d["isAvailable"] === true,
        sizeBytes: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null,
      });
    }
  }
  return out;
}

type Trigger =
  | { kind: "removal"; removed: RemovedSeat[]; reason: "seat_removed" | "rig_deleted" }
  | { kind: "cap"; capBytes: number };

export interface SimulatorLifecycleDeps {
  db: Database.Database;
  eventBus: EventBus;
  /** Injected the way the daemon injects its other external tools. Absent: the service is disabled (no simctl is ever run)
   *  until `enableRealSimctl()`; only the real launch path calls that. */
  simctl?: SimctlExec;
  /** The configured cap in whole GB (`simulators.size_cap_gb`), read fresh for each sweep. */
  capGb?: () => number;
  /** Default: only darwin has simulators; elsewhere the timer never starts. */
  platform?: string;
  log?: (line: string) => void;
}

export class SimulatorLifecycle {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private simctl: SimctlExec | null;
  private readonly capGb: () => number;
  private readonly platform: string;
  private readonly log: (line: string) => void;
  /** Serialises sweeps and removals so two of them never list and erase at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SimulatorLifecycleDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.simctl = deps.simctl ?? null;
    this.capGb = deps.capGb ?? (() => SIMULATOR_SIZE_CAP_DEFAULT_GB);
    this.platform = deps.platform ?? process.platform;
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  /** Turns the real `xcrun simctl` on. Called by the real launch path only, and only when `realSimctlAllowed`. */
  enableRealSimctl(): void {
    this.simctl = realSimctlExec;
  }

  get enabled(): boolean {
    return this.simctl !== null;
  }

  /** The seats of one rig, or one node of it, read before a delete so the erase can run after the delete committed.
   *  The kernel rig's seats are never returned: their generic tokens must not claim a hand-made device. */
  seatsForRemoval(rigId: string, nodeId?: string): RemovedSeat[] {
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?").get(rigId) as { name: string } | undefined;
    if (!rig || rig.name === KERNEL_RIG_NAME) return [];
    const rows = (nodeId === undefined
      ? this.db.prepare("SELECT id AS nodeId, rig_id AS rigId, logical_id AS logicalId FROM nodes WHERE rig_id = ?").all(rigId)
      : this.db.prepare("SELECT id AS nodeId, rig_id AS rigId, logical_id AS logicalId FROM nodes WHERE rig_id = ? AND id = ?").all(rigId, nodeId)
    ) as RemovedSeat[];
    return rows;
  }

  /** Trigger (a): erase the shut-down simulators of seats whose rows were just deleted. Never throws. */
  eraseForRemovedSeats(removed: RemovedSeat[], reason: "seat_removed" | "rig_deleted"): Promise<SimulatorRunResult> {
    if (removed.length === 0) return Promise.resolve({ status: "ok", outcomes: [] });
    return this.enqueue({ kind: "removal", removed, reason });
  }

  /** Trigger (b): erase attributed, shut-down simulators bigger than the cap. Never throws. */
  sweepOverCap(): Promise<SimulatorRunResult> {
    const gb = this.capGb();
    if (!Number.isFinite(gb) || gb <= 0) return Promise.resolve({ status: "disabled", outcomes: [] });
    return this.enqueue({ kind: "cap", capBytes: gb * BYTES_PER_GB });
  }

  /** Starts the periodic cap sweep (boot sweep, then every interval). Null where there are no simulators (not darwin). */
  startSweepTimer(intervalMs: number = SIMULATOR_SWEEP_INTERVAL_MS): ReturnType<typeof setInterval> | null {
    if (this.simctl === null || this.platform !== "darwin") return null;
    const tick = (): void => { void this.sweepOverCap(); };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
  }

  private enqueue(trigger: Trigger): Promise<SimulatorRunResult> {
    if (this.simctl === null) return Promise.resolve({ status: "disabled", outcomes: [] });
    const run = this.queue.then(() => this.run(trigger)).catch((err: unknown): SimulatorRunResult => {
      this.log(`[simulators] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "unavailable", outcomes: [] };
    });
    this.queue = run;
    return run;
  }

  private allNodes(): NodeRow[] {
    // The seats that take part: rigs neither archived nor the kernel (a stopped rig takes part). See the header.
    return this.db.prepare(
      `SELECT n.id AS nodeId, n.rig_id AS rigId, n.logical_id AS logicalId FROM nodes n
         JOIN rigs r ON r.id = n.rig_id
        WHERE r.archived_at IS NULL AND r.name <> ?`,
    ).all(KERNEL_RIG_NAME) as NodeRow[];
  }

  /** Why this device must be left alone, or the seat it belongs to for this trigger. */
  private decide(device: SimulatorDevice, trigger: Trigger): { skip: string } | { seat: NodeRow | RemovedSeat } {
    const owners = this.allNodes().filter((n) => nameIsForSeat(device.name, n.logicalId));
    let seat: NodeRow | RemovedSeat;
    if (trigger.kind === "removal") {
      const removedOwners = trigger.removed.filter((s) => nameIsForSeat(device.name, s.logicalId));
      if (removedOwners.length === 0) return { skip: "unattributed" };
      if (owners.length > 0) return { skip: "ambiguous" };
      seat = removedOwners[0]!;
    } else {
      if (owners.length === 0) return { skip: "unattributed" };
      if (owners.length > 1) return { skip: "ambiguous" };
      seat = owners[0]!;
    }
    if (!device.isAvailable) return { skip: "unavailable" };
    if (device.state !== "Shutdown") return { skip: `not_shut_down:${device.state}` };
    if (trigger.kind === "cap") {
      if (device.sizeBytes === null) return { skip: "size_unknown" };
      if (device.sizeBytes <= trigger.capBytes) return { skip: "under_cap" };
    }
    return { seat };
  }

  private async list(): Promise<SimulatorDevice[]> {
    return parseSimctlDevices(await this.exec(["list", "devices", "-j"]));
  }

  private exec(args: string[]): Promise<string> {
    if (this.simctl === null) return Promise.reject(new Error("simctl is not enabled in this process"));
    return this.simctl(args);
  }

  private async run(trigger: Trigger): Promise<SimulatorRunResult> {
    let devices: SimulatorDevice[];
    try {
      devices = await this.list();
    } catch (err) {
      this.log(`[simulators] simctl unavailable, nothing done: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "unavailable", outcomes: [] };
    }
    const reason: SimulatorEraseReason = trigger.kind === "cap" ? "over_size_cap" : trigger.reason;
    const outcomes: SimulatorOutcome[] = [];
    for (const first of devices) {
      const verdict = this.decide(first, trigger);
      if ("skip" in verdict) {
        outcomes.push({ udid: first.udid, name: first.name, action: "skipped", reason: verdict.skip, sizeBytes: first.sizeBytes });
        // A not_shut_down verdict is only reached after attribution passed, so the device is a removed seat's.
        if (verdict.skip.startsWith("not_shut_down") && trigger.kind === "removal") {
          this.log(`[simulators] ${first.name} (${first.udid}) belongs to a removed seat but is ${first.state}: left alone`);
        }
        continue;
      }
      // Re-read the device immediately before the erase and decide again on what simctl says now.
      let fresh: SimulatorDevice | undefined;
      try {
        fresh = (await this.list()).find((d) => d.udid === first.udid);
      } catch (err) {
        this.log(`[simulators] re-read failed for ${first.udid}, left alone: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const again = fresh ? this.decide(fresh, trigger) : { skip: "gone" };
      if (!fresh || "skip" in again) {
        outcomes.push({ udid: first.udid, name: first.name, action: "skipped", reason: fresh ? (again as { skip: string }).skip : "gone", sizeBytes: first.sizeBytes });
        continue;
      }
      try {
        await this.exec(["erase", fresh.udid]);
      } catch (err) {
        this.log(`[simulators] erase of ${fresh.name} (${fresh.udid}) failed: ${err instanceof Error ? err.message : String(err)}`);
        outcomes.push({ udid: fresh.udid, name: fresh.name, action: "failed", reason, sizeBytes: fresh.sizeBytes });
        continue;
      }
      outcomes.push({ udid: fresh.udid, name: fresh.name, action: "erased", reason, sizeBytes: fresh.sizeBytes });
      try {
        this.eventBus.emit({
          type: "simulator.erased",
          rigId: again.seat.rigId,
          nodeId: again.seat.nodeId,
          seat: again.seat.logicalId,
          udid: fresh.udid,
          name: fresh.name,
          sizeBytes: fresh.sizeBytes,
          reason,
          ...(trigger.kind === "cap" ? { capBytes: trigger.capBytes } : {}),
        });
      } catch (err) {
        this.log(`[simulators] erased ${fresh.udid} but the event could not be written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: "ok", outcomes };
  }
}
