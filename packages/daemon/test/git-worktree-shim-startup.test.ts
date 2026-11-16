// workspaces-o9o.50: the daemon (re)writes the rig-bin git shim at startup, not only at a seat launch. Measured after
// releases 1 and 2 (2026-11-16): stu and mbp kept the OLD <OPENRIG_HOME>/rig-bin/git (B's 'command -v -a' bug) while the
// daemon ran the fixed code, because only a seat launch wrote it, and running seats exec that file on every git call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { OPENRIG_HOME } from "../src/openrig-compat.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";
import { __shimSource } from "../src/domain/git-worktree-shim.js";

// The shim B shipped before o9o.2: the bug the stale hosts kept running.
const STALE = "#!/usr/bin/env bash\nreal=\"$(command -v -a git | sed -n 2p)\"\nexec \"$real\" \"$@\"\n";
const rigBin = join(OPENRIG_HOME, "rig-bin");
const shim = join(rigBin, "git");
const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(os.tmpdir(), "shim-startup-"));
  roots.push(root);
  return root;
}

/** Start the daemon in-process and hand back every console line it printed. */
async function startDaemon(): Promise<{ out: string; err: string }> {
  const home = scratch();
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  vi.spyOn(PluginVendorService.prototype, "attemptAutoFetch").mockResolvedValue();
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  const { db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "" });
  db.close();
  const lines = (spy: typeof log) => spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
  return { out: lines(log), err: lines(error) };
}

const shimLines = (text: string) => text.split("\n").filter((line) => line.includes("git worktree shim"));
const leftovers = () => (existsSync(rigBin) ? readdirSync(rigBin).filter((name) => name !== "git") : []);

beforeEach(() => rmSync(rigBin, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(rigBin, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon start (re)writes the rig-bin git shim", () => {
  it("a stale shim from an older release is replaced with the package's at daemon start, before any seat launches", async () => {
    mkdirSync(rigBin, { recursive: true });
    writeFileSync(shim, STALE, { mode: 0o755 });
    const { out } = await startDaemon();
    expect(readFileSync(shim, "utf8")).toBe(__shimSource());
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(shimLines(out)).toHaveLength(1);
    expect(shimLines(out)[0]).toMatch(/git worktree shim: replaced .*rig-bin\/git \(sha256 [0-9a-f]{12} -> [0-9a-f]{12}\)/);
    expect(leftovers()).toEqual([]);
  });

  it("no shim yet: daemon start creates it, executable, and says so", async () => {
    const { out } = await startDaemon();
    expect(readFileSync(shim, "utf8")).toBe(__shimSource());
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(shimLines(out)).toEqual([expect.stringMatching(/git worktree shim: created .*rig-bin\/git \(sha256 [0-9a-f]{12}\)/)]);
    expect(leftovers()).toEqual([]);
  });

  it("a current shim is left alone (same inode, same mtime) and logged as unchanged", async () => {
    mkdirSync(rigBin, { recursive: true });
    writeFileSync(shim, __shimSource(), { mode: 0o755 });
    const before = statSync(shim);
    const { out } = await startDaemon();
    const after = statSync(shim);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(shimLines(out)).toEqual([expect.stringMatching(/git worktree shim: unchanged .*rig-bin\/git \(sha256 [0-9a-f]{12}\)/)]);
  });

  it("a current shim that is not executable gets its mode fixed (0755) and is logged as mode-fixed", async () => {
    mkdirSync(rigBin, { recursive: true });
    writeFileSync(shim, __shimSource(), { mode: 0o644 });
    const { out } = await startDaemon();
    expect(readFileSync(shim, "utf8")).toBe(__shimSource());
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(shimLines(out)).toEqual([expect.stringMatching(/git worktree shim: mode-fixed .*rig-bin\/git \(0644 -> 0755\)/)]);
    expect(leftovers()).toEqual([]);
  });

  it("rig-bin is a symlink: nothing is written through it, the refusal is reported, and the daemon still starts", async () => {
    const elsewhere = scratch();
    writeFileSync(join(elsewhere, "git"), STALE, { mode: 0o755 });
    symlinkSync(elsewhere, rigBin);
    const { out, err } = await startDaemon();
    expect(readFileSync(join(elsewhere, "git"), "utf8")).toBe(STALE);
    expect(readdirSync(elsewhere)).toEqual(["git"]);
    expect(lstatSync(rigBin).isSymbolicLink()).toBe(true);
    expect(shimLines(out)).toEqual([]);
    expect(shimLines(err)).toEqual([expect.stringMatching(/git worktree shim: refused .*rig-bin is a symlink/)]);
  });

  it("rig-bin/git is a symlink: its target is not written, the link stays, the refusal is reported", async () => {
    const elsewhere = scratch();
    const target = join(elsewhere, "real-git");
    writeFileSync(target, STALE, { mode: 0o755 });
    mkdirSync(rigBin, { recursive: true });
    symlinkSync(target, shim);
    const { out, err } = await startDaemon();
    expect(readFileSync(target, "utf8")).toBe(STALE);
    expect(readlinkSync(shim)).toBe(target);
    expect(leftovers()).toEqual([]);
    expect(shimLines(out)).toEqual([]);
    expect(shimLines(err)).toEqual([expect.stringMatching(/git worktree shim: refused .*rig-bin\/git is a symlink/)]);
  });
});
