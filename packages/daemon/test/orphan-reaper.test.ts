// Test processes that outlive their suite: a tmux server and a detached scenario daemon each ran for a day or more on a
// shared build host after their temp home was deleted, because the run that started them was killed, timed out, or had
// its stop failure swallowed before teardown. These rows start real processes (sleep, tmux) of their own and prove the
// watchdog, the recorded-identity checks and the stop escalation leave none behind and aim no signal at anyone else's
// process. Identity is pid + start time + command (ps), which works on Linux and macOS; nothing here reads another
// process's environment except the explicitly Linux-only rows. Nothing here touches another process, a default tmux
// socket, a real daemon or ~/.openrig.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import {
  hasProcFs, identityOf, processAlive, reapWhenOwnerDies, sameProcess, stopOwnedTmuxServer, terminateIdentified, tmuxServerPid, waitGone,
} from "./helpers/orphan-reaper.js";
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
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-reaper-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const identity = (pid: number) => { const id = identityOf(pid); if (id === null) throw new Error(`no identity for pid ${pid}`); return id; };
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
/** Pids of watchdogs mentioning `needle` (their argument list carries it); null when pgrep finds none. */
function watchdogsFor(needle: string): number[] {
  try { return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; }
}

describe("recorded process identity", () => {
  it("matches the live process and nothing else: a reused pid, a different command or a dead process do not match", async () => {
    const pid = longSleeper();
    const id = identity(pid);
    expect(sameProcess(id), "positive control").toBe(true);
    expect(sameProcess({ ...id, started: id.started + " x" }), "same pid, other start time (a reused pid)").toBe(false);
    expect(sameProcess({ ...id, command: id.command + " x" }), "same pid, other command").toBe(false);
    process.kill(-pid, "SIGKILL");
    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(sameProcess(id), "dead").toBe(false);
  }, 30_000);

  it("terminateIdentified signals only a pid that is still the recorded process", async () => {
    const reused = longSleeper(), real = longSleeper();
    const survivors = await terminateIdentified([{ ...identity(reused), started: "Thu Jan  1 00:00:00 1970" }, identity(real)], 300);
    expect(survivors, "nothing recorded survives").toEqual([]);
    expect(await waitGone(real, 10_000), "the recorded process was stopped (and reaped by its parent)").toBe(true);
    expect(processAlive(reused), "a pid whose start time no longer matches was not signalled").toBe(true);
  }, 30_000);
});

