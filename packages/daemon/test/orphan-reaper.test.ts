// Test processes that outlive their suite: a tmux server and a detached scenario daemon each ran for a day or more on a
// shared build host after their temp home was deleted, because the run that started them was killed, timed out, or had
// its stop failure swallowed before teardown. These rows start real processes (sleep, tmux) of their own and prove the
// watchdog, the identity checks and the stop escalation leave none behind and aim no signal at anyone else's process.
// Nothing here touches another process, a default tmux socket, a real daemon or ~/.openrig.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { processAlive, reapWhenOwnerDies, stopOwnedTmuxServer, tmuxServerPid, waitGone } from "./helpers/orphan-reaper.js";
import { spawnScenarioDaemon } from "./helpers/scenario-daemon.js";

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

let counter = 0;
function longSleeper(extraEnv: Record<string, string> = {}): number {
  const child = spawn("/bin/sh", ["-c", "sleep 600"], { detached: true, stdio: "ignore", env: { ...process.env, ...extraEnv } });
  child.unref();
  const pid = child.pid!;
  cleanups.push(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } });
  return pid;
}
const uniqueEntry = () => `A6_REAPER_FIXTURE=${process.pid}-${Date.now()}-${++counter}`;
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-reaper-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function tmuxFixture() {
  const dir = tempDir(), socket = path.join(dir, "tmux");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TMPDIR: dir };
  delete env.TMUX;
  cleanups.push(() => { try { execFileSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore", timeout: 5000 }); } catch { /* gone */ } });
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "a", "sleep 600"], { env });
  const serverPid = Number(execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, encoding: "utf8" }).trim());
  cleanups.push(() => { try { process.kill(serverPid, "SIGKILL"); } catch { /* gone */ } });
  return { dir, socket, env, serverPid };
}

describe("reapWhenOwnerDies", () => {
  it("stops the processes carrying the listed environment entry once the owner is killed, and only those", async () => {
    const entry = uniqueEntry();
    const owner = longSleeper(), victim = longSleeper({ [entry.split("=")[0]!]: entry.split("=")[1]! });
    const bystander = longSleeper(), lookalike = longSleeper({ [entry.split("=")[0]!]: entry.split("=")[1]! + "-other" });
    const reaper = reapWhenOwnerDies({ ownerPid: owner, environ: [entry] });
    cleanups.push(() => reaper.disarm());
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the watchdog has polled at least once
    expect(processAlive(victim), "positive control: owner alive, victim untouched").toBe(true);
    process.kill(owner, "SIGKILL");
    expect(await waitGone(victim, 30_000), "victim stopped after the owner died").toBe(true);
    expect(processAlive(bystander), "a process without the entry is never touched").toBe(true);
    expect(processAlive(lookalike), "a process whose value merely extends the entry is never touched").toBe(true);
  }, 60_000);

  it("a disarmed watchdog does nothing when the owner later dies", async () => {
    const entry = uniqueEntry();
    const owner = longSleeper(), victim = longSleeper({ [entry.split("=")[0]!]: entry.split("=")[1]! });
    reapWhenOwnerDies({ ownerPid: owner, environ: [entry] }).disarm();
    process.kill(owner, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 3500)); // longer than the watchdog's poll plus its grace
    expect(processAlive(victim)).toBe(true);
  }, 30_000);

  it.skipIf(!hasTmux)("stops the tmux server on the listed socket once the owner is killed", async () => {
    const { socket, serverPid } = tmuxFixture(), owner = longSleeper();
    const reaper = reapWhenOwnerDies({ ownerPid: owner, tmuxSockets: [socket] });
    cleanups.push(() => reaper.disarm());
    expect(processAlive(serverPid), "positive control: the server runs").toBe(true);
    process.kill(owner, "SIGKILL");
    expect(await waitGone(serverPid, 30_000), "tmux server stopped after the owner died").toBe(true);
  }, 60_000);
});

describe.skipIf(!hasTmux)("stopOwnedTmuxServer", () => {
  it("leaves no server and no session shell behind, and treats a positively absent server as nothing to stop", async () => {
    const { socket, env, serverPid } = tmuxFixture();
    expect(processAlive(serverPid), "positive control").toBe(true);
    await stopOwnedTmuxServer(socket, env, { pid: serverPid });
    expect(processAlive(serverPid)).toBe(false);
    expect(await tmuxServerPid(socket, env), "tmux itself says there is no server").toBeNull();
    await stopOwnedTmuxServer(socket, env); // idempotent
  }, 60_000);

  it("a starved (SIGSTOPped) server is still stopped, by pid, when kill-server cannot answer", async () => {
    const { socket, env, serverPid } = tmuxFixture();
    process.kill(serverPid, "SIGSTOP");
    await stopOwnedTmuxServer(socket, env, { pid: serverPid, commandTimeoutMs: 500, graceMs: 500 });
    expect(processAlive(serverPid)).toBe(false);
  }, 60_000);

  it("a pid lookup that times out on a live server throws instead of reporting it stopped", async () => {
    const { socket, env, serverPid } = tmuxFixture();
    // A 1 ms bound cannot be met by starting a tmux client at all: the timeout path, against a perfectly healthy server.
    await expect(stopOwnedTmuxServer(socket, env, { commandTimeoutMs: 1, graceMs: 300 })).rejects.toThrow(/cannot be verified stopped/);
    expect(processAlive(serverPid), "the live server was not declared stopped").toBe(true);
  }, 60_000);

  it("a pid lookup that cannot get an answer from a starved server throws instead of reporting it stopped", async () => {
    const { socket, env, serverPid } = tmuxFixture();
    process.kill(serverPid, "SIGSTOP");
    await expect(stopOwnedTmuxServer(socket, env, { commandTimeoutMs: 300, graceMs: 300 })).rejects.toThrow(/cannot be verified stopped/);
    expect(processAlive(serverPid), "the unverified server was not declared stopped (the caller keeps its watchdog and directory)").toBe(true);
    process.kill(serverPid, "SIGCONT");
    await stopOwnedTmuxServer(socket, env, { pid: serverPid }); // once it answers again, the verified stop works
    expect(processAlive(serverPid)).toBe(false);
  }, 60_000);
});

