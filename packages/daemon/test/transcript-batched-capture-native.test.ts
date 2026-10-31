// #161 against a private hc core: 30 rotating sessions are captured together, every transcript equals the session's own capture
// byte for byte, at most a read each per cadence step, and a killed session leaves the others current (its read answers
// "not there" and only its own entry is marked missing).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real client to the private core, noting when each read began. */
class ReadLogClient extends HcClient {
  reads: Array<{ at: number; terminal: unknown }> = [];
  override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (method === "terminal.read") this.reads.push({ at: Date.now(), terminal: params.terminal });
    return super.call<T>(method, params, options);
  }
}

describe.skipIf(!findHc())("hc batched transcript capture (#161)", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("30 sessions: byte-identical transcripts, at most one read each per cadence step, a killed session isolated", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "batched-hc-"));
    const client = new ReadLogClient(scratch.socketPath);
    // The rotation reads through the counting client; this test's own reads (readiness, convergence) go through a plain one.
    const rotation = new HcAdapter(client);
    const adapter = new HcAdapter(scratch.client());
    const names = Array.from({ length: 30 }, (_, i) => `seat-${i}@native`);
    const file = (n: string) => path.join(home, `${n}.log`);
    const say = (n: string, text: string) => scratch.client().call("terminal.send", { terminal: hcTerminalName(n), text });
    /** Wait until every transcript equals its session's own capture (both read now, so a racing write retries). */
    const converged = async (sessions: string[], timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const pending: string[] = [];
        for (const n of sessions) {
          const expected = await adapter.capturePaneContent(n, 1000);
          if (!fs.existsSync(file(n)) || fs.readFileSync(file(n), "utf8") !== expected) pending.push(n);
        }
        if (pending.length === 0 || Date.now() > deadline) return pending;
        await wait(200);
      }
    };
    try {
      for (const n of names) {
        await scratch.client().call("terminal.run", {
          argv: ["sh", "-c", `i=0; while [ $i -lt 40 ]; do echo "${n} line $i"; i=$((i+1)); done; exec cat`],
          name: hcTerminalName(n), labels: { [SEAT_LABEL]: n }, cwd: home, no_parent: true, no_notify: true, outlive_parent: true,
        });
      }
      for (const n of names) await expect.poll(async () => (await adapter.capturePaneContent(n, 1000)) ?? "", { timeout: 15_000 }).toContain(`${n} line 39`);
      for (const n of names) startTranscriptRotation(rotation, n, file(n), { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
      expect(await converged(names, 15_000)).toEqual([]);

      // Busy rounds: every session prints. A session is read once per 2 s cadence step, so the reads in the window stay within
      // 30 per step (tmux counted forks: a listing and a chain per chunk of 24; hc has no chain, one read per terminal).
      const roundsFrom = Date.now();
      for (let round = 0; round < 3; round++) {
        for (const n of names) await say(n, `round ${round} ${n}`);
        await wait(2000);
      }
      expect(await converged(names, 10_000)).toEqual([]);
      const steps = Math.ceil((Date.now() - roundsFrom) / 2000);
      const reads = client.reads.filter((r) => r.at >= roundsFrom);
      expect(reads.length).toBeLessThanOrEqual(30 * (steps + 1));
      for (const n of names) expect(reads.some((r) => r.terminal === hcTerminalName(n)), `${n} was read`).toBe(true);

      const killed = names[3]!;
      const before = fs.readFileSync(file(killed), "utf8");
      await scratch.client().call("terminal.kill", { terminal: hcTerminalName(killed) });
      const alive = names.filter((n) => n !== killed);
      for (const n of alive) await say(n, `after kill ${n}`);
      expect(await converged(alive, 15_000)).toEqual([]);
      for (const n of alive) expect(fs.readFileSync(file(n), "utf8")).toContain(`after kill ${n}`);
      expect(fs.readFileSync(file(killed), "utf8")).toContain(`${killed} line 39`);
      expect(fs.readFileSync(file(killed), "utf8").startsWith(before.trimEnd())).toBe(true);
    } finally {
      clearAllTranscriptRotationsForTest();
      for (const n of names) await adapter.killSession(n).catch(() => undefined);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
