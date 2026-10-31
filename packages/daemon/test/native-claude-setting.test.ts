// OF-180 N4: `transport.native_claude` is read on every send; the answer is kept until the settings file or the env
// override changes. Real files in a temp dir; nothing here reads ~/.openrig.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { cachedFlag, nativeClaudeFlag, NATIVE_CLAUDE_ENV, settingsFileSignature } from "../src/domain/native-claude-setting.js";

// The real statSync by default; one test hands the signature a fabricated stat (see the inode row).
const fabricated = vi.hoisted(() => ({ stat: undefined as object | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: (...args: Parameters<typeof actual.statSync>) => fabricated.stat ?? actual.statSync(...args) };
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); delete process.env[NATIVE_CLAUDE_ENV]; });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "nc-setting-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("cachedFlag", () => {
  it("resolves once while the signature is unchanged, and again as soon as it changes (no time-to-live)", () => {
    let sig = "a"; let calls = 0; let answer = false;
    const flag = cachedFlag(() => sig, () => { calls++; return answer; });
    expect([flag(), flag(), flag(), calls]).toEqual([false, false, false, 1]);
    answer = true; // the inputs did not change, so the kept answer stands
    expect(flag()).toBe(false);
    sig = "b";
    expect([flag(), flag(), calls]).toEqual([true, true, 2]);
  });
  it("a resolve that throws answers false and is retried on the next call (a transient error does not stick)", () => {
    let calls = 0; let broken = true;
    const flag = cachedFlag(() => "same", () => { calls++; if (broken) throw new Error("EIO"); return true; });
    expect([flag(), flag(), calls]).toEqual([false, false, 2]);
    broken = false;
    expect([flag(), flag(), calls]).toEqual([true, true, 3]);
  });
});

describe("settingsFileSignature", () => {
  it("is 'absent' for a missing file and differs once the file exists", () => {
    const p = join(scratch(), "config.json");
    expect(settingsFileSignature(p)).toBe("absent");
    writeFileSync(p, "{}");
    expect(settingsFileSignature(p)).not.toBe("absent");
  });
  it("is stable for an untouched file and changes on a same-size rewrite, and on an atomic replace with the same bytes", () => {
    const dir = scratch(); const p = join(dir, "config.json");
    writeFileSync(p, '{"a":1}'); utimesSync(p, 1_000, 1_000);
    const first = settingsFileSignature(p);
    expect(settingsFileSignature(p)).toBe(first);
    writeFileSync(p, '{"a":2}'); utimesSync(p, 2_000, 2_000); // same size, different time
    const second = settingsFileSignature(p);
    expect(second).not.toBe(first);
    writeFileSync(join(dir, "next.json"), '{"a":2}'); utimesSync(join(dir, "next.json"), 2_000, 2_000);
    renameSync(join(dir, "next.json"), p); // same bytes and mtime, a new inode
    expect(settingsFileSignature(p)).not.toBe(second);
  });
});

describe("settingsFileSignature: the inode term", () => {
  // A real atomic replace cannot isolate the inode: the rename moves the change time too, so a signature without the inode
  // would still differ. The kernel offers no way to hold size, mtime and ctime equal across two inodes, so the stat result
  // is fabricated here: stats identical in every field but the inode. Production consequence: a settings file replaced
  // by an atomic save that lands on the same size and timestamps would keep serving the old flag value.
  it("two stats that differ only in the inode give two signatures; identical stats give one", () => {
    const stat = (ino: bigint) => ({ ino, size: 7n, mtimeNs: 5n, ctimeNs: 9n });
    const sign = (ino: bigint) => {
      fabricated.stat = stat(ino);
      try { return settingsFileSignature("/fabricated/config.json"); } finally { fabricated.stat = undefined; }
    };
    const first = sign(100n);
    expect(sign(100n)).toBe(first);
    expect(sign(101n)).not.toBe(first);
  });
});

describe("the wired flag: a real SettingsStore, a real file", () => {
  function wired(p: string) {
    const store = new SettingsStore(p);
    let reads = 0;
    const real = store.resolveOne.bind(store);
    store.resolveOne = ((...a: Parameters<typeof real>) => { reads++; return real(...a); }) as typeof store.resolveOne;
    const flag = nativeClaudeFlag(store);
    return { flag, reads: () => reads };
  }
  it("many sends read the settings once; a changed file reaches the very next send", () => {
    const p = join(scratch(), "config.json");
    writeFileSync(p, '{"transport":{"nativeClaude":false}}'); utimesSync(p, 1_000, 1_000);
    const w = wired(p);
    expect([w.flag(), w.flag(), w.flag(), w.reads()]).toEqual([false, false, false, 1]);
    writeFileSync(p, '{"transport":{"nativeClaude":true}}'); utimesSync(p, 2_000, 2_000);
    expect([w.flag(), w.flag(), w.reads()]).toEqual([true, true, 2]);
  });
  it("a missing file is the default (off); creating it turns the flag on at the next send", () => {
    const p = join(scratch(), "config.json");
    const w = wired(p);
    expect([w.flag(), w.flag(), w.reads()]).toEqual([false, false, 1]);
    writeFileSync(p, '{"transport":{"nativeClaude":true}}');
    expect(w.flag()).toBe(true);
  });
  it("the env override decides ahead of the file and is picked up without a file change", () => {
    const p = join(scratch(), "config.json");
    writeFileSync(p, '{"transport":{"nativeClaude":false}}');
    const w = wired(p);
    expect(w.flag()).toBe(false);
    process.env[NATIVE_CLAUDE_ENV] = "true";
    expect(w.flag()).toBe(true);
    delete process.env[NATIVE_CLAUDE_ENV];
    expect(w.flag()).toBe(false);
  });
});
