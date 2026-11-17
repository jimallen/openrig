// workspaces-o9o.11: `rig doctor`'s host section, before a host's first launch. Sparky's first launch failed four ways
// that no check reported: a login-shell prompt swallowed the typed launch, Pi was not on the seat's PATH,
// pi.operator_login_dir was unset, and a spec folder was writable by group. These rows must say so, and change nothing.
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { doctorCommand, runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import {
  daemonHostRows,
  fetchDaemonHostRows,
  gitTemplateCheck,
  inotifyHeadroomCheck,
  piOperatorLoginCheck,
  remoteHostsCheck,
  runtimesInSpec,
  SEAT_SHELL_NOTE,
  type LocalHostFacts,
} from "../src/host-readiness.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

function localFacts(over: Partial<LocalHostFacts> = {}): LocalHostFacts {
  return {
    platform: "linux",
    uid: 1000,
    readFile: () => null,
    readdir: () => null,
    readlink: () => null,
    stat: () => null,
    gitTemplateHasExclude: () => true,
    registeredHosts: () => null,
    ...over,
  };
}

const swallowed = {
  name: "seat_shell",
  status: "fail" as const,
  message: "A login shell started the way a seat's is (/bin/zsh) did not run a typed command within 10 s.",
  reason: "The probe terminal showed (secrets redacted):\n[oh-my-zsh] Would you like to update? [Y/n]",
  fix: "Open a new terminal, run `$SHELL -l` and see what it asks before the prompt.",
};

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
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
    } as never),
    platform: "darwin",
    mkdirp: () => {},
    checkWritable: () => {},
    readHcHello: async () => ({ kind: "no_core", detail: "fixture: no core" }),
    localHostFacts: localFacts(),
    fetchHostRows: async () => ({ status: 200, rows: [{ name: "seat_shell", status: "pass", message: "ok" }] }),
    ...overrides,
  };
}

async function runDoctor(deps: DoctorDeps, args: string[] = ["--json"]): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(doctorCommand(deps));
    await program.parseAsync(["node", "rig", "doctor", ...args]);
  } finally {
    console.log = origLog;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, exitCode };
}

const checksOf = (logs: string[]) => (JSON.parse(logs.join("\n")) as { checks: Array<{ name: string; status: string; message: string; fix?: string; reason?: string }> }).checks;

