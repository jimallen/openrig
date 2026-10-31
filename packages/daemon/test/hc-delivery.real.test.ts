import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { HcAttach, type HcAttachment } from "../src/adapters/hc-attach.js";
import { HcHost } from "../src/adapters/hc-host.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { HcDelivery, hcPanePid, type HcDeliveryOutcome, type HcPendingSend } from "../src/adapters/hc-delivery.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

/** A program on a pty. It echoes what it is typed (so a token is on the screen), logs every chunk of stdin as hex, and
 *  with `turns` reports idle, then working and done for each Enter, so the core's turn counter moves. Bracketed paste on. */
const STUB = `
import os, sys, time, tty
mode, log_path = sys.argv[1], sys.argv[2]
tty.setraw(0)
turns = "turns" in mode.split(",")
os.write(1, b"\\x1b[?2004h")
if turns:
    os.write(1, b"\\x1b]7501;state=idle:app=stub\\x1b\\\\")
os.write(1, b"READY\\r\\n")
log = open(log_path, "ab", buffering=0)
while True:
    try:
        b = os.read(0, 65536)
    except InterruptedError:
        continue
    if not b:
        break
    log.write(b.hex().encode() + b"\\n")
    shown = b.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"").replace(b"\\r", b"\\r\\n")
    os.write(1, shown)
    if turns and b"\\r" in b:
        os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\")
        time.sleep(0.3)
        os.write(1, b"\\x1b]7501;state=done:app=stub\\x1b\\\\")
`;

