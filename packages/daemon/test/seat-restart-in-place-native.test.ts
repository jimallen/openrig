// OPR.0.7.0.5 — native harness for the in-place restart: terminals on a PRIVATE hc core (helpers/hc-scratch.ts: own HOME,
// HC_SESSION and XDG paths, a verified stop at the end), a compiled stub `codex` (no real Codex, no account, no credentials),
// the REAL CodexRuntimeAdapter, the REAL HcAdapter, and the production route factory with its default process and /proc
// readers. Both pane shapes.
//
// Isolation: every seat is a terminal of the test's own core, torn down by name and then by the verified stop of that core;
// stub processes are killed by pid at the end. Skips without hc, a C compiler, or Linux /proc.
//
// What hc changes (design-hc-cutover §3 gap 5): there is no pane to respawn. A restart of a direct-native seat is kill, then
// run again under the same name and labels, so the terminal's ADDRESS changes and the binding follows the label, and the
// original's output stays readable at the old address as a finished terminal, not above the successor's. A shell-backed seat
// keeps its terminal and its shell, as it kept its pane. There is no pane-local `remain-on-exit` to put back: a finished hc
// terminal stays readable until removed.
//
// The real Codex must be unreachable (an earlier version of this harness let a login shell's profile put
// the installed Codex first on PATH). So: every terminal process starts NON-login from `env -i` with an
// explicit PATH/HOME/CODEX_HOME; CODEX_HOME is the test's temp dir and asserted not to be ~/.codex;
// every launch goes through the adapter's pinned launch PATH; and a check INSIDE the terminal fails closed
// (prints PREFLIGHT-REFUSED, starts nothing) unless `codex` resolves to the stub there.
//
// Roots are given to `terminal.run` as separate argv words, so hc execs them directly: no outer shell sits
// between the core and the terminal's root process on images whose shell doesn't exec a lone `-c` command.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { sessionEnvLabels } from "../src/adapters/hc-identity.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TOKEN = "019a0000-0000-7000-8000-00000000c0de";

function available(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v cc"], { stdio: "ignore" });
    return findHc() !== null && fs.existsSync("/proc/self/environ");
  } catch { return false; }
}

// Made only where the harness can run, so a skipped run leaves no empty folder behind.
const runnable = available();
const root = runnable ? fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-restart-native-")) : nodePath.join(os.tmpdir(), "openrig-restart-native-unused");
let core: HcScratch | undefined;
const scratch = (): HcScratch => (core ??= startHcScratch());
const host = (): HcAdapter => new HcAdapter(scratch().client());
const terminalOf = (seat: string) => scratch().client().call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });

const STUB_C = `
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
static void bye(int s) { (void)s; _exit(0); }
int main(int argc, char **argv) {
  signal(SIGTERM, bye);
  if (!getenv("STUB_QUIET")) for (int i = 1; i <= 40; i++) printf("history line %d from pid %d\\n", i, (int)getpid());
  printf("OpenAI Codex (v0.0.0-stub)\\nstub conversation %s pid %d\\n\\n\\xe2\\x80\\xba \\n", argc > 1 ? argv[argc - 1] : "?", (int)getpid());
  fflush(stdout);
  for (;;) pause();
}
`;

const sessions: string[] = [];
const pids = new Set<number>();
afterAll(async () => {
  if (!runnable) return;
  for (const name of sessions) await host().killSession(name).catch(() => {});
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  // Then this run's own core, stopped and verified gone before its directory goes (a failure keeps both).
  core?.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

async function panePid(pane: string): Promise<number> {
  return (await host().getPanePid(pane)) ?? Number.NaN;
}
/** Running stub processes, by their executable path (never by matching command text). */
function stubPids(): number[] {
  const stub = nodePath.join(root, "bin", "codex");
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    try { return fs.readlinkSync(`/proc/${entry}/exe`) === stub ? [Number(entry)] : []; } catch { return []; }
  });
}

