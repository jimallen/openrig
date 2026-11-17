import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import type { TranscriptFiles, TranscriptReader } from "../src/domain/transcript-files.js";

// workspaces-o9o.69: transcript storage is a domain decision (what to read and write, which modes, replace through a temp
// file and a rename) carried out through the TranscriptFiles port. These drive the store and the rotation through an
// in-memory fake of the port, so no file is touched; the node adapter is covered by the existing transcript suites.

type Op = { op: string; path: string; to?: string; mode?: number };

function memoryFiles(): TranscriptFiles & { ops: Op[]; files: Map<string, { body: Buffer; mode: number }>; folders: Map<string, number> } {
  const files = new Map<string, { body: Buffer; mode: number }>();
  const folders = new Map<string, number>();
  const ops: Op[] = [];
  const at = (path: string) => {
    const file = files.get(path);
    if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return file;
  };
  return {
    ops, files, folders,
    exists: (path) => files.has(path) || folders.has(path),
    stat: (path) => ({ size: at(path).body.length, mtimeMs: 1_000 }),
    makeFolder(dir, mode) { ops.push({ op: "makeFolder", path: dir, mode }); if (!folders.has(dir)) folders.set(dir, mode); },
    append(path, text, mode) {
      ops.push({ op: "append", path, mode });
      const prior = files.get(path);
      files.set(path, { body: Buffer.concat([prior?.body ?? Buffer.alloc(0), Buffer.from(text, "utf-8")]), mode: prior?.mode ?? mode });
    },
    readText: (path) => at(path).body.toString("utf-8"),
    write(path, text, mode) { ops.push({ op: "write", path, mode }); files.set(path, { body: Buffer.from(text, "utf-8"), mode: files.get(path)?.mode ?? mode }); },
    rename(from, to) { ops.push({ op: "rename", path: from, to }); files.set(to, at(from)); files.delete(from); },
    openRead(path): TranscriptReader {
      const body = at(path).body;
      ops.push({ op: "openRead", path });
      return {
        size: () => body.length,
        read: (buffer, offset, length, position) => body.copy(buffer, offset, position, Math.min(body.length, position + length)),
        close: () => { ops.push({ op: "close", path }); },
      };
    },
  };
}

afterEach(() => clearAllTranscriptRotationsForTest());

