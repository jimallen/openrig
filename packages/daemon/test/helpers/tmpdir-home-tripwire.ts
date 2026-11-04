// OF-225: a delivery test that hands an adapter `os.tmpdir()` as its home makes the adapter write the host's
// `<tmpdir>/.claude.json` (a trust key per case) and `<tmpdir>/.codex/config.toml`. Nothing failed, so it went on for
// months. This is the tripwire: call it inside a `describe`, and every case in that block is judged afterwards.
//
// Design (stat only, never contents: a .claude.json can hold account data):
//  - `os.tmpdir()` follows `process.env.TMPDIR` on POSIX, read on every call. For the block, TMPDIR points at a fresh
//    private folder, so "the tmpdir" the code under test sees is this run's own. A write by a case lands there; a
//    concurrent run (a release run, a base checkout still on the old code) writes to ITS tmpdir and cannot trip this.
//    That is the whole false-positive story: the guard never looks at the host's shared /tmp.
//  - after each case the two files are stat'ed (exists, size, mtime, inode) against the snapshot taken before the
//    previous case (the first case against the snapshot before the block), and a difference fails THAT case, naming the test and the file.
// What it does not cover: a case outside the block, and a write by a child process given an explicit TMPDIR/HOME of
// its own. Those are read by the sweep in the OF-225 PR, not by this guard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect } from "vitest";

export const TMPDIR_HOME_FILES = [".claude.json", path.join(".codex", "config.toml")] as const;

export type FileStat = { size: number; mtimeMs: number; ino: number } | null;

export function statHomeFiles(dir: string): Record<string, FileStat> {
  const out: Record<string, FileStat> = {};
  for (const rel of TMPDIR_HOME_FILES) {
    try {
      const s = fs.lstatSync(path.join(dir, rel));
      out[rel] = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

/** The files whose stat differs between two snapshots, as `<rel>: <before> -> <after>` lines. */
export function changedHomeFiles(before: Record<string, FileStat>, after: Record<string, FileStat>): string[] {
  const show = (s: FileStat) => (s ? `exists size=${s.size} mtimeMs=${s.mtimeMs} ino=${s.ino}` : "absent");
  return TMPDIR_HOME_FILES.filter((rel) => JSON.stringify(before[rel]) !== JSON.stringify(after[rel]))
    .map((rel) => `${rel}: ${show(before[rel] ?? null)} -> ${show(after[rel] ?? null)}`);
}

export function guardTmpdirHomeFiles(): void {
  let privateTmp = "";
  let savedTmpdir: string | undefined;
  let before: Record<string, FileStat> = {};
  beforeAll(() => {
    savedTmpdir = process.env["TMPDIR"];
    privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "or-tmphome-guard-"));
    process.env["TMPDIR"] = privateTmp;
    before = statHomeFiles(os.tmpdir());
  });
  afterEach(() => {
    const now = statHomeFiles(os.tmpdir());
    const changed = changedHomeFiles(before, now);
    before = now; // the next case is judged against this one, so only the case that wrote is blamed, not every case after it
    expect(changed, `"${expect.getState().currentTestName}" wrote a home-relative file into os.tmpdir() (${os.tmpdir()}); give the adapter a per-test home instead: ${changed.join("; ")}`).toEqual([]);
  });
  afterAll(() => {
    if (savedTmpdir === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = savedTmpdir;
    fs.rmSync(privateTmp, { recursive: true, force: true });
  });
}
