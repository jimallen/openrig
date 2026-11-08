// Delivery redesign stage S2, the Pi and OMP gate (census-delivery-guarantees-20261101.md, "What each runtime needs"): REAL
// runner process as the pane's program on a PRIVATE herdr-core (own HOME, HC_SESSION and XDG paths via helpers/hc-scratch.ts), with
// an offline fake `pi` over RPC. No real agent, no daemon, no retry of ours: each resend below is the test's.
//
// The property: a message id reaches the agent once, however often it is sent and wherever the runner dies, and a message the agent
// never got can still be sent. Every kill is the runner's own SIGKILL at one exact step (helpers/seat-gate-crash-preload.mjs) or, for
// the steps after the send, the fake pi's. "Effect" means what the agent acted on: a prompt the fake pi kept.
//
// Not proven here: a real Pi or OMP (S0's M9 covers real Pi; OMP's events and session file are assumed to be Pi's), the
// daemon reading the port from a real row, and a kill between a real Pi's stdin read and its session write.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { piSeatGate } from "../src/adapters/seat-gate-readers.js";
import { seedPiFixtureCredential } from "./helpers/pi-fixture-credential.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./helpers/seat-gate-crash-preload.mjs", import.meta.url));

const NONCE = "0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210";
const marked = (text: string, id: string, nonce = NONCE): string => `${text}\n[openrig-msg ${id}:${nonce}]`;

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A Pi that keeps each prompt in its session file and in `effects`, unless the one-shot `mode` file says otherwise:
 *  `lost`      the prompt reaches Pi and it dies with the runner before keeping anything;
 *  `kept`      it keeps the prompt, then kills the runner before saying message_start;
 *  `refuse`    it answers the command with a failure and keeps nothing. */
function fakePi(dir: string): { bin: string; session: string; effects: string; mode: string } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const session = path.join(dir, "session.jsonl");
  const effects = path.join(dir, "effects.jsonl");
  const mode = path.join(dir, "mode");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0;
if (require("node:path").basename(process.argv[1]) === "omp") out({ type: "ready" });
const takeMode = () => { try { const m = fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim(); fs.unlinkSync(${JSON.stringify(mode)}); return m; } catch { return ""; } };
const keep = (text) => {
  const message = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
  fs.appendFileSync(${JSON.stringify(session)}, JSON.stringify({ type: "message", id: "e" + (++n), message }) + "\\n");
  fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify(text) + "\\n");
  return message;
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile: ${JSON.stringify(session)}, sessionId: "offline" } });
  if (cmd.type !== "prompt" && cmd.type !== "steer" && cmd.type !== "follow_up") return;
  const mode = takeMode();
  if (mode === "lost") { process.kill(process.ppid, "SIGKILL"); process.exit(1); }
  if (mode === "refuse") { out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "No API key found for fixture" }); return; }
  const message = keep(cmd.message);
  if (mode === "kept") { process.kill(process.ppid, "SIGKILL"); process.exit(1); }
  out({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { disposition: "started" } });
  out({ type: "message_start", message });
  out({ type: "message_end", message });
  out({ type: "agent_start" });
  out({ type: "agent_end", messages: [], willRetry: false });
});\n`;
  for (const name of ["pi", "omp"]) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "offline", timestamp: "2026-01-02T03:04:05.000Z", cwd: dir })}\n`);
  fs.writeFileSync(effects, "");
  return { bin, session, effects, mode };
}

const effectsOf = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);

