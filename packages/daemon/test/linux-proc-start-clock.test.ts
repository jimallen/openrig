// OF-220: the Linux adapter of the ProcessStartClock port, driven through its injected IO (no /proc needed).
import { describe, expect, it } from "vitest";
import { BOOT_REMEASURE_MS, LinuxProcStartClock, createProcessStartClock, parseStatStartTicks } from "../src/adapters/linux-proc-start-clock.js";

// Field 22 is 3 000 ticks (30 s) after boot. Field 2 holds spaces and parentheses, as a process may name itself.
const statWith = (ticks: number, comm = "node (vitest 1)") =>
  `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;

function io(opts: { uptime: () => string; stats: Record<number, string>; now: () => number }) {
  return {
    now: opts.now,
    readText: async (p: string): Promise<string> => {
      if (p === "/proc/uptime") return opts.uptime();
      const m = p.match(/^\/proc\/(\d+)\/stat$/);
      const stat = m ? opts.stats[Number(m[1])] : undefined;
      if (stat === undefined) throw new Error(`ENOENT ${p}`);
      return stat;
    },
  };
}

describe("parseStatStartTicks", () => {
  it("reads field 22 after the LAST closing parenthesis of the command", () => {
    expect(parseStatStartTicks(statWith(3000))).toBe(3000);
    expect(parseStatStartTicks(statWith(77, "a) S 9 (b"))).toBe(77);
  });
  it("refuses what is not a stat line", () => {
    expect(parseStatStartTicks("garbage")).toBeNull();
    expect(parseStatStartTicks("1 (x) S 1 2")).toBeNull();
    expect(parseStatStartTicks(statWith(-1))).toBeNull();
  });
});

describe("LinuxProcStartClock", () => {
  // Wall clock 2031-07-15 12:00:00.000 UTC, uptime 100 s: boot at 11:58:20; a process at tick 3000 began 30 s after boot.
  const NOW = Date.UTC(2031, 6, 15, 12, 0, 0, 0);
  const BOOT = NOW - 100_000;

  it("dates a process as boot instant + starttime ticks of 10 ms, to the tick (not a second early)", async () => {
    const clock = new LinuxProcStartClock(io({ uptime: () => "100.00 400.00", stats: { 4242: statWith(3000), 7: statWith(3001) }, now: () => NOW }));
    const starts = await clock.startedAtMs([4242, 7, 999]);
    expect(starts.get(4242)).toBe(BOOT + 30_000);
    expect(starts.get(7)).toBe(BOOT + 30_010);
    expect(starts.has(999)).toBe(false); // gone: no date, never a guess
  });

  it("keeps its boot instant across uptime read jitter so a start's second cannot flip between two reads", async () => {
    let uptime = "100.00 0";
    const clock = new LinuxProcStartClock(io({ uptime: () => uptime, stats: { 4242: statWith(3000) }, now: () => NOW }));
    const first = (await clock.startedAtMs([4242])).get(4242)!;
    uptime = "100.01 0"; // 10 ms of jitter
    expect((await clock.startedAtMs([4242])).get(4242)).toBe(first);
  });

  it("measures the boot instant again when the wall clock has stepped by more than the hysteresis", async () => {
    let now = NOW;
    const clock = new LinuxProcStartClock(io({ uptime: () => "100.00 0", stats: { 4242: statWith(3000) }, now: () => now }));
    const first = (await clock.startedAtMs([4242])).get(4242)!;
    now = NOW + BOOT_REMEASURE_MS + 1;
    expect((await clock.startedAtMs([4242])).get(4242)).toBe(first + BOOT_REMEASURE_MS + 1);
  });

  it("answers nothing when /proc/uptime is unreadable", async () => {
    const clock = new LinuxProcStartClock(io({ uptime: () => "nonsense", stats: { 4242: statWith(3000) }, now: () => NOW }));
    expect((await clock.startedAtMs([4242])).size).toBe(0);
  });

  it("reads every requested pid, beyond one read chunk", async () => {
    const pids = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const stats = Object.fromEntries(pids.map((p) => [p, statWith(p)]));
    const starts = await new LinuxProcStartClock(io({ uptime: () => "100.00 0", stats, now: () => NOW })).startedAtMs(pids);
    expect(starts.size).toBe(150);
    expect(starts.get(1149)).toBe(BOOT + 1149 * 10);
  });
});

describe("createProcessStartClock", () => {
  it("is the /proc clock on Linux and none elsewhere (macOS ps lstart is already the true second: measured 0.010-0.999 s, 60 of 60)", () => {
    expect(createProcessStartClock("linux")).toBeInstanceOf(LinuxProcStartClock);
    expect(createProcessStartClock("darwin")).toBeNull();
  });
});