describe.runIf(runnable)("in-place restart, native (private hc core, stub codex)", () => {
  const bin = nodePath.join(root, "bin");
  const home = nodePath.join(root, "codex-home");
  const work = nodePath.join(root, "work");
  const launchPath = `${bin}:/usr/bin:/bin`;

  async function setup(shape: "shell_backed" | "direct_native" | "script_backed", opts: { running?: { networkOverride: boolean; daemonOptOut: boolean; addDirs: string[] }; quiet?: boolean; prelude?: string;
    /** Shell-backed: type the launch the way OpenRig does (the host adapter's staged `/bin/sh <script>`). */
    staged?: boolean;
    /** Start the Codex by hand, without the flag a managed launch carries. */
    withoutDaemonFlag?: boolean;
    /** The daemon's delivery guard on this adapter, as startup.ts sets it. */
    guarded?: boolean } = {}) {
    // One seat at a time: end the previous test's session and wait for its stub to exit.
    for (const name of sessions) await host().killSession(name).catch(() => {});
    for (let i = 0; i < 50 && stubPids().length > 0; i++) await sleep(100);
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    if (!fs.existsSync(nodePath.join(bin, "codex"))) {
      fs.writeFileSync(nodePath.join(root, "codex.c"), STUB_C);
      execFileSync("cc", ["-o", nodePath.join(bin, "codex"), nodePath.join(root, "codex.c")]);
    }
    const stub = nodePath.join(bin, "codex");
    const resolved = execFileSync("/bin/sh", ["-c", "command -v codex"], { env: { PATH: launchPath }, encoding: "utf8" }).trim();
    if (resolved !== stub) throw new Error(`Refusing to run: codex on the pinned PATH is ${resolved}, not the stub.`);
    expect(home).not.toBe(nodePath.join(os.homedir(), ".codex"));
    const seat = `dev-codex@${shape === "shell_backed" ? "shell" : shape === "script_backed" ? "script" : "native"}-rig`;
    sessions.push(seat);
    // The shared fixture leaves out the guard's tables, so a guarded seat runs on the whole schema.
    const db = opts.guarded ? new Database(":memory:") : createFullTestDb();
    if (opts.guarded) migrate(db, ALL_MIGRATIONS);
    const realTmux = host();
    if (opts.guarded) realTmux.deliveryGuard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    const adapter = new CodexRuntimeAdapter({
      tmux: realTmux, launchPath, detectDaemonSupport: async () => ({ kind: "supported" }),
      fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), writeFile: () => {}, exists: (p) => fs.existsSync(p), mkdirp: () => {}, homedir: root },
    });
    const setupApp = createTestApp(db, { tmux: realTmux, adapters: { codex: adapter },
      appDeps: { seatActivityService: { getSeatState: () => ({ seatNodeId: "", activity: "working", needsInput: { count: 0, reason: null },
        needsInputEvidence: null, decidedBy: null, seq: 1, changedAt: "", rungs: [], lastSwap: null }) } as never } });
    const rig = setupApp.rigRepo.createRig(seat.split("@")[1]!);
    const node = setupApp.rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex", cwd: work });
    const session = setupApp.sessionRegistry.registerSession(node.id, seat);
    setupApp.sessionRegistry.updateStatus(session.id, "running");
    setupApp.sessionRegistry.updateResumeToken(session.id, "codex_id", TOKEN, "scrape");

    // The running Codex starts with exactly the flags the seat's managed relaunch composes.
    const override = new NativePermissionStore(db).launchOverride(node.id, "codex");
    const built = await adapter.buildResumeCommand({
      id: "", nodeId: node.id, attachmentType: "hc", tmuxSession: seat, tmuxWindow: null, tmuxPane: null,
      updatedAt: "", cwd: work, launchPosture: "floor",
      kernelAuthority: override.kernelAuthority, teamPermissionDefault: override.teamPermissionDefault,
      nonInterruptive: setupApp.rigRepo.getRigNonInterruptive(rig.id),
    }, { name: seat, resumeToken: TOKEN, ...(opts.running ? { running: opts.running } : {}) });
    if (!built.ok) throw new Error(built.error);
    // The terminal's processes start from env -i, non-login: nothing of the core's or the test's environment reaches them.
    const cleanStart = ["env", "-i", `PATH=${launchPath}`, `HOME=${root}`, `CODEX_HOME=${home}`, "TERM=screen", ...(opts.quiet ? ["STUB_QUIET=1"] : []), "/bin/sh"];
    const preflight = `[ "$(command -v codex)" = ${q(stub)} ] && [ "$CODEX_HOME" = ${q(home)} ]`;
    // A seat's terminal named and labelled as the host names one (the launch environment it records is the "session env" the
    // restart reads back, as `-e CODEX_HOME=...` was on the tmux session), with the root process this harness chooses.
    const startTerminal = (argv: string[]) => scratch().client().call("terminal.run", {
      argv, name: hcTerminalName(seat), labels: { ...sessionEnvLabels({ CODEX_HOME: home }), [SEAT_LABEL]: seat }, cwd: work,
      no_parent: true, no_notify: true, outlive_parent: true,
    });
    if (shape === "script_backed") {
      // OF-200: the launch as the daemon makes it for an hc seat: a shell terminal first, then OpenRig's staged script REPLACES that shell
      // (`exec /bin/sh <script>`), so the script is the terminal's own process and the stub is its child.
      await startTerminal(cleanStart);
      await sleep(200);
      const sent = await realTmux.sendShellCommand(seat, `${preflight} && ${built.command} || echo PREFLIGHT-REFUSED`, undefined, { asTerminalProgram: true });
      if (!sent.ok) throw new Error(sent.message);
    } else if (shape === "shell_backed") {
      await startTerminal(cleanStart);
      await sleep(200);
      const command = opts.withoutDaemonFlag ? built.command.replace(" --no-daemon", "") : built.command;
      const launch = `${opts.prelude ?? ""}${preflight} && ${command} || echo PREFLIGHT-REFUSED`;
      if (opts.staged) {
        const sent = await realTmux.sendShellCommand(seat, launch);
        if (!sent.ok) throw new Error(sent.message);
      } else {
        await scratch().client().call("terminal.send", { terminal: hcTerminalName(seat), text: launch });
      }
    } else {
      const script = `${preflight} || { echo PREFLIGHT-REFUSED; exec sleep 30; }; exec ${built.command}`;
      await startTerminal([...cleanStart, "-c", script]);
    }
    await sleep(500);
    const refused = ((await realTmux.capturePaneContent(seat, 200)) ?? "").split("\n").some((line) => line.trim() === "PREFLIGHT-REFUSED");
    expect(refused, "the in-terminal preflight found the stub and the temp CODEX_HOME").toBe(false);
    const pane = (await terminalOf(seat)).address;
    setupApp.sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: pane });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids(), "exactly one stub codex, started by the terminal").toHaveLength(1);
    const post = async (route: string, body: Record<string, unknown> = {}) => {
      const res = await setupApp.app.request(`/api/seat/${route}/${encodeURIComponent(seat)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    return { seat, pane, post, seatHost: realTmux };
  }

  it("shell-backed: the same conversation resumes in the same terminal under the same shell, with the running choices", async () => {
    const dirs = [nodePath.join(root, "shared-one"), nodePath.join(root, "shared-two")];
    const { seat, pane, post } = await setup("shell_backed", { running: { networkOverride: true, daemonOptOut: true, addDirs: dirs } });
    const shellBefore = await panePid(pane);
    const [oldStub] = stubPids();

    const plan = await post("restart-plan");
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ planOnly: true, paneShape: "shell_backed", conversationProof: "argv",
      activity: { state: "working" }, codexHome: home, childProcesses: [], oldProcess: { pid: oldStub } });

    const result = await post("restart", { reason: "native harness", operator: "test@rig" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", pane, oldProcess: { pid: oldStub },
      newProcess: { sameExecutable: true } });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids(), "only the replacement stub runs").toEqual([result.body.newProcess.pid]);
    expect(result.body.newProcess.pid).not.toBe(oldStub);
    expect(await panePid(pane), "same terminal shell").toBe(shellBefore);
    const screen = (await host().capturePaneContent(pane, 300)) ?? "";
    expect(screen, "the original's output stays in the terminal").toContain(`from pid ${oldStub}`);
    expect(screen).toContain(`stub conversation ${TOKEN} pid ${result.body.newProcess.pid}`);
    expect((await terminalOf(seat)).address, "the seat's terminal is the same one").toBe(pane);
    // #1196 r2 F1: the replacement runs with the old process's --no-daemon, network override and add-dirs.
    const newArgv = fs.readFileSync(`/proc/${result.body.newProcess.pid}/cmdline`, "utf8").split("\0");
    expect(newArgv).toContain("--no-daemon");
    expect(newArgv).toContain("sandbox_workspace_write.network_access=true");
    expect(newArgv.filter((_, index) => newArgv[index - 1] === "--add-dir")).toEqual(dirs);

    const verified = await post("restart-verify", {});
    expect(verified.body).toMatchObject({ ok: true, outcome: "restarted_account_unverified", accountEvidence: { state: "not_requested" } });
  }, 60_000);

  it("a Codex launched the way OpenRig launches it (staged sh script), restarted twice in the same terminal", async () => {
    const { pane, post } = await setup("shell_backed", { staged: true });
    const shell = await panePid(pane);
    const [oldStub] = stubPids();
    const parentOf = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    const script = parentOf(oldStub!);
    expect(script, "a staged script sits between the shell and Codex").not.toBe(shell);
    expect(parentOf(script)).toBe(shell);
    expect(fs.readFileSync(`/proc/${script}/cmdline`, "utf8")).toMatch(/openrig-tmux-send-\d+-[0-9a-f-]+\.txt/);

    for (const round of [1, 2]) {
      const plan = await post("restart-plan");
      expect(plan.body, `round ${round}: ${JSON.stringify(plan.body)}`).toMatchObject({ ok: true, paneShape: "shell_backed" });
      const result = await post("restart", { reason: `native harness staged round ${round}` });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", pane, paneShape: "shell_backed" });
      for (const pid of stubPids()) pids.add(pid);
      expect(stubPids(), `round ${round}: only the replacement stub runs`).toEqual([result.body.newProcess.pid]);
      expect(await panePid(pane), "same terminal shell").toBe(shell);
    }
  }, 90_000);

  it("script-backed (OF-200): a Codex launched as its terminal's program is the staged script's child; the restart stops Codex, the terminal ends, and the resume is the new terminal's program", async () => {
    const { seat, pane, post } = await setup("script_backed");
    const [oldStub] = stubPids();
    const parentOf = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    const script = parentOf(oldStub!);
    expect(script, "OpenRig's staged script is the terminal's own process: no login shell is above Codex").toBe((await terminalOf(seat)).pid);
    expect(fs.readFileSync(`/proc/${script}/cmdline`, "utf8")).toMatch(/openrig-tmux-send-\d+-[0-9a-f-]+\.txt/);

    const plan = await post("restart-plan");
    expect(plan.body, JSON.stringify(plan.body)).toMatchObject({ ok: true, planOnly: true, paneShape: "script_backed", pane, oldProcess: { pid: oldStub } });
    const result = await post("restart", { reason: "native harness script-backed" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", paneShape: "script_backed", oldProcess: { pid: oldStub } });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids(), "only the replacement stub runs").toEqual([result.body.newProcess.pid]);
    expect(result.body.newProcess.pid).not.toBe(oldStub);
    expect((await scratch().client().call<HcTerminal>("terminal.get", { terminal: pane })).state, "the first terminal ended with its Codex").toBe("finished");
    const now = await terminalOf(seat);
    expect(now.state).toBe("live");
    expect(now.address, "a respawn mints a new address; the binding follows the label").not.toBe(pane);
    expect(result.body.pane).toBe(now.address);
    const screen = (await host().capturePaneContent(seat, 300)) ?? "";
    expect(screen).toContain(`stub conversation ${TOKEN} pid ${result.body.newProcess.pid}`);
    // The seat is reachable by the next restart: the replacement is a direct-native pane now.
    const again = await post("restart", { reason: "native harness script-backed round 2" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ outcome: "restarted_account_unverified" });
    for (const pid of stubPids()) pids.add(pid);
  }, 90_000);

  it("security review N1: a Codex running without --no-daemon is not restarted in place on hc, and nothing is stopped", async () => {
    const { pane, post } = await setup("shell_backed", { withoutDaemonFlag: true });
    const [oldStub] = stubPids();
    expect(fs.readFileSync(`/proc/${oldStub}/cmdline`, "utf8").split("\0"), "the fixture really started it without the flag").not.toContain("--no-daemon");
    const result = await post("restart", { reason: "native harness N1" });
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body).toMatchObject({ ok: false, code: "relaunch_unavailable" });
    expect(String(result.body.message)).toMatch(/running without --no-daemon.*Nothing was stopped/s);
    expect(stubPids(), "the same Codex still runs").toEqual([oldStub]);
    expect((await terminalOf(`dev-codex@shell-rig`)).address).toBe(pane);
  }, 60_000);

  it("security review N3: with the delivery guard on, the route's lease carries the signal and the respawn through both pane shapes", async () => {
    const shell = await setup("shell_backed", { guarded: true });
    const [oldShellStub] = stubPids();
    const restarted = await shell.post("restart", { reason: "native harness guarded" });
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    expect(restarted.body).toMatchObject({ outcome: "restarted_account_unverified", pane: shell.pane });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids()).toEqual([restarted.body.newProcess.pid]);
    expect(restarted.body.newProcess.pid).not.toBe(oldShellStub);

    const native = await setup("direct_native", { guarded: true });
    const before = await panePid(native.pane);
    const direct = await native.post("restart", { reason: "native harness guarded" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    expect(direct.body).toMatchObject({ outcome: "restarted_account_unverified", paneShape: "direct_native" });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids()).toEqual([direct.body.newProcess.pid]);
    expect(direct.body.newProcess.pid).not.toBe(before);
    expect((await terminalOf(native.seat)).address, "a direct-native restart moves the address").not.toBe(native.pane);
    // Whatever the binding says now, the next ordinary stop through the guard must still end the seat.
    await expect(native.seatHost.killSession(native.seat)).resolves.toEqual({ ok: true });
  }, 90_000);

  it("direct-native: killed and run again under the same name; the original's output stays readable at its old address", async () => {
    const { seat, pane, post } = await setup("direct_native");
    const before = await panePid(pane);
    expect(stubPids(), "the terminal's own process is the stub").toEqual([before]);
    const result = await post("restart", { reason: "native harness" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", paneShape: "direct_native" });
    expect(result.body.paneHeld).toBeUndefined();
    for (const pid of stubPids()) pids.add(pid);
    const now = await terminalOf(seat);
    expect(now.state, "the seat's name answers with a live terminal").toBe("live");
    expect(now.labels[SEAT_LABEL]).toBe(seat);
    expect(now.address, "a respawn mints a new address (no pane to keep)").not.toBe(pane);
    const after = now.pid!;
    expect(after).not.toBe(before);
    // The replacement is the new terminal's root, or its child where the image's sh doesn't exec a lone
    // command (review-r2's dash): compare with the reported process, and tie it to the terminal separately.
    const replacement = result.body.newProcess.pid as number;
    expect(stubPids(), "only the replacement stub runs").toEqual([replacement]);
    const parent = Number(fs.readFileSync(`/proc/${replacement}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    expect([replacement, parent], "the replacement is the new terminal's root or its direct child").toContain(after);
    // The successor's screen starts clean; the original's output is kept at the old address, as a finished terminal.
    const screen = (await host().capturePaneContent(now.address, 300)) ?? "";
    expect(screen).toContain(`stub conversation ${TOKEN} pid ${replacement}`);
    expect(screen, "the original's output is not above the successor's").not.toContain(`from pid ${before}`);
    const old = await scratch().client().call<HcTerminal>("terminal.get", { terminal: pane });
    expect(old.state, "the original's terminal is finished, not removed").toBe("finished");
    expect((await host().capturePaneContent(pane, 300)) ?? "", "the original's scrollback stays readable at its old address").toContain(`from pid ${before}`);
  }, 60_000);

  it("#1196 r2 F3: an Account line already below the cursor, untouched by the restart, is not account evidence", async () => {
    // review-r2's case: the line sits on row 25, the cursor is moved to the top, and the restart's output
    // stays above it, so the frame keeps the line in place across the restart.
    const prelude = `printf '\\033[2J\\033[25;1H%s: %s\\033[1;1H' Account me@example.com; `;
    const { pane, post } = await setup("shell_backed", { quiet: true, prelude });
    const before = ((await host().capturePaneScreen(pane)) ?? "").split("\n");
    expect(before[24], "the old Account line is on row 25 before the restart").toBe("Account: me@example.com");
    const result = await post("restart", { reason: "native harness F3" });
    expect(result.body, JSON.stringify(result.body)).toMatchObject({ outcome: "restarted_account_unverified" });
    for (const pid of stubPids()) pids.add(pid);
    const after = ((await host().capturePaneScreen(pane)) ?? "").split("\n");
    expect(after[24], "the same line is still on row 25 after the restart").toBe("Account: me@example.com");
    // tmux asked the cursor row; hc states a cursor only in a full-screen app's first paint (measured: null for this positioned
    // line on the primary screen), so the same fact is read off the screen: the restart's own output sits above the old line.
    const outputRow = after.findIndex((line) => line.includes("stub conversation"));
    expect(outputRow, "the restart's output is on the screen, above the old line").toBeGreaterThanOrEqual(0);
    expect(outputRow, "the restart's output is above the old line").toBeLessThan(24);
    const verified = await post("restart-verify", { expectAccount: "me@example.com" });
    expect(verified.body).toMatchObject({ ok: true, outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  }, 60_000);
});
