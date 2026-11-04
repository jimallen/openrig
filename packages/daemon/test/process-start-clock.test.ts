// OF-220: a process's stored start names the second it TRULY began in. `ps -o lstart=` on Linux can name a second up to two
// before (btime is whole seconds, ps cuts again), and every reader of a stored start assumes the true start lies in
// [L, L+1) s. These tests drive the REAL listers against a hermetic `ps` that reads early, with a fake boot clock that knows
// the truth, and carry the production consequence through the real Codex log gate: a row a retired occupant of a reused pid
// wrote inside the margin must not become the new process's thread.
// The dates are 2031, away from wall clock, so a clock-reading mutant cannot hide behind "now".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";
import { CodexThreadIdResolver, lstartToMinTs } from "../src/domain/codex-thread-id.js";
import { isClaudeSidecarFromEarlierProcess } from "../src/domain/resume-token-capture.js";
import { readNativeEffort } from "../src/domain/seat-effort.js";
import {
  CLOCK_START_MAX_AFTER_PS_MS, clockStartForPsStart, formatPsLstart, installProcessStartClock, parsePsLstartMs,
  withTrueStartTimes, type ProcessStartClock,
} from "../src/domain/process-start-clock.js";
import { processStart } from "../src/adapters/native-inbox-os.js";
import { createProcessStartClock } from "../src/adapters/linux-proc-start-clock.js";

// What `ps` printed: it reads one whole second (here: more) before the true start, as it does on Sparky after its reboot.
const PS_SAYS = "Tue Jul 15 09:30:10 2031";
const PS_SECOND_MS = new Date(2031, 6, 15, 9, 30, 10).getTime();
// What the kernel knows: the process began 1.4 s after the second ps named, in the next one.
const TRUE_START_MS = PS_SECOND_MS + 1_400;
const TRUE_SECOND = "Tue Jul 15 09:30:11 2031";

let scratch: string | undefined;
afterEach(() => {
  installProcessStartClock(null);
  vi.unstubAllEnvs();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function clockOf(starts: Record<number, number>): ProcessStartClock {
  return { startedAtMs: async (pids) => new Map(pids.filter((p) => p in starts).map((p) => [p, starts[p]!])) };
}

function installEarlyPs(): void {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "of220-ps-"));
  fs.writeFileSync(path.join(scratch, "ps"), [
    "#!/bin/sh",
    'case "$2" in',
    `  lstart=) printf '%s\\n' "${PS_SAYS}" ;;`,
    `  *ucomm*) printf '%s\\n' "PID PPID PGID TPGID UCOMM STARTED COMMAND" "101 1 101 101 codex ${PS_SAYS} codex resume tok-1" "102 1 102 102 codex ${PS_SAYS} codex" "103 1 103 103 zsh ${PS_SAYS} -zsh" ;;`,
    `  *) printf '%s\\n' "PID PPID STARTED COMMAND" "101 1 ${PS_SAYS} codex resume tok-1" "102 1 ${PS_SAYS} codex" "103 1 ${PS_SAYS} -zsh" ;;`,
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
}

const LISTERS = [["listNativeProcesses", listNativeProcesses], ["defaultListProcessesStrict", defaultListProcessesStrict]] as const;

describe.each(LISTERS)("%s dates a process by the boot clock", (_name, list) => {
  it("names the second the process truly began in, not the earlier one ps read", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ 101: TRUE_START_MS }));
    const rows = await list();
    expect(rows.find((r) => r.pid === 101)!.startedAt).toBe(TRUE_SECOND);
  });

  it("keeps ps's start for a pid the clock cannot date, and for every pid when there is no clock", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ 101: TRUE_START_MS }));
    const dated = await list();
    expect(dated.filter((r) => r.pid !== 101).every((r) => r.startedAt === PS_SAYS)).toBe(true);
    installProcessStartClock(null);
    expect((await list()).every((r) => r.startedAt === PS_SAYS)).toBe(true);
  });

  it("keeps ps's start when the clock fails", async () => {
    installEarlyPs();
    installProcessStartClock({ startedAtMs: async () => { throw new Error("proc unreadable"); } });
    expect((await list()).every((r) => r.startedAt === PS_SAYS)).toBe(true);
  });

  it("does not date a pid the clock read as a newcomer (reused between the ps read and the clock read)", async () => {
    installEarlyPs();
    // 9 s after the second ps named: a different process now holds pid 102. Two and a half seconds before it: not this one either.
    installProcessStartClock(clockOf({ 102: PS_SECOND_MS + 9_000, 103: PS_SECOND_MS - 2_500 }));
    const rows = await list();
    expect(rows.find((r) => r.pid === 102)!.startedAt).toBe(PS_SAYS);
    expect(rows.find((r) => r.pid === 103)!.startedAt).toBe(PS_SAYS);
  });

  it("agrees between the two listers on the same process", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ 101: TRUE_START_MS }));
    expect((await listNativeProcesses()).find((r) => r.pid === 101)!.startedAt)
      .toBe((await defaultListProcessesStrict()).find((r) => r.pid === 101)!.startedAt);
  });
});

