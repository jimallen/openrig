// `rig bundle create --project-dir` and `--context-pack`: the carried project folder and carried context packs
// go through the SAME guarded, capped, entry-limited, cycle-safe reader as the author skill/plugin trees
// (vendored-file-guard.ts collectVendoredTree / readContainedVendoredFileWithMode).
//
// Defects (OF-26, measured in the OF-24 review): a 40 MiB project file was copied; a hard link to an OUTSIDE file
// was copied with the outside bytes; a directory-link cycle threw RangeError (a 500); a 30-level doubled-symlink
// fan-out HUNG; a context pack read only its manifest-listed files but with no cap and a stat-then-read gap.
//
// TRUST BOUNDARY: the daemon API caller is trusted; these rows pin accident/swap protection, not an allowlist.
// Rows that would HANG on a regression run in a CHILD process with a timeout; FIFO rows with a writer attached
// kill the writer in `finally`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { vendorContextPackDir } from "../src/domain/bundle-carried-context-pack.js";
import { vendorProjectDir } from "../src/domain/bundle-carried-project.js";
import {
  VENDORED_CONTEXT_PACK_MAX_BYTES, VENDORED_FILE_MAX_BYTES, VENDORED_PROJECT_TREE_MAX_BYTES, VENDORED_TREE_MAX_ENTRIES, VendoredFileRefused,
} from "../src/domain/vendored-file-guard.js";

const MARKER = "CARRIED-OUTSIDE-MARKER";
const MIB = 1024 * 1024;
const PACK_MANIFEST = ["name: demo-world", "version: 0.1.0", "taxonomy: world", "files:", "  - path: identity/who.md", "    role: identity", "  - path: craft/how.md", "    role: craft", ""].join("\n");

function walk(dir: string): string[] {
  const out: string[] = [];
  (function w(d: string, pre: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) w(path.join(d, e.name), rel); else out.push(rel);
    }
  })(dir, "");
  return out.sort();
}

