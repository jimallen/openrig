import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// The production adapter against a real core. tmux had two transports (a shell string and an argv) that had to observe and change the
// same isolated server identically, and a second test counting the processes each started; hc has one transport, the socket, so this
// is the one scenario, run once, with the same observations.
describe.skipIf(!findHc())("hc adapter against a real core", () => {
  let scratch: HcScratch;
  let root: string;
  let result: Record<string, unknown>;
  beforeAll(async () => {
    scratch = startHcScratch();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-exec-"));
    vi.stubEnv("SHELL", "/bin/sh");
    const adapter = new HcAdapter(scratch.client());
    // An unrelated seat on the same core: the listings below must show it and the operations must leave it alone.
    await adapter.createSession("anchor", root);
    const created = await adapter.createSession("seat a", root);
    const duplicate = await adapter.createSession("seat a", root);
    // Type only once the pane's shell has drawn its prompt. Text typed earlier is echoed by the tty ahead of the prompt and the
    // command's output then shares the prompt's line ("$ openrig-native"), so no line equals the marker.
    for (let i = 0; i < 300 && !/[$#%>] ?$/.test((await adapter.capturePaneContent("seat a", 50) ?? "").trimEnd()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const typed = await adapter.sendText("seat a", "echo 'openrig-'native", undefined, { bracketed: false });
    const entered = await adapter.sendKeys("seat a", ["Enter"]);
    // The quotes keep the typed line from matching: only the command's output contains the marker.
    let single: string | null = null;
    for (let i = 0; i < 100 && !single?.includes("openrig-native"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      single = await adapter.capturePaneContent("seat a", 50);
    }
    const batch = await adapter.capturePanesContent(["seat a", "missing"], 50);
    const activity = await adapter.readAllSessionWindowActivity();
    result = {
      created,
      duplicate: duplicate.ok ? duplicate : duplicate.code,
      typed,
      entered,
      captured: single!.split("\n").filter((line) => line === "openrig-native"),
      batchMatchesSingle: batch?.get("seat a")?.text === single,
      batchMissing: batch?.get("missing")?.text,
      sessions: (await adapter.listSessions()).map((s) => [s.name, s.windows, s.attached]).sort(),
      activity: activity === null ? null : [...activity.keys()],
      missingProbe: await adapter.probeSession("missing"),
      missingKill: await adapter.killSession("missing"),
      missingKeys: await adapter.sendKeys("missing", ["Enter"]),
      killed: await adapter.killSession("seat a"),
    };
    await vi.waitFor(async () => expect((await adapter.probeSession("seat a")).state).toBe("absent"), { timeout: 10_000 });
    result.afterKill = (await adapter.listSessions()).map((s) => s.name);
    // The core is gone (nothing listens at this socket): the seat's state is unknown, not absent.
    const unreachable = new HcAdapter(new HcClient(path.join(root, "no-core.sock")));
    const probe = await unreachable.probeSession("seat a");
    result.noCoreProbe = probe.state;
    result.noCoreSessions = await unreachable.listSessions().then(() => "listed", (err: Error) => err.message);
  }, 120_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("creates, refuses a duplicate, types, captures, lists, probes, kills and reads an unreachable core", () => {
    expect(result).toMatchObject({
      created: { ok: true },
      duplicate: "duplicate_session",
      typed: { ok: true },
      entered: { ok: true },
      batchMatchesSingle: true,
      batchMissing: null,
      sessions: [["anchor", 1, false], ["seat a", 1, false]],
      missingProbe: { state: "absent" },
      missingKill: { ok: false, code: "session_not_found" },
      missingKeys: { ok: false, code: "session_not_found" },
      // No activity clock on hc (hc-identity.ts): the listing is empty, which readers take as "no signal", never as idle.
      activity: [],
      killed: { ok: true },
      afterKill: ["anchor"],
      noCoreProbe: "transport_unavailable",
    });
    // A listing the core could not give is a failure, never the empty list tmux gave for a server that was not running.
    expect(result.noCoreSessions).toMatch(/^hc core not reachable at /);
    expect(result.captured).toEqual(["openrig-native"]);
  });
});
