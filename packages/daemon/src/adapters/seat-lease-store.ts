import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import type { RelaunchCheckPort, SeatLeaseObservation } from "../domain/relaunch-checks.js";

/** A lease as registered by `rig seat lease`: the seat's own work holding something others wait on (a UI test host, say). */
export interface SeatLease {
  holder: string; pid: number; reason?: string; registeredAt: string;
  /** When the holder process started, as the OS reports it; with the pid it names that one process (a reused pid has another). */
  holderStartedAt?: string;
}

/** A holder names the lease's file: letters, digits, dot, dash, underscore; it starts with a letter or digit. */
const HOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type LeaseRefusal = { ok: false; code: "invalid_lease_holder" | "invalid_lease_pid"; message: string };

/** What the store needs to know about a process. */
export interface LeaseProcessProbe {
  /** Whether any process has this pid: signal 0 checks without sending. EPERM means it exists under another user. */
  exists(pid: number): boolean;
  /** When the process with this pid started, as the OS reports it; null when it cannot be read. */
  startedAt(pid: number): string | null;
}

export const osLeaseProcessProbe: LeaseProcessProbe = {
  exists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  startedAt(pid) {
    try {
      // lstart in the C locale, as listNativeProcesses reads it (Linux and macOS).
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  },
};

/**
 * workspaces-o9o.8: seat leases on disk, one JSON file per holder under <root>/<seat>/ (root: $OPENRIG_HOME/state/seat-leases). A lease
 * counts while its holder process is alive; a dead one is stale and reported, never counted. Writes are atomic (temp file, then rename).
 */
export class SeatLeaseStore {
  constructor(private readonly root: string, private readonly probe: LeaseProcessProbe = osLeaseProcessProbe) {}

  private seatDir(seat: string): string {
    return nodePath.join(this.root, encodeURIComponent(seat));
  }

  acquire(seat: string, lease: { holder: string; pid: number; reason?: string }, now: Date = new Date()): { ok: true; lease: SeatLease } | LeaseRefusal {
    if (!HOLDER.test(lease.holder)) {
      return { ok: false, code: "invalid_lease_holder", message: `A lease holder is 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit (got "${lease.holder}").` };
    }
    if (!Number.isInteger(lease.pid) || lease.pid <= 1) {
      return { ok: false, code: "invalid_lease_pid", message: `A lease names the pid of the process that holds it, a whole number above 1 (got ${String(lease.pid)}).` };
    }
    const holderStartedAt = this.probe.startedAt(lease.pid);
    const record: SeatLease = {
      holder: lease.holder, pid: lease.pid, ...(lease.reason ? { reason: lease.reason } : {}), registeredAt: now.toISOString(),
      ...(holderStartedAt ? { holderStartedAt } : {}),
    };
    const dir = this.seatDir(seat);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = nodePath.join(dir, `${lease.holder}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return { ok: true, lease: record };
  }

  /** True when the holder's lease was there and is now gone. */
  release(seat: string, holder: string): boolean {
    if (!HOLDER.test(holder)) return false;
    const file = nodePath.join(this.seatDir(seat), `${holder}.json`);
    try {
      statSync(file);
    } catch {
      return false;
    }
    rmSync(file, { force: true });
    return true;
  }

  /** Alive only when the pid is in use by the same process that registered the lease (o9o.8 finding 3). */
  private liveness(record: Partial<SeatLease> & { pid: number }): "alive" | "gone" | "unknown" {
    if (!this.probe.exists(record.pid)) return "gone";
    const now = this.probe.startedAt(record.pid);
    if (!record.holderStartedAt || now === null) return "unknown";
    return now === record.holderStartedAt ? "alive" : "gone";
  }

  /** The seat's leases, each with whether its holder is alive. A seat with no folder has none. Throws when the folder cannot be read. */
  leases(seat: string): SeatLeaseObservation[] {
    const dir = this.seatDir(seat);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const found: SeatLeaseObservation[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(nodePath.join(dir, name), "utf8")) as Partial<SeatLease>;
      if (typeof record.holder !== "string" || typeof record.pid !== "number") throw new Error(`lease file ${name} is not a lease`);
      found.push({ holder: record.holder, pid: record.pid, ...(record.reason ? { reason: record.reason } : {}), liveness: this.liveness({ ...record, pid: record.pid }) });
    }
    return found;
  }
}

/** The node filesystem behind the relaunch checks' port. */
export function nodeRelaunchChecks(leases: SeatLeaseStore): RelaunchCheckPort {
  return {
    leases: (seat) => leases.leases(seat),
    folderFiles: (dir) => readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, modifiedAt: statSync(nodePath.join(dir, entry.name)).mtime.toISOString() })),
  };
}
