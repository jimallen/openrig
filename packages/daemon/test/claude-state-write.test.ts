import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { writeGuardedClaudeState, type GuardedStateFs } from "../src/adapters/claude-state-write.js";

// workspaces-o9o.176: the one symlink-safe write both the onboarding/trust bootstrap and the Code Mode answer go through (verify-sec2).
// Real files and real links: it never writes through a linked file or a linked guard directory, refuses a file system that cannot check,
// and otherwise merges and writes without following a link.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-write-")));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function realFs(): GuardedStateFs {
  return {
    readJsonObject: (p) => { const v = JSON.parse(fs.readFileSync(p, "utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("state must be a JSON object; existing state preserved."); return v as Record<string, unknown>; },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    lstat: (p) => { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : st.isDirectory() ? "directory" : "other"; } catch { return null; } },
    writeFileNoFollow: (p, text) => { const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600); try { fs.writeFileSync(fd, text, "utf8"); } finally { fs.closeSync(fd); } },
  };
}
const setTrue = (k: string) => (state: Record<string, unknown>) => { if (state[k] === true) return { changed: false }; state[k] = true; return { changed: true }; };
let n = 0;
const dir = () => { const d = path.join(root, `c${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };

describe("writeGuardedClaudeState", () => {
  it("creates an absent state file (0600) and writes only when the mutation changed it", () => {
    const sp = path.join(dir(), ".claude.json");
    expect(writeGuardedClaudeState(realFs(), sp, { subject: "x", mutate: setTrue("ok") })).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(sp, "utf8"))).toEqual({ ok: true });
    expect(fs.statSync(sp).mode & 0o777).toBe(0o600);
    // A no-op mutation does not rewrite the file.
    const before = fs.readFileSync(sp, "utf8");
    expect(writeGuardedClaudeState(realFs(), sp, { subject: "x", mutate: setTrue("ok") })).toEqual({ ok: true });
    expect(fs.readFileSync(sp, "utf8")).toBe(before);
  });

  it("preserves every existing field, adding only what the mutation sets", () => {
    const sp = path.join(dir(), ".claude.json");
    fs.writeFileSync(sp, JSON.stringify({ keep: { a: 1 }, theme: "x" }));
    writeGuardedClaudeState(realFs(), sp, { subject: "x", mutate: setTrue("hasCompletedOnboarding") });
    expect(JSON.parse(fs.readFileSync(sp, "utf8"))).toEqual({ keep: { a: 1 }, theme: "x", hasCompletedOnboarding: true });
  });

  it("refuses a symlinked state file as a guard refusal carrying the file: the target is untouched, and the message names it and the subject", () => {
    const d = dir();
    const sp = path.join(d, ".claude.json");
    const target = path.join(d, "target.json");
    fs.writeFileSync(target, JSON.stringify({ theirs: true }));
    fs.symlinkSync(target, sp);
    const outcome = writeGuardedClaudeState(realFs(), sp, { subject: "the Claude onboarding and trust state", mutate: setTrue("hasCompletedOnboarding") });
    expect(outcome).toEqual({ ok: false, refused: true, path: sp, message: `${sp} is a symbolic link, so the Claude onboarding and trust state was not written; OpenRig never writes through a link` });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ theirs: true });
  });

  it("refuses a guard directory that is a symbolic link (a seat home redirected), before touching the file — a refusal carrying the dir", () => {
    const d = dir();
    const elsewhere = path.join(d, "elsewhere"); fs.mkdirSync(elsewhere);
    const seatHome = path.join(d, "home"); fs.symlinkSync(elsewhere, seatHome);
    const sp = path.join(seatHome, ".claude.json");
    const outcome = writeGuardedClaudeState(realFs(), sp, { subject: "Code Mode's one-time answer", prefix: "code_mode: ", guardDirs: [seatHome], mutate: setTrue("x") });
    expect(outcome).toEqual({ ok: false, refused: true, path: seatHome, message: `code_mode: ${seatHome} is a symbolic link, so Code Mode's one-time answer was not written; OpenRig never writes through a link` });
    expect(fs.existsSync(path.join(elsewhere, ".claude.json"))).toBe(false);
  });

  it("refuses a file that exists but is not a regular file — a guard refusal carrying the path", () => {
    const d = dir();
    const sp = path.join(d, ".claude.json"); fs.mkdirSync(sp);   // a directory where the state file should be
    const outcome = writeGuardedClaudeState(realFs(), sp, { subject: "s", mutate: setTrue("x") });
    expect(outcome).toEqual({ ok: false, refused: true, path: sp, message: `${sp} is not a file, so s was not written` });
  });

  it("fails closed (writes nothing) when the file system cannot check for or write without following a link — a non-fatal reason, not a detected refusal", () => {
    const sp = path.join(dir(), ".claude.json");
    const bare: GuardedStateFs = { readJsonObject: () => ({}), mkdirp: () => {} };     // no lstat, no writeFileNoFollow
    expect(writeGuardedClaudeState(bare, sp, { subject: "s", mutate: setTrue("x") }))
      .toEqual({ ok: false, refused: false, message: `${sp} was not written: this file system cannot check for or refuse a symbolic link` });
    expect(fs.existsSync(sp)).toBe(false);
  });

  it("a mutation that reports a warning stops the write and returns it as a non-fatal reason (a kept answer)", () => {
    const sp = path.join(dir(), ".claude.json");
    fs.writeFileSync(sp, JSON.stringify({ a: 1 }));
    const outcome = writeGuardedClaudeState(realFs(), sp, { subject: "s", mutate: () => ({ changed: false, warning: "kept" }) });
    expect(outcome).toEqual({ ok: false, refused: false, message: "kept" });
    expect(JSON.parse(fs.readFileSync(sp, "utf8"))).toEqual({ a: 1 });
  });

  it("a mutation that throws (malformed state) is returned as a non-fatal reason naming the file, never a guard refusal", () => {
    const sp = path.join(dir(), ".claude.json");
    fs.writeFileSync(sp, JSON.stringify([1, 2]));                // not an object
    const outcome = writeGuardedClaudeState(realFs(), sp, { subject: "the Claude onboarding and trust state", mutate: () => ({ changed: true }) });
    expect(outcome).toEqual({ ok: false, refused: false, message: `${sp} was not written: state must be a JSON object; existing state preserved.` });
  });
});
