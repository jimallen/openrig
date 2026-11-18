import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileNoFollow } from "../src/adapters/no-follow-write.js";

// workspaces-o9o.123 (verify-sec2, finding 2): Code Mode's one-time answer is written into a seat's .claude.json without following a
// symbolic link there, so a link swapped in after the adapter's lstat check cannot redirect the write. Real files, real links.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-follow-write-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("writeFileNoFollow (the Claude adapter's write for Code Mode's answer)", () => {
  it("refuses a symbolic link at the path and leaves its target untouched", () => {
    const target = path.join(root, "target.json");
    const link = path.join(root, "link.json");
    fs.writeFileSync(target, '{"shared":true}');
    fs.symlinkSync(target, link);
    expect(() => writeFileNoFollow(link, '{"x":1}')).toThrow(/ELOOP/);
    expect(fs.readFileSync(target, "utf8")).toBe('{"shared":true}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a dangling link too (it would otherwise create the target)", () => {
    const link = path.join(root, "dangling.json");
    const target = path.join(root, "would-be-created.json");
    fs.symlinkSync(target, link);
    expect(() => writeFileNoFollow(link, "{}")).toThrow(/ELOOP/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("creates a new file 0600 and replaces an existing regular file's content", () => {
    const fresh = path.join(root, "fresh.json");
    writeFileNoFollow(fresh, '{"a":1}');
    expect(fs.readFileSync(fresh, "utf8")).toBe('{"a":1}');
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
    writeFileNoFollow(fresh, '{"b":2}');
    expect(fs.readFileSync(fresh, "utf8")).toBe('{"b":2}');
  });

  it("is the write startup.ts gives the Claude adapter", () => {
    const startup = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain('import { writeFileNoFollow } from "./adapters/no-follow-write.js";');
    expect(startup).toMatch(/new ClaudeCodeAdapter\(\{[^\n]*fsOps: \{[^\n]*writeFileNoFollow,/);
  });
});
