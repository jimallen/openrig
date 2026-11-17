// workspaces-o9o.52: a rig spec's culture_file may name a file in the RUNNING install's specs folder (`shipped:<relative>`), so one kernel
// spec serves every host whatever its install prefix. The root is the install's own (runningShippedSpecsRoot), the lexical AND real target
// must stay inside it, and the file is recorded as typed under the install with the specs folder as its owner, so a moved or upgraded
// install is followed by the existing re-anchoring.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { checkCultureFile, resolveCultureFile } from "../src/domain/culture-file-guard.js";
import { reanchorBuiltinStartupFile, runningShippedSpecsRoot } from "../src/domain/builtin-startup-files.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(nodePath.join(tmpdir(), "o9o52-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fake install's specs folder holding rigs/k/culture/CULTURE.md, and a secret file beside (outside) it. */
function install() {
  const base = temp();
  const specs = nodePath.join(base, "lib", "node_modules", "@openrig", "cli", "daemon", "specs");
  mkdirSync(nodePath.join(specs, "rigs", "k", "culture"), { recursive: true });
  writeFileSync(nodePath.join(specs, "rigs", "k", "culture", "CULTURE.md"), "# Kernel culture\n");
  writeFileSync(nodePath.join(base, "outside.md"), "# not the install's\n");
  return { base, specs };
}

describe("resolveCultureFile", () => {
  it("a plain culture_file resolves under the rig root, owned by the rig root, as before", () => {
    const rigRoot = temp();
    writeFileSync(nodePath.join(rigRoot, "CULTURE.md"), "x\n");
    expect(resolveCultureFile("CULTURE.md", rigRoot, "/nonexistent")).toMatchObject({ ok: true, shipped: false, ownerRoot: rigRoot, absolutePath: nodePath.join(rigRoot, "CULTURE.md") });
  });

  it("a shipped: culture_file resolves in the install's specs folder, recorded as typed and owned by that folder", () => {
    const { specs } = install();
    const target = resolveCultureFile("shipped:rigs/k/culture/CULTURE.md", "/some/rig/root", specs);
    expect(target).toEqual({ ok: true, shipped: true, ownerRoot: specs, absolutePath: nodePath.join(specs, "rigs/k/culture/CULTURE.md") });
  });

  it("the default root is the running install's own specs folder", () => {
    const target = resolveCultureFile("shipped:rigs/launch/kernel/culture/CULTURE.md", "/some/rig/root");
    expect(target).toMatchObject({ ok: true, ownerRoot: runningShippedSpecsRoot(), absolutePath: nodePath.join(runningShippedSpecsRoot(), "rigs/launch/kernel/culture/CULTURE.md") });
  });

  it("a symlink inside the specs folder that points OUT of it is refused", () => {
    const { base, specs } = install();
    symlinkSync(nodePath.join(base, "outside.md"), nodePath.join(specs, "rigs", "k", "escape.md"));
    const target = resolveCultureFile("shipped:rigs/k/escape.md", "/r", specs);
    expect(target.ok).toBe(false);
    expect(JSON.stringify(target)).toContain("outside");
  });

  it("an install reached through a symlink (an npm global link) resolves, and its file is read through the guarded reader", () => {
    const { specs } = install();
    const link = nodePath.join(temp(), "linked-specs");
    symlinkSync(specs, link);
    const target = resolveCultureFile("shipped:rigs/k/culture/CULTURE.md", "/r", link);
    expect(target).toMatchObject({ ok: true, ownerRoot: link, absolutePath: nodePath.join(link, "rigs/k/culture/CULTURE.md") });
    if (!target.ok) throw new Error("unreachable");
    const read = checkCultureFile("shipped:rigs/k/culture/CULTURE.md", target.absolutePath);
    expect(read.ok && read.content).toBe("# Kernel culture\n");
  });

  it.each([
    ["an empty path", "shipped:", "must name a file"],
    ["an absolute path", "shipped:/etc/hosts", "must be a path relative"],
    ["a climb out", "shipped:rigs/../../x.md", "must stay inside"],
  ])("refuses %s", (_name, ref, message) => {
    const target = resolveCultureFile(ref, "/r", install().specs);
    expect(target.ok).toBe(false);
    expect(JSON.stringify(target)).toContain(message);
  });
});

describe("a recorded shipped: culture follows a moved install (re-anchoring)", () => {
  it("a file recorded under another packaged install's specs, owned by those specs, is re-anchored onto the running install", () => {
    const old = install();
    const running = install();
    const recorded = resolveCultureFile("shipped:rigs/k/culture/CULTURE.md", "/r", old.specs);
    if (!recorded.ok) throw new Error(recorded.message);
    const moved = reanchorBuiltinStartupFile({ path: "shipped:rigs/k/culture/CULTURE.md", absolutePath: recorded.absolutePath, ownerRoot: recorded.ownerRoot }, undefined, running.specs);
    expect(moved.absolutePath).toBe(nodePath.join(running.specs, "rigs/k/culture/CULTURE.md"));
  });
});

describe("the rig spec validator", () => {
  const spec = (culture: string) => ({ version: "0.2", name: "k", culture_file: culture, pods: [] });
  it("accepts a shipped: culture_file", () => {
    // The fixture has no pods (that has its own error); only culture_file is judged here.
    expect(PodRigSpecSchema.validate(spec("shipped:rigs/launch/kernel/culture/CULTURE.md")).errors.filter((e) => e.startsWith("culture_file"))).toEqual([]);
  });
  it.each(["shipped:", "shipped:/etc/hosts", "shipped:a/../../b"])("refuses %j", (culture) => {
    expect(PodRigSpecSchema.validate(spec(culture)).errors.join("\n")).toMatch(/culture_file: a shipped: culture_file/);
  });
});