describe.skipIf(!HC)("HcDelivery against a private hc core: exactly once", () => {
  const core = new PrivateCore("dlv");
  const attach = new HcAttach(core.socketPath);
  let stubPath: string;
  let n = 0;

  beforeAll(() => {
    core.start();
    mkdirSync(join(core.root, "w"), { recursive: true });
    stubPath = join(core.root, "w", "stub.py");
    writeFileSync(stubPath, STUB);
  });
  afterAll(() => core.stop());

  interface Seat { seat: string; address: string; stdin: () => string }

  async function launch(mode: string): Promise<Seat> {
    const seat = `dlv${++n}@rig`;
    const address = hcTerminalName(seat);
    const log = join(core.root, "w", `${address}.stdin`);
    writeFileSync(log, "");
    await core.client.call("terminal.run", { argv: ["python3", "-I", stubPath, mode, log], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the stub's first paint");
    return { seat, address, stdin: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((hex) => Buffer.from(hex, "hex").toString("latin1")).join("") };
  }

  /** A person at the keyboard: one key every 400 ms, so the core's ~3 s quiet window never opens until `stop`. */
  async function person(address: string): Promise<{ stop: () => Promise<void> }> {
    const viewer: HcAttachment = await attach.open({ terminal: address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    viewer.write("p");
    const timer = setInterval(() => { try { viewer.write("p"); } catch { /* the viewer ended with a core restart */ } }, 400);
    return { stop: async () => { clearInterval(timer); await viewer.detach().catch(() => undefined); } };
  }

  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const delivery = (timeoutMs: number) => new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: timeoutMs }));
  const pending = (outcome: HcDeliveryOutcome): HcPendingSend => {
    if (outcome.state !== "waiting" && outcome.state !== "unknown") throw new Error(`expected a pending outcome, got ${JSON.stringify(outcome).slice(0, 200)}`);
    return outcome.pending;
  };

  it("holds a send the core is queueing for a person, finds it by its token once typed, and never sends twice", async () => {
    const stub = await launch("plain");
    const typing = await person(stub.address);
    const d = delivery(1_500);
    const first = await d.deliver(stub.seat, "hello <tok-a1>", { token: "tok-a1" });
    expect(first).toMatchObject({ state: "waiting", reason: "waiting_on_person" });
    // While the person types, the verdict stays "waiting": the core still holds the text.
    expect(await d.verify(pending(first))).toMatchObject({ state: "waiting" });
    expect(stub.stdin()).not.toContain("hello");
    await typing.stop();
    const settled = await until(() => d.verify(pending(first)), (o) => o.state !== "waiting", "the token on the screen", 15_000);
    expect(settled).toMatchObject({ state: "delivered", evidence: "token_on_screen" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(occurrences(stub.stdin(), "\x1b[200~hello <tok-a1>\x1b[201~")).toBe(1);
    expect(occurrences(stub.stdin(), "\r")).toBe(1);
  }, 40_000);

  it("settles a send by the turn alone for a program that reports status, with no token", async () => {
    const stub = await launch("turns");
    const typing = await person(stub.address);
    const d = delivery(1_500);
    const first = await d.deliver(stub.seat, "work please");
    expect(first).toMatchObject({ state: "waiting" });
    expect(pending(first)).toMatchObject({ preStatus: "idle", preReported: true, preTurn: 0 });
    await typing.stop();
    const settled = await until(() => d.verify(pending(first)), (o) => o.state !== "waiting", "the turn to advance", 20_000);
    expect(settled).toMatchObject({ state: "delivered", evidence: "turn_advanced" });
    expect(occurrences(stub.stdin(), "\x1b[200~work please\x1b[201~")).toBe(1);
  }, 45_000);

  it("takes the core's own acknowledgement when there is no one at the keyboard", async () => {
    const stub = await launch("turns");
    const outcome = await delivery(20_000).deliver(stub.seat, "straight in");
    expect(outcome).toMatchObject({ state: "delivered", evidence: "reply", verified: true, started: true });
    expect(occurrences(stub.stdin(), "straight in")).toBe(1);
  }, 40_000);

  it("proves a send gone when the core restarts while it waits, and a retry then delivers exactly once", async () => {
    const stub = await launch("plain");
    const addressBefore = (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).address;
    const typing = await person(stub.address);
    const d = delivery(12_000);
    const racing = d.deliver(stub.seat, "survive this <tok-b1>", { token: "tok-b1" });
    // The restart must come after the send was issued by more than the margin, or it proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    core.restart();
    await typing.stop();
    const first = await racing;
    const verdict = first.state === "not_delivered" ? first : await until(() => d.verify(pending(first)), (o) => o.state !== "waiting" && o.state !== "unknown", "a verdict after the restart", 15_000);
    expect(verdict).toMatchObject({ state: "not_delivered", reason: "core_restarted_send_gone" });
    // The queued send did not survive the restart: the program never saw it, and the terminal kept its address.
    expect(stub.stdin()).not.toContain("survive this");
    expect((await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).address).toBe(addressBefore);
    const retried = await delivery(20_000).deliver(stub.seat, "survive this <tok-b1>", { token: "tok-b1" });
    expect(retried).toMatchObject({ state: "delivered" });
    await until(() => stub.stdin(), (s) => s.includes("survive this"), "the retried text", 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(occurrences(stub.stdin(), "survive this <tok-b1>")).toBe(1);
  }, 60_000);

  it("refuses a finished seat and an unknown one with nothing typed", async () => {
    const stub = await launch("plain");
    await core.client.call("terminal.kill", { terminal: stub.address });
    await until(async () => (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state, (s) => s === "finished", "the kill");
    expect(await delivery(2_000).deliver(stub.seat, "x")).toMatchObject({ state: "not_delivered", reason: "finished" });
    expect(await delivery(2_000).deliver("never@rig", "x")).toMatchObject({ state: "not_delivered", reason: "not_found" });
    expect(stub.stdin()).toBe("");
  }, 30_000);

  it("gives the native inbox an ancestor of the agent: the terminal's pid is the login shell the agent is typed into", async () => {
    const host = new HcHost(core.client, { daemonEnv: { PATH: process.env.PATH, HOME: core.env.HOME, SHELL: "/bin/sh" } });
    await host.createSession("native@rig", core.root);
    const input = new HcInput(core.client, attach, { deliveryTimeoutMs: 10_000 });
    // The host is shared: a stand-in named by the run, so no other run's `sleep` can be mistaken for this agent.
    const standIn = `sleep 600.${process.pid}${Date.now() % 100000}`;
    await input.sendShellCommand("native@rig", standIn);
    const pane = await hcPanePid(core.client, "native@rig");
    expect(pane).not.toBeNull();
    const table = () => spawnSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }));
    const child = await until(() => table().find((p) => p.args === standIn && p.pid !== pane), (p) => p !== undefined, "the agent stand-in");
    const byPid = new Map(table().map((p) => [p.pid, p]));
    // The walk the native inbox makes (claude-native-inbox.ts eligibility): from the agent up the ppid chain to the pane pid.
    let cursor = child;
    const chain: number[] = [];
    for (let hops = 0; cursor && hops < 32; hops++) { chain.push(cursor.pid); if (cursor.pid === pane) break; cursor = byPid.get(cursor.ppid); }
    expect(chain).toContain(pane);
    expect(chain[0]).not.toBe(pane);  // the agent is a descendant of the shell, not the terminal's own pid
    await input.sendKeys("native@rig", ["C-c"]);
  }, 40_000);
});