describe("the clock's reading is accepted only as the same process", () => {
  it("accepts [ps second, ps second + 2 s) and nothing outside it", () => {
    const L = PS_SECOND_MS;
    expect(clockStartForPsStart(L, L + 1_999)).toBe(L + 1_999);
    expect(clockStartForPsStart(L, L)).toBe(L);
    expect(clockStartForPsStart(L, L + CLOCK_START_MAX_AFTER_PS_MS)).toBeNull();
    expect(clockStartForPsStart(L, L - 100)).toBeNull();
    expect(clockStartForPsStart(L, undefined)).toBeNull();
    expect(clockStartForPsStart(Number.NaN, L)).toBeNull();
  });

  it("writes and reads back a ps lstart string the way ps prints it (day padded to two columns)", () => {
    expect(formatPsLstart(new Date(2031, 6, 5, 9, 3, 7, 999).getTime())).toBe("Sat Jul  5 09:03:07 2031");
    expect(parsePsLstartMs("Sat Jul  5 09:03:07 2031")).toBe(new Date(2031, 6, 5, 9, 3, 7).getTime());
    expect(Number.isNaN(parsePsLstartMs("not a date"))).toBe(true);
  });

  it("with no clock installed returns the rows untouched", async () => {
    const rows = [{ pid: 1, startedAt: PS_SAYS }];
    expect(await withTrueStartTimes(rows)).toBe(rows);
  });
});

describe("what a start time 1 s early would have attributed to a reused pid", () => {
  // A pid is reused: the retired occupant logged a Codex row at 09:30:11.2, then the new process began at 09:30:11.4.
  // ps named 09:30:10, so the gate `ts > second(ps)` let the retired occupant's row through as the new process's thread.
  const PID = 101;
  const RETIRED_ROW_TS = Math.floor(PS_SECOND_MS / 1000) + 1; // 09:30:11, inside the true start's second, before the start
  const CURRENT_ROW_TS = Math.floor(PS_SECOND_MS / 1000) + 2;

  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

  /** A Codex home with the retired occupant's row, and the new process's own row when asked. */
  function codexHome(withCurrentRow: boolean): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "of220-codex-"));
    homes.push(home);
    const logs = new Database(path.join(home, "logs_2.sqlite"));
    logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
    const state = new Database(path.join(home, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
    for (const id of ["retired-thread", "current-thread"]) state.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, "cli", `${home}/${id}.jsonl`);
    const insert = logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)");
    insert.run(RETIRED_ROW_TS, `pid:${PID}:native-process`, "retired-thread");
    if (withCurrentRow) insert.run(CURRENT_ROW_TS, `pid:${PID}:native-process`, "current-thread");
    logs.close(); state.close();
    return home;
  }

  it("does not hand the retired occupant's thread to the new process", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ [PID]: TRUE_START_MS }));
    const identity = (await listNativeProcesses()).find((r) => r.pid === PID)!.startedAt!;
    expect(await new CodexThreadIdResolver({ codexHome: codexHome(false) }).resolve(PID, identity)).toBeUndefined();
  });

  it("still resolves the new process's own thread, written after its true start", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ [PID]: TRUE_START_MS }));
    const identity = (await listNativeProcesses()).find((r) => r.pid === PID)!.startedAt!;
    expect(lstartToMinTs(identity)).toBe(Math.floor(TRUE_START_MS / 1000));
    expect(await new CodexThreadIdResolver({ codexHome: codexHome(true) }).resolve(PID, identity)).toBe("current-thread");
  });

  it("gates a transcript turn and a status-line sample against the true start", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ [PID]: TRUE_START_MS }));
    const identity = (await listNativeProcesses()).find((r) => r.pid === PID)!.startedAt!;
    // A sample taken at 09:30:10.5 predates the true start (09:30:11.4): an earlier process's.
    const sampledAt = new Date(PS_SECOND_MS + 500).toISOString();
    expect(await isClaudeSidecarFromEarlierProcess(sampledAt, "s", async () => identity)).toBe(true);

    scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "of220-effort-"));
    const transcript = path.join(scratch, "t.jsonl");
    const turn = (at: number) => JSON.stringify({ type: "assistant", effort: "high", timestamp: new Date(at).toISOString() });
    fs.writeFileSync(transcript, `${turn(PS_SECOND_MS + 500)}\n`);
    expect(readNativeEffort("claude-code", transcript, identity).state).toBe("not_verified");
    fs.writeFileSync(transcript, `${turn(TRUE_START_MS + 100)}\n`);
    expect(readNativeEffort("claude-code", transcript, identity).state).toBe("observed");
  });
});

describe("processStart (the native inbox's Date) uses the boot clock too", () => {
  it("returns the kernel's start when it is the same process, ps's when it is not", async () => {
    installEarlyPs();
    installProcessStartClock(clockOf({ 101: TRUE_START_MS, 102: PS_SECOND_MS + 9_000 }));
    expect((await processStart(101))!.getTime()).toBe(TRUE_START_MS);
    expect((await processStart(102))!.getTime()).toBe(PS_SECOND_MS);
    installProcessStartClock(null);
    expect((await processStart(101))!.getTime()).toBe(PS_SECOND_MS);
  });
});

describe("real processes, real ps, the platform's own clock", () => {
  it("never names a second before the one the process was spawned in", async () => {
    installProcessStartClock(createProcessStartClock());
    const children: ReturnType<typeof spawn>[] = [];
    try {
      for (let i = 0; i < 12; i += 1) {
        const before = Date.now();
        const child = spawn("sleep", ["30"], { stdio: "ignore" });
        const after = Date.now();
        children.push(child);
        const row = (await listNativeProcesses()).find((r) => r.pid === child.pid);
        expect(row, "the spawned process is listed").toBeDefined();
        const named = parsePsLstartMs(row!.startedAt!);
        // The process began between `before` and `after`; the second named must be that second (100 ms of read slack at a boundary).
        expect(named).toBeGreaterThanOrEqual(Math.floor((before - 100) / 1000) * 1000);
        expect(named).toBeLessThanOrEqual(after);
      }
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  }, 60_000);
});