describe("reapWhenOwnerDies", () => {
  it("stops the recorded process once the owner is killed, and nothing else: not a bystander, not a reused pid", async () => {
    const owner = longSleeper(), victim = longSleeper(), bystander = longSleeper(), reused = longSleeper();
    const recordedReused = { ...identity(reused), started: "Thu Jan  1 00:00:00 1970" }; // the pid is right, the process is not the recorded one
    const reaper = reapWhenOwnerDies({ ownerPid: owner, identities: [identity(victim), recordedReused] });
    cleanups.push(() => reaper.disarm());
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the watchdog has polled at least once
    expect(processAlive(victim), "positive control: owner alive, victim untouched").toBe(true);
    process.kill(owner, "SIGKILL");
    expect(await waitGone(victim, 30_000), "victim stopped after the owner died").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(processAlive(bystander), "an unlisted process is never touched").toBe(true);
    expect(processAlive(reused), "a pid whose start time no longer matches the record is never touched").toBe(true);
  }, 60_000);

  it("a disarmed watchdog does nothing when the owner later dies", async () => {
    const owner = longSleeper(), victim = longSleeper();
    reapWhenOwnerDies({ ownerPid: owner, identities: [identity(victim)] }).disarm();
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

  it.skipIf(!hasProcFs())("Linux: stops processes carrying the listed environment entry, and only those", async () => {
    const entry = `A6_REAPER_FIXTURE=${process.pid}-${Date.now()}-${++counter}`;
    const [name, value] = entry.split("=") as [string, string];
    const owner = longSleeper(), victim = longSleeper({ [name]: value }), lookalike = longSleeper({ [name]: value + "-other" }), bystander = longSleeper();
    const reaper = reapWhenOwnerDies({ ownerPid: owner, environ: [entry] });
    cleanups.push(() => reaper.disarm());
    process.kill(owner, "SIGKILL");
    expect(await waitGone(victim, 30_000)).toBe(true);
    expect(processAlive(lookalike) && processAlive(bystander), "a longer value and an unmarked process are never touched").toBe(true);
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

  it("a pid lookup that fails for any reason other than \"no server\" throws instead of reporting it stopped", async () => {
    const { socket, env, serverPid } = tmuxFixture();
    // tmux cannot even be started (empty PATH): a failure that is neither "no server running" nor a clean answer. A 1 ms
    // timeout would test the same branch, but whether it fires before a fast tmux answers depends on the host's load.
    await expect(stopOwnedTmuxServer(socket, { ...env, PATH: "/nonexistent-a6" }, { commandTimeoutMs: 5_000, graceMs: 300 })).rejects.toThrow(/cannot be verified stopped/);
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
  // daemon does) and optionally records it in the scratch home's daemon.json the way the real CLI does, listens on the
  // `--port` it was given, leaves a zombie to record, and/or exits 1; `daemon stop` succeeds without stopping anything
  // (the swallowed-failure case).
  interface Mode { ignoreTerm?: boolean; failStart?: boolean; writeState?: boolean; statePid?: number; listen?: boolean; zombie?: boolean; respawnOnStop?: boolean }
  function fakeRig(dir: string, mode: Mode): { bin: string; pidFile: string } {
    const bin = path.join(dir, "fake-rig.cjs"), pidFile = path.join(dir, "victim.pid");
    const script = mode.listen ? "require('net').createServer().listen(Number(process.env.A6_PORT), '127.0.0.1'); setInterval(() => {}, 1000)"
      : mode.zombie ? "" : mode.ignoreTerm ? "trap '' TERM; while :; do sleep 1; done" : "sleep 600";
    fs.writeFileSync(bin, `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const argv = process.argv.slice(2);
const [a, b] = argv;
if (a === "daemon" && b === "start") {
  const port = argv[argv.indexOf("--port") + 1];
  const child = ${mode.listen ? `spawn(process.execPath, ["-e", ${JSON.stringify(script)}], { detached: true, stdio: "ignore", env: { ...process.env, A6_PORT: port } })`
    : mode.zombie ? `spawn("/bin/sh", ["-c", "sleep 0.1 & echo $! > ${pidFile}.z; exec sleep 600"], { detached: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "OPENRIG_HOME")) })`
    : `spawn("/bin/sh", ["-c", ${JSON.stringify(script)}], { detached: true, stdio: "ignore" })`};
  child.unref();
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  const finish = () => {
    const pid = ${mode.zombie ? `Number(fs.readFileSync(${JSON.stringify(pidFile + ".z")}, "utf8"))` : mode.statePid ? String(mode.statePid) : "child.pid"};
    ${mode.writeState === false ? "" : `fs.writeFileSync(path.join(process.env.OPENRIG_HOME, "daemon.json"), JSON.stringify({ pid, port: 1 }));`}
    ${mode.failStart ? "process.exit(1);" : ""}
  };
  setTimeout(finish, ${mode.zombie ? 700 : mode.listen ? 600 : 0});
  fs.writeFileSync(${JSON.stringify(pidFile + ".port")}, port);
}
${mode.respawnOnStop ? `if (a === "daemon" && b === "stop") {
  // A daemon that supervises itself: stopping it brings a replacement up on the same port under a NEW pid.
  try { process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)}, "utf8"))); } catch {}
  setTimeout(() => {
    const port = fs.readFileSync(${JSON.stringify(pidFile + ".port")}, "utf8");
    const ready = ${JSON.stringify(pidFile + ".ready")};
    const again = spawn(process.execPath, ["-e", "require('net').createServer().listen(Number(process.env.A6_PORT), '127.0.0.1', () => require('fs').writeFileSync(process.env.A6_READY, '1')); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { ...process.env, A6_PORT: port, A6_READY: ready } });
    again.unref();
    fs.writeFileSync(${JSON.stringify(pidFile + ".replacement")}, String(again.pid));
    // Exit only once the replacement is really listening, so a slow host cannot make it undiscoverable by the time stop() looks.
    const wait = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(wait); process.exit(0); } }, 20);
  }, 400);
}` : ""}
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
      expect(watchdogsFor(scaffold.tmuxSocketPath), "the watchdog is disarmed after a verified stop").toEqual([]);
    }, 60_000);
  }

  it("stop() verifies against what is found now (the listening port), not only daemon.json: a daemon daemon.json does not name is still stopped", async () => {
    const dir = tempDir();
    // The state file names an unrelated, older process; the real daemon only listens on the port.
    const bystander = longSleeper();
    await new Promise((resolve) => setTimeout(resolve, 1200)); // older than the call, at ps's one-second resolution
    const { bin, pidFile } = fakeRig(dir, { listen: true, statePid: bystander });
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    killGroup(pid);
    expect(processAlive(pid), "positive control: the listener runs").toBe(true);
    await daemon.stop();
    expect(processAlive(pid), "the daemon found by its port is stopped").toBe(false);
    expect(processAlive(bystander), "the unrelated process daemon.json names is not").toBe(true);
  }, 60_000);

  it("stop() also stops a replacement the daemon brought up under a new pid (what is found now, not only what was recorded at start)", async () => {
    const dir = tempDir();
    const { bin, pidFile } = fakeRig(dir, { listen: true, respawnOnStop: true });
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 });
    killGroup(Number(fs.readFileSync(pidFile, "utf8")));
    await daemon.stop();
    const replacement = Number(fs.readFileSync(pidFile + ".replacement", "utf8"));
    killGroup(replacement);
    expect(processAlive(replacement), "the replacement daemon is stopped too").toBe(false);
  }, 60_000);

  it("stop() keeps the scaffold and the watchdog, and throws, when the daemon is still there after the escalation", async () => {
    const dir = tempDir();
    const { bin, pidFile } = fakeRig(dir, { zombie: true }); // a holder no signal can remove
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 300 });
    killGroup(Number(fs.readFileSync(pidFile, "utf8")));
    await expect(daemon.stop()).rejects.toThrow(/still alive after stop/);
    const watchdogs = watchdogsFor(scaffold.tmuxSocketPath);
    cleanups.push(() => { for (const w of watchdogs) { try { process.kill(-w, "SIGKILL"); } catch { /* gone */ } } });
    expect(fs.existsSync(scaffold.root), "the scaffold was not deleted").toBe(true);
    expect(watchdogs.length, "the watchdog stays armed").toBeGreaterThan(0);
  }, 60_000);

  // A start that fails after detaching the daemon: found by daemon.json, by the port it listens on, or (Linux) by the
  // scaffold's home in its environment.
  const failedStartCases: Array<{ name: string; mode: Mode; skip?: boolean }> = [
    { name: "daemon.json written", mode: { failStart: true } },
    { name: "no daemon.json, found by its listening port", mode: { failStart: true, writeState: false, listen: true } },
    { name: "no daemon.json and no port, found by the scaffold's home in its environment (Linux)", mode: { failStart: true, writeState: false }, skip: !hasProcFs() },
  ];
  for (const c of failedStartCases) {
    it.skipIf(c.skip === true)(`a \`rig daemon start\` that fails after detaching the daemon (${c.name}) leaves no daemon behind and no watchdog`, async () => {
      const dir = tempDir();
      const { bin, pidFile } = fakeRig(dir, c.mode);
      const scaffold = prepareHermeticEnv();
      cleanups.push(() => scaffold.cleanup());
      await expect(spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 })).rejects.toThrow(/failed to start/);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      killGroup(pid);
      expect(processAlive(pid), "the daemon detached by the failed start is stopped").toBe(false);
      expect(watchdogsFor(scaffold.tmuxSocketPath), "everything was stopped, so the watchdog is disarmed").toEqual([]);
    }, 60_000);
  }

  it("a failed start whose leftover cannot be stopped keeps the watchdog armed (disarm only if no holder survived)", async () => {
    const dir = tempDir();
    // The recorded holder is a zombie: it is alive to kill(0) and ps, and no signal can remove it until its parent reaps it.
    const { bin, pidFile } = fakeRig(dir, { failStart: true, zombie: true });
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    await expect(spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 300 })).rejects.toThrow(/failed to start/);
    killGroup(Number(fs.readFileSync(pidFile, "utf8")));
    const watchdogs = watchdogsFor(scaffold.tmuxSocketPath);
    cleanups.push(() => { for (const w of watchdogs) { try { process.kill(-w, "SIGKILL"); } catch { /* gone */ } } });
    expect(watchdogs.length, "a survivor keeps a watchdog armed").toBeGreaterThan(0);
  }, 60_000);

  it("never signals a process that daemon.json names but that is not this scaffold's (a stale or reused pid)", async () => {
    const dir = tempDir();
    const bystander = longSleeper();
    await new Promise((resolve) => setTimeout(resolve, 1200)); // older than the call, at ps's one-second resolution
    const { bin } = fakeRig(dir, { statePid: bystander });
    const scaffold = prepareHermeticEnv();
    cleanups.push(() => scaffold.cleanup());
    // Nothing started by this call is identifiable (the state file names an older process, nothing listens), so the helper
    // refuses rather than guess; it must not have signalled the bystander either way.
    await expect(spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 })).rejects.toThrow(/cannot be identified/);
    killGroup(Number(fs.readFileSync(path.join(dir, "victim.pid"), "utf8")));
    expect(processAlive(bystander), "the unrelated process named by daemon.json is untouched").toBe(true);
  }, 60_000);
});