describe("scenario daemon stop", () => {
  // A stand-in `rig`: `daemon start` spawns a detached long-lived process (it inherits the scaffold's environment, as the real
  // daemon does), optionally records it in the scratch home's daemon.json the way the real CLI does, and optionally exits 1;
  // `daemon stop` succeeds without stopping anything (the swallowed-failure case).
  function fakeRig(dir: string, mode: { ignoreTerm?: boolean; failStart?: boolean; writeState?: boolean; statePid?: number }): { bin: string; pidFile: string } {
    const bin = path.join(dir, "fake-rig.cjs"), pidFile = path.join(dir, "victim.pid");
    fs.writeFileSync(bin, `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const [a, b] = process.argv.slice(2);
if (a === "daemon" && b === "start") {
  const child = spawn("/bin/sh", ["-c", ${JSON.stringify(mode.ignoreTerm ? "trap '' TERM; while :; do sleep 1; done" : "sleep 600")}], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  ${mode.writeState === false ? "" : `fs.writeFileSync(path.join(process.env.OPENRIG_HOME, "daemon.json"), JSON.stringify({ pid: ${mode.statePid ?? "child.pid"}, port: 1 }));`}
  ${mode.failStart ? "process.exit(1);" : ""}
}
`);
    return { bin, pidFile };
  }
  const killGroup = (pid: number) => cleanups.push(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });

  it("a killed runner (no teardown) leaves no daemon behind: the helper's watchdog stops the daemon it started", async () => {
    const dir = tempDir();
    const { bin, pidFile } = fakeRig(dir, {});
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/scenario-daemon-orphan-child.ts", import.meta.url)), bin],
      { stdio: ["ignore", "pipe", "inherit"] });
    cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    let root = "";
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const m = /READY (\S+)/.exec(out);
        if (m) { root = m[1]!; resolve(); }
      });
      child.once("exit", (code) => reject(new Error(`fixture exited ${code} before READY`)));
    });
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    killGroup(pid);
    expect(processAlive(pid), "positive control: the daemon runs while its runner lives").toBe(true);
    child.kill("SIGKILL");
    expect(await waitGone(pid, 60_000), "daemon stopped after its runner was killed").toBe(true);
  }, 120_000);

  for (const ignoreTerm of [false, true]) {
    it(`leaves no daemon behind when \`rig daemon stop\` does not stop it${ignoreTerm ? " and it ignores SIGTERM" : ""}`, async () => {
      const dir = tempDir();
      const { bin, pidFile } = fakeRig(dir, { ignoreTerm });
      const scaffold = prepareHermeticEnv();
      cleanups.push(() => scaffold.cleanup());
      const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 });
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      killGroup(pid);
      expect(processAlive(pid), "positive control: the fake daemon runs before stop").toBe(true);
      await daemon.stop();
      expect(processAlive(pid)).toBe(false);
      expect(fs.existsSync(scaffold.root), "the scaffold is still removed").toBe(false);
    }, 60_000);
  }

  for (const writeState of [true, false]) {
    it(`a \`rig daemon start\` that fails after detaching the daemon (${writeState ? "daemon.json written" : "no daemon.json"}) leaves no daemon behind`, async () => {
      const dir = tempDir();
      const { bin, pidFile } = fakeRig(dir, { failStart: true, writeState });
      const scaffold = prepareHermeticEnv();
      cleanups.push(() => scaffold.cleanup());
      await expect(spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 })).rejects.toThrow(/failed to start/);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      killGroup(pid);
      expect(processAlive(pid), "the daemon detached by the failed start is stopped").toBe(false);
    }, 60_000);
  }

  it("never signals a process that daemon.json names but that is not this scaffold's (a stale or reused pid)", async () => {
    const dir = tempDir();
    const bystander = longSleeper();
    const { bin } = fakeRig(dir, { statePid: bystander });
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 });
    killGroup(Number(fs.readFileSync(path.join(dir, "victim.pid"), "utf8")));
    await daemon.stop();
    expect(processAlive(bystander), "the unrelated process named by daemon.json survived stop()").toBe(true);
  }, 60_000);
});
