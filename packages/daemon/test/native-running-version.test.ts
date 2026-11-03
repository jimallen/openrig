// OF-212: the two OS reads behind a replaced Claude binary: the running version from the process's own transcript, and
// `claude` found on a PATH. Real files in a private temp dir; nothing reaches a live seat or process.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnPath, transcriptRunningVersion } from "../src/adapters/native-inbox-os.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "of212-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const rec = (version: string | undefined, timestamp: string) => JSON.stringify({ type: "assistant", ...(version === undefined ? {} : { version }), timestamp });
const START = new Date("2026-11-03T09:27:42.000Z");

describe("transcriptRunningVersion", () => {
  function transcript(lines: string[]): string { const p = join(tmp(), "t.jsonl"); writeFileSync(p, lines.join("\n") + "\n"); return p; }

  it("the newest stamped record on or after the start names the version, whatever older records say", () => {
    const p = transcript([rec("2.1.316", "2026-11-03T08:00:00.000Z"), rec("2.1.317", "2026-11-03T09:28:00.000Z"), rec(undefined, "2026-11-03T09:29:00.000Z")]);
    expect(transcriptRunningVersion(p, START)).toBe("2.1.317");
  });

  it("a record exactly at the start counts; one a millisecond before does not", () => {
    expect(transcriptRunningVersion(transcript([rec("2.1.317", START.toISOString())]), START)).toBe("2.1.317");
    expect(transcriptRunningVersion(transcript([rec("2.1.317", "2026-11-03T09:27:41.999Z")]), START)).toBeNull();
  });

  it("only records of an earlier process (all before the start) name nothing: a resumed transcript is not this process's word", () => {
    expect(transcriptRunningVersion(transcript([rec("2.1.316", "2026-11-03T08:00:00.000Z")]), START)).toBeNull();
  });

  it("a malformed version, a missing timestamp, a torn line and a missing file all name nothing", () => {
    expect(transcriptRunningVersion(transcript([rec("latest", "2026-11-03T10:00:00.000Z")]), START)).toBeNull();
    expect(transcriptRunningVersion(transcript([JSON.stringify({ version: "2.1.317" })]), START)).toBeNull();
    expect(transcriptRunningVersion(transcript(["{\"version\":\"2.1.317\",\"timest"]), START)).toBeNull();
    expect(transcriptRunningVersion(join(tmp(), "none.jsonl"), START)).toBeNull();
    expect(transcriptRunningVersion(null, START)).toBeNull();
  });

  it("reads only the tail of a large transcript, and still finds the newest record there", () => {
    const filler = rec("2.1.316", "2026-11-03T08:00:00.000Z") + " ".repeat(1000);
    const p = transcript([...Array.from({ length: 600 }, () => filler), rec("2.1.317", "2026-11-03T09:30:00.000Z")]);
    expect(transcriptRunningVersion(p, START)).toBe("2.1.317");
  });
});

describe("claudeOnPath", () => {
  function install(dir: string, exec = true): string {
    const bin = join(dir, "pkg", "bin"); mkdirSync(bin, { recursive: true });
    const real = join(bin, "claude.exe"); writeFileSync(real, "x"); if (exec) chmodSync(real, 0o755);
    mkdirSync(join(dir, "bin"), { recursive: true });
    symlinkSync(real, join(dir, "bin", "claude"));
    return real;
  }

  it("follows the symlink the name is to the file it points at", () => {
    const d = tmp(); const real = install(d);
    expect(claudeOnPath(`/nonexistent:${join(d, "bin")}`)).toBe(realpathOf(real));
  });

  it("the first directory that has one wins", () => {
    const a = tmp(), b = tmp(); const ra = install(a); install(b);
    expect(claudeOnPath(`${join(a, "bin")}:${join(b, "bin")}`)).toBe(realpathOf(ra));
  });

  it("no PATH, no claude on it, or a dangling link → null", () => {
    const d = tmp(); mkdirSync(join(d, "bin")); symlinkSync(join(d, "gone"), join(d, "bin", "claude"));
    expect([claudeOnPath(""), claudeOnPath(join(d, "bin")), claudeOnPath(tmp())]).toEqual([null, null, null]);
  });
});

function realpathOf(p: string): string { return realpathSync(p); }
