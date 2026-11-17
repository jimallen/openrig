// workspaces-o9o.28 review (1): every capture transcript rotation makes asks for soft-wrapped rows joined, including the one
// a real tmux cannot easily drive: a session the batch's listing lacked is read on its own from then on (the unlisted
// path). The real-tmux rows (transcript-rotation-soft-wrap.real.test.ts) cover the batch, a single session and a host
// that cannot batch; this row drives the unlisted path through a fake host and records what each call asked for.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PaneCapture } from "../src/adapters/tmux.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, type TranscriptHost } from "../src/domain/transcript-rotation.js";
import { nodeTranscriptFiles } from "../src/adapters/node-transcript-files.js";

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
      // A short cadence and no stop: stopping a rotation clears its unlisted mark (stopTranscriptRotation), so only the
      // NEXT tick of a rotation still running takes the unlisted path.
      const opts = { lines: 50, pollIntervalMs: 20 };
      // Two sessions in one tick share a batch, which marks both missing.
      startTranscriptRotation(nodeTranscriptFiles(), host, "o9o28-x", path.join(dir, "x.log"), opts);
      startTranscriptRotation(nodeTranscriptFiles(), host, "o9o28-y", path.join(dir, "y.log"), opts);
      await waitFor(() => batched.length >= 1);
      expect(single).toEqual([]);

      // Their next ticks read each one alone: the unlisted path, not the batch's own per-target read.
      await waitFor(() => new Set(single.map((c) => c.name)).size === 2);
      expect(batched[0]).toEqual({ joinWrappedLines: true });
      expect(new Set(single.map((c) => c.name))).toEqual(new Set(["o9o28-x", "o9o28-y"]));
      for (const call of single) expect(call.opts, call.name).toEqual({ joinWrappedLines: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
