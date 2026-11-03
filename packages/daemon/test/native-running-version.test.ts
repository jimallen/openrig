// OF-212: the two OS reads behind a replaced Claude binary: the running version from the process's own transcript, and
// `claude` found on a PATH. Real files in a private temp dir; nothing reaches a live seat or process.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { claudeOnPath, lsofCommand, resolveClaudeExecPath, transcriptRunningVersion } from "../src/adapters/native-inbox-os.js";

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

describe("transcriptRunningVersion: the path is reported by the relay, so it is read with care (OF-212 review F2, F3, F4)", () => {
  const good = (): string => rec("2.1.317", "2026-11-03T09:30:00.000Z") + "\n";
  function file(content = good()): string { const p = join(tmp(), "t.jsonl"); writeFileSync(p, content); return p; }

  it("a FIFO with no writer is refused without blocking the daemon", () => {
    const p = join(tmp(), "fifo");
    execFileSync("mkfifo", [p]);
    expect(transcriptRunningVersion(p, START)).toBeNull();
  });

  it("a directory is refused", () => {
    expect(transcriptRunningVersion(tmp(), START)).toBeNull();
  });

  it("a file the daemon's user does not own vouches for nothing; one it owns does", () => {
    const p = file();
    const me = process.getuid!();
    expect([transcriptRunningVersion(p, START, me + 1), transcriptRunningVersion(p, START, me)]).toEqual([null, "2.1.317"]);
  });

  it("a symlink is followed to the regular file it names, and judged there", () => {
    const real = file(); const link = join(tmp(), "link.jsonl"); symlinkSync(real, link);
    const dirLink = join(tmp(), "dirlink"); symlinkSync(tmp(), dirLink);
    expect([transcriptRunningVersion(link, START), transcriptRunningVersion(dirLink, START)]).toEqual(["2.1.317", null]);
  });

  it("two versions written since the start name nothing: a second process on the same session may be the writer of one", () => {
    const p = file(rec("2.1.316", "2026-11-03T09:29:00.000Z") + "\n" + rec("2.1.317", "2026-11-03T09:30:00.000Z") + "\n");
    expect(transcriptRunningVersion(p, START)).toBeNull();
  });

  it("the same version written twice since the start is one version; an older version before the start does not count", () => {
    const p = file(rec("2.1.316", "2026-11-03T08:00:00.000Z") + "\n" + rec("2.1.317", "2026-11-03T09:29:00.000Z") + "\n" + rec("2.1.317", "2026-11-03T09:30:00.000Z") + "\n");
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

  it("a relative PATH entry is skipped: it would resolve against the daemon's working directory", () => {
    const d = tmp(); const real = install(d);
    const relativeEntry = relative(process.cwd(), join(d, "bin"));
    expect(relativeEntry.startsWith("/")).toBe(false);
    expect([claudeOnPath(relativeEntry), claudeOnPath(`${relativeEntry}:${join(d, "bin")}`)]).toEqual([null, realpathSync(real)]);
  });

  it("no PATH, no claude on it, or a dangling link → null", () => {
    const d = tmp(); mkdirSync(join(d, "bin")); symlinkSync(join(d, "gone"), join(d, "bin", "claude"));
    expect([claudeOnPath(""), claudeOnPath(join(d, "bin")), claudeOnPath(tmp())]).toEqual([null, null, null]);
  });
});

function realpathOf(p: string): string { return realpathSync(p); }

// OF-212 (live cause, found by the coordinator): the daemon's PATH has no /usr/sbin, where macOS keeps lsof, so lsof by name never ran.
describe("lsof is found without /usr/sbin on the daemon's PATH", () => {
  it("macOS: the absolute path when the file exists; the bare name when it does not; Linux never needs it", () => {
    expect([lsofCommand("darwin", () => true), lsofCommand("darwin", () => false), lsofCommand("linux", () => true)]).toEqual(["/usr/sbin/lsof", "lsof", "lsof"]);
  });

  it("macOS: it asks about /usr/sbin/lsof itself, not any other path", () => {
    const asked: string[] = [];
    lsofCommand("darwin", (p) => { asked.push(p); return false; });
    expect(asked).toEqual(["/usr/sbin/lsof"]);
  });

  // The daemon's PATH, as measured on the live daemon: homebrew, /usr/local/bin, /usr/bin, /bin; no /usr/sbin, no /sbin.
  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/sbin/lsof"))("macOS: a live process's executable resolves with PATH lacking /usr/sbin", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin";
    try {
      const found = await resolveClaudeExecPath(process.pid);
      expect(found).not.toBeNull();
      expect(found!.startsWith("/")).toBe(true);
    } finally { process.env.PATH = saved; }
  });
});
