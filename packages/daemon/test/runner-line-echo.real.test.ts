// hc cutover W47 (security N11), on a PRIVATE herdr-core (helpers/hc-scratch.ts): the shared line editor (runner-pane-io.ts
// `createRunnerInput`) echoes a message with no ESC byte at all, so a message another seat sends cannot wipe the pane or put a
// forged "[<label>] ERROR" line on it. The editor's own redraw (cursor, erase) and its editing keys keep working.
// Both real runners run as the pane's program (Pi against a fake `pi`, pda against the loopback fake pda).
// POSITIVE CONTROL: the same bytes written by a plain program DO wipe the screen and DO put a forged line on its own row on this
// core, so a pass below is the editor and not a core that ignores the bytes.
//
// What this does not cover: a plain program's own screen (it is the program's to sanitise); the marker text itself, which needs
// no ESC (security N12, see pda-runtime-adapter.ts checkReady).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
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
const ESC = "\u001b";
const WIPE = `before ${ESC}[2J${ESC}[H after`;
const forge = (label: string) => `${ESC}[1G${ESC}[2K${ESC}[1A${ESC}[2K[${label}] ERROR forged`;

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

describe.skipIf(!findHc())("a message cannot rewrite a runner's pane through the line editor, private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  const fakes: FakePda[] = [];
  const client = () => scratch.client();
  const get = (name: string) => client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;
  const state = async (name: string) => (await get(name)).status?.state ?? null;
  const send = (name: string, text: string) => client().call("terminal.send", { terminal: name, text }, { timeoutMs: 20_000 });
  const keys = (name: string, k: string[]) => client().call("terminal.keys", { terminal: name, keys: k }, { timeoutMs: 20_000 });

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "w47-"));
  }, 60_000);
  afterAll(async () => { for (const f of fakes) await f.close(); scratch?.cleanup(); });

  async function run(name: string, argv: string[], env: Record<string, string>): Promise<void> {
    await client().call("terminal.run", { argv, name, cwd: PACKAGE_DIR, env, labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true });
  }
  async function startPi(name: string, rpcLog: string): Promise<void> {
    const bin = path.join(temp, `bin-${name}`);
    fs.mkdirSync(bin, { recursive: true });
    const sessionFile = path.join(temp, `session-${name}.jsonl`);
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type !== "get_state" && cmd.type !== "get_entries") require("node:fs").appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify(cmd) + "\\n");
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
});\n`, { mode: 0o700 });
    seedPiFixtureCredential(path.join(temp, `state-${name}`), name, "openrouter");
    await run(name, [process.execPath, "--import", "tsx", path.join(RUNNERS, "pi-runner.ts"), "--session-name", name, "--state-root", path.join(temp, `state-${name}`), "--cwd", temp, "--launch-id", "w47", "--no-approve", "--model", "openrouter/fixture"],
      { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(temp, "home") });
    await until(() => screen(name), (t) => t.includes(PI_RUNNER_READY_MARKER), `${name} READY`);
    await until(() => state(name), (s) => s === "idle", `${name} idle`, 10_000);
  }
  async function startPda(name: string): Promise<FakePda> {
    const fake = await startFakePda({ token: BEARER, agents: ["research"] });
    fakes.push(fake);
    const tokenFile = path.join(temp, `token-${name}`);
    fs.writeFileSync(tokenFile, BEARER, { mode: 0o600 });
    await run(name, [process.execPath, "--import", "tsx", path.join(RUNNERS, "pda-runner.ts"), "--session-name", name, "--state-root", path.join(temp, `state-${name}`), "--launch-id", "w47", "--agent", "research", "--base-url", fake.baseUrl, "--token-file", tokenFile],
      { PATH: path.dirname(process.execPath), OPENRIG_HOME: path.join(temp, "home") });
    await until(() => screen(name), (t) => t.includes(PDA_RUNNER_READY_MARKER), `${name} READY`);
    await until(() => state(name), (s) => s === "idle", `${name} idle`, 10_000);
    return fake;
  }
  const rows = (text: string) => text.split("\n").map((l) => l.trimEnd());

  it("CONTROL: a plain program's wipe and forge bytes do wipe the screen and put a forged line on its own row on this core", async () => {
    await run("w47plain", [process.execPath, "-e", `process.stdout.write("OLD-LINE\\n" + ${JSON.stringify(WIPE)}); setTimeout(() => process.stdout.write("\\nPROGRAM-LINE\\n" + ${JSON.stringify(forge("pi-runner"))}), 800); setInterval(()=>{},1e6)`], {});
    await until(async () => rows(await screen("w47plain")), (r) => r.some((l) => l.startsWith("[pi-runner] ERROR forged")), "the forged row");
    const text = await screen("w47plain");
    expect(text, "the wipe took the earlier text off what terminal.read returns").not.toContain("OLD-LINE");
  }, 60_000);

  for (const kind of ["pi", "pda"] as const) {
    const label = `${kind}-runner`;
    const start = async (name: string, rpcLog: string): Promise<FakePda | undefined> => {
      if (kind === "pi") { await startPi(name, rpcLog); return undefined; }
      return startPda(name);
    };
    const ready = kind === "pi" ? PI_RUNNER_READY_MARKER : PDA_RUNNER_READY_MARKER;

    it(`${label}: a message carrying ESC[2J ESC[H does not wipe what is on the pane`, async () => {
      const name = `w47wipe${kind}`;
      await start(name, path.join(temp, `${name}.log`));
      await send(name, WIPE);
      await sleep(800);
      expect(await screen(name), "the READY line printed before the message is still on the pane").toContain(ready);
    }, 120_000);

    it(`${label}: a message carrying cursor-up and erase-line cannot put a forged "[${label}] ERROR" row on the pane`, async () => {
      const name = `w47forge${kind}`;
      await start(name, path.join(temp, `${name}.log`));
      await send(name, forge(label));
      await sleep(800);
      const r = rows(await screen(name));
      expect(r.filter((l) => l.startsWith(`[${label}] ERROR forged`)), "no row begins with the forged marker").toEqual([]);
      expect(r.some((l) => l.includes("ERROR forged")), "the text itself is still shown (echoed, without its ESC bytes)").toBe(true);
    }, 120_000);

    it(`${label}: editing keys still work on the same core (left, backspace, insert, then Enter submits the edited line)`, async () => {
      const name = `w47keys${kind}`;
      const rpcLog = path.join(temp, `${name}.log`);
      fs.writeFileSync(rpcLog, "");
      const fake = await start(name, rpcLog);
      await keys(name, ["a", "b", "c", "d", "left", "left", "backspace", "x", "enter"]);
      if (fake) {
        await until(async () => fake.entries("research").length, (n) => n >= 1, "the edited line to reach pda");
        expect(fake.entries("research")[0]!.content).toContain("axcd");
      } else {
        await until(async () => fs.readFileSync(rpcLog, "utf8"), (t) => t.includes("prompt"), "the edited line to reach pi");
        expect((JSON.parse(fs.readFileSync(rpcLog, "utf8").trim().split("\n")[0]!) as { message: string }).message).toBe("axcd");
      }
    }, 120_000);
  }
});