describe("bundle create: carried project and context pack use the guarded reader", () => {
  let work: string;
  let proj: string;
  let pack: string;
  let outside: string;
  let staging: string;
  const writers: Array<ReturnType<typeof spawn>> = [];

  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "carried-vendor-")));
    proj = path.join(work, "proj");
    pack = path.join(work, "pack");
    outside = path.join(work, "outside");
    staging = path.join(work, "staging");
    for (const d of [proj, pack, outside, staging, path.join(pack, "identity"), path.join(pack, "craft")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(proj, "project.yaml"), "id: demo\n");
    fs.writeFileSync(path.join(proj, "SPEC.md"), "# spec\n");
    fs.writeFileSync(path.join(pack, "manifest.yaml"), PACK_MANIFEST);
    fs.writeFileSync(path.join(pack, "identity", "who.md"), "# Who\n");
    fs.writeFileSync(path.join(pack, "craft", "how.md"), "# How\n");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const w of writers.splice(0)) w.kill("SIGKILL");
    fs.rmSync(work, { recursive: true, force: true });
  });

  const fifoWithWriter = (fifo: string) => {
    execFileSync("mkfifo", [fifo]);
    writers.push(spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `fifo ${MARKER}\n`, fifo], { stdio: "ignore" }));
  };
  const child = (mode: string, dir: string, fifo?: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers", "carried-vendor-child.ts"), mode, dir, staging, ...(fifo ? [fifo] : [])],
      { encoding: "utf-8", timeout: 25000, killSignal: "SIGKILL", cwd: path.join(import.meta.dirname, "..") });
    // ETIMEDOUT is the regression: the read blocked.
    expect(r.error, `child did not finish: ${r.error?.message} ${r.stderr}`).toBeUndefined();
    expect(r.status, String(r.stderr)).toBe(0);
    return JSON.parse(String(r.stdout).trim().split("\n").pop()!) as { ok: boolean; refused?: boolean; message?: string; fired: boolean };
  };
  const bigFile = (p: string, bytes: number) => { fs.writeFileSync(p, ""); fs.truncateSync(p, bytes); };
  const stagedHas = (needle: string) => fs.existsSync(staging) && walk(staging).some((f) => fs.readFileSync(path.join(staging, f)).includes(needle));
  /** Swap `target` right after the daemon's default-fs statSync of it returns: the stat-then-read window. */
  const swapAfterStat = (target: string, swap: () => void) => {
    const state = { fired: false };
    const realTarget = fs.realpathSync(target);
    const orig = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const result = (orig as (...a: unknown[]) => unknown)(p, ...rest);
      if (!state.fired && String(p) === realTarget) { state.fired = true; swap(); }
      return result;
    }) as typeof fs.statSync);
    return state;
  };

  // ---------------------------------------------------------------- project (--project-dir)

  it("CONTROL project: nested files, binary bytes, the executable bit and in-folder file and directory links bundle byte-identically", () => {
    fs.mkdirSync(path.join(proj, "missions", "m1"), { recursive: true });
    fs.mkdirSync(path.join(proj, "real-dir"));
    fs.writeFileSync(path.join(proj, "missions", "m1", "MISSION.md"), "# mission\n");
    fs.writeFileSync(path.join(proj, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.writeFileSync(path.join(proj, "blob.bin"), Buffer.from([0, 255, 128, 10, 13]));
    fs.writeFileSync(path.join(proj, "real-dir", "inner.md"), "inner\n");
    fs.symlinkSync("SPEC.md", path.join(proj, "SPEC-link.md"));
    fs.symlinkSync("real-dir", path.join(proj, "dir-link"));
    expect(vendorProjectDir(proj, staging)).toEqual({ id: "demo", path: "project" });
    const got = walk(path.join(staging, "project"));
    expect(got).toEqual(["SPEC-link.md", "SPEC.md", "blob.bin", "dir-link/inner.md", "missions/m1/MISSION.md", "project.yaml", "real-dir/inner.md", "run.sh"]);
    const s = (...p: string[]) => path.join(staging, "project", ...p);
    expect(fs.readFileSync(s("blob.bin")).equals(Buffer.from([0, 255, 128, 10, 13]))).toBe(true);
    expect(fs.readFileSync(s("SPEC-link.md"), "utf-8")).toBe("# spec\n");
    expect(fs.readFileSync(s("dir-link", "inner.md"), "utf-8")).toBe("inner\n");
    expect(fs.lstatSync(s("SPEC-link.md")).isSymbolicLink()).toBe(false);
  });

  it("project files keep the source permission bits (the executable bit), as author-tree files do", () => {
    fs.writeFileSync(path.join(proj, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    vendorProjectDir(proj, staging);
    expect(fs.statSync(path.join(staging, "project", "run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(staging, "project", "SPEC.md")).mode & 0o111).toBe(0);
  });

  it("a 40 MiB project file is refused with the per-file cap, not copied", () => {
    bigFile(path.join(proj, "dump.bin"), 40 * MIB);
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorProjectDir(proj, staging)).toThrow(new RegExp(`over the ${VENDORED_FILE_MAX_BYTES}-byte limit`));
    expect(fs.existsSync(path.join(staging, "project", "dump.bin"))).toBe(false);
  });

  it("a project whose files together pass the tree cap is refused", () => {
    // 17 MiB against the 16 MiB project cap; the number is written out so moving the constant moves a row.
    expect(VENDORED_PROJECT_TREE_MAX_BYTES).toBe(16 * MIB);
    for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(proj, `part-${String(i).padStart(2, "0")}.bin`), Buffer.alloc(MIB));
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorProjectDir(proj, staging)).toThrow(/holds more than \d+ bytes of files/);
  });

  it("a symlink to an OUTSIDE EMPTY directory is refused too (no file inside would trip the file check)", () => {
    fs.mkdirSync(path.join(outside, "empty"));
    fs.symlinkSync(path.join(outside, "empty"), path.join(proj, "emptylink"));
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorProjectDir(proj, staging)).toThrow(/directory link .* outside its folder/);
  });

  it("a hard link inside the project to an OUTSIDE file is refused and the outside bytes are not copied", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    fs.linkSync(path.join(outside, "secret.txt"), path.join(proj, "alias.txt"));
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorProjectDir(proj, staging)).toThrow(/hard links/);
    expect(stagedHas(MARKER)).toBe(false);
  });

  it("a directory-link cycle is a named refusal (400), not a RangeError (500)", () => {
    fs.mkdirSync(path.join(proj, "sub"));
    fs.writeFileSync(path.join(proj, "sub", "a.md"), "a\n");
    fs.symlinkSync(path.join(proj, "sub"), path.join(proj, "sub", "loop"));
    let caught: unknown;
    try { vendorProjectDir(proj, staging); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(VendoredFileRefused);
    expect((caught as Error).message).toMatch(/symlink cycle at 'sub\/loop'/);
  });

  it("a 30-level doubled-symlink fan-out is refused by the entry cap (child process, 25 s timeout)", () => {
    // level i holds two links to level i+1: 2^30 paths, no cycle.
    for (let i = 0; i <= 30; i++) fs.mkdirSync(path.join(proj, `l${i}`));
    for (let i = 0; i < 30; i++) {
      fs.symlinkSync(path.join(proj, `l${i + 1}`), path.join(proj, `l${i}`, "a"));
      fs.symlinkSync(path.join(proj, `l${i + 1}`), path.join(proj, `l${i}`, "b"));
    }
    fs.writeFileSync(path.join(proj, "l30", "leaf.md"), "leaf\n");
    const r = child("project", proj);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(new RegExp(`more than ${VENDORED_TREE_MAX_ENTRIES} entries`));
  });

  it.each([
    ["a symlink to an OUTSIDE file", (p: string) => fs.symlinkSync(path.join(outside, "secret.txt"), path.join(p, "leak.txt"))],
    ["a symlink to an OUTSIDE directory", (p: string) => fs.symlinkSync(outside, path.join(p, "leakdir"))],
  ])("%s is refused (400) and no outside bytes are bundled", (_name, make) => {
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    make(proj);
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorProjectDir(proj, staging)).toThrow(/outside its folder/);
    expect(stagedHas(MARKER)).toBe(false);
  });

  it("a FIFO inside the project (writer attached) is refused, not skipped and not read", () => {
    try {
      fifoWithWriter(path.join(proj, "pipe"));
      expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
      expect(() => vendorProjectDir(proj, staging)).toThrow(/not a regular file/);
      expect(stagedHas(MARKER)).toBe(false);
    } finally {
      for (const w of writers.splice(0)) w.kill("SIGKILL");
    }
  });

  it("a FIFO inside the project (NO writer) is refused promptly (child process, 25 s timeout)", () => {
    execFileSync("mkfifo", [path.join(proj, "pipe")]);
    const r = child("project", proj);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
  });

  it("project.yaml swapped for an oversize file between the stat and the read is refused (stat-then-read window)", () => {
    const state = swapAfterStat(path.join(proj, "project.yaml"), () => {
      fs.unlinkSync(path.join(proj, "project.yaml"));
      fs.writeFileSync(path.join(proj, "project.yaml"), `id: demo\n# ${"x".repeat(2 * MIB)}\n`);
    });
    expect(() => vendorProjectDir(proj, staging)).toThrow(VendoredFileRefused);
    expect(state.fired).toBe(true);
    expect(fs.existsSync(path.join(staging, "project"))).toBe(false);
  });

  it("project.yaml swapped for a symlink to a FIFO with NO writer between the stat and the read does not stall (child process)", () => {
    const fifo = path.join(outside, "pipe");
    execFileSync("mkfifo", [fifo]);
    const r = child("project-swap", proj, fifo);
    expect(r.fired).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
  });

  // ---------------------------------------------------------------- context pack (--context-pack)

  it("CONTROL pack: every built-in context pack bundles its manifest and declared files byte-identically", () => {
    const srcRoot = path.join(import.meta.dirname, "..", "context-packs-src");
    // The source tree carries repo-relative symlinks (`help/help.md -> ../../../../docs/...`) that are replaced by
    // copies when the packs are built; a pack with one leaves its folder at base too, so it is not a control.
    const hasLink = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isSymbolicLink() || (e.isDirectory() && hasLink(path.join(d, e.name))));
    const packs = fs.readdirSync(srcRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(srcRoot, e.name, "manifest.yaml")) && !hasLink(path.join(srcRoot, e.name)));
    expect(packs.length).toBeGreaterThanOrEqual(2);
    for (const entry of packs) {
      const dir = path.join(srcRoot, entry.name);
      const stage = fs.mkdtempSync(path.join(work, "stage-"));
      const declared = vendorContextPackDir(dir, stage);
      const bundled = path.join(stage, path.dirname(declared));
      const files = walk(bundled);
      expect(files).toContain("manifest.yaml");
      for (const f of files) expect(fs.readFileSync(path.join(bundled, f)).equals(fs.readFileSync(path.join(dir, f))), `${entry.name}/${f}`).toBe(true);
    }
  });

  it("CONTROL pack: a fixture pack carries only its manifest and declared files", () => {
    fs.writeFileSync(path.join(pack, "README.md"), "not part of the pack\n");
    expect(vendorContextPackDir(pack, staging)).toBe("context-packs/demo-world/manifest.yaml");
    expect(walk(staging)).toEqual(["context-packs/demo-world/craft/how.md", "context-packs/demo-world/identity/who.md", "context-packs/demo-world/manifest.yaml"]);
  });

  it("pack files keep the source permission bits", () => {
    fs.chmodSync(path.join(pack, "craft", "how.md"), 0o755);
    vendorContextPackDir(pack, staging);
    expect(fs.statSync(path.join(staging, "context-packs/demo-world/craft/how.md")).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(staging, "context-packs/demo-world/identity/who.md")).mode & 0o111).toBe(0);
  });

  it("a 40 MiB declared pack file is refused with the per-file cap, not copied", () => {
    bigFile(path.join(pack, "identity", "who.md"), 40 * MIB);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/byte limit/);
    expect(walk(staging)).toEqual([]);
  });

  it("a pack whose declared files together pass the pack cap is refused", () => {
    expect(VENDORED_CONTEXT_PACK_MAX_BYTES).toBe(8 * MIB);
    const n = 9;
    const lines = ["name: demo-world", "version: 0.1.0", "taxonomy: world", "files:"];
    for (let i = 0; i < n; i++) { lines.push(`  - path: craft/p${i}.md`, "    role: craft"); fs.writeFileSync(path.join(pack, "craft", `p${i}.md`), Buffer.alloc(MIB - 1, 97)); }
    fs.writeFileSync(path.join(pack, "manifest.yaml"), lines.join("\n") + "\n");
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/holds more than \d+ bytes of files/);
  });

  it("manifest.yaml over the per-file cap is refused", () => {
    fs.writeFileSync(path.join(pack, "manifest.yaml"), `${PACK_MANIFEST}# ${"x".repeat(2 * MIB)}\n`);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/byte limit/);
  });

  it("a manifest.yaml that is a hard link to an OUTSIDE file is refused", () => {
    fs.writeFileSync(path.join(outside, "m.yaml"), PACK_MANIFEST);
    fs.rmSync(path.join(pack, "manifest.yaml"));
    fs.linkSync(path.join(outside, "m.yaml"), path.join(pack, "manifest.yaml"));
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/hard links/);
  });

  it("a declared pack file that is a hard link to an OUTSIDE file is refused and the outside bytes are not copied", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    fs.rmSync(path.join(pack, "identity", "who.md"));
    fs.linkSync(path.join(outside, "secret.txt"), path.join(pack, "identity", "who.md"));
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/hard links/);
    expect(stagedHas(MARKER)).toBe(false);
  });

  it("a declared pack file that is a symlink to an OUTSIDE file is refused (400)", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    fs.rmSync(path.join(pack, "identity", "who.md"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(pack, "identity", "who.md"));
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(() => vendorContextPackDir(pack, staging)).toThrow(/outside the pack directory/);
    expect(stagedHas(MARKER)).toBe(false);
  });

  it("a declared pack file swapped for an oversize file between the stat and the read is refused (stat-then-read window)", () => {
    const state = swapAfterStat(path.join(pack, "identity", "who.md"), () => {
      fs.unlinkSync(path.join(pack, "identity", "who.md"));
      fs.writeFileSync(path.join(pack, "identity", "who.md"), Buffer.alloc(2 * MIB, 97));
    });
    expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
    expect(state.fired).toBe(true);
    expect(walk(staging)).toEqual([]);
  });

  it("a declared pack file swapped for a FIFO with a writer between the stat and the read is refused, not read", () => {
    try {
      const fifo = path.join(outside, "pipe");
      fifoWithWriter(fifo);
      const state = swapAfterStat(path.join(pack, "identity", "who.md"), () => {
        fs.unlinkSync(path.join(pack, "identity", "who.md"));
        fs.symlinkSync(fifo, path.join(pack, "identity", "who.md"));
      });
      expect(() => vendorContextPackDir(pack, staging)).toThrow(VendoredFileRefused);
      expect(state.fired).toBe(true);
      expect(stagedHas(MARKER)).toBe(false);
    } finally {
      for (const w of writers.splice(0)) w.kill("SIGKILL");
    }
  });

  it("manifest.yaml swapped for a symlink to a FIFO with NO writer between the stat and the read does not stall (child process)", () => {
    const fifo = path.join(outside, "pipe");
    execFileSync("mkfifo", [fifo]);
    const r = child("pack-manifest-swap", pack, fifo);
    expect(r.fired).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
  });

  it("a declared pack file swapped for a symlink to a FIFO with NO writer between the stat and the read does not stall (child process)", () => {
    const fifo = path.join(outside, "pipe");
    execFileSync("mkfifo", [fifo]);
    const r = child("pack-swap", pack, fifo);
    expect(r.fired).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
  });
});
