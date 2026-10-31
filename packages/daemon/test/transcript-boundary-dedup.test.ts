import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

/** The real client to the private core, counting the reads a capture makes. */
class CountingClient extends HcClient {
  reads = 0;
  override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (method === "terminal.read") this.reads += 1;
    return super.call<T>(method, params, options);
  }
}

describe.skipIf(!findHc())("hc transcript boundary replay", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("does not accumulate a boundary line echoed in unchanged pane scrollback", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-replay-"));
    const outputPath = path.join(temp, "transcript.log");
    const sessionName = "boundary@fixture";
    const oldBoundary = "--- SESSION BOUNDARY: prior restore";
    const echoedBoundary = "--- SESSION BOUNDARY: latest restore";
    const client = new CountingClient(scratch.socketPath);
    const adapter = new HcAdapter(client);
    try {
      await scratch.client().call("terminal.run", {
        argv: ["sh", "-c", `printf '%s\\n' '${echoedBoundary}' 'stable terminal output'; sleep 60`], name: hcTerminalName(sessionName),
        labels: { [SEAT_LABEL]: sessionName }, cwd: temp, no_parent: true, no_notify: true, outlive_parent: true,
      });
      const readyDeadline = Date.now() + 5000;
      while (!(await adapter.capturePaneContent(sessionName, 20))?.includes("stable terminal output") && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await adapter.capturePaneContent(sessionName, 20)).toContain(echoedBoundary);
      fs.writeFileSync(outputPath, `${oldBoundary}\n${echoedBoundary}\n`);
      client.reads = 0;
      startTranscriptRotation(adapter, sessionName, outputPath, { lines: 20, pollIntervalMs: 30 });
      const captureDeadline = Date.now() + 5000;
      while (client.reads < 4 && Date.now() < captureDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client.reads).toBeGreaterThanOrEqual(4);
      stopTranscriptRotation(sessionName);
      const lines = fs.readFileSync(outputPath, "utf8").split("\n");
      expect(lines.filter((line) => line === oldBoundary)).toHaveLength(1);
      // One retained structural header and one unmodified terminal-scrollback line.
      expect(lines.filter((line) => line === echoedBoundary)).toHaveLength(2);
      expect(lines).toContain("stable terminal output");
    } finally {
      stopTranscriptRotation(sessionName);
      await adapter.killSession(sessionName);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
