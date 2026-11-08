// OF-267 (B): can hc's terminal status say "this Pi seat has been working since T" through a long silent tool call?
//
// The Pi runner writes OSC 7501 `working` on agent_start / tool_execution_start and `idle` on agent_end (runner-hc-status.ts), and
// writes nothing in between. These rows run the REAL Pi runner against an offline fake `pi` on a PRIVATE hc core (own HOME,
// HC_SESSION and XDG paths via helpers/hc-scratch.ts; the host's core and the app are never contacted) and read the core the way the
// daemon would: `terminal.get`. They pin the facts the daemon's busy report rests on:
//   1. status is `working` at every poll through a hook-silent tool call, and `status_ms` does not move while it holds;
//   2. `status_ms` is when the status began (epoch ms on this host's clock), not a duration;
//   3. later tool starts in the same run do not move it, so "working since" is the start of the run;
//   4. idle at agent_end moves it, and a runner that dies leaves no live terminal behind a stale `working`.
// OF267_HOLD_MS lengthens the hold (the measurement run used 330000, past the hook store's 5-minute freshness window).
//
// Not proven here: a real Pi, macOS, and a runner that is alive but wedged (it would read `working` too, which is the truth of an open turn).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { seedPiFixtureCredential } from "./helpers/pi-fixture-credential.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const HOLD_MS = Number(process.env.OF267_HOLD_MS ?? 20_000);
const POLL_MS = Math.max(500, Math.floor(HOLD_MS / 40));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!findHc())("a Pi seat's hc status through a long silent tool call (private core)", () => {
  let scratch: HcScratch;
  let temp: string;
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "of267-"));
  }, 60_000);
  afterAll(() => { scratch?.cleanup(); });

  /** A Pi whose prompt runs: agent_start, a bash tool start, `hold` ms of silence, a second tool start, the tool end, agent_end. */
  function fakePi(dir: string, hold: number): string {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
  if (cmd.type === "prompt") {
    out({ type: "agent_start" });
    setTimeout(() => out({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1" }), 300);
    setTimeout(() => out({ type: "tool_execution_start", toolName: "read", toolCallId: "t2" }), 300 + ${hold} / 2);
    setTimeout(() => { out({ type: "tool_execution_end", toolName: "read", toolCallId: "t2" }); out({ type: "agent_end", messages: [], willRetry: false }); }, 300 + ${hold});
  }
});\n`, { mode: 0o700 });
    return bin;
  }

  async function startRunner(name: string, dir: string, hold: number): Promise<number> {
    const bin = fakePi(dir, hold);
    seedPiFixtureCredential(path.join(dir, "state"), name, "openrouter");
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", path.join(RUNNERS, "pi-runner.ts"), "--session-name", name, "--state-root", path.join(dir, "state"), "--cwd", dir,
        "--launch-id", name, "--no-approve", "--model", "openrouter/fixture"],
      name, cwd: PACKAGE_DIR, env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(dir, "home") },
      labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await until(() => screen(name), (t) => t.includes(PI_RUNNER_READY_MARKER), "the Pi runner's READY marker");
    await until(() => get(name), (t) => t.reported === true, `${name} to report status`, 10_000);
    return 0;
  }

  it("status stays working with an unmoving status_ms through the silent call, status_ms is the epoch start of the run, idle moves it", async () => {
    const dir = path.join(temp, "long");
    await startRunner("of267pi", dir, HOLD_MS);
    const idleBefore = await get("of267pi");
    expect(idleBefore.status?.state).toBe("idle");

    const sentAt = Date.now();
    await scratch.client().call("terminal.send", { terminal: "of267pi", text: "run" }, { timeoutMs: 20_000 });
    const working = await until(() => get("of267pi"), (t) => t.status?.state === "working", "the seat to read working", 10_000);
    const seenAt = Date.now();
    const timeline: Array<{ t: number; state: string | undefined; status_ms: number | null | undefined; turn: number | undefined; live: string }> = [];
    const runEnds = sentAt + 300 + HOLD_MS;
    while (Date.now() < runEnds - 1500) {
      const t = await get("of267pi");
      timeline.push({ t: Date.now() - sentAt, state: t.status?.state, status_ms: t.status_ms, turn: t.turn, live: t.state });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    console.log(`OF267 first working read: status_ms=${working.status_ms} sentAt=${sentAt} seenAt=${seenAt} idleBefore.status_ms=${idleBefore.status_ms}`);
    console.log(`OF267 timeline (${timeline.length} polls): ${JSON.stringify(timeline.filter((_, i) => i % 5 === 0 || i === timeline.length - 1))}`);

    // 1. working at every poll, the same status_ms, the terminal live, through the call and past the second tool start.
    expect(timeline.length).toBeGreaterThan(5);
    expect(new Set(timeline.map((p) => p.state))).toEqual(new Set(["working"]));
    expect(new Set(timeline.map((p) => p.live))).toEqual(new Set(["live"]));
    expect(new Set(timeline.map((p) => p.status_ms)).size, "a second tool start in the same run does not restart 'since'").toBe(1);
    expect(timeline[0]!.status_ms).toBe(working.status_ms);
    // 2. status_ms is the time the status began on this host's clock (epoch ms): within the send-to-read window, and an absolute time.
    expect(working.status_ms!).toBeGreaterThanOrEqual(sentAt - 2000);
    expect(working.status_ms!).toBeLessThanOrEqual(seenAt + 1000);
    expect(working.status_ms!).toBeGreaterThan(idleBefore.status_ms ?? 0);

    // 4a. idle at agent_end moves it.
    const idle = await until(() => get("of267pi"), (t) => t.status?.state === "idle", "the run to end idle", HOLD_MS + 15_000);
    expect(idle.status_ms!).toBeGreaterThan(working.status_ms! + HOLD_MS - 2000);
  }, HOLD_MS + 120_000);

  it("a runner that dies mid-run leaves no live terminal reading working", async () => {
    const dir = path.join(temp, "dies");
    await startRunner("of267die", dir, 60_000);
    await scratch.client().call("terminal.send", { terminal: "of267die", text: "run" }, { timeoutMs: 20_000 });
    const working = await until(() => get("of267die"), (t) => t.status?.state === "working", "the seat to read working", 10_000);
    expect(working.state).toBe("live");
    expect(working.pid, "the runner's pid").toBeGreaterThan(0);
    process.kill(working.pid!, "SIGKILL");
    const after = await until(() => get("of267die"), (t) => t.state !== "live", "the terminal to stop being live", 15_000);
    console.log(`OF267 after SIGKILL: ${JSON.stringify({ state: after.state, status: after.status, status_ms: after.status_ms, exit_code: after.exit_code, finished_ms: after.finished_ms })}`);
    expect(after.state).not.toBe("live");
  }, 120_000);
});
