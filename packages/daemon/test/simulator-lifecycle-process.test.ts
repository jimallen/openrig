// OF-208 — a scenario-daemon-style spawn never reaches the real simctl.
//
// The production entrypoint (isDirectRun -> startServer) is started the way a scenario/hermetic daemon is: a private
// OPENRIG_HOME. `xcrun` on PATH is a stub that records every call; the real simctl is not reachable. The daemon boots
// (on darwin its boot sweep would call `xcrun simctl list`), then a rig with a seat is created in its database and
// deleted through its HTTP API (the removal trigger would call `xcrun simctl list` and could erase). Nothing may call the stub.
// VITEST and NODE_ENV are removed from the child's environment so the private-home guard is what is tested, not the
// test-runner backstop.
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RigRepository } from "../src/domain/rig-repository.js";
import { killIfRunning, spawnDaemonEntrypoint } from "./helpers/daemon-entrypoint.js";

const HEAVY_LOAD_CEILING_MS = 300_000;
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-of208-proc-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OF-208 a scenario-daemon-style spawn never calls simctl", () => {
  it("boot and a rig removal on a private OPENRIG_HOME leave the recording xcrun stub uncalled", async () => {
    const home = tempDir();
    const stubDir = tempDir();
    const calls = path.join(stubDir, "calls.log");
    fs.writeFileSync(path.join(stubDir, "xcrun"), `#!/bin/sh\necho "$@" >> '${calls}'\necho '{"devices":{}}'\n`, { mode: 0o755 });
    const dbPath = path.join(home, "openrig.sqlite");
    // The helper pins the bind host to loopback and retries a port lost between reservation and bind (OF-232).
    const { child, port } = await spawnDaemonEntrypoint({
      home,
      env: { PATH: `${stubDir}:/usr/bin:/bin:${path.dirname(process.execPath)}` },
      readyTimeoutMs: HEAVY_LOAD_CEILING_MS - 20_000,
    });
    try {
      // A rig whose seat is named for the device the stub would never report; the removal path runs end to end.
      const db = new Database(dbPath);
      let rigId: string;
      try {
        const repo = new RigRepository(db);
        const rig = repo.createRig("eztrack");
        repo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
        rigId = rig.id;
      } finally {
        db.close();
      }
      const res = await fetch(`http://127.0.0.1:${port}/api/rigs/${rigId}`, { method: "DELETE" });
      expect(res.status).toBe(204);

      // The removal's simctl call (if any) starts in the same tick as the response and the stub answers in milliseconds.
      await new Promise((r) => setTimeout(r, 2_000));
      const seen = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
      expect(seen, `a daemon on a private OPENRIG_HOME ran simctl: ${seen}`).toBe("");

      child.kill("SIGINT");
      await once(child, "exit");
    } finally {
      killIfRunning(child);
    }
  }, HEAVY_LOAD_CEILING_MS);
});
