import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { anchorDaemonCwd } from "../src/daemon-cwd-anchor.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

// OF-31 production consequence: a daemon started (rig daemon start) from a
// directory that is later deleted failed EVERY Codex seat launch with
// "Codex profile 'rig-yolo' failed to load: shell-init: error retrieving
// current directory: getcwd: cannot access parent directories".
function run(mode: "direct" | "imported") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-cwd-anchor-"));
  roots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(home);
  // Synthetic codex: like the real shell init, it dies when its cwd is gone.
  fs.writeFileSync(path.join(root, "bin", "codex"),
    "#!/bin/sh\n/bin/pwd -P >/dev/null 2>&1 || { echo 'shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory' >&2; exit 1; }\nexit 0\n",
    { mode: 0o700 });
  const child = spawnSync(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"),
    path.join(import.meta.dirname, "fixtures/daemon-cwd-anchor-probe.ts"), root, mode,
  ], { cwd: root, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OPENRIG_HOME: path.join(root, "openrig") } });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return { out: JSON.parse(child.stdout.trim().split("\n").pop()!), home };
}

describe("daemon cwd anchor (OF-31)", () => {
  it("the Codex profile preflight still loads after the launch directory is deleted, when started as the daemon entry", () => {
    const { out, home } = run("direct");
    expect(out.result).toEqual({ ok: true, profile: "rig-yolo" });
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(home));
  });

  it("control: importing the module from anything but the daemon entry leaves the cwd alone (the fixture bites)", () => {
    const { out } = run("imported");
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain("getcwd: cannot access parent directories");
    expect(out.cwd).toBeNull();
  });

  it("resolves relative single-path env against the launch cwd, leaves lists and absolutes alone, then chdirs to home", () => {
    const env: NodeJS.ProcessEnv = {
      OPENRIG_DB: "state/x.sqlite", RIGGED_HOME: "rh", OPENRIG_WORKSPACE_ROOT: "ws",
      OPENRIG_TOPOLOGY_ROOT: "/abs/topo", OPENRIG_PROGRESS_SCAN_ROOTS: "a:b", OPENRIG_PORT: "7433", OTHER_DIR: "keep",
    };
    const chdirs: string[] = [];
    const target = anchorDaemonCwd(env, { cwd: () => "/launch", chdir: (d) => chdirs.push(d), home: () => "/home/u" });
    expect(target).toBe("/home/u");
    expect(chdirs).toEqual(["/home/u"]);
    expect(env).toEqual({
      OPENRIG_DB: "/launch/state/x.sqlite", RIGGED_HOME: "/launch/rh", OPENRIG_WORKSPACE_ROOT: "/launch/ws",
      OPENRIG_TOPOLOGY_ROOT: "/abs/topo", OPENRIG_PROGRESS_SCAN_ROOTS: "a:b", OPENRIG_PORT: "7433", OTHER_DIR: "keep",
    });
  });

  it("does not rewrite :memory:, ~ or file: values", () => {
    const env: NodeJS.ProcessEnv = { OPENRIG_DB: ":memory:", OPENRIG_HOME: "~/x", OPENRIG_SKILLS_ROOT: "file:y" };
    anchorDaemonCwd(env, { cwd: () => "/launch", chdir: () => {}, home: () => "/home/u" });
    expect(env).toEqual({ OPENRIG_DB: ":memory:", OPENRIG_HOME: "~/x", OPENRIG_SKILLS_ROOT: "file:y" });
  });

  it("still anchors when the launch cwd is already gone", () => {
    const chdirs: string[] = [];
    anchorDaemonCwd({ OPENRIG_DB: "rel.sqlite" }, {
      cwd: () => { throw new Error("uv_cwd"); }, chdir: (d) => chdirs.push(d), home: () => "/home/u" });
    expect(chdirs).toEqual(["/home/u"]);
  });

  it("index.ts imports the anchor before every other module (wiring pin; textual)", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
    const firstImport = src.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "./daemon-cwd-anchor.js";');
  });
});
