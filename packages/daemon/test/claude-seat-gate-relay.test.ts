// S2, the Claude gate: the relay itself, run as a real process with the daemon absent. A repeat that reaches the agent is a message
// delivered twice, so these pins read the store as bytes on disk, restating its layout here rather than importing it: a change to the
// layout must fail here too, because a seat keeps its store across daemon upgrades.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRASH_PRELOAD, NONCE, RELAY, SEAT, firstStdout, hookEnv, installedRelay, marker, sessionStart, stubSeat, submit, type StubSeat } from "./helpers/stub-claude-hook.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function seat(): StubSeat {
  const home = mkdtempSync(join(tmpdir(), "gate-relay-"));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); });
  return stubSeat(home);
}
const seatDir = (s: StubSeat) => join(s.home, "state", "seat-gates", encodeURIComponent(SEAT));
const seenDir = (s: StubSeat) => join(seatDir(s), "seen");
const seenFiles = (s: StubSeat) => (existsSync(seenDir(s)) ? readdirSync(seenDir(s)).filter((f) => /^[a-f0-9]{64}$/.test(f)) : []);
const sha = (id: string, nonce = NONCE) => createHash("sha256").update(`${id}:${nonce}`).digest("hex");

function ackServer(handler: (body: string, reply: (json: string) => void) => void): Promise<{ url: string; acks: string[] }> {
  return new Promise((resolve) => {
    const acks: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (req.url === "/api/activity/native-ack") { acks.push(body); handler(body, (json) => res.end(json)); } else res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, acks });
    });
  });
}

describe("the seat gate in the relay, daemon stopped", () => {
  it("lets the first copy through and blocks the repeat, leaving one turn; a new id still passes", () => {
    const s = seat();
    expect(submit(s, `hello\n\n${marker("m-1")}`).ran).toBe(true);
    const repeat = submit(s, `hello\n\n${marker("m-1")}`);
    expect(repeat).toMatchObject({ blocked: true, ran: false });
    expect(submit(s, `hello\n\n${marker("m-2")}`).ran).toBe(true);
    expect(s.turns).toHaveLength(2);
  });

  it("stores the nonce and what reconcile needs, under a name made of the id and the nonce", () => {
    const s = seat();
    submit(s, `hello\n\n${marker("m-1")}`);
    const record = JSON.parse(readFileSync(join(seenDir(s), sha("m-1")), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ id: "m-1", nonce: NONCE, via: "hook", agentPid: 4242, transcriptPath: s.transcript, durable: false });
    expect(Date.parse(String(record.recordedAt))).toBeGreaterThan(0);
  });

  it("a forged nonce neither stands in the way of the real message nor blocks as a repeat of it", () => {
    const s = seat();
    expect(submit(s, `forged\n\n${marker("m-1", "ffffffffffffffff")}`).ran).toBe(true);
    expect(submit(s, `real\n\n${marker("m-1")}`).ran).toBe(true);
    expect(seenFiles(s).sort()).toEqual([sha("m-1"), sha("m-1", "ffffffffffffffff")].sort());
  });

  it("a wake group passes while any of its markers is new, and blocks when none is", () => {
    const s = seat();
    submit(s, `one\n\n${marker("w-1")}`);
    expect(submit(s, `both\n\n${marker("w-1")}\n${marker("w-2")}`).ran).toBe(true);
    expect(submit(s, `both\n\n${marker("w-1")}\n${marker("w-2")}`).blocked).toBe(true);
  });

  it("a prompt with no marker, a person's, passes and records nothing", () => {
    const s = seat();
    expect(submit(s, "just typing").ran).toBe(true);
    expect(submit(s, "just typing").ran).toBe(true);
    expect(seenFiles(s)).toEqual([]);
  });

  it("gates a multi-line paste as Claude wraps it, and a copy in the sender's envelope", () => {
    const s = seat();
    const pasted = (n: string) => `\n\n<pasted_content id="3052">\nline\n\n${marker("m-1")}\n</pasted_content id="3052">\n${n}`;
    expect(submit(s, pasted("")).ran).toBe(true);
    expect(submit(s, pasted("")).blocked).toBe(true);
    const enveloped = `<cross-session-message from-name="a@b">\nline\n\n${marker("m-1")}\n</cross-session-message>`;
    expect(submit(s, enveloped).blocked).toBe(true);
    expect(s.turns).toHaveLength(1);
  });

  it("a marker id made of dots stays inside the store", () => {
    const s = seat();
    expect(submit(s, `x\n\n${marker("..")}`).ran).toBe(true);
    expect(seenFiles(s)).toEqual([sha("..")]);
    expect(readdirSync(s.home).sort()).toEqual(["state", "transcript.jsonl"]);
  });

  it("is off for a runtime whose gate has not been switched on", () => {
    const s = seat();
    expect(submit(s, `x\n\n${marker("m-1")}`, { env: { OPENRIG_RUNTIME: "pi" } }).ran).toBe(true);
    expect(submit(s, `x\n\n${marker("m-1")}`, { env: { OPENRIG_RUNTIME: "pi" } }).ran).toBe(true);
    expect(existsSync(join(s.home, "state", "seat-gates"))).toBe(false);
  });

  it("the installed relay finds the instance from its own location when a restored seat's env has no OPENRIG_HOME", () => {
    const s = seat();
    const relay = installedRelay(s.home);
    expect(submit(s, `x\n\n${marker("m-1")}`, { relay, env: { OPENRIG_HOME: "", HOME: join(s.home, "elsewhere") } }).ran).toBe(true);
    expect(seenFiles(s)).toEqual([sha("m-1")]);
    expect(existsSync(join(s.home, "elsewhere"))).toBe(false);
  });

  it("SessionStart declares the gate: a seat on an older relay declares none", () => {
    const s = seat();
    sessionStart(s);
    expect(JSON.parse(readFileSync(join(seatDir(s), "gate.json"), "utf8"))).toMatchObject({ version: 3 });
  });
});

