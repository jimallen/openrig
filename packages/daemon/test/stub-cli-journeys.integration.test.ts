import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";

// Real CLI/daemon/SQLite/a private hc core with two scripted agents. These journeys exercise
// ordinary user commands; they do not model a provider prompt or input consumption.
// Reuse one private fixture to keep the PR cost bounded. Each assertion uses its
// own marker/selector, and only the stream case restarts this fixture's daemon.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");

describe.runIf(findHc() !== null)("stub CLI journeys", () => {
  let core: HcScratch | undefined;
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const launchedRigs: string[] = [];
  const sender = "work-worker@rig-alpha";
  const recipient = "work-worker@rig-beta";

  async function cli(args: string[]) {
    const result = await runRig(args, { ...daemon!.readEnv, OPENRIG_SESSION_NAME: sender }, rigBin);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    core = startHcScratch();
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    // The daemon and its CLI find the seat host by these, as a daemon finds it in production.
    Object.assign(scaffold.env, { HC_SESSION: core.session, XDG_RUNTIME_DIR: core.env.XDG_RUNTIME_DIR, HC_SOCKET: core.socketPath });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    for (const name of ["alpha", "beta"]) {
      const cwd = join(scaffold.root, name);
      mkdirSync(cwd);
      const result = await runRig(["up", join(library, `rig-${name}-stub.yaml`), "--cwd", cwd, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(result.code, JSON.stringify({ name, ...result })).toBe(0);
      launchedRigs.push(`rig-${name}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); core?.cleanup(); return; }
    try {
      // Stop the launched seats while their daemon can still coordinate teardown.
      // Removing the scratch tree with live rigs can race their final writes.
      for (const rig of launchedRigs) await cli(["down", rig, "--json", "--force"]);
    } finally {
      try { await daemon.stop(); } finally { core?.cleanup(); }
    }
  }, 60_000);

  it.each(["normal", "wider than the terminal soft-wrap"])("verified send renders in the addressed pane and not its sibling: %s", async (mode) => {
    const wrapped = mode !== "normal";
    // A long token forces real mid-word terminal wrapping, not just modeled newlines. hc cannot pin a terminal narrower (a
    // terminal takes its viewers' size, born 200x120) and its capture joins soft-wrapped lines, so the token outgrows the
    // terminal's own width instead, and the wrap is proved by the width, not by a newline in the capture.
    const marker = `verified-send-${randomUUID()}` + (wrapped ? "-" + "x".repeat(300) + " tail" : "");
    if (wrapped) {
      const terminal = await core!.client().call<HcTerminal>("terminal.get", { terminal: hcTerminalName(recipient) });
      expect(marker.length, "the token is wider than the terminal, so the line really wraps").toBeGreaterThan(terminal.cols);
    }
    const receipt = await cli(["send", recipient, marker, "--verify", "--json"]);
    expect(receipt.verified).toBe(true);
    const target = await cli(["capture", recipient, "--json"]);
    const sibling = await cli(["capture", sender, "--json"]);
    expect(JSON.stringify(target).replace(/\\n/g, "")).toContain(marker);
    expect(JSON.stringify(sibling).replace(/\\n/g, "")).not.toContain(marker);
    // Pane rendering is the contract here. The stub has no consuming input loop.
  }, 60_000);

  it("keeps the current-rig view exact while explicit scopes reach the other live rig", async () => {
    const all = await cli(["ps", "--nodes", "--all-rigs", "--json"]);
    expect(all.map((n: { canonicalSessionName: string }) => n.canonicalSessionName).sort()).toEqual([sender, recipient]);
    for (const [rig, seat] of [["rig-alpha", sender], ["rig-beta", recipient]]) {
      const nodes = await cli(["ps", "--nodes", "--rig", rig, "--json"]);
      expect(nodes.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([seat]);
      expect(nodes[0].sessionStatus).toBe("running");
    }
    const current = await cli(["ps", "--nodes", "--json"]);
    expect(current.entries.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([sender]);
    expect(current.scope).toMatchObject({ rig: "rig-alpha", rigsOnHost: 2 });
    // Exact arrays, not subset matches: an extra sibling is a failure.
  }, 60_000);

  it("replays one exact stream item after restart and an idempotent emit retry", async () => {
    const id = `journey-${randomUUID()}`;
    const tag = `journey-tag-${randomUUID()}`;
    const body = `durable-body-${randomUUID()}`;
    const emit = ["stream", "emit", "--source", sender, "--id", id, "--body", body, "--hint-tags", tag, "--json"];
    const item = await cli(emit);
    expect(item).toMatchObject({ streamItemId: id, sourceSession: sender, body });
    await cli(["stream", "emit", "--source", recipient, "--body", "unrelated-stream-control", "--json"]);
    const read = () => cli(["stream", "list", "--tag", tag, "--json"]);
    expect(await read()).toEqual([item]);
    await daemon!.restart();
    expect(await read()).toEqual([item]);
    expect(await cli(emit)).toEqual(item);
    expect(await read()).toEqual([item]);
    // Durable CLI replay, not an SSE/live-watch or stub-activity-hook claim.
  }, 60_000);
});
