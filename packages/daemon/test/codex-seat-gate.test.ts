// S2, the Codex gate. A repeat that reaches the agent is a message delivered twice; a record of a prompt the conversation lost is a
// message delivered never. Both stay out only if the relay's record and the rollout are held against each other, so these run the
// real relay as a real process and read the store through the daemon's own port.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { codexRolloutMarkers, codexSeatGate, reconcileCodexSeatGate } from "../src/adapters/codex-seat-gate.js";
import { HOOK_GATE_VERSION } from "../src/adapters/hook-gate-version.js";
import { HookSeenStore, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { CRASH_PRELOAD, NONCE, RELAY, SEAT, brokenRelay, codexHookEnv, codexSessionStart, marker, rolloutUserLine, stubCodexSeat, submitToCodex, type StubCodexSeat } from "./helpers/stub-codex-hook.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function seat(): StubCodexSeat {
  const home = mkdtempSync(join(tmpdir(), "codex-gate-"));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); });
  const s = stubCodexSeat(home);
  codexSessionStart(s);
  return s;
}
const storeOf = (s: StubCodexSeat) => new HookSeenStore(seatGateRoot(s.home));
const seenDir = (s: StubCodexSeat) => join(s.home, "state", "seat-gates", encodeURIComponent(SEAT), "seen");
const seenFile = (s: StubCodexSeat, id: string, nonce = NONCE) => join(seenDir(s), createHash("sha256").update(`${id}:${nonce}`).digest("hex"));
const gate = (s: StubCodexSeat, rollout: string | null = s.rollout, nonce: string | null = NONCE) =>
  codexSeatGate({ store: storeOf(s), nonceOf: () => nonce, rolloutPathOf: () => rollout });
const look = (s: StubCodexSeat, id: string, rollout: string | null = s.rollout, nonce: string | null = NONCE) => gate(s, rollout, nonce).lookup(SEAT, messageId(id));
const reconcile = (s: StubCodexSeat, rollout: string | null = s.rollout) => reconcileCodexSeatGate(storeOf(s), SEAT, rollout);

