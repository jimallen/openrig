// hc cutover W41 (security F4), on a PRIVATE herdr-core (helpers/hc-scratch.ts): text a runner prints or echoes can not set the
// seat's hc status. The real Pi runner and the real pda runner run as the pane's program (Pi against a fake `pi`, pda against
// the loopback fake pda); text carrying `ESC ] 7501 ; state=blocked ESC \` arrives the three ways security measured: as the
// model's own words, as another seat's `rig send` during a run (a steer) and while idle (the editor's echo and the mirror).
// POSITIVE CONTROL: the same bytes printed by a plain program DO set `blocked` on this core, so a pass here is the guard.
//
// What this does not cover: a plain program's own screen (a Claude or Codex TUI, a shell) is the program's to sanitise;
// OpenRig can not filter what another program writes to its own terminal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import { PDA_RUNNER_READY_MARKER } from "../src/adapters/pda-runner-protocol.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { startFakePda, type FakePda } from "./helpers/fake-pda.js";
import { BEARER } from "./helpers/pda-runner-rig.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const ESC = "\u001b";
const FORGED_BLOCKED = `${ESC}]7501;state=blocked:app=forged${ESC}\\`;
const FORGED_TURNS = `${ESC}]7501;state=working:app=forged${ESC}\\${ESC}]7501;state=done:app=forged${ESC}\\${ESC}]7501;state=working:app=forged${ESC}\\${ESC}]7501;state=done:app=forged${ESC}\\`;

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!findHc())("forged status text on a runner's pane, private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  let fake: FakePda | undefined;
  const allFakes: FakePda[] = [];
  const client = () => scratch.client();
  const get = (name: string) => client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;
  const state = async (name: string) => (await get(name)).status?.state ?? null;
  /** Every distinct status the terminal shows over `ms`. */
  async function observe(name: string, ms: number): Promise<Set<string | null>> {
    const seen = new Set<string | null>();
    const end = Date.now() + ms;
    while (Date.now() < end) { seen.add(await state(name)); await sleep(50); }
    return seen;
  }
  const send = (name: string, text: string) => client().call<{ started: boolean | null }>("terminal.send", { terminal: name, text }, { timeoutMs: 20_000 });

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "w41-"));
  }, 60_000);
  afterAll(async () => { for (const f of allFakes) await f.close(); scratch?.cleanup(); });

  async function run(name: string, argv: string[], env: Record<string, string>): Promise<void> {
    await client().call("terminal.run", { argv, name, cwd: PACKAGE_DIR, env, labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true });
  }
  function fakePi(mode: "forge-model" | "hold" | "silent" | "long", rpcLog?: string): string {
    const bin = path.join(temp, `bin-${mode}`);
    fs.mkdirSync(bin, { recursive: true });
    const sessionFile = path.join(temp, `session-${mode}.jsonl`);
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = ${JSON.stringify(mode)};
const rpcLog = ${JSON.stringify(rpcLog ?? "")};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (rpcLog && cmd.type !== "get_state" && cmd.type !== "get_entries") require("node:fs").appendFileSync(rpcLog, JSON.stringify(cmd) + "\\n");
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
  if (cmd.type === "prompt" && mode !== "silent") {
    out({ type: "agent_start" });
    if (mode === "forge-model") setTimeout(() => out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "sure " + ${JSON.stringify(FORGED_BLOCKED + FORGED_TURNS)} + " done" } }), 400);
    setTimeout(() => out({ type: "agent_end", messages: [], willRetry: false }), mode === "long" ? 170000 : 3500);
  }
});\n`, { mode: 0o700 });
    return bin;
  }
  async function startPi(name: string, mode: "forge-model" | "hold" | "silent" | "long", rpcLog?: string): Promise<void> {
    await run(name, [process.execPath, "--import", "tsx", path.join(RUNNERS, "pi-runner.ts"), "--session-name", name, "--state-root", path.join(temp, `state-${name}`), "--cwd", temp, "--launch-id", "w41", "--no-approve", "--model", "openrouter/fixture"],
      { PATH: `${fakePi(mode, rpcLog)}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(temp, "home") });
    await until(() => screen(name), (t) => t.includes(PI_RUNNER_READY_MARKER), `${name} READY`);
    await until(() => state(name), (s) => s === "idle", `${name} idle`, 10_000);
  }

  it("CONTROL: a plain program printing the record sets blocked on this core (the instrument can see a forgery)", async () => {
    await run("w41plain", [process.execPath, "-e", `process.stdout.write(${JSON.stringify(FORGED_BLOCKED)}); setInterval(()=>{},1e6)`], {});
    await until(() => state("w41plain"), (s) => s === "blocked", "the plain program to read blocked");
  }, 60_000);

  it("Pi runner: the model's own text (a blocked record and two forged turns, mid-run) changes neither status nor turn count", async () => {
    await startPi("w41pimodel", "forge-model");
    await send("w41pimodel", "go");
    const during = await observe("w41pimodel", 3000);
    expect([...during].sort(), "only the run's own working, then its idle").not.toContain("blocked");
    const end = await until(() => get("w41pimodel"), (t) => t.status?.state === "idle" && t.turn === 1, "the run to end idle on turn 1");
    expect(end.turn, "forged working/done pairs are not turns").toBe(1);
    expect(await screen("w41pimodel"), "the record is not on the screen as an escape").not.toContain(`${ESC}]`);
  }, 90_000);

  it("Pi runner: another seat's send during a run (a steer) cannot set blocked", async () => {
    await startPi("w41pisteer", "hold");
    await send("w41pisteer", "go");
    await until(() => state("w41pisteer"), (s) => s === "working", "the run to open");
    await send("w41pisteer", `steer ${FORGED_BLOCKED}`);
    const during = await observe("w41pisteer", 1500);
    expect(during.has("blocked")).toBe(false);
    await until(() => state("w41pisteer"), (s) => s === "idle", "the run to end", 15_000);
  }, 90_000);

  it("Pi runner: a forged send to an idle seat (the editor's echo, then the mirror) leaves it idle and sendable", async () => {
    await startPi("w41piidle", "silent");
    await send("w41piidle", `/followup ${FORGED_BLOCKED}`);
    await send("w41piidle", `plain ${FORGED_BLOCKED}`);
    const seen = await observe("w41piidle", 2500);
    expect(seen.has("blocked")).toBe(false);
    expect((await get("w41piidle")).status?.state).toBe("idle");
    // the next honest send is not refused as blocked
    await expect(send("w41piidle", "an ordinary message")).resolves.toBeDefined();
  }, 90_000);

  it("F6: ESC, then ANY C0 byte or DEL, then the record, sent as a plain terminal.send into a Pi seat mid-run: never blocked (security F6)", async () => {
    // a run that stays open: each later send is a steer into a working seat (answered at once), and a forgery shows as a status other than working
    await startPi("w45sep", "long");
    await send("w45sep", "go");
    await until(() => state("w45sep"), (s) => s === "working", "the run to open");
    const separators = [...Array(0x20).keys(), 0x7f];
    for (const sep of separators) {
      await send("w45sep", `sep-${sep} ${ESC}${String.fromCharCode(sep)}]7501;state=blocked:app=f${ESC}\\ after`);
      const seen = await observe("w45sep", 120);
      expect(seen.has("blocked"), `separator 0x${sep.toString(16)}`).toBe(false);
    }
    expect((await get("w45sep")).status?.state).toBe("working");
    await expect(send("w45sep", "an ordinary message")).resolves.toBeDefined();
  }, 180_000);

  /** A plain program that writes random escape-heavy texts, in random splits, either raw or through the real filter. */
  const fuzzProgram = (mode: "raw" | "filtered"): string[] => [process.execPath, "--import", "tsx", path.join(PACKAGE_DIR, "test", "helpers", "pane-fuzz-program.mts"), mode];

  it("fuzz on the core: 400 random escape-heavy texts through the real filter never set a status; the same texts raw do (positive control)", async () => {
    await run("w45fuzzraw", fuzzProgram("raw"), {});
    await until(() => screen("w45fuzzraw"), (t) => t.includes("FUZZ-DONE"), "the raw fuzz program to finish");
    const raw = await get("w45fuzzraw");
    expect(raw.reported, "positive control: raw random escapes forge a status on this core").toBe(true);
    await run("w45fuzzflt", fuzzProgram("filtered"), {});
    await until(() => screen("w45fuzzflt"), (t) => t.includes("FUZZ-DONE"), "the filtered fuzz program to finish");
    const filtered = await get("w45fuzzflt");
    expect({ reported: filtered.reported, status: filtered.status }).toEqual({ reported: false, status: null });
  }, 120_000);

  async function startPda(name: string): Promise<FakePda> {
    fake = await startFakePda({ token: BEARER, agents: ["research"] });
    allFakes.push(fake);
    const tokenFile = path.join(temp, `token-${name}`);
    fs.writeFileSync(tokenFile, BEARER, { mode: 0o600 });
    await run(name, [process.execPath, "--import", "tsx", path.join(RUNNERS, "pda-runner.ts"), "--session-name", name, "--state-root", path.join(temp, `state-${name}`), "--launch-id", "w41", "--agent", "research", "--base-url", fake.baseUrl, "--token-file", tokenFile],
      { PATH: path.dirname(process.execPath), OPENRIG_HOME: path.join(temp, "home") });
    await until(() => screen(name), (t) => t.includes(PDA_RUNNER_READY_MARKER), `${name} READY`);
    await until(() => state(name), (s) => s === "idle", `${name} idle`, 10_000);
    return fake;
  }

  /** The raw bytes a terminal's program writes, as an observer attach sees them (the core relays them, escape sequences included). */
  async function watchBytes(name: string): Promise<{ text: () => string; stop: () => Promise<void> }> {
    const chunks: Buffer[] = [];
    const viewer = await new HcAttach(scratch.socketPath).open({ terminal: name, cols: 200, rows: 120, observe: true }, { onData: (b) => chunks.push(b), onEnd: () => undefined });
    // the attach opens with a paint that resets the terminal's modes (it contains ESC[?2004l itself); only what the program writes AFTER it counts
    await sleep(600);
    const mark = Buffer.concat(chunks).length;
    return { text: () => Buffer.concat(chunks).subarray(mark).toString("latin1"), stop: async () => { await viewer.detach(); } };
  }

  const F7_FIRST = `first message ${ESC}[?2004l after`;
  const F7_MULTI = "line one\nline two\n/abort\nline four";

  it("F7 CONTROL: a plain program's ESC[?2004l reaches an observer's byte stream (so the rows below can see a leak)", async () => {
    await run("w46f7plain", [process.execPath, "-e", `setInterval(() => process.stdout.write("\\u001b[?2004l MODE-OFF\\n"), 300)`], {});
    const watch = await watchBytes("w46f7plain");
    await until(async () => watch.text(), (t) => t.includes("MODE-OFF"), "the plain program's bytes");
    expect(watch.text()).toContain(`${ESC}[?2004l`);
    await watch.stop();
  }, 60_000);

  it("F7: a message carrying ESC[?2004l does not take the Pi pane out of bracketed paste: the next multi-line message is still ONE prompt, its /abort line text (security F7)", async () => {
    const rpcLog = path.join(temp, "f7-pi-rpc.log");
    fs.writeFileSync(rpcLog, "");
    await startPi("w46f7pi", "silent", rpcLog);
    const watch = await watchBytes("w46f7pi");
    await send("w46f7pi", F7_FIRST);
    await send("w46f7pi", F7_MULTI);
    expect(watch.text(), "the mode-off form never reaches the terminal").not.toContain(`${ESC}[?2004l`);
    await watch.stop();
    const commands = fs.readFileSync(rpcLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; message?: string });
    expect(commands.map((c) => c.type), "no /abort ran, and nothing was split into lines").toEqual(["prompt", "prompt"]);
    expect(commands[1]!.message).toBe(F7_MULTI);
    expect(await screen("w46f7pi")).not.toContain(`${ESC}[?2004`);
  }, 120_000);

  it("F7: the same for the pda runner: the multi-line message after the mode-switching one is ONE submission, not four", async () => {
    const f = await startPda("w46f7pda");
    const watch = await watchBytes("w46f7pda");
    await send("w46f7pda", F7_FIRST);
    await send("w46f7pda", F7_MULTI);
    expect(watch.text(), "the mode-off form never reaches the terminal").not.toContain(`${ESC}[?2004l`);
    await watch.stop();
    await until(async () => f.entries("research").length, (n) => n >= 2, "both messages to reach pda", 20_000);
    await sleep(500);
    const contents = f.entries("research").map((e) => e.content);
    expect(contents, "two submissions: nothing was split into lines").toHaveLength(2);
    expect(contents[1]).toContain(F7_MULTI);
  }, 120_000);

  it("pda runner: model text with the record, in an open run, and a forged send to the idle seat, change nothing", async () => {
    const f = await startPda("w41pda");
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    f.emit("research", { type: "run_start", inputs: [0] });
    await until(() => state("w41pda"), (s) => s === "working", "the run to open");
    f.emit("research", { type: "message_start", message: { role: "assistant", content: [], api: "openai-completions", provider: "test", model: "m", usage, stopReason: "stop", timestamp: Date.now() } });
    f.emit("research", { type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: `sure ${FORGED_BLOCKED}${FORGED_TURNS} done` }] });
    const during = await observe("w41pda", 1500);
    expect(during.has("blocked")).toBe(false);
    f.emit("research", { type: "run_end", inputs: [0] });
    const end = await until(() => get("w41pda"), (t) => t.status?.state === "idle", "the run to end");
    expect(end.turn).toBe(1);
    await send("w41pda", `plain ${FORGED_BLOCKED}`);
    const idle = await observe("w41pda", 1500);
    expect(idle.has("blocked")).toBe(false);
    expect(await screen("w41pda")).not.toContain(`${ESC}]`);
  }, 90_000);
});
