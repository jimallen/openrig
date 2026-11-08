// hc cutover W37: the real Pi runner and the real pda runner, each as the pane's program on a PRIVATE herdr-core (own HOME,
// HC_SESSION and XDG paths via helpers/hc-scratch.ts; the host's core and the app are never contacted), with no real agent:
// the Pi runner drives an offline fake `pi` over RPC, the pda runner a loopback fake pda (helpers/fake-pda.ts).
//
// The symptom (live-pi-hc-20261101.md 1b): `hc get` on a runner seat stayed `reported:false, status:null, turn:0` before and after
// turns, so every `rig send` to it ended `waiting`. These rows read the core itself: the seat reports idle when ready, turn
// advances once per run, and the pane holds no stray escape bytes.
//
// Not proven here: a real Pi (its own RPC events are the fake's), a real pda, the daemon in the loop (no activity endpoint is
// set, so only the pane's own report is under test), and macOS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import { PDA_RUNNER_READY_MARKER } from "../src/adapters/pda-runner-protocol.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { startFakePda, type FakePda } from "./helpers/fake-pda.js";
import { BEARER } from "./helpers/pda-runner-rig.js";
import { seedPiFixtureCredential } from "./helpers/pi-fixture-credential.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!findHc())("runner status through a private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  let fake: FakePda | undefined;
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;
  const runnerSummary = (t: HcTerminal) => ({ reported: t.reported, status: t.status?.state ?? null, turn: t.turn });

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "w37-"));
  }, 60_000);

  afterAll(async () => {
    await fake?.close();
    scratch?.cleanup();
  });

  async function runRunner(name: string, argv: string[], env: Record<string, string>): Promise<void> {
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", ...argv], name, cwd: PACKAGE_DIR, env,
      labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true,
    });
  }

  it("Pi runner: reported:true and idle once ready, and the turn counter advances for each run Pi makes", async () => {
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const sessionFile = path.join(temp, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    // A Pi that answers get_state and, for each prompt, runs for 600 ms: agent_start ... agent_end.
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
  if (cmd.type === "prompt") { out({ type: "agent_start" }); setTimeout(() => out({ type: "agent_end", messages: [], willRetry: false }), 600); }
});\n`, { mode: 0o700 });
    seedPiFixtureCredential(path.join(temp, "state"), "w37pi", "openrouter");
    await runRunner("w37pi", [
      path.join(RUNNERS, "pi-runner.ts"), "--session-name", "w37pi", "--state-root", path.join(temp, "state"), "--cwd", temp,
      "--launch-id", "w37", "--no-approve", "--model", "openrouter/fixture",
    ], { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(temp, "home") });

    await until(() => screen("w37pi"), (t) => t.includes(PI_RUNNER_READY_MARKER), "the Pi runner's READY marker");
    // The symptom: before the fix this stays {reported:false, status:null, turn:0}.
    expect(runnerSummary(await until(() => get("w37pi"), (t) => t.reported === true, "w37pi to report status", 10_000))).toEqual({ reported: true, status: "idle", turn: 0 });

    for (const turn of [1, 2]) {
      const sent = await scratch.client().call<{ started: boolean | null; status: string | null; turn: number }>("terminal.send", { terminal: "w37pi", text: `run ${turn}` }, { timeoutMs: 20_000 });
      expect(sent.started, `send ${turn} saw the seat go working`).toBe(true);
      expect(runnerSummary(await until(() => get("w37pi"), (t) => t.status?.state === "idle" && t.turn === turn, `turn ${turn} to end idle`))).toEqual({ reported: true, status: "idle", turn });
    }
    expect(await screen("w37pi"), "the status record is consumed by the core, never drawn").not.toMatch(/7501|\u001b/);
  }, 90_000);

  it("pda runner: reported:true and idle once attached, and the turn counter advances for each run pda makes", async () => {
    fake = await startFakePda({ token: BEARER, agents: ["research"] });
    const tokenFile = path.join(temp, "token");
    fs.writeFileSync(tokenFile, BEARER, { mode: 0o600 });
    await runRunner("w37pda", [
      path.join(RUNNERS, "pda-runner.ts"), "--session-name", "w37pda", "--state-root", path.join(temp, "pda-state"), "--launch-id", "w37",
      "--agent", "research", "--base-url", fake.baseUrl, "--token-file", tokenFile,
    ], { PATH: path.dirname(process.execPath), OPENRIG_HOME: path.join(temp, "home") });

    await until(() => screen("w37pda"), (t) => t.includes(PDA_RUNNER_READY_MARKER), "the pda runner's READY marker");
    expect(runnerSummary(await until(() => get("w37pda"), (t) => t.reported === true, "w37pda to report status", 10_000))).toEqual({ reported: true, status: "idle", turn: 0 });

    for (const turn of [1, 2]) {
      fake.streamReply("research", [`reply ${turn}`]);
      expect(runnerSummary(await until(() => get("w37pda"), (t) => t.status?.state === "idle" && t.turn === turn, `turn ${turn} to end idle`))).toEqual({ reported: true, status: "idle", turn });
    }
    expect(await screen("w37pda")).not.toMatch(/7501|\u001b/);
  }, 90_000);
});
