import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const keys = ["OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"];

describe.skipIf(!findHc())("hc transcript seat environment", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  /** The environment a seat's shell was given, as that shell prints it. */
  async function seatEnv(adapter: HcAdapter, name: string, dir: string): Promise<Record<string, string>> {
    const captured = path.join(dir, `${name}.env`);
    expect(await adapter.sendText(name, `/usr/bin/env > '${captured}.tmp' && mv '${captured}.tmp' '${captured}'`)).toEqual({ ok: true });
    expect(await adapter.sendKeys(name, ["Enter"])).toEqual({ ok: true });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(captured) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return Object.fromEntries(fs.readFileSync(captured, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => {
      const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)];
    }));
  }

  it("does not pin daemon transcript defaults inside a seat", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-env-"));
    const config = path.join(temp, "config.json");
    // The daemon's own environment carries a transcript policy; a seat must not inherit it as a pin.
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("OPENRIG_TRANSCRIPTS_LINES", "777");
    vi.stubEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS", "44");
    const adapter = new HcAdapter(scratch.client());
    try {
      expect(await adapter.createSession("fixture", temp)).toEqual({ ok: true });
      const seen = await seatEnv(adapter, "fixture", temp);
      for (const key of keys) vi.stubEnv(key, seen[key]);  // the seat's view of the names, which the settings store reads from the seat
      expect(keys.map((key) => seen[key])).toEqual(["", ""]);
      fs.writeFileSync(config, JSON.stringify({ transcripts: { lines: 123, pollIntervalSeconds: 15 } }));
      const store = new SettingsStore(config);
      expect(store.resolveOne("transcripts.lines")).toMatchObject({ value: 123, source: "file" });
      expect(store.resolveOne("transcripts.poll_interval_seconds")).toMatchObject({ value: 15, source: "file" });
      // A deliberate seat override remains authoritative.
      vi.stubEnv("OPENRIG_TRANSCRIPTS_LINES", "777");
      expect(await adapter.createSession("explicit", temp, { OPENRIG_TRANSCRIPTS_LINES: "321" })).toEqual({ ok: true });
      expect((await seatEnv(adapter, "explicit", temp)).OPENRIG_TRANSCRIPTS_LINES).toBe("321");
    } finally {
      await adapter.killSession("fixture"); await adapter.killSession("explicit");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