describe("the gate on a Codex prompt, daemon stopped", () => {
  it("lets the first copy through and blocks the repeat, one turn; a new id still passes", () => {
    const s = seat();
    expect(submitToCodex(s, `hello\n${marker("m-1")}`).ran).toBe(true);
    expect(submitToCodex(s, `hello\n${marker("m-1")}`)).toMatchObject({ blocked: true, ran: false });
    expect(submitToCodex(s, `hello\n${marker("m-2")}`).ran).toBe(true);
    expect(s.turns).toHaveLength(2);
  });

  it("gates a multi-line paste over the length Codex collapses: the hook still gets the whole text", () => {
    const s = seat();
    const long = `${"x".repeat(1610)}\nline\n${marker("m-1")}`;
    expect(submitToCodex(s, long).ran).toBe(true);
    expect(submitToCodex(s, long).blocked).toBe(true);
  });

  it("a forged nonce neither stands in the way of the real id nor confirms it", async () => {
    const s = seat();
    expect(submitToCodex(s, `forged\n${marker("m-1", "ffffffffffffffff")}`).ran).toBe(true);
    await expect(look(s, "m-1", null)).resolves.toEqual({ kind: "not_seen" });
    expect(submitToCodex(s, `real\n${marker("m-1")}`).ran).toBe(true);
    await expect(look(s, "m-1")).resolves.toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
  });

  it("a wake group passes while any marker is new, and blocks when none is", () => {
    const s = seat();
    submitToCodex(s, `one\n${marker("w-1")}`);
    expect(submitToCodex(s, `both\n${marker("w-1")}\n${marker("w-2")}`).ran).toBe(true);
    expect(submitToCodex(s, `both\n${marker("w-1")}\n${marker("w-2")}`).blocked).toBe(true);
  });

  it("a person's prompt with no marker passes and records nothing", () => {
    const s = seat();
    expect(submitToCodex(s, "just typing").ran).toBe(true);
    expect(submitToCodex(s, "just typing").ran).toBe(true);
    expect(existsSync(seenDir(s))).toBe(false);
  });

  it("a runtime the gate does not serve is untouched", () => {
    const s = seat();
    expect(submitToCodex(s, `x\n${marker("m-1")}`, { env: { OPENRIG_RUNTIME: "pi" } }).ran).toBe(true);
    expect(submitToCodex(s, `x\n${marker("m-1")}`, { env: { OPENRIG_RUNTIME: "pi" } }).ran).toBe(true);
  });

  it("fails closed: a marked prompt it could not record does not reach the agent, and an unmarked one still passes", () => {
    const s = seat();
    mkdirSync(seenDir(s), { recursive: true });
    chmodSync(seenDir(s), 0o500);
    cleanups.push(() => { chmodSync(seenDir(s), 0o700); });
    const run = submitToCodex(s, `x\n${marker("m-1")}`);
    expect(run).toMatchObject({ blocked: true, ran: false });
    expect(run.reason).toMatch(/could not record/);
    expect(submitToCodex(s, "typing").ran).toBe(true);
  });

  it("the block does not tell the daemon a turn began: Codex sends no Stop after one", async () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    const posts: string[] = [];
    const server = createServer((req, res) => { let b = ""; req.on("data", (c: Buffer) => { b += c.toString(); }); req.on("end", () => { posts.push(b); res.end("{}"); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const run = (prompt: string) => new Promise<string>((done) => {
      const child = spawn(process.execPath, [RELAY], { env: codexHookEnv(s, { OPENRIG_URL: url, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" }), stdio: ["pipe", "pipe", "ignore"] });
      let out = ""; child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.on("close", () => done(out));
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
    });
    expect(await run(`x\n${marker("m-1")}`)).toContain('"block"');
    expect(posts).toEqual([]);
    expect(await run(`x\n${marker("m-2")}`)).toBe("");
    expect(posts).toHaveLength(1);
  });

  it("SessionStart declares the gate; a seat that never ran this relay declares none, and is not gated", async () => {
    const s = seat();
    expect(storeOf(s).declaredVersion(SEAT)).toBe(HOOK_GATE_VERSION);
    expect(storeOf(s).declaredVersion("other@rig1")).toBeNull();
    await expect(gate(s).lookup("other@rig1", messageId("m-1"))).resolves.toEqual({ kind: "unavailable", cause: "no_gate_declared" });
  });
});

describe("a crash in the hook: the prompt is in the rollout with no seen record", () => {
  const crashes: Array<[string, (dir: string) => { relay?: string; nodeArgs?: string[]; env?: Record<string, string> }]> = [
    ["a relay that cannot load", (dir) => ({ relay: brokenRelay(dir) })],
    ["SIGKILL before the record", () => ({ nodeArgs: ["--require", CRASH_PRELOAD], env: { RELAY_CRASH: "before" } })],
  ];
  describe.each(crashes)("%s", (_name, crash) => {
    it("the hook really died and the prompt ran unrecorded", () => {
      const s = seat();
      const run = submitToCodex(s, `x\n${marker("m-1")}`, crash(s.home));
      expect(run).toMatchObject({ crashed: true, ran: true, blocked: false });
      expect((existsSync(seenDir(s)) ? readdirSync(seenDir(s)) : []).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
    });

    it("reconcile marks it received, and a resend is blocked: one turn", async () => {
      const s = seat();
      submitToCodex(s, `x\n${marker("m-1")}`, crash(s.home));
      expect(reconcile(s)).toEqual({ received: [{ id: "m-1", nonce: NONCE }], cleared: [], unsettled: [] });
      await expect(look(s, "m-1", null)).resolves.toMatchObject({ kind: "seen" });
      expect(submitToCodex(s, `x\n${marker("m-1")}`).blocked).toBe(true);
      expect(s.turns).toHaveLength(1);
    });

    it("a lookup finds it on a live seat, before any restart, so the resend never goes", async () => {
      const s = seat();
      submitToCodex(s, `x\n${marker("m-1")}`, crash(s.home));
      await expect(look(s, "m-1")).resolves.toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
      await expect(look(s, "m-2")).resolves.toEqual({ kind: "not_seen" });
    });
  });

  it("a crash AFTER the record, the decision never printed: the prompt ran, and the record stands", async () => {
    const s = seat();
    const run = submitToCodex(s, `x\n${marker("m-1")}`, { nodeArgs: ["--require", CRASH_PRELOAD], env: { RELAY_CRASH: "after" } });
    expect(run).toMatchObject({ crashed: true, ran: true });
    expect(reconcile(s)).toEqual({ received: [], cleared: [], unsettled: [] });
    expect(storeOf(s).read(SEAT, { id: "m-1", nonce: NONCE })).toMatchObject({ kind: "seen", record: { durable: true } });
    expect(submitToCodex(s, `x\n${marker("m-1")}`).blocked).toBe(true);
  });

  it("with no record naming the rollout, reconcile needs the seat's own, and finds nothing without it", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`, { relay: brokenRelay(s.home) });
    expect(reconcile(s, null)).toEqual({ received: [], cleared: [], unsettled: [] });
    expect(reconcile(s).received).toHaveLength(1);
  });

  it("a forged nonce in the rollout does not confirm the real id", async () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1", "ffffffffffffffff")}`, { relay: brokenRelay(s.home) });
    await expect(look(s, "m-1")).resolves.toEqual({ kind: "not_seen" });
    reconcile(s);
    await expect(look(s, "m-1", null)).resolves.toEqual({ kind: "not_seen" });
    expect(submitToCodex(s, `real\n${marker("m-1")}`).ran).toBe(true);
  });
});

describe("a seat killed between the hook and the rollout: seen with no prompt", () => {
  it("a resend without reconcile is blocked for good, the loss the record causes", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`, { agentDiesInHook: true });
    expect(submitToCodex(s, `x\n${marker("m-1")}`).blocked).toBe(true);
    expect(s.turns).toEqual([]);
  });

  it("reconcile clears exactly that id, and the resend lands once; a control is kept", () => {
    const s = seat();
    submitToCodex(s, `kept\n${marker("k-1")}`);
    submitToCodex(s, `x\n${marker("m-1")}`, { agentDiesInHook: true });
    expect(reconcile(s)).toEqual({ cleared: [{ id: "m-1", nonce: NONCE }], received: [], unsettled: [] });
    expect(submitToCodex(s, `x\n${marker("m-1")}`).ran).toBe(true);
    expect(submitToCodex(s, `x\n${marker("m-1")}`).blocked).toBe(true);
    expect(submitToCodex(s, `kept\n${marker("k-1")}`).blocked).toBe(true);
    expect(s.turns).toHaveLength(2);
  });

  it("clears the id when the rollout was never created: Codex writes it with the first prompt", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`, { agentDiesInHook: true });
    expect(existsSync(s.rollout)).toBe(false);
    expect(reconcile(s).cleared).toHaveLength(1);
  });

  it("an unreadable rollout settles nothing: clearing could double the message", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    chmodSync(s.rollout, 0o000);
    cleanups.push(() => { chmodSync(s.rollout, 0o600); });
    expect(reconcile(s)).toEqual({ received: [], cleared: [], unsettled: [{ id: "m-1", nonce: NONCE }] });
    expect(existsSync(seenFile(s, "m-1"))).toBe(true);
  });

  it("a durable record is never looked at again: a pruned rollout cannot clear it", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    reconcile(s);
    rmSync(s.rollout);
    expect(reconcile(s)).toEqual({ received: [], cleared: [], unsettled: [] });
    expect(submitToCodex(s, `x\n${marker("m-1")}`).blocked).toBe(true);
  });

  it("a record is judged against the rollout it names, not the seat's newer one", () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    const newer = join(s.home, "rollout-newer.jsonl");
    writeFileSync(newer, "");
    expect(reconcile(s, newer)).toEqual({ received: [], cleared: [], unsettled: [] });
  });
});

describe("the SeatGate port over a Codex seat", () => {
  it("not_seen before, seen after, with the record's own time", async () => {
    const s = seat();
    await expect(look(s, "m-1")).resolves.toEqual({ kind: "not_seen" });
    submitToCodex(s, `x\n${marker("m-1")}`);
    const seen = await look(s, "m-1", null);
    expect(seen).toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
    expect(seen.kind === "seen" && Date.parse(seen.record.recordedAt)).toBeGreaterThan(0);
  });

  it("a row with no nonce confirms nothing", async () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    await expect(look(s, "m-1", s.rollout, null)).resolves.toEqual({ kind: "not_seen" });
  });

  it("an unreadable store or rollout proves nothing either way", async () => {
    const s = seat();
    submitToCodex(s, `x\n${marker("m-1")}`);
    chmodSync(s.rollout, 0o000);
    cleanups.push(() => { chmodSync(s.rollout, 0o600); });
    await expect(look(s, "m-2")).resolves.toMatchObject({ kind: "unavailable" });
    chmodSync(seenDir(s), 0o000);
    cleanups.push(() => { chmodSync(seenDir(s), 0o700); });
    await expect(look(s, "m-1", null)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("declares the version", () => {
    expect(gate(seat()).version).toBe(HOOK_GATE_VERSION);
  });
});

describe("what counts as a prompt in a rollout", () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  it("only a user response_item: `compacted` copies and `item_completed` echoes are not prompts (counted on a real 0.166.0 rollout)", () => {
    const s = seat();
    const quoted = `old\n${marker("gone")}`;
    writeFileSync(s.rollout, [
      line({ type: "compacted", payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: quoted }] }] } }),
      line({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: quoted }] } } }),
      line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: quoted }] } }),
      line({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: quoted }] } }),
      rolloutUserLine(`real\n${marker("kept")}`),
    ].join(""));
    expect([...(codexRolloutMarkers(s.rollout) ?? new Map()).keys()]).toEqual([`kept:${NONCE}`]);
    expect(reconcile(s).received).toEqual([{ id: "kept", nonce: NONCE }]);
  });

  it("a torn last line is no prompt, and a garbage line is skipped", () => {
    const s = seat();
    writeFileSync(s.rollout, `not json [openrig-msg a:b]\n${rolloutUserLine(`one\n${marker("m-1")}`)}`);
    appendFileSync(s.rollout, rolloutUserLine(`two\n${marker("m-2")}`).slice(0, -5));
    expect([...(codexRolloutMarkers(s.rollout) ?? new Map()).keys()]).toEqual([`m-1:${NONCE}`]);
  });

  it("no file is no prompts; an unreadable one is unknown", () => {
    const s = seat();
    expect(codexRolloutMarkers(s.rollout)?.size).toBe(0);
    writeFileSync(s.rollout, "");
    chmodSync(s.rollout, 0o000);
    cleanups.push(() => { chmodSync(s.rollout, 0o600); });
    expect(codexRolloutMarkers(s.rollout)).toBeNull();
  });
});
