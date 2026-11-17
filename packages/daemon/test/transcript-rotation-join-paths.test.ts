// workspaces-o9o.28 review (1): every capture transcript rotation makes asks for soft-wrapped rows joined, including the one
// a real tmux cannot easily drive: a session the batch's listing lacked is read on its own from then on (the unlisted
// path). The real-tmux rows (transcript-rotation-soft-wrap.real.test.ts) cover the batch, a single session and a host
// that cannot batch; this row drives the unlisted path through a fake host and records what each call asked for.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PaneCapture } from "../src/adapters/tmux.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, stopTranscriptRotation, type TranscriptHost } from "../src/domain/transcript-rotation.js";

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe("transcript rotation: the unlisted per-target read joins wrapped rows too", () => {
  afterEach(() => clearAllTranscriptRotationsForTest());

  it("a session the batch marked missing is read alone next time, with joinWrappedLines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9o28-join-"));
    const batched: Array<{ joinWrappedLines?: boolean } | undefined> = [];
    const single: Array<{ name: string; opts: { joinWrappedLines?: boolean } | undefined }> = [];
    const host: TranscriptHost = {
      capturePaneContent: async (name, _lines, opts) => { single.push({ name, opts }); return "pane text\n"; },
      capturePanesContent: async (targets, _lines, _now, opts) => {
        batched.push(opts);
        return new Map<string, PaneCapture>(targets.map((t) => [t, { text: null, capturedAt: new Date(), missing: true }]));
      },
    };
    try {
      const opts = { lines: 50, pollIntervalMs: 60_000 };
      // Two sessions in one tick share a batch, which marks both missing.
      startTranscriptRotation(host, "o9o28-x", path.join(dir, "x.log"), opts);
      startTranscriptRotation(host, "o9o28-y", path.join(dir, "y.log"), opts);
      await waitFor(() => batched.length === 1);
      stopTranscriptRotation("o9o28-x");
      stopTranscriptRotation("o9o28-y");
      expect(single).toEqual([]);

      // Restarted, x is read on its own: the unlisted path, not a batch.
      startTranscriptRotation(host, "o9o28-x", path.join(dir, "x.log"), opts);
      await waitFor(() => single.length === 1);
      expect(batched).toHaveLength(1);
      expect(batched[0]).toEqual({ joinWrappedLines: true });
      expect(single).toEqual([{ name: "o9o28-x", opts: { joinWrappedLines: true } }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
