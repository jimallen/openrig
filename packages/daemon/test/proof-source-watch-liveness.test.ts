// workspaces-o9o.38: the proof source watch must never report "watching" without evidence that the kernel watch exists.
// Found by build-impl5 (o9o.26) and reproduced at d0303ca8 on Node v22.23.4: when inotify_add_watch fails for every
// call (watch budget exhausted; Sparky reached 65,364 of 65,536 that day), a recursive fs.watch is silently dead (no
// throw, no 'error' event, no events) while observation() still says "watching", so proof readiness pushes stop.
//
// These rows run the real source-watch in a child process under an LD_PRELOAD shim (test/helpers/inotify-enospc-shim.c)
// that makes inotify_add_watch fail ENOSPC after FAIL_AFTER calls in that process only; the host's watch budget is not
// touched. Linux only (inotify), and the shim needs a C compiler.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const helpers = path.join(import.meta.dirname, "helpers");
const cc = process.platform === "linux" ? spawnSync("cc", ["--version"], { encoding: "utf-8" }) : null;
const runnable = cc !== null && cc.status === 0;
let shim = "";
const made: string[] = [];
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

beforeAll(() => {
  if (!runnable) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9o38-shim-"));
  made.push(dir);
  shim = path.join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", shim, path.join(helpers, "inotify-enospc-shim.c"), "-ldl"], { encoding: "utf-8" });
  if (built.status !== 0) throw new Error(`shim build failed: ${built.stderr}`);
});

/** A missions root: legacy (no project.yaml, one recursive watcher) or nested under a project (two watchers). */
function missionsRoot(shape: "legacy" | "nested", withFile = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `o9o38-${shape}-`));
  made.push(root);
  const missions = shape === "legacy" ? path.join(root, "missions") : path.join(root, "work", "initiatives");
  fs.mkdirSync(path.join(missions, "trial", "slices", "01-alpha"), { recursive: true });
  if (withFile) fs.writeFileSync(path.join(missions, "trial", "slices", "01-alpha", "SPEC.md"), "# Alpha\n");
  if (shape === "nested") fs.writeFileSync(path.join(root, "project.yaml"), "kind: project\nmissions:\n  root: work/initiatives\n");
  return missions;
}

/** What the real source-watch claims, armed in a child process whose inotify_add_watch fails after `failAfter` calls (-1: never). */
function observe(missions: string, failAfter: number, lateDir?: string): { state: string; revision: string; cause?: string; logs: string[] } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(helpers, "source-watch-child.ts"), missions, ...(lateDir ? [lateDir] : [])], {
    encoding: "utf-8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, LD_PRELOAD: shim, FAIL_AFTER: String(failAfter) },
  });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

describe.skipIf(!runnable)("o9o.38: source watch liveness under inotify exhaustion (needs Linux and cc)", () => {
  it("a legacy root whose recursive watch could not arm a single inotify watch is reported unavailable, not watching", () => {
    expect(observe(missionsRoot("legacy"), 0).state).toBe("unavailable");
  });

  it("a nested root under the same exhaustion is reported unavailable", () => {
    expect(observe(missionsRoot("nested"), 0).state).toBe("unavailable");
  });

  it("a directory created after arming that cannot get a watch turns the claim to unavailable", () => {
    // Node arms the watched root and its 4 directories (5 calls, measured with strace), so with 5 allowed the late
    // directory's watch is the first to fail.
    const seen = observe(missionsRoot("legacy"), 5, "trial/slices/02-beta");
    expect(seen.state).toBe("unavailable");
    expect(seen.cause).toMatch(/no live watch on 1 of the watched path\(s\) .*first: .*02-beta$/);
  });

  it("a file whose own watch failed, with every directory watched, is a gap: its edits would give no event", () => {
    // Root, 4 directories, then 01-alpha/SPEC.md is armed last: with 5 allowed only the file's watch fails.
    const seen = observe(missionsRoot("legacy", true), 5);
    expect(seen.state).toBe("unavailable");
    expect(seen.cause).toMatch(/first: .*SPEC\.md$/);
  });

  it("names the cause when nothing could be watched", () => {
    const seen = observe(missionsRoot("legacy"), 0);
    expect(seen.cause).toMatch(/no live watch on 5 of the watched path\(s\) .*inotify watch limit/);
    expect(seen.logs.join("\n")).toMatch(/unavailable \(no live watch/);
  });

  it("positive control: with the watch budget intact both shapes report watching", () => {
    expect(observe(missionsRoot("legacy", true), -1).state).toBe("watching");
    expect(observe(missionsRoot("nested", true), -1).state).toBe("watching");
  });

  it("positive control: a directory created after arming, with the budget intact, never flips the claim", () => {
    const seen = observe(missionsRoot("legacy"), -1, "trial/slices/02-beta");
    expect(seen.state).toBe("watching");
    expect(seen.logs).toEqual([]);
  });
});
