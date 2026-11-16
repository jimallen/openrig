// workspaces-o9o.17, verify-sec review: a managed file is replaced atomically. A write that fails part-way (ENOSPC after
// 5 bytes, as the review simulated) must leave the old file whole and no temp behind; startup logs a failed refresh and
// carries on, so a truncated file would reach every seat started that boot. Real temp directories; only the write that
// fails is simulated.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";

const failing = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  /** When armed: write the first 5 bytes, then fail the way a full disk does. */
  const writeFileSync: typeof real.writeFileSync = (file, data, options) => {
    if (!failing.armed) return real.writeFileSync(file, data, options);
    const partial = String(data).slice(0, 5);
    if (typeof file === "number") real.writeSync(file, partial);
    else real.writeFileSync(file, partial);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});

import * as fs from "node:fs";
import { nodePluginVendorFs } from "../src/adapters/plugin-vendor-fs.js";

const made: string[] = [];
afterEach(() => {
  failing.armed = false;
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o17-atomic-"));
  made.push(d);
  return d;
}

describe("o9o.17 (verify-sec review): the vendor adapter replaces a managed file atomically", () => {
  it("a write that fails part-way leaves the old file whole and no temp behind", () => {
    const d = dir();
    const target = nodePath.join(d, "claude.json");
    fs.writeFileSync(target, "the old, complete manifest\n");
    failing.armed = true;
    expect(() => nodePluginVendorFs().writeFile(target, "the new, complete manifest\n")).toThrow(/ENOSPC/);
    failing.armed = false;
    expect(fs.readFileSync(target, "utf-8")).toBe("the old, complete manifest\n");
    expect(fs.readdirSync(d)).toEqual(["claude.json"]);
  });

  it("a new file whose write fails is not created, and no temp is left", () => {
    const d = dir();
    failing.armed = true;
    expect(() => nodePluginVendorFs().writeFile(nodePath.join(d, "guard.cjs"), "// guard\n")).toThrow(/ENOSPC/);
    failing.armed = false;
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it("positive control: a write that succeeds replaces the file with the given mode, and no temp is left", () => {
    const d = dir();
    const target = nodePath.join(d, "guard.cjs");
    fs.writeFileSync(target, "old\n");
    nodePluginVendorFs().writeFile(target, "new\n", 0o755);
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(d)).toEqual(["guard.cjs"]);
  });

  it("a symlink at the target is replaced by the file, and its outside target is untouched", () => {
    const d = dir();
    const outside = nodePath.join(dir(), "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    const target = nodePath.join(d, "claude.json");
    fs.symlinkSync(outside, target);
    nodePluginVendorFs().writeFile(target, "new\n");
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
    expect(fs.readFileSync(outside, "utf-8")).toBe("outside\n");
  });
});
