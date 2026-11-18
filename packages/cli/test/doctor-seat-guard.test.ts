// workspaces-o9o.173: `rig doctor` says when a running Claude seat's rig-body guard cannot run (its node or guard script is
// gone), so nobody learns of it only when the degraded guard refuses a kill. The seat's command line is built with the
// daemon's own launch code (withRigBodyGuard, claudeRigBodyGuardGroup), so a change to the hook's shape fails here.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import type { SeatProcess } from "../src/seat-process-environments.js";
import { claudeRigBodyGuardGroup, withRigBodyGuard } from "../../daemon/src/adapters/claude-rig-body-guard.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

const HOME = "/home/u/.openrig";
const NODE = "/opt/node-v22/bin/node";
const SCRIPT = "/pkg/daemon/assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs";

function makeDeps(seats: SeatProcess[] | null, present: Set<string>): DoctorDeps {
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
    openrigHome: HOME,
    seatGuardFiles: { isExecutable: (f) => present.has(f), isFile: (f) => present.has(f) },
  };
}
const row = (seats: SeatProcess[] | null, present: string[]) =>
  runDoctorChecks(makeDeps(seats, new Set(present))).checks.find((c) => c.name === "running_seats_guard");

/** A Claude seat's argv as the daemon launches it: one --settings carrying the guard hook (with the given node). */
const claudeArgv = (node: string, script: string, equalsForm = false): string[] => {
  const json = JSON.stringify({ hooks: { PreToolUse: [claudeRigBodyGuardGroup(script, { nodePath: node })] } });
  return equalsForm ? ["claude", "--dangerously-skip-permissions", `--settings=${json}`] : ["claude", "--dangerously-skip-permissions", "--settings", json];
};
const seat = (session: string, argv: string[], home: string | null = HOME): SeatProcess => ({ pid: 10, session, home, path: [], argv });

describe("o9o.173: rig doctor reports a Claude seat whose guard cannot run", () => {
  it("a seat whose guard node is gone is named with the path and the remedy; a seat whose guard can run is not", () => {
    const check = row([seat("down@rig", claudeArgv("/gone/bin/node", SCRIPT)), seat("ok@rig", claudeArgv(NODE, SCRIPT))], [NODE, SCRIPT]);
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("seat guard unavailable on 1 of 2 Claude seats");
    expect(check?.message).toContain("down@rig (missing: node /gone/bin/node)");
    expect(check?.message).not.toContain("ok@rig");
    expect(check?.message).toContain("Relaunch or restore the seat");
  });

  it("a missing guard script is named too, and both when both are gone", () => {
    expect(row([seat("s@rig", claudeArgv(NODE, "/gone/rig-body-guard.cjs"))], [NODE])?.message).toContain("s@rig (missing: guard script /gone/rig-body-guard.cjs)");
    expect(row([seat("s@rig", claudeArgv("/gone/node", "/gone/rig-body-guard.cjs"))], [])?.message)
      .toContain("s@rig (missing: node /gone/node, guard script /gone/rig-body-guard.cjs)");
  });

  it("every Claude seat whose guard can run passes, counting them; the --settings=<json> form is read too", () => {
    expect(row([seat("a@rig", claudeArgv(NODE, SCRIPT)), seat("b@rig", claudeArgv(NODE, SCRIPT, true))], [NODE, SCRIPT]))
      .toMatchObject({ status: "pass", message: expect.stringMatching(/^2 Claude seats of \/home\/u\/\.openrig on this host can run the seat guard/) });
  });

  it("the launch's real argv (withRigBodyGuard, the daemon's own node) is read", () => {
    const argv = withRigBodyGuard(["claude", "--dangerously-skip-permissions"], SCRIPT);
    expect(row([seat("w@rig", argv)], [SCRIPT])?.message).toContain(`w@rig (missing: node ${process.execPath})`);
    expect(row([seat("w@rig", argv)], [SCRIPT, process.execPath])?.status).toBe("pass");
  });

  it("a node path holding a single quote and a space is read back exactly through the launch's shell quoting", () => {
    const quoted = "/opt/it's node/bin/node";
    expect(row([seat("q@rig", claudeArgv(quoted, SCRIPT))], [SCRIPT])?.message).toContain(`q@rig (missing: node ${quoted})`);
    expect(row([seat("q@rig", claudeArgv(quoted, SCRIPT))], [SCRIPT, quoted])?.status).toBe("pass");
  });

  it("no Claude seat with the guard (a Codex or Pi seat, a shell), or a platform it cannot read, is skipped with the reason, never a pass", () => {
    expect(row([seat("codex@rig", ["codex", "--yolo"]), seat("sh@rig", ["/bin/zsh"])], [])).toMatchObject({ status: "skipped", message: expect.stringContaining("no Claude seat") });
    expect(row(null, [])).toMatchObject({ status: "skipped", message: expect.stringContaining("/proc") });
  });

  it("only this instance's seats count: a test scaffold's seat with its own OPENRIG_HOME is not judged", () => {
    expect(row([seat("scaffold@rig", claudeArgv("/gone/node", SCRIPT), "/tmp/scaffold/.openrig")], [])?.status).toBe("skipped");
  });
});

const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill("SIGKILL"); });

describe.runIf(process.platform === "linux")("o9o.173: the seat's command line is read from /proc (Linux)", () => {
  it("a real process carrying OPENRIG_SESSION_NAME and a guard --settings whose script is gone is reported", async () => {
    const session = `o9o173-${process.pid}@probe`;
    const json = JSON.stringify({ hooks: { PreToolUse: [claudeRigBodyGuardGroup("/gone/o9o173/rig-body-guard.cjs", { nodePath: process.execPath })] } });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--settings", json], {
      env: { ...process.env, OPENRIG_SESSION_NAME: session, OPENRIG_HOME: HOME }, stdio: "ignore",
    });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    // workspaces-o9o.185: the real /proc reader, given only this test's own child (never the rest of the host).
    const { readSeatProcesses } = await import("../src/seat-process-environments.js");
    const deps = makeDeps(null, new Set());
    deps.readSeatProcesses = () => readSeatProcesses({ pids: [child.pid!] });
    deps.seatGuardFiles = { isExecutable: (f) => f === process.execPath, isFile: (f) => f === process.execPath };
    const check = runDoctorChecks(deps).checks.find((c) => c.name === "running_seats_guard");
    expect(check?.message).toContain(`${session} (missing: guard script /gone/o9o173/rig-body-guard.cjs)`);
  });
});
