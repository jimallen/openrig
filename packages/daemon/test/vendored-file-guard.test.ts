// Unit rows for vendored-file-guard.ts and the assembler seam it plugs into. The route-level rows (a real
// symlink, FIFO, oversize file through /api/bundles/create) are in bundle-create-vendor-guard.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VENDORED_FILE_MAX_BYTES, VENDORED_TREE_MAX_BYTES, VENDORED_FILE_KIND, VendoredFileRefused, VendoredFileUnavailable, VendoredTreeBudget,
  checkVendoredFile, isInsideRoot, readContainedVendoredFile, type VendoredReadDeps,
} from "../src/domain/vendored-file-guard.js";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";

describe("vendored-file-guard constants", () => {
  it("pins the caps the route rows hard-code (1 MiB per file, 8 MiB per folder) and the shared kind", () => {
    expect(VENDORED_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(VENDORED_TREE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(VENDORED_FILE_KIND.maxBytes).toBe(VENDORED_FILE_MAX_BYTES);
  });
});

describe("isInsideRoot", () => {
  it.each([
    ["/r", "/r", true], ["/r", "/r/a/b", true], ["/r", "/r2", false], ["/r", "/rx/a", false], ["/r/a", "/r", false], ["/r", "/elsewhere", false],
  ])("root %s target %s -> %s", (root, target, want) => expect(isInsideRoot(root, target)).toBe(want));
});

describe("readContainedVendoredFile", () => {
  const ok = (realPath: string, text = "x") => ({ ok: true as const, realPath, bytes: text.length, content: text, raw: Buffer.from(text) });
  const deps = (over: Partial<VendoredReadDeps>): VendoredReadDeps => ({ realpath: p => p, check: (_r, p) => ok(p), ...over });

  it("returns the guarded bytes for a file inside the root", () => {
    expect(Buffer.from(readContainedVendoredFile(deps({}), "/root", "a", "/root/a")).toString()).toBe("x");
  });

  it("refuses BEFORE reading when the real path is outside the root (the outside file is never opened)", () => {
    let opened = false;
    const d = deps({ realpath: () => "/outside/f", check: () => { opened = true; return ok("/outside/f"); } });
    expect(() => readContainedVendoredFile(d, "/root", "a", "/root/a")).toThrow(/outside its folder \/root/);
    expect(opened).toBe(false);
  });

  it("refuses when the file the guarded read ACTUALLY opened is outside (a link retargeted after the first check)", () => {
    const d = deps({ check: () => ok("/outside/f") });
    expect(() => readContainedVendoredFile(d, "/root", "a", "/root/a")).toThrow(/outside its folder \/root/);
  });

  it("with no root only the guard applies", () => {
    expect(Buffer.from(readContainedVendoredFile(deps({ realpath: () => "/anywhere" }), null, "a", "/x/a")).toString()).toBe("x");
  });

  it("maps an unresolvable path to a VendoredFileUnavailable (NOT a policy refusal) carrying the errno code", () => {
    const d = deps({ realpath: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
    try { readContainedVendoredFile(d, "/root", "a", "/root/a"); throw new Error("did not throw"); } catch (error) {
      expect(error).toBeInstanceOf(VendoredFileUnavailable);
      expect(error).not.toBeInstanceOf(VendoredFileRefused);
      expect((error as VendoredFileUnavailable).code).toBe("ENOENT");
    }
  });

  it.each([["not_found", "ENOENT"], ["unreadable", "EACCES"]] as const)("a %s result from the guard becomes VendoredFileUnavailable with code %s", (reason, code) => {
    const d = deps({ check: () => ({ ok: false as const, reason, message: `unavailable ${reason}` }) });
    try { readContainedVendoredFile(d, "/root", "a", "/root/a"); throw new Error("did not throw"); } catch (error) {
      expect(error).toBeInstanceOf(VendoredFileUnavailable);
      expect(error).not.toBeInstanceOf(VendoredFileRefused);
      expect((error as VendoredFileUnavailable).message).toBe(`unavailable ${reason}`);
      expect((error as VendoredFileUnavailable).code).toBe(code);
    }
  });

  it.each(["not_regular_file", "too_large", "hard_linked", "changed"] as const)("a %s result from the guard becomes a VendoredFileRefused (policy, 400)", (reason) => {
    const d = deps({ check: () => ({ ok: false as const, reason, message: `refused ${reason}` }) });
    try { readContainedVendoredFile(d, "/root", "a", "/root/a"); throw new Error("did not throw"); } catch (error) {
      expect(error).toBeInstanceOf(VendoredFileRefused);
      expect((error as VendoredFileRefused).message).toBe(`refused ${reason}`);
    }
  });
});

describe("VendoredTreeBudget", () => {
  it("allows exactly the cap and refuses one byte over", () => {
    const b = new VendoredTreeBudget("folder", 10);
    b.take(4); b.take(6);
    expect(() => b.take(1)).toThrow(VendoredFileRefused);
  });
  it("is cumulative across files", () => {
    const b = new VendoredTreeBudget("folder", 10);
    b.take(6);
    expect(() => b.take(5)).toThrow(/folder holds more than 10 bytes/);
  });
});

describe("assembler seam over a real filesystem", () => {
  let tmp: string;
  let persona: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vendored-guard-unit-")));
    persona = path.join(tmp, "agents", "impl");
    fs.mkdirSync(persona, { recursive: true });
    fs.writeFileSync(path.join(persona, "agent.yaml"), ["name: impl-agent", 'version: "1.0.0"', "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []"].join("\n"));
    fs.writeFileSync(path.join(tmp, "rig.yaml"), ['version: "0.2"', "name: r", "pods:", "  - id: dev", "    label: dev", "    members:", "      - id: impl", '        agent_ref: "local:agents/impl"', "        profile: default", "        runtime: claude-code", "        cwd: .", "    edges: []", "edges: []"].join("\n"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const walk = (dir: string, prefix = ""): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
  const fsOps = (withSeam: boolean) => ({
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p: string) => fs.readFileSync(p),
    ...(withSeam ? { readVendoredFile: (r: string, p: string) => checkVendoredFile(r, p) } : {}),
    realpath: (p: string) => fs.realpathSync(p),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    writeFile: (p: string, c: string | Uint8Array) => { fs.writeFileSync(p, c); },
    copyDir: () => {},
    listFiles: (dir: string) => walk(dir),
  }) as unknown as PodAssemblerFsOps;
  const assemble = (withSeam: boolean) => new PodBundleAssembler({ fsOps: fsOps(withSeam) }).assemble({ rigRoot: tmp, rigSpecPath: path.join(tmp, "rig.yaml"), outputDir: path.join(tmp, "staged"), bundleName: "b", bundleVersion: "1.0.0" });

  it("with the seam wired a symlink to an outside file throws the typed VendoredFileRefused (the route maps it to 400)", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-guard-out-"));
    try {
      fs.writeFileSync(path.join(out, "s.txt"), "outside");
      fs.symlinkSync(path.join(out, "s.txt"), path.join(persona, "leak.txt"));
      expect(() => assemble(true)).toThrow(VendoredFileRefused);
      expect(fs.existsSync(path.join(tmp, "staged", "agents", "impl-agent", "leak.txt"))).toBe(false);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  it("CONTROL: with the seam wired a normal folder vendors; without it (in-memory test filesystems) the plain read is used", () => {
    fs.writeFileSync(path.join(persona, "notes.md"), "notes");
    for (const seam of [true, false]) {
      fs.rmSync(path.join(tmp, "staged"), { recursive: true, force: true });
      assemble(seam);
      expect(fs.readFileSync(path.join(tmp, "staged", "agents", "impl-agent", "notes.md"), "utf-8")).toBe("notes");
    }
  });

  it("the folder total cap applies without the seam too (it counts the bytes actually read)", () => {
    const each = VENDORED_FILE_MAX_BYTES - 1024;
    const n = Math.floor(VENDORED_TREE_MAX_BYTES / each) + 1;
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(persona, `p${i}.bin`), Buffer.alloc(each, 0x61));
    expect(() => assemble(false)).toThrow(/holds more than 8388608 bytes/);
  });
});
