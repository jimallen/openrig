import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stopOwnedTmuxServerSync } from "./helpers/orphan-reaper.js";

// The fixture imports the BUILT daemon (packages/daemon/dist). In a tree without a build it would die with
// ERR_MODULE_NOT_FOUND, which says nothing about the probe, so the test is skipped there: run the daemon build first.
const hasDaemonBuild = existsSync(fileURLToPath(new URL("../dist/adapters/tmux.js", import.meta.url)));

it.skipIf(!hasDaemonBuild)("probes exact native session names so a live prefix neighbor cannot hide a detached seat (needs packages/daemon/dist; skipped without a daemon build)", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-exact-probe-"));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/exact-session-probe.mjs", import.meta.url)), home,
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 15000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ nativeTmux: true, argvAndLegacy: true, missingDetached: true, neighborPreserved: true, exactPaneListing: true });
  } finally {
    // The fixture's own teardown does not run when the timeout kills it: stop its server here, verified, before its home goes.
    stopOwnedTmuxServerSync(join(home, "tmux.sock"), { ...process.env, HOME: home });
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
