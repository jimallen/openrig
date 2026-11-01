// S2: a hook that really dies. A crash fails open, so the prompt runs with no record and a resend would double it. Reconcile finds the
// prompt in the transcript and records it. The other way round, a record with no prompt (the agent died in the hook, M5), is cleared
// so the resend passes. Each case runs the real relay as a process and a stub of Claude (helpers/stub-claude-hook.ts). A real agent's
// proof is S0 and the combined run, not this file.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSeenStore, reconcileSeen, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { hookSeatGate } from "../src/adapters/hook-seat-gate.js";
import { fileIncludes } from "../src/adapters/native-inbox-os.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { CRASH_PRELOAD, NONCE, SEAT, brokenRelay, marker, sessionStart, stubSeat, submit, type StubSeat } from "./helpers/stub-claude-hook.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function seat(): StubSeat {
  const home = mkdtempSync(join(tmpdir(), "gate-crash-"));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); });
  return stubSeat(home);
}
const storeOf = (s: StubSeat) => new HookSeenStore(seatGateRoot(s.home));
const m1 = { id: "m-1", nonce: NONCE };
const reconcile = (s: StubSeat, alive = false) => reconcileSeen({ store: storeOf(s), seat: SEAT, transcripts: [s.transcript], processAlive: () => alive });
const prompt = `hello\n\n${marker("m-1")}`;

describe("a hook that crashes fails open: the prompt ran with no record", () => {
  it.each([
    ["the relay cannot load", (s: StubSeat) => ({ relay: brokenRelay(s.home) })],
    ["SIGKILL before the record", () => ({ nodeArgs: ["--require", CRASH_PRELOAD], env: { RELAY_CRASH: "before" } })],
  ])("%s: reconcile marks it received, so the resend is one turn", (_name, crash) => {
    const s = seat();
    const run = submit(s, prompt, crash(s));
    expect(run).toMatchObject({ crashed: true, ran: true });
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "not_seen" });
    // The instrument: unreconciled, a healthy relay really would let the resend double it.
    const unreconciled = seat();
    submit(unreconciled, prompt, crash(unreconciled));
    expect(submit(unreconciled, prompt).ran).toBe(true);
    expect(unreconciled.turns).toHaveLength(2);

    expect(reconcile(s).received).toEqual([m1]);
    expect(storeOf(s).read(SEAT, m1)).toMatchObject({ kind: "seen", record: { via: "transcript", durable: true } });
    expect(submit(s, prompt).blocked).toBe(true);
    expect(s.turns).toHaveLength(1);
  });

  it("the SeatGate answers from the transcript before reconcile has run, so a pump does not resend", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, prompt, { relay: brokenRelay(s.home) });
    const gate = hookSeatGate({ store: storeOf(s), nonceOf: () => NONCE, transcriptsOf: () => [s.transcript], fileIncludes });
    expect(await gate.lookup(SEAT, messageId("m-1"))).toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
    expect(await gate.lookup(SEAT, messageId("m-never"))).toEqual({ kind: "not_seen" });
  });

  it("a crashed hook whose prompt never ran stays absent, and a new id is untouched", () => {
    const s = seat();
    submit(s, `other\n\n${marker("m-2")}`);
    expect(reconcile(s).received).toEqual([]);
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "not_seen" });
  });
});

describe("the hook recorded and died", () => {
  it("the prompt still ran: the record is kept and made durable", () => {
    const s = seat();
    expect(submit(s, prompt, { nodeArgs: ["--require", CRASH_PRELOAD], env: { RELAY_CRASH: "after" } })).toMatchObject({ crashed: true, ran: true });
    expect(reconcile(s)).toMatchObject({ received: [], cleared: [] });
    expect(storeOf(s).read(SEAT, m1)).toMatchObject({ kind: "seen", record: { via: "hook", durable: true } });
    expect(submit(s, prompt).blocked).toBe(true);
    expect(s.turns).toHaveLength(1);
  });

  it("the agent died with it (M5): the record is cleared and the resend is one turn; a control passes", () => {
    const s = seat();
    submit(s, prompt, { agentDiesInHook: true });
    expect(s.turns).toHaveLength(0);
    expect(storeOf(s).read(SEAT, m1).kind).toBe("seen");
    expect(submit(s, prompt).blocked).toBe(true); // without the clear, the resend is refused for good (M5 Codex)
    expect(reconcile(s).cleared).toEqual([m1]);
    expect(submit(s, prompt).ran).toBe(true);
    expect(submit(s, `next\n\n${marker("m-2")}`).ran).toBe(true);
    expect(s.turns).toHaveLength(2);
  });

  it("the agent is alive: its transcript lags its hook, so the record stays", () => {
    const s = seat();
    submit(s, prompt, { agentDiesInHook: true });
    expect(reconcile(s, true).cleared).toEqual([]);
    expect(storeOf(s).read(SEAT, m1).kind).toBe("seen");
  });

  it("the transcript cannot be read: nothing is cleared, because that could double the message", () => {
    const s = seat();
    submit(s, prompt, { agentDiesInHook: true });
    const result = reconcileSeen({ store: storeOf(s), seat: SEAT, transcripts: [s.transcript], processAlive: () => false, markers: () => null });
    expect(result).toMatchObject({ cleared: [], unsettled: [m1] });
    expect(storeOf(s).read(SEAT, m1).kind).toBe("seen");
  });

  it("the transcript does not exist yet: a first prompt's record is cleared (M5)", () => {
    const s = seat();
    submit(s, prompt, { agentDiesInHook: true });
    expect(existsSync(s.transcript)).toBe(false);
    expect(reconcile(s).cleared).toEqual([m1]);
  });

  it("a record that names no process is left alone", () => {
    const s = seat();
    submit(s, prompt, { agentDiesInHook: true, env: { CLAUDE_PID: "" } });
    expect(reconcile(s).cleared).toEqual([]);
  });

  it("reconcile again changes nothing", () => {
    const s = seat();
    submit(s, prompt);
    reconcile(s);
    expect(reconcile(s)).toEqual({ received: [], cleared: [], unsettled: [] });
  });
});
