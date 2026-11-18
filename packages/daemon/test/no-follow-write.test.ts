import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

  // workspaces-o9o.123 round 2 (verify-sec2 F2): O_NOFOLLOW stops a SYMBOLIC link but not a HARD link. The writer fstats the fd and
  // refuses a file with more than one link (nlink>1) before truncating, so an attacker's hard link to another file is not written through.
  it("refuses a hard link (nlink>1) and leaves the other name's content untouched", () => {
    const victim = path.join(root, "victim.json");
    const hard = path.join(root, "hardlink.json");
    fs.writeFileSync(victim, '{"theirs":true}');
    fs.linkSync(victim, hard);                                   // a second hard link to the same inode
    expect(fs.statSync(hard).nlink).toBe(2);
    expect(() => writeFileNoFollow(hard, '{"x":1}')).toThrow(/hard link|nlink/i);
    expect(fs.readFileSync(victim, "utf8")).toBe('{"theirs":true}');   // not truncated, not written
    expect(fs.readFileSync(hard, "utf8")).toBe('{"theirs":true}');
  });

  it("refuses a non-regular file: a character device (/dev/null) is not written through", () => {
    if (process.platform === "win32" || !fs.existsSync("/dev/null")) return;   // NOT RUN without a POSIX /dev/null (names its condition)
    expect(fs.statSync("/dev/null").isCharacterDevice()).toBe(true);
    expect(() => writeFileNoFollow("/dev/null", "{}")).toThrow(/not a regular file|regular file/i);
  });

  it("refuses a FIFO without blocking the daemon (O_NONBLOCK): a FIFO with no reader is not opened for writing", () => {
    const fifo = path.join(root, "fifo");
    try { execFileSync("mkfifo", [fifo]); } catch { return; }    // NOT RUN where mkfifo is unavailable (names its condition)
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    // O_WRONLY|O_NONBLOCK on a reader-less FIFO returns ENXIO; either way the write is refused, and it never blocks.
    expect(() => writeFileNoFollow(fifo, "{}")).toThrow(/ENXIO|not a regular file|regular file/i);
  });

  it("is the write startup.ts gives the Claude adapter", () => {
    const startup = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain('import { writeFileNoFollow } from "./adapters/no-follow-write.js";');
    expect(startup).toMatch(/new ClaudeCodeAdapter\(\{[^\n]*fsOps: \{[^\n]*writeFileNoFollow,/);
  });
});