describe("rig doctor's host section", () => {
  it("reports a login shell that swallows the typed launch, as a failure with its fix", async () => {
    const { logs, exitCode } = await runDoctor(makeDeps({ fetchHostRows: async () => ({ status: 200, rows: [swallowed] }) }));
    const row = checksOf(logs).find((c) => c.name === "seat_shell");
    expect(row?.status).toBe("fail");
    expect(row?.reason).toContain("[Y/n]");
    expect(exitCode).toBe(1);
  });

  it("asks the daemon for the seat-shell rows by default, with the spec's runtimes, and prints the stated line", async () => {
    const fetchHostRows = vi.fn(async () => ({ status: 200, rows: [{ name: "seat_shell", status: "pass" as const, message: "ok" }] }));
    const spec = "name: r\npods:\n  - id: p\n    members:\n      - id: a\n        runtime: pi\n      - id: b\n        runtime: terminal\n";
    const { logs } = await runDoctor(makeDeps({ fetchHostRows, specPath: "/s/rig.yaml", readFile: (p) => (p === "/s/rig.yaml" ? spec : null) }));
    expect(fetchHostRows).toHaveBeenCalledWith({ seatShell: true, runtimes: ["pi", "terminal"] });
    expect(JSON.parse(logs.join("\n")).note).toBe(SEAT_SHELL_NOTE);
  });

  it("--no-seat-shell asks for no probe shell and prints no stated line", async () => {
    const fetchHostRows = vi.fn(async () => ({ status: 200, rows: [{ name: "seat_shell", status: "skipped" as const, message: "Skipped (--no-seat-shell)" }] }));
    const { logs } = await runDoctor(makeDeps({ fetchHostRows }), ["--no-seat-shell"]);
    expect(fetchHostRows).toHaveBeenCalledWith({ seatShell: false, runtimes: null });
    expect(logs.join("\n")).not.toContain(SEAT_SHELL_NOTE);
  });

  it("a daemon that cannot be asked skips its rows instead of passing them", async () => {
    const { logs } = await runDoctor(makeDeps({ fetchHostRows: async () => null }));
    expect(checksOf(logs).find((c) => c.name === "host_daemon_checks")).toMatchObject({ status: "skipped", fix: "rig daemon start, then rig doctor again" });
    const old = await runDoctor(makeDeps({ fetchHostRows: async () => ({ status: 404, rows: null }) }));
    expect(checksOf(old.logs).find((c) => c.name === "host_daemon_checks")?.message).toContain("older version");
  });

  it("a Pi spec with pi.operator_login_dir unset gets the launch's own fix", async () => {
    const spec = "name: r\npods:\n  - id: p\n    members:\n      - id: a\n        runtime: pi\n";
    const { logs } = await runDoctor(makeDeps({ specPath: "/s/rig.yaml", readFile: (p) => (p === "/s/rig.yaml" ? spec : null) }));
    const row = checksOf(logs).find((c) => c.name === "pi_operator_login");
    expect(row?.status).toBe("warn");
    expect(row?.fix).toContain("rig config set pi.operator_login_dir");
  });

  it("FIX 1: the host check sends the terminal token, and a 401 reads as a failure naming it, never a pass", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { ok: false, status: 401, json: async () => ({}) };
    };
    const response = await fetchDaemonHostRows(fetchFn, "http://127.0.0.1:7433", { Authorization: "Bearer from-terminal-auth" }, { seatShell: true, runtimes: null });
    expect(calls).toEqual([{ url: "http://127.0.0.1:7433/api/doctor/host", headers: { Authorization: "Bearer from-terminal-auth", "content-type": "application/json" } }]);
    expect(daemonHostRows(response, true)).toEqual([expect.objectContaining({ name: "host_daemon_checks", status: "fail", fix: expect.stringContaining("OPENRIG_TERMINAL_BEARER_TOKEN") })]);
  });

  it("rig setup's checks never start a probe shell", () => {
    const fetchHostRows = vi.fn();
    const { checks, asyncChecks } = runDoctorChecks(makeDeps({ fetchHostRows }));
    expect(checks.some((c) => c.name.startsWith("seat_"))).toBe(false);
    expect(asyncChecks).toHaveLength(3);
    expect(fetchHostRows).not.toHaveBeenCalled();
  });
});

