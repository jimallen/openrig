import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/domain/transcript-store.js";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
it.each([1, 16 * 1024 + 10])("finishes tailing native log files with %s malformed continuation bytes", (count) => {
  root = mkdtempSync(join(tmpdir(), "openrig-tail-malformed-"));
  const store = new TranscriptStore({ transcriptsRoot: root });
  store.ensureTranscriptDir("fixture");
  writeFileSync(store.getTranscriptPath("fixture", "dev@fixture"), Buffer.concat([
    Buffer.alloc(count, 0x80), Buffer.from("\nfinal evidence\n"),
  ]));
  const result = store.readTail("fixture", "dev@fixture", 50);
  expect(result).toContain("final evidence");
  expect(result).toContain("\uFFFD");
});
it.each(["é", "界", "🙂"])("preserves a valid %s character split across the backward read boundary", (character) => {
  root = mkdtempSync(join(tmpdir(), "openrig-tail-valid-"));
  const store = new TranscriptStore({ transcriptsRoot: root });
  store.ensureTranscriptDir("fixture");
  // 16 KiB - 1 single-byte characters on one line. Hyphen-broken, so the tail's redaction (workspaces-o9o.47: its
  // 40+ character run rule) leaves the line as written and the assertion stays about the multibyte boundary.
  const suffix = ("abc-".repeat(4096)).slice(0, 16 * 1024 - 1);
  writeFileSync(store.getTranscriptPath("fixture", "dev@fixture"), character + suffix);
  expect(store.readTail("fixture", "dev@fixture", 50)).toBe(character + suffix + "\n");
});
