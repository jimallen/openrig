import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureCodexSeatHome,
  codexSeatHomePath,
  sanitizeSessionForPath,
} from "../src/domain/codex-seat-home.js";

let tmp: string;
let openrigHome: string;
let shared: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-seat-home-test-"));
  openrigHome = path.join(tmp, ".openrig");
  shared = path.join(tmp, ".codex");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "auth.json"), "{}");
  await fs.writeFile(path.join(shared, "config.toml"), "");
  await fs.mkdir(path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin", "bin"), { recursive: true });
  await fs.writeFile(path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin", "bin", "codex"), "fake");
  await fs.symlink(
    path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin"),
    path.join(shared, "packages", "app-server-daemon", "current"),
  );
  await fs.writeFile(path.join(shared, "packages", "app-server-daemon", "auto-update-version"), "0.158.0-aarch64-apple-darwin");
  await fs.mkdir(path.join(shared, "packages", "other-package"));
  await fs.writeFile(path.join(shared, "rig-yolo.config.toml"), "approval_policy = \"never\"\n");
  // runtime state that must NOT be shared into seat homes
  await fs.writeFile(path.join(shared, "history.jsonl"), "");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("codex-seat-home", () => {
  it("places the seat home under <openrigHome>/codex-seats/<session>, keeping @", async () => {
    expect(sanitizeSessionForPath("verify-qa@jims-team")).toBe("verify-qa@jims-team");
    const home = await ensureCodexSeatHome("verify-qa@jims-team", { openrigHome, sharedCodexHome: shared });
    expect(home.path).toBe(codexSeatHomePath(openrigHome, "verify-qa@jims-team"));
    const stat = await fs.lstat(home.path);
    expect(stat.isDirectory()).toBe(true);
  });

  it("symlinks shared account material but copies profile fragments", async () => {
    const home = await ensureCodexSeatHome("verify-qa@jims-team", { openrigHome, sharedCodexHome: shared });
    const auth = await fs.lstat(path.join(home.path, "auth.json"));
    expect(auth.isSymbolicLink()).toBe(true);
    const pkgs = await fs.lstat(path.join(home.path, "packages"));
    expect(pkgs.isDirectory() && !pkgs.isSymbolicLink()).toBe(true); // real dir: app-server bookkeeping must be seat-local

    const profile = await fs.lstat(path.join(home.path, "rig-yolo.config.toml"));
    // copied, not linked: canonical path stays per-seat (distinct codex resume keys)
    expect(profile.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(home.path, "rig-yolo.config.toml"), "utf8"))
      .toContain("approval_policy");
    expect(home.copiedProfiles).toContain("rig-yolo.config.toml");

    // app-server payload shared via releases symlink; `current` rooted INSIDE
    // the seat home so another seat's install can never repoint it away
    const releases = await fs.lstat(path.join(home.path, "packages", "app-server-daemon", "releases"));
    expect(releases.isSymbolicLink()).toBe(true);
    const current = await fs.readlink(path.join(home.path, "packages", "app-server-daemon", "current"));
    expect(current.startsWith(home.path)).toBe(true);
    const daemonBin = path.join(home.path, "packages", "app-server-daemon", "current", "bin", "codex");
    expect(await fs.readFile(daemonBin, "utf8")).toBe("fake"); // resolves through the link chain

    // runtime state never leaks in
    await expect(fs.lstat(path.join(home.path, "history.jsonl"))).rejects.toThrow();
  });

  it("is idempotent and never overwrites a working seat home", async () => {
    const first = await ensureCodexSeatHome("exec-cos@jims-team", { openrigHome, sharedCodexHome: shared });
    // operator/scratch writes inside the seat home must survive a re-seed
    await fs.writeFile(path.join(first.path, "notes.md"), "seat work product");
    await fs.writeFile(path.join(shared, "new-thing"), "x");
    const second = await ensureCodexSeatHome("exec-cos@jims-team", { openrigHome, sharedCodexHome: shared });
    expect(second.path).toBe(first.path);
    expect(await fs.readFile(path.join(first.path, "notes.md"), "utf8")).toBe("seat work product");
  });

  it("tolerates a missing shared codex home (codex bootstraps its own state)", async () => {
    await fs.rm(shared, { recursive: true, force: true });
    const home = await ensureCodexSeatHome("build-impl@jims-team", { openrigHome, sharedCodexHome: shared });
    const stat = await fs.lstat(home.path);
    expect(stat.isDirectory()).toBe(true);
    expect(home.linked).toHaveLength(0);
    expect(home.copiedProfiles).toHaveLength(0);
  });
});