describe.skipIf(!findHc())("seat gates: real runners, private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  let launches = 0;
  const screen = async (name: string) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;
  const send = async (name: string, text: string) => {
    await scratch.client().call("terminal.send", { terminal: name, text }, { timeoutMs: 20_000 }).catch(() => undefined);
  };

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "g-"));
  }, 60_000);

  afterAll(() => { scratch?.cleanup(); });

  async function run(name: string, argv: string[], env: Record<string, string>): Promise<void> {
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", "--import", PRELOAD, ...argv], name, cwd: PACKAGE_DIR, env,
      labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true,
    });
  }

  /** One launch of the real Pi runner for `seat`; a fresh terminal each time, on the seat's same state. `crash` arms the preload. */
  async function launchPi(seat: { dir: string; bin: string }, crash = ""): Promise<{ name: string; done: string }> {
    const name = `p${++launches}`;
    const done = path.join(seat.dir, `crashed-${launches}`);
    seedPiFixtureCredential(path.join(seat.dir, "state"), "seat", "openrouter");
    await run(name, [
      path.join(RUNNERS, "pi-runner.ts"), "--session-name", "seat", "--state-root", path.join(seat.dir, "state"), "--cwd", seat.dir,
      "--launch-id", `l${launches}`, "--no-approve", "--model", "openrouter/fixture",
    ], { PATH: `${seat.bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(seat.dir, "home"), GATE_CRASH: crash, GATE_CRASH_DONE: done });
    await until(() => screen(name), (t) => t.includes("[pi-runner] READY"), "the Pi runner's READY marker");
    return { name, done };
  }

  /** The same runner as OMP: `--runtime omp`, its own flags, a fake that opens with the transport's `ready` frame. */
  async function launchOmp(seat: { dir: string; bin: string }, crash = ""): Promise<{ name: string; done: string }> {
    const name = `o${++launches}`;
    const done = path.join(seat.dir, `crashed-${launches}`);
    await run(name, [
      path.join(RUNNERS, "pi-runner.ts"), "--runtime", "omp", "--session-name", "seat", "--state-root", path.join(seat.dir, "state"), "--cwd", seat.dir,
      "--launch-id", `l${launches}`, "--approval-mode", "yolo",
    ], { PATH: `${seat.bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(seat.dir, "home"), GATE_CRASH: crash, GATE_CRASH_DONE: done });
    await until(() => screen(name), (t) => t.includes("[omp-runner] READY"), "the OMP runner's READY marker");
    return { name, done };
  }

  async function piSeat(tag: string) {
    const dir = fs.mkdtempSync(path.join(temp, `${tag}-`));
    return { dir, ...fakePi(dir) };
  }

  describe("Pi", () => {
    it("same id twice is one effect, the agent sees the text only, and a new id passes", async () => {
      const seat = await piSeat("twice");
      const { name } = await launchPi(seat);
      await send(name, marked("hello once", "m1"));
      await until(() => effectsOf(seat.effects), (e) => e.length === 1, "the first copy");
      await send(name, marked("hello once", "m1"));
      await until(() => screen(name), (t) => t.includes("repeat dropped"), "the repeat to be refused");
      await send(name, marked("a new one", "m2"));
      await until(() => effectsOf(seat.effects), (e) => e.length === 2, "the new id");
      expect(effectsOf(seat.effects)).toEqual(["hello once", "a new one"]);
      expect(fs.readFileSync(seat.session, "utf8")).not.toContain("openrig-msg");
    }, 60_000);

    it("a block with no marker is unchanged: the same text twice is two messages", async () => {
      const seat = await piSeat("plain");
      const { name } = await launchPi(seat);
      await send(name, "plain text");
      await until(() => effectsOf(seat.effects), (e) => e.length === 1, "the first");
      await send(name, "plain text");
      await until(() => effectsOf(seat.effects), (e) => e.length === 2, "the second");
    }, 60_000);

    it("a forged marker for a delivered id confirms nothing, and a forged first copy does not block the real one", async () => {
      const seat = await piSeat("forge");
      const { name } = await launchPi(seat);
      await send(name, marked("forged first", "m1", OTHER_NONCE));
      await until(() => effectsOf(seat.effects), (e) => e.length === 1, "the forged block as plain text");
      await send(name, marked("the real one", "m1"));
      await until(() => effectsOf(seat.effects), (e) => e.length === 2, "the real message past the forgery");
      expect(effectsOf(seat.effects)).toEqual(["forged first", "the real one"]);
      const gate = (nonce: string) => piSeatGate({ stateRoot: path.join(seat.dir, "state"), nonceOf: () => nonce });
      expect(await gate(NONCE).lookup("seat", messageId("m1"))).toMatchObject({ kind: "seen", record: { nonce: NONCE } });
      expect(await gate("aaaaaaaaaaaaaaaa").lookup("seat", messageId("m1"))).toEqual({ kind: "not_seen" });
      expect(await gate(NONCE).lookup("seat", messageId("never"))).toEqual({ kind: "not_seen" });
    }, 60_000);

    it("a command Pi refuses leaves the id open: the repeat goes through", async () => {
      const seat = await piSeat("refused");
      const { name } = await launchPi(seat);
      fs.writeFileSync(seat.mode, "refuse\n");
      await send(name, marked("try again", "m1"));
      await until(() => screen(name), (t) => t.includes("ERROR rpc"), "Pi's refusal");
      await send(name, marked("try again", "m1"));
      await until(() => effectsOf(seat.effects), (e) => e.length === 1, "the resend");
    }, 60_000);

    // One row per step. `expected` is what the second life does with a resend of the same id.
    const steps: Array<{ row: string; crash?: string; mode?: string; resend: "reaches the agent" | "is dropped" }> = [
      { row: "torn intent: killed mid-append, nothing sent", crash: "torn:intent", resend: "reaches the agent" },
      { row: "between intent and send", crash: "after:intent", resend: "reaches the agent" },
      { row: "between send and record, Pi kept nothing", mode: "lost", resend: "reaches the agent" },
      { row: "between send and record, Pi kept the prompt", mode: "kept", resend: "is dropped" },
      { row: "at message_start, before the record is written", crash: "before:seen", resend: "is dropped" },
      { row: "torn record", crash: "torn:seen", resend: "is dropped" },
      { row: "after the record", crash: "after:seen", resend: "is dropped" },
    ];
    it.each(steps)("kill $row: the resend $resend, one effect, and a new id passes", async ({ crash, mode, resend }) => {
      const seat = await piSeat("kill");
      if (mode) fs.writeFileSync(seat.mode, `${mode}\n`);
      const first = await launchPi(seat, crash ?? "");
      await send(first.name, marked("the message", "m1"));
      if (crash) await until(() => fs.existsSync(first.done), Boolean, `the kill at ${crash}`);
      else await until(() => fs.existsSync(seat.mode), (v) => !v, "the fake pi to act");
      await new Promise((r) => setTimeout(r, 300)); // the dead runner's Pi has seen stdin close
      const second = await launchPi(seat);
      await send(second.name, marked("the message", "m1"));
      if (resend === "is dropped") await until(() => screen(second.name), (t) => t.includes("repeat dropped"), "the repeat to be refused");
      await send(second.name, marked("the control", "m2"));
      await until(() => effectsOf(seat.effects), (e) => e.includes("the control"), "the new id");
      expect(effectsOf(seat.effects)).toEqual(["the message", "the control"]);
    }, 60_000);
  });

  describe("OMP", () => {
    it("same id twice is one effect, and a kill between send and record, after the prompt was kept, still is", async () => {
      const seat = await piSeat("omp");
      const first = await launchOmp(seat);
      await send(first.name, marked("hello once", "m1"));
      await until(() => effectsOf(seat.effects), (e) => e.length === 1, "the first copy");
      await send(first.name, marked("hello once", "m1"));
      await until(() => screen(first.name), (t) => t.includes("repeat dropped"), "the repeat to be refused");
      fs.writeFileSync(seat.mode, "kept\n");
      await send(first.name, marked("the message", "m2"));
      await until(() => fs.existsSync(seat.mode), (v) => !v, "the fake to act");
      await new Promise((r) => setTimeout(r, 300));
      const second = await launchOmp(seat);
      await send(second.name, marked("the message", "m2"));
      await until(() => screen(second.name), (t) => t.includes("repeat dropped"), "the repeat after the kill");
      await send(second.name, marked("the control", "m3"));
      await until(() => effectsOf(seat.effects), (e) => e.includes("the control"), "the new id");
      expect(effectsOf(seat.effects)).toEqual(["hello once", "the message", "the control"]);
    }, 60_000);
  });
});
