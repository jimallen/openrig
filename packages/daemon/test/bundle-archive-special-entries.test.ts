// Install side: an archive entry that extracts as a FIFO or device node would be read by the integrity check
// (a plain synchronous read of every manifest-named file), so unpack and inspect refuse it up front, through
// the one shared verdict (unsafeArchiveEntryReason).
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectUnsafeArchiveEntries, unsafeArchiveEntryReason } from "../src/domain/bundle-archive.js";

describe("archive entries that are not files", () => {
  it.each(["FIFO", "CharacterDevice", "BlockDevice"])("%s is refused", (type) => {
    expect(unsafeArchiveEntryReason("agents/x/pipe", type)).toBe(`${type}: agents/x/pipe`);
  });
  it.each(["File", "Directory", "OldFile", "ContiguousFile", undefined])("CONTROL: %s is not refused", (type) => {
    expect(unsafeArchiveEntryReason("agents/x/f", type)).toBeNull();
  });

  let tmp: string | undefined;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

  it("a real archive carrying a FIFO is refused by the pre-scan; the same archive without it is clean", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-fifo-"));
    const src = path.join(tmp, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "bundle.yaml"), "name: x\n");
    const clean = path.join(tmp, "clean.tgz");
    // System tar: node-tar blocks opening a writer-less FIFO when packing it.
    execFileSync("tar", ["-czf", clean, "-C", src, "bundle.yaml"], { timeout: 10000 });
    expect(await collectUnsafeArchiveEntries(clean)).toEqual([]);
    execFileSync("mkfifo", [path.join(src, "pipe")]);
    const dirty = path.join(tmp, "dirty.tgz");
    execFileSync("tar", ["-czf", dirty, "-C", src, "bundle.yaml", "pipe"], { timeout: 10000 });
    expect(await collectUnsafeArchiveEntries(dirty)).toEqual(["FIFO: pipe"]);
  });
});
