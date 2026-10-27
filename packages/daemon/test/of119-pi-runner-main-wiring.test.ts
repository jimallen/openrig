// OF-119 (review N3): the deployed wiring of the Pi runner's alive tick and atomic sidecar write. The unit rows in
// of119-pi-liveness-paste-hint.test.ts test startAliveTick and writeSidecarAtomic in isolation; this one starts the REAL
// runner (pi-runner.ts main(), against an offline fake `pi`) and reads what lands on disk. Production consequence: without
// `startAliveTick(core)` in main(), every new runner's sidecar goes stale 180 s after its last write and `rig send` falls
// back to the pane classifier for an idle seat (the OF-88 question-frame refusal) permanently; without the atomic writer a
// reader can parse a half-written sidecar.
// The preload runs Date.now 200x faster (the tick is wall-clock driven, so its 60 s cadence is due at the first 5 s check)
// and logs fs.renameSync calls. Real time spent: about 6 s.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { piSeatPaths, PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER } from "../src/adapters/pi-runner-protocol.js";

describe.skipIf(process.platform === "win32")("OF-119: the real runner main() keeps its sidecar alive and replaces it atomically", () => {
  it("an idle ready runner rewrites the sidecar with a newer aliveAt, every write going through a temp file and a rename", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wiring-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const sessionFile = path.join(temp, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const cmd=JSON.parse(line); if(cmd.type==='get_state') console.log(JSON.stringify({type:'response',id:cmd.id,success:true,
data:{sessionFile:${JSON.stringify(sessionFile)},sessionId:'offline'}}));
});\n`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const runnerStatePath = piSeatPaths(stateRoot, "fixture").runnerStatePath;
    const renameLog = path.join(temp, "renames.log");
    const preload = fileURLToPath(new URL("./helpers/pi-runner-wiring-preload.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "wiring-attempt", "--no-approve", "--model", "openrouter/fixture"], {
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home"), WIRING_RENAME_LOG: renameLog },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });
    const read = () => { try { return JSON.parse(fs.readFileSync(runnerStatePath, "utf8")); } catch { return null; } };
    try {
      const readyBy = Date.now() + 15000;
      while (!output.includes(PI_RUNNER_READY_MARKER) && !output.includes(PI_RUNNER_ERROR_MARKER) && Date.now() < readyBy) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const first = read();
      expect(first?.ready, output).toBe(true);
      expect(typeof first.aliveAt, "every ready write carries aliveAt").toBe("string");
      // Idle: nothing but the tick can rewrite the sidecar now.
      const tickBy = Date.now() + 15000;
      let later = first;
      while ((later?.aliveAt ?? first.aliveAt) === first.aliveAt && Date.now() < tickBy) {
        await new Promise(resolve => setTimeout(resolve, 50));
        later = read();
      }
      expect(later?.aliveAt, "the tick rewrote the idle sidecar").not.toBe(first.aliveAt);
      expect(Date.parse(later.aliveAt)).toBeGreaterThan(Date.parse(first.aliveAt));
      const renames = fs.readFileSync(renameLog, "utf8").trim().split("\n");
      expect(renames.length).toBeGreaterThanOrEqual(2); // the ready write and the tick
      for (const line of renames) expect(line).toBe(`${runnerStatePath}.tmp -> ${runnerStatePath}`);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 40000);
});
