// OF-220: the Linux adapter of the ProcessStartClock port, driven through its injected IO (no /proc needed).
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LinuxProcStartClock, createProcessStartClock, parseStatStartTicks } from "../src/adapters/linux-proc-start-clock.js";
import { FileBootInstantStore } from "../src/adapters/boot-instant-file-store.js";
import type { BootInstantStore } from "../src/domain/process-start-clock.js";

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
    // The threshold is pinned by its value, not by the constant under test (OF-230 c): 500 ms is jitter, 501 ms is a step.
    now = NOW + 500;
    expect((await clock.startedAtMs([4242])).get(4242)).toBe(first);
    now = NOW + 501;
    expect((await clock.startedAtMs([4242])).get(4242)).toBe(first + 501);
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

// OF-230: the boot instant is kept across daemon lives, keyed by the kernel's boot id.
describe("LinuxProcStartClock keeps its boot instant per boot", () => {
  const NOW = Date.UTC(2031, 6, 15, 12, 0, 0, 0);
  const BOOT_A = "11111111-aaaa-4aaa-8aaa-111111111111";
  const BOOT_B = "22222222-bbbb-4bbb-8bbb-222222222222";

  function memoryStore() {
    const kept = new Map<string, number>();
    const calls: string[] = [];
    const store: BootInstantStore = {
      read: async (id) => { calls.push(`read ${id}`); return kept.get(id) ?? null; },
      write: async (id, ms) => { calls.push(`write ${id}`); kept.clear(); kept.set(id, ms); },
    };
    return { store, kept, calls };
  }
  const daemon = (opts: { bootId: string | (() => never); uptime: string; now: number }, store: BootInstantStore | null) => new LinuxProcStartClock({
    now: () => opts.now,
    readText: async (p) => {
      if (p === "/proc/sys/kernel/random/boot_id") { if (typeof opts.bootId !== "string") opts.bootId(); return `${opts.bootId}\n`; }
      if (p === "/proc/uptime") return `${opts.uptime} 0`;
      if (p === "/proc/4242/stat") return statWith(3000);
      throw new Error(`ENOENT ${p}`);
    },
  }, store);

  it("a second daemon on the same boot names the same instant for a process, though its own uptime read is 10 ms off", async () => {
    const { store } = memoryStore();
    const first = (await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, store).startedAtMs([4242])).get(4242)!;
    // Without the kept instant this daemon would measure NOW - 99 990 ms, 10 ms later than the first.
    const second = (await daemon({ bootId: BOOT_A, uptime: "100.01", now: NOW }, store).startedAtMs([4242])).get(4242)!;
    expect(second).toBe(first);
    expect(first).toBe(NOW - 100_000 + 30_000);
  });

  it("measures again after a reboot (another boot id) and keeps that one instead", async () => {
    const { store, kept } = memoryStore();
    await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, store).startedAtMs([4242]);
    // A reboot 3 days later: boot instant differs by far more than the jitter, and so does the id.
    const later = NOW + 3 * 86_400_000;
    const after = (await daemon({ bootId: BOOT_B, uptime: "50.00", now: later }, store).startedAtMs([4242])).get(4242)!;
    expect(after).toBe(later - 50_000 + 30_000);
    expect(kept.get(BOOT_B)).toBe(later - 50_000);
    expect(kept.has(BOOT_A)).toBe(false);
  });

  it("does not reuse another boot's instant even when the wall clock happens to agree within the jitter", async () => {
    const { store } = memoryStore();
    await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, store).startedAtMs([4242]);
    // Same boot instant to within 5 ms, but another boot: the instant is measured, not read from the other boot's record.
    const other = (await daemon({ bootId: BOOT_B, uptime: "100.005", now: NOW }, store).startedAtMs([4242])).get(4242)!;
    expect(other).toBe(NOW - 100_005 + 30_000);
  });

  it("re-measures and replaces the kept instant when the wall clock stepped while the daemon was down", async () => {
    const { store, kept } = memoryStore();
    await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, store).startedAtMs([4242]);
    const stepped = (await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW + 2_000 }, store).startedAtMs([4242])).get(4242)!;
    expect(stepped).toBe(NOW + 2_000 - 100_000 + 30_000);
    expect(kept.get(BOOT_A)).toBe(NOW + 2_000 - 100_000);
  });

  it("writes only when it measured: an adopted instant is not rewritten", async () => {
    const { store, calls } = memoryStore();
    await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, store).startedAtMs([4242]);
    calls.length = 0;
    const clock = daemon({ bootId: BOOT_A, uptime: "100.01", now: NOW }, store);
    await clock.startedAtMs([4242]);
    await clock.startedAtMs([4242]);
    expect(calls).toEqual([`read ${BOOT_A}`]);
  });

  it("falls back to measuring, without throwing, when the boot id or the store fails", async () => {
    const expected = NOW - 100_000 + 30_000;
    const broken: BootInstantStore = { read: async () => { throw new Error("EIO"); }, write: async () => { throw new Error("EROFS"); } };
    expect((await daemon({ bootId: BOOT_A, uptime: "100.00", now: NOW }, broken).startedAtMs([4242])).get(4242)).toBe(expected);
    const { store, calls } = memoryStore();
    const noId = daemon({ bootId: () => { throw new Error("ENOENT boot_id"); }, uptime: "100.00", now: NOW }, store);
    expect((await noId.startedAtMs([4242])).get(4242)).toBe(expected);
    expect(calls).toEqual([]); // no boot id, no key: nothing read, nothing kept
  });
});

describe("FileBootInstantStore", () => {
  let dir: string;
  const fresh = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "of230-boot-")); return path.join(dir, "state", "boot-instant.json"); };
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps the instant for its boot id across store instances and reads none for another boot id", async () => {
    const file = fresh();
    await new FileBootInstantStore(file).write("boot-a", 1_793_733_380_203.5);
    expect(await new FileBootInstantStore(file).read("boot-a")).toBe(1_793_733_380_203.5);
    expect(await new FileBootInstantStore(file).read("boot-b")).toBeNull();
    await new FileBootInstantStore(file).write("boot-b", 5);
    expect(await new FileBootInstantStore(file).read("boot-a")).toBeNull();
    expect(fs.readdirSync(path.dirname(file))).toEqual(["boot-instant.json"]); // no staging file left behind
  });

  it("a write that dies before its rename leaves the previous record whole and no staging file (atomic replace)", async () => {
    const file = fresh();
    await new FileBootInstantStore(file).write("boot-a", 111);
    const rename = vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("killed before rename"));
    try {
      await expect(new FileBootInstantStore(file).write("boot-b", 222)).rejects.toThrow("killed before rename");
    } finally { rename.mockRestore(); }
    expect(await new FileBootInstantStore(file).read("boot-a")).toBe(111);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["boot-instant.json"]);
  });

  it.each([["absent", null], ["torn", "{\"bootId\":\"boot-a\",\"bootM"], ["not an object", "7"], ["a non-number instant", "{\"bootId\":\"boot-a\",\"bootMs\":\"1\"}"]])(
    "reads none from a record that is %s",
    async (_label, content) => {
      const file = fresh();
      if (content !== null) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
      expect(await new FileBootInstantStore(file).read("boot-a")).toBeNull();
    },
  );
});
