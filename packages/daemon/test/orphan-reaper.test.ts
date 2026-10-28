// Test processes that outlive their suite: a tmux server and a detached scenario daemon each ran for a day or more on a
// shared build host after their temp home was deleted, because the run that started them was killed, timed out, or had
// its stop failure swallowed before teardown. These rows start real processes (sleep, tmux) of their own and prove the
// watchdog and the stop escalation leave none behind. Nothing here touches another process, a default tmux socket,
// a real daemon or ~/.openrig.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { processAlive, reapWhenOwnerDies, stopOwnedTmuxServer, waitGone } from "./helpers/orphan-reaper.js";
import { spawnScenarioDaemon } from "./helpers/scenario-daemon.js";

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

function longSleeper(script = "sleep 600"): number {
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
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

describe("reapWhenOwnerDies", () => {
  it("stops the listed pid once the owner is killed, and not before", async () => {
    const owner = longSleeper(), victim = longSleeper(), bystander = longSleeper();
    const reaper = reapWhenOwnerDies({ ownerPid: owner, pids: [victim] });
    cleanups.push(() => reaper.disarm());
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the watchdog has polled at least once
    expect(processAlive(victim), "positive control: owner alive, victim untouched").toBe(true);
    process.kill(owner, "SIGKILL");
    expect(await waitGone(victim, 30_000), "victim stopped after the owner died").toBe(true);
    expect(processAlive(bystander), "an unlisted process is never touched").toBe(true);
  }, 60_000);

  it("a disarmed watchdog does nothing when the owner later dies", async () => {
    const owner = longSleeper(), victim = longSleeper();
    reapWhenOwnerDies({ ownerPid: owner, pids: [victim] }).disarm();
    process.kill(owner, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 3500)); // longer than the watchdog's poll plus its grace
    expect(processAlive(victim)).toBe(true);
  }, 30_000);

  it.skipIf(!hasTmux)("stops the tmux server on the listed socket once the owner is killed", async () => {
    const dir = tempDir(), socket = path.join(dir, "tmux"), owner = longSleeper();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TMPDIR: dir };
    delete env.TMUX;
    cleanups.push(() => { try { execFileSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" }); } catch { /* gone */ } });
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "a", "sleep 600"], { env });
    const serverPid = Number(execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, encoding: "utf8" }).trim());
    const reaper = reapWhenOwnerDies({ ownerPid: owner, tmuxSockets: [socket] });
    cleanups.push(() => reaper.disarm());
    expect(processAlive(serverPid), "positive control: the server runs").toBe(true);
    process.kill(owner, "SIGKILL");
    expect(await waitGone(serverPid, 30_000), "tmux server stopped after the owner died").toBe(true);
  }, 60_000);
});

describe.skipIf(!hasTmux)("stopOwnedTmuxServer", () => {
  it("leaves no server and no session shell behind", async () => {
    const dir = tempDir(), socket = path.join(dir, "tmux");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TMPDIR: dir };
    delete env.TMUX;
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "a", "sleep 600"], { env });
    const serverPid = Number(execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, encoding: "utf8" }).trim());
    expect(processAlive(serverPid), "positive control").toBe(true);
    await stopOwnedTmuxServer(socket, env);
    expect(processAlive(serverPid)).toBe(false);
    await stopOwnedTmuxServer(socket, env); // idempotent: no server is not an error
  }, 60_000);
});

describe("scenario daemon stop", () => {
  // A stand-in `rig` that "starts" a detached long-lived process, records it in the scratch home's daemon.json the way the
  // real CLI does, and whose `daemon stop` succeeds without stopping anything (the swallowed-failure case).
  function fakeRig(dir: string, ignoreTerm: boolean): { bin: string; pidFile: string } {
    const bin = path.join(dir, "fake-rig.cjs"), pidFile = path.join(dir, "victim.pid");
    fs.writeFileSync(bin, `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const [a, b] = process.argv.slice(2);
if (a === "daemon" && b === "start") {
  const child = spawn("/bin/sh", ["-c", ${JSON.stringify(ignoreTerm ? "trap '' TERM; while :; do sleep 1; done" : "sleep 600")}], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(process.env.OPENRIG_HOME, "daemon.json"), JSON.stringify({ pid: child.pid, port: 1 }));
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
}
`);
    return { bin, pidFile };
  }

  it("a killed runner (no teardown) leaves no daemon behind: the helper's watchdog stops the daemon it started", async () => {
    const dir = tempDir();
    const { bin, pidFile } = fakeRig(dir, false);
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
    cleanups.push(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    expect(processAlive(pid), "positive control: the daemon runs while its runner lives").toBe(true);
    child.kill("SIGKILL");
    expect(await waitGone(pid, 60_000), "daemon stopped after its runner was killed").toBe(true);
  }, 120_000);

  for (const ignoreTerm of [false, true]) {
    it(`leaves no daemon behind when \`rig daemon stop\` does not stop it${ignoreTerm ? " and it ignores SIGTERM" : ""}`, async () => {
      const dir = tempDir();
      const { bin, pidFile } = fakeRig(dir, ignoreTerm);
      const scaffold = prepareHermeticEnv();
      cleanups.push(() => scaffold.cleanup());
      const daemon = await spawnScenarioDaemon(scaffold, { rigBin: bin, timeoutMs: 30_000, stopGraceMs: 500 });
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      cleanups.push(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
      expect(processAlive(pid), "positive control: the fake daemon runs before stop").toBe(true);
      await daemon.stop();
      expect(processAlive(pid)).toBe(false);
      expect(fs.existsSync(scaffold.root), "the scaffold is still removed").toBe(false);
    }, 60_000);
  }
});