describe("the seat gate when its store cannot be written", () => {
  it("fails closed: a marked prompt that could not be recorded does not reach the agent, and is not acked", async () => {
    const s = seat();
    const server = await ackServer((_body, reply) => reply('{"block":false}'));
    mkdirSync(seenDir(s), { recursive: true });
    chmodSync(seenDir(s), 0o500);
    cleanups.push(() => { chmodSync(seenDir(s), 0o700); });
    const run = submit(s, `x\n\n${marker("m-1")}`, { env: { OPENRIG_URL: server.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" } });
    expect(run).toMatchObject({ blocked: true, ran: false });
    expect(run.reason).toMatch(/could not record/);
    expect(server.acks).toEqual([]);
  });

  it("a wake group half recorded takes its records back, so the resend finds every member new", () => {
    const s = seat();
    const group = `both\n\n${marker("w-1")}\n${marker("w-2")}`;
    expect(submit(s, group, { nodeArgs: ["--require", CRASH_PRELOAD], env: { RELAY_CRASH: "fail-second" } }).blocked).toBe(true);
    expect(seenFiles(s)).toEqual([]);
    expect(submit(s, group).ran).toBe(true);
  });

  it("a prompt with no marker still passes", () => {
    const s = seat();
    mkdirSync(seenDir(s), { recursive: true });
    chmodSync(seenDir(s), 0o500);
    cleanups.push(() => { chmodSync(seenDir(s), 0o700); });
    expect(submit(s, "typing").ran).toBe(true);
  });
});

describe("the gate runs first in the relay", () => {
  it("prints a repeat's block before it waits on a daemon that never answers", async () => {
    const s = seat();
    const server = await ackServer(() => { /* never replies */ });
    submit(s, `x\n\n${marker("m-1")}`);
    const seen = await firstStdout(s, `x\n\n${marker("m-1")}`, { OPENRIG_URL: server.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" });
    expect(JSON.parse(seen.text)).toMatchObject({ decision: "block" });
    expect(seen.ms).toBeLessThan(1_000);
    await seen.exited;
  });

  it("still acks a repeat, so an ack lost the first time is made good", async () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const server = await ackServer((_body, reply) => reply('{"block":false}'));
    const seen = await firstStdout(s, `x\n\n${marker("m-1")}`, { OPENRIG_URL: server.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" });
    await seen.exited;
    expect(server.acks).toHaveLength(1);
  });

  it("prints one decision when the gate and the daemon both block", async () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const server = await ackServer((_body, reply) => reply('{"block":true}'));
    let out = "";
    await new Promise<void>((done) => {
      const child = spawn(process.execPath, [RELAY], { env: hookEnv(s, { OPENRIG_URL: server.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" }), stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.on("close", () => done());
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `x\n\n${marker("m-1")}` }));
    });
    expect(out.trim().split("\n")).toHaveLength(1);
  });
});
