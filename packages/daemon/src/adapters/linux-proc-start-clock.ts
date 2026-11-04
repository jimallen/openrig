// OF-220 — the Linux adapter of the domain's ProcessStartClock port (domain/process-start-clock.ts).
//
// A process's start is the kernel's own: `starttime` (field 22 of /proc/<pid>/stat, ticks since boot) on the boot clock
// that /proc/uptime reports. The boot instant in epoch ms is "now minus uptime", measured once and kept, because /proc/uptime
// has 10 ms resolution and a boot instant re-measured on every read would move a process's start by a few ms between two
// reads, and flip the second it names for the few processes that began within those ms of a second boundary. It is
// measured again only when the wall clock has plainly moved (stepped) under it, by more than BOOT_REMEASURE_MS.
// CLK_TCK is 100 on Linux: USER_HZ is fixed by the kernel's userspace ABI.
import { readFile } from "node:fs/promises";
import type { ProcessStartClock } from "../domain/process-start-clock.js";

const TICKS_PER_SECOND = 100;
/** A boot instant that differs from the kept one by less than this is read jitter (10 ms uptime resolution, scheduling), not a
 *  clock step. */
export const BOOT_REMEASURE_MS = 500;
const READ_CHUNK = 64;

export interface LinuxProcStartClockIo {
  readText(path: string): Promise<string>;
  now(): number;
}

const nodeIo: LinuxProcStartClockIo = { readText: (path) => readFile(path, "utf8"), now: () => Date.now() };

/** Field 22 of a /proc/<pid>/stat line, in ticks, or null. Field 2 (the command) may hold spaces and parentheses, so fields
 *  are counted after the LAST ")". */
export function parseStatStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" "); // fields[0] is field 3 (state), so field 22 is fields[19]
  const ticks = Number(fields[19]);
  return fields.length >= 20 && Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
}

export class LinuxProcStartClock implements ProcessStartClock {
  private bootMs: number | null = null;

  constructor(private readonly io: LinuxProcStartClockIo = nodeIo) {}

  private async bootInstantMs(): Promise<number | null> {
    const before = this.io.now();
    const uptime = Number((await this.io.readText("/proc/uptime")).split(" ")[0]);
    const after = this.io.now();
    if (!Number.isFinite(uptime)) return null;
    const measured = (before + after) / 2 - uptime * 1000;
    if (this.bootMs === null || Math.abs(measured - this.bootMs) > BOOT_REMEASURE_MS) this.bootMs = measured;
    return this.bootMs;
  }

  async startedAtMs(pids: readonly number[]): Promise<ReadonlyMap<number, number>> {
    const result = new Map<number, number>();
    const boot = await this.bootInstantMs();
    if (boot === null) return result;
    for (let i = 0; i < pids.length; i += READ_CHUNK) {
      await Promise.all(pids.slice(i, i + READ_CHUNK).map(async (pid) => {
        try {
          const ticks = parseStatStartTicks(await this.io.readText(`/proc/${pid}/stat`));
          if (ticks !== null) result.set(pid, boot + (ticks * 1000) / TICKS_PER_SECOND);
        } catch { /* gone or unreadable: no date, the caller keeps ps's */ }
      }));
    }
    return result;
  }
}

/** The platform's clock, or null where there is no /proc boot clock (macOS: `ps` lstart is already the true second). */
export function createProcessStartClock(platform: NodeJS.Platform = process.platform): ProcessStartClock | null {
  return platform === "linux" ? new LinuxProcStartClock() : null;
}