describe("the Pi operator login row", () => {
  const dirs = (paths: Record<string, "dir" | "file">) => localFacts({
    stat: (p) => (paths[p] ? { isFile: paths[p] === "file", isDirectory: paths[p] === "dir", uid: 1000 } : null),
  });
  it("SCOPE: a spec with no Pi seat skips the row even when the setting is set and wrong", () => {
    expect(piOperatorLoginCheck("/does/not/exist", false, dirs({}))).toMatchObject({ status: "skipped", message: "The spec has no Pi seats." });
    expect(piOperatorLoginCheck("/does/not/exist", null, dirs({})).status).toBe("fail");
  });

  it("is skipped for a spec with no Pi seat, and when unset with no spec", () => {
    expect(piOperatorLoginCheck(undefined, false, localFacts()).status).toBe("skipped");
    expect(piOperatorLoginCheck("", null, localFacts()).status).toBe("skipped");
  });
  it("fails a folder that is missing, or that has no auth.json", () => {
    expect(piOperatorLoginCheck("/op", true, dirs({})).status).toBe("fail");
    expect(piOperatorLoginCheck("/op", true, dirs({ "/op": "dir" }))).toMatchObject({ status: "fail" });
    expect(piOperatorLoginCheck("/op", true, dirs({ "/op": "dir", "/op/auth.json": "dir" })).status).toBe("fail");
  });
  it("passes a folder with an auth.json, and reads no file to say so", () => {
    const facts = dirs({ "/op": "dir", "/op/auth.json": "file" });
    const readFile = vi.spyOn(facts, "readFile");
    expect(piOperatorLoginCheck("/op", true, facts).status).toBe("pass");
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("the inotify row", () => {
  /** /proc with two of this user's processes and one of another user's, holding inotify fds with `watches` watches each. */
  function proc(maxWatches: number, watchesPerFd: number) {
    const opened: string[] = [];
    const facts = localFacts({
      readFile: (p) => {
        opened.push(p);
        if (p === "/proc/sys/fs/inotify/max_user_watches") return `${maxWatches}\n`;
        if (p === "/proc/sys/fs/inotify/max_user_instances") return "128\n";
        if (/^\/proc\/\d+\/fdinfo\/\d+$/.test(p)) return `pos:\t0\n${"inotify wd:1 ino:2 sdev:3\n".repeat(watchesPerFd)}`;
        return null;
      },
      readdir: (p) => (p === "/proc" ? ["1", "2", "3", "self", "sys"] : /^\/proc\/\d+\/fd$/.test(p) ? ["0", "5"] : null),
      readlink: (p) => (p.endsWith("/fd/5") ? "anon_inode:inotify" : "pipe:[77]"),
      stat: (p) => ({ isFile: false, isDirectory: true, uid: p === "/proc/3" ? 0 : 1000 }),
    });
    return { facts, opened };
  }
  it("counts this user's watches and instances, never opening an fd", () => {
    const { facts, opened } = proc(1000, 10);
    const row = inotifyHeadroomCheck(facts);
    expect(row).toMatchObject({ status: "pass", message: "inotify headroom: 20 of 1000 watches and 2 of 128 instances in use by this user." });
    expect(opened.filter((p) => /\/fd\/\d+$/.test(p))).toEqual([]);
  });
  it("FIX 2: a process of this user whose fd list or fdinfo cannot be read makes the count unknown, never a pass", () => {
    const base = proc(1000, 1).facts;
    const noFdList = { ...base, readdir: (p: string) => (p === "/proc/2/fd" ? null : base.readdir(p)) };
    expect(inotifyHeadroomCheck(noFdList)).toMatchObject({ status: "skipped" });
    expect(inotifyHeadroomCheck(noFdList).reason).toContain("/proc/2/fd");
    const noFdinfo = { ...base, readFile: (p: string) => (p === "/proc/1/fdinfo/5" ? null : base.readFile(p)) };
    expect(inotifyHeadroomCheck(noFdinfo)).toMatchObject({ status: "skipped" });
    // A process that ended between the listing and the read is not unknown: it holds nothing now.
    // The race as it happens: pid 2 is there when listed, then gone by the time its fd list is read.
    let pid2Stats = 0;
    const ended = {
      ...base,
      readdir: (p: string) => (p === "/proc/2/fd" ? null : base.readdir(p)),
      stat: (p: string) => (p === "/proc/2" ? (++pid2Stats === 1 ? base.stat(p) : null) : base.stat(p)),
    };
    expect(inotifyHeadroomCheck(ended).status).toBe("pass");
    expect(pid2Stats).toBe(2);
  });

  it("warns at 80% of either limit", () => {
    expect(inotifyHeadroomCheck(proc(25, 10).facts).status).toBe("warn");
    expect(inotifyHeadroomCheck(proc(26, 10).facts).status).toBe("pass");
  });
  it("is skipped off Linux and when the limits cannot be read", () => {
    expect(inotifyHeadroomCheck(localFacts({ platform: "darwin" })).status).toBe("skipped");
    expect(inotifyHeadroomCheck(localFacts()).status).toBe("skipped");
  });
});

describe("the git template and remote host rows", () => {
  it("warns, worded for release 3, when a new repository gets no info/exclude", () => {
    const row = gitTemplateCheck(localFacts({ gitTemplateHasExclude: () => false }));
    expect(row.status).toBe("warn");
    expect(row.message).toContain("release 3");
    expect(gitTemplateCheck(localFacts({ gitTemplateHasExclude: () => null })).status).toBe("skipped");
    expect(gitTemplateCheck(localFacts()).status).toBe("pass");
  });
  it("points each registered host at rig host doctor and probes none of them", () => {
    expect(remoteHostsCheck(localFacts({ registeredHosts: () => ({ ids: ["stu", "mbp"] }) }))).toMatchObject({ status: "pass", fix: "rig host doctor stu; rig host doctor mbp" });
    expect(remoteHostsCheck(localFacts({ registeredHosts: () => ({ error: "bad yaml" }) })).status).toBe("fail");
    expect(remoteHostsCheck(localFacts()).status).toBe("skipped");
  });
  it("reads the runtimes a spec's seats use", () => {
    expect(runtimesInSpec({ pods: [{ members: [{ runtime: "pi" }, { runtime: "codex" }, { runtime: "pi" }] }, { members: [{}] }] })).toEqual(["codex", "pi"]);
    expect(runtimesInSpec({})).toBeNull();
  });
});
