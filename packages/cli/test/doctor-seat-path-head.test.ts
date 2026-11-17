// workspaces-o9o.106: `rig doctor` says when a running seat was launched before the seat PATH head (seat-bin, then rig-bin,
// ahead of the pane rc's entries, cbc6faf73), so the git worktree shim never applies to it. Found in o9o.104: every seat
// launched on sparky before the 2026-11-16 21:21 CET daemon restart had rig-bin at PATH entry 12-13, and nothing showed it.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import type { SeatProcess } from "../src/seat-process-environments.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

function makeDeps(seats: SeatProcess[] | null): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => (cmd === "hc --version" ? "hc 0.1.16\n" : ""),
    checkPort: async () => true,
    configStore: stubConfigStore({
      daemon: { port: 7433, host: "127.0.0.1" },
      db: { path: "/tmp/openrig/openrig.sqlite" },
      transcripts: { enabled: true, path: "/tmp/openrig/transcripts", lines: 1000, pollIntervalSeconds: 2 },
    }),
    platform: "linux",
    mkdirp: () => {},
    checkWritable: () => {},
    readHcHello: async () => ({ kind: "no_core", detail: "fixture: no core" }),
    pluginsDir: "/nonexistent-plugins",
    readSeatProcesses: () => seats,
    openrigHome: "/home/u/.openrig",
  };
}

const row = (seats: SeatProcess[] | null) => runDoctorChecks(makeDeps(seats)).checks.find((c) => c.name === "running_seats_path_head");

const HEAD = ["/home/u/.openrig/run/seat-bin/0abc", "/home/u/.openrig/rig-bin"];
const RC = ["/home/linuxbrew/.linuxbrew/bin", "/usr/bin"];

describe("o9o.106: rig doctor flags a seat launched before the seat PATH head", () => {
  it("a seat whose processes all lack the head is named, with the remedy; a seat with it is not", () => {
    const check = row([
      { pid: 10, session: "stale@rig", home: "/home/u/.openrig", path: [HEAD[0]!, ...RC, HEAD[1]!] },            // seat-bin first, rig-bin buried
      { pid: 11, session: "current@rig", home: "/home/u/.openrig", path: [...RC, HEAD[1]!] },                      // its pane's login shell: no head
      { pid: 12, session: "current@rig", home: "/home/u/.openrig", path: [...HEAD, ...RC] },                       // its runtime: the head
    ]);
    expect(check).toMatchObject({ status: "warn" });
    expect(check!.message).toContain("stale@rig");
    expect(check!.message).not.toContain("current@rig");
    expect(check!.message).toContain("relaunch to adopt");
    expect(check!.message).toContain("1 of 2 seats of /home/u/.openrig on this host was launched before the seat PATH head");
  });

  it("every seat with the head passes, counting them", () => {
    expect(row([{ pid: 1, session: "a@r", home: "/home/u/.openrig", path: [...HEAD, ...RC] }, { pid: 2, session: "b@r", home: "/home/u/.openrig", path: [...HEAD] }]))
      .toMatchObject({ status: "pass", message: expect.stringContaining("2 seats") });
  });

  it("no seat process on this host, or a platform it cannot read, is skipped with the reason, never a pass", () => {
    expect(row([])).toMatchObject({ status: "skipped", message: expect.stringContaining("no seat process") });
    expect(row(null)).toMatchObject({ status: "skipped", message: expect.stringContaining("not checked") });
  });

  it("only this instance's seats count: a test scaffold's seat, with its own OPENRIG_HOME, is not judged", () => {
    const check = row([
      { pid: 1, session: "mine@r", home: "/home/u/.openrig", path: [...HEAD, ...RC] },
      { pid: 2, session: "scaffold@t", home: "/tmp/hc-dr-x/h/openrig", path: [...RC] },
      { pid: 3, session: "nohome@t", home: null, path: [...RC] },
    ]);
    expect(check).toMatchObject({ status: "pass", message: expect.stringContaining("1 seat of /home/u/.openrig on this host has the seat PATH head") });
  });

  it("the head is the two folders in order, not merely present", () => {
    const check = row([
      { pid: 1, session: "swapped@r", home: "/home/u/.openrig", path: [HEAD[1]!, HEAD[0]!, ...RC] },
      { pid: 2, session: "noseatbin@r", home: "/home/u/.openrig", path: [RC[0]!, HEAD[1]!, ...RC] },
      { pid: 3, session: "norigbin@r", home: "/home/u/.openrig", path: [HEAD[0]!, ...RC] },
    ]);
    expect(check).toMatchObject({ status: "warn" });
    expect(check!.message).toContain("3 of 3 seats");
    for (const s of ["swapped@r", "noseatbin@r", "norigbin@r"]) expect(check!.message).toContain(s);
  });
});

describe.runIf(process.platform === "linux")("o9o.106: the Linux reader takes each process's PATH from its environ", () => {
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill("SIGKILL"); child = undefined; });

  it("finds a process carrying OPENRIG_SESSION_NAME, with its PATH in order", async () => {
    const session = `o9o106-fixture-${process.pid}@test`;
    child = spawn("/bin/sleep", ["30"], { env: { OPENRIG_SESSION_NAME: session, OPENRIG_HOME: "/tmp/o9o106-home", PATH: [...HEAD, "/usr/bin"].join(":") }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const { readSeatProcesses } = await import("../src/seat-process-environments.js");
    const mine = (readSeatProcesses() ?? []).filter((p) => p.session === session);
    expect(mine).toEqual([{ pid: child.pid, session, home: "/tmp/o9o106-home", path: [...HEAD, "/usr/bin"] }]);
  });
});