describe("o9o.69: TranscriptStore through the TranscriptFiles port", () => {
  it("a boundary marker creates the rig folder 0700 and appends to a 0600 file, and nothing else", () => {
    const files = memoryFiles();
    const store = new TranscriptStore({ files, transcriptsRoot: "/transcripts" });
    expect(store.writeBoundaryMarker("rig", "seat@rig", "restore")).toBe(true);
    expect(files.ops).toEqual([
      { op: "makeFolder", path: "/transcripts/rig", mode: 0o700 },
      { op: "append", path: "/transcripts/rig/seat@rig.log", mode: 0o600 },
    ]);
    expect(files.readText("/transcripts/rig/seat@rig.log")).toMatch(/^--- SESSION BOUNDARY: restore at \S+ ---\n$/);
  });

  it("ensureTranscriptDir creates the rig folder 0700", () => {
    const files = memoryFiles();
    expect(new TranscriptStore({ files, transcriptsRoot: "/transcripts" }).ensureTranscriptDir("rig")).toBe(true);
    expect(files.ops).toEqual([{ op: "makeFolder", path: "/transcripts/rig", mode: 0o700 }]);
  });

  it("readTail, readFull and grep read through the port and close every reader they open", () => {
    const files = memoryFiles();
    const store = new TranscriptStore({ files, transcriptsRoot: "/transcripts" });
    files.files.set("/transcripts/rig/seat@rig.log", { body: Buffer.from("alpha\nbeta\ngamma\n", "utf-8"), mode: 0o600 });
    expect(store.readTail("rig", "seat@rig", 2)).toBe("beta\ngamma\n");
    expect(store.readFull("rig", "seat@rig")).toBe("alpha\nbeta\ngamma\n");
    expect(store.grep("rig", "seat@rig", "^b")).toEqual(["beta"]);
    const opened = files.ops.filter((o) => o.op === "openRead").length;
    expect(opened).toBeGreaterThan(0);
    expect(files.ops.filter((o) => o.op === "close").length).toBe(opened);
  });

  it("a missing transcript is null on every read and capture_missing in health, through the port", () => {
    const files = memoryFiles();
    const store = new TranscriptStore({ files, transcriptsRoot: "/transcripts" });
    expect(store.readTail("rig", "seat@rig", 5)).toBeNull();
    expect(store.readFull("rig", "seat@rig")).toBeNull();
    expect(store.grep("rig", "seat@rig", "x")).toBeNull();
    expect(store.getIngestHealth("rig", "seat@rig")).toEqual({ state: "unavailable", reason: "capture_missing", lastCapturedAt: null });
    expect(files.ops).toEqual([]);
  });

  it("an empty transcript reads as an empty tail and capture_empty", () => {
    const files = memoryFiles();
    const store = new TranscriptStore({ files, transcriptsRoot: "/transcripts" });
    files.files.set("/transcripts/rig/seat@rig.log", { body: Buffer.alloc(0), mode: 0o600 });
    expect(store.readTail("rig", "seat@rig", 5)).toBe("");
    expect(store.getIngestHealth("rig", "seat@rig").reason).toBe("capture_empty");
  });

  it("a reader that comes up short is an I/O failure (null), never NUL padding, and is still closed", () => {
    const files = memoryFiles();
    const store = new TranscriptStore({ files, transcriptsRoot: "/transcripts" });
    files.files.set("/transcripts/rig/seat@rig.log", { body: Buffer.from("one\ntwo\n", "utf-8"), mode: 0o600 });
    const open = files.openRead.bind(files);
    files.openRead = (path) => ({ ...open(path), read: () => 0 });
    expect(store.readTail("rig", "seat@rig", 1)).toBeNull();
    expect(files.ops.filter((o) => o.op === "close")).toHaveLength(1);
  });
});

describe("o9o.69: transcript rotation through the TranscriptFiles port", () => {
  it("a capture is written to a 0600 temp in a 0700 folder and renamed over the transcript", async () => {
    const files = memoryFiles();
    const host = { capturePaneContent: vi.fn(async () => "pane line\n") };
    startTranscriptRotation(files, host, "seat@rig", "/transcripts/rig/seat@rig.log", { lines: 10, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(files.files.has("/transcripts/rig/seat@rig.log")).toBe(true));
    stopTranscriptRotation("seat@rig");
    const tmp = `/transcripts/rig/seat@rig.log.tmp.${process.pid}`;
    expect(files.ops).toEqual([
      { op: "makeFolder", path: "/transcripts/rig", mode: 0o700 },
      { op: "write", path: tmp, mode: 0o600 },
      { op: "rename", path: tmp, to: "/transcripts/rig/seat@rig.log" },
    ]);
    expect(files.readText("/transcripts/rig/seat@rig.log")).toBe("pane line\n");
  });

  it("keeps the transcript's boundary markers above the capture, and does not rewrite identical bytes", async () => {
    const files = memoryFiles();
    const path = "/transcripts/rig/seat@rig.log";
    files.files.set(path, { body: Buffer.from("--- SESSION BOUNDARY: restore at t ---\nold\n", "utf-8"), mode: 0o600 });
    const host = { capturePaneContent: vi.fn(async () => "new\n") };
    startTranscriptRotation(files, host, "seat@rig", path, { lines: 10, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(files.ops.some((o) => o.op === "rename")).toBe(true));
    stopTranscriptRotation("seat@rig");
    expect(files.readText(path)).toBe("--- SESSION BOUNDARY: restore at t ---\nnew\n");

    files.ops.length = 0;
    startTranscriptRotation(files, host, "seat@rig", path, { lines: 10, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(host.capturePaneContent).toHaveBeenCalledTimes(2));
    await new Promise((r) => setImmediate(r));
    stopTranscriptRotation("seat@rig");
    expect(files.ops).toEqual([]);
  });
});
