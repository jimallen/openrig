// S2: the daemon's reading of a hook gate's seen store, the file search reconcile rests on, and the `SeatGate` port over them.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSeenStore, seatGateFolder, seatGateRoot, transcriptMarkers } from "../src/adapters/hook-seen-store.js";
import { hookSeatGate } from "../src/adapters/hook-seat-gate.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { NONCE, SEAT, marker, sessionStart, stubSeat, submit, type StubSeat } from "./helpers/stub-claude-hook.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function seat(): StubSeat {
  const home = mkdtempSync(join(tmpdir(), "gate-store-"));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); });
  return stubSeat(home);
}
const storeOf = (s: StubSeat) => new HookSeenStore(seatGateRoot(s.home));
function gateOf(s: StubSeat, nonce: string | null = NONCE) {
  return hookSeatGate({ store: storeOf(s), nonceOf: () => nonce, transcriptsOf: () => [s.transcript], fileIncludes: () => false });
}

describe("the SeatGate over the seen store", () => {
  it("reads what the real relay wrote, with its nonce", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
    expect(gateOf(s).version).toBe(1);
  });

  it("a record under another nonce is forged: it confirms nothing", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1", "ffffffffffffffff")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "not_seen" });
  });

  it("a row with no nonce yet confirms nothing", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s, null).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "not_seen" });
  });

  it("a seat that declared no gate is unavailable, not unseen: an older relay leaves no records to read", async () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "unavailable", cause: "no_gate_declared" });
  });

  it("a record whose contents name another message is not trusted, and one that holds no JSON is unavailable", () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const dir = join(seatGateRoot(s.home), seatGateFolder(SEAT), "seen");
    const [name] = readdirSync(dir);
    const m1 = { id: "m-1", nonce: NONCE };
    expect(storeOf(s).read(SEAT, m1).kind).toBe("seen");
    writeFileSync(join(dir, name!), JSON.stringify({ id: "m-2", nonce: NONCE, recordedAt: "2020-01-01T00:00:00.000Z" }));
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "not_seen" });
    writeFileSync(join(dir, name!), "not json");
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "unavailable", cause: "malformed_record" });
  });

  it("a store that cannot be read says so", () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const dir = join(seatGateRoot(s.home), seatGateFolder(SEAT), "seen");
    chmodSync(dir, 0o000);
    cleanups.push(() => { chmodSync(dir, 0o700); });
    expect(storeOf(s).read(SEAT, { id: "m-1", nonce: NONCE })).toMatchObject({ kind: "unavailable" });
  });
});

describe("seatGateFolder", () => {
  it("keeps a seat name to one safe folder, as the relay does", () => {
    expect(seatGateFolder("dev.impl@rig/1")).toBe("dev%2Eimpl%40rig%2F1");
    expect(seatGateFolder("..")).toBe("%2E%2E");
  });
});

const userRecord = (text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "text", text }] }, uuid: "u", timestamp: "t", sessionId: "s" });

describe("transcriptMarkers", () => {
  it("finds a marker that straddles two chunks", () => {
    const s = seat();
    const path = join(s.home, "t.jsonl");
    const text = marker("m-1");
    writeFileSync(path, `${userRecord(`${"x".repeat(90)}\n${text}`)}\n`);
    expect([...transcriptMarkers(path, 64)!.values()]).toEqual([{ id: "m-1", nonce: NONCE }]);
  });

  // Real record shapes: a key census of live transcripts, Claude 2.1.310 to 2.1.316.
  const prompt = `hello\n${marker("m-1")}`;
  const enqueue = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "t", sessionId: "s", content: prompt });
  const remove = JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: "t", sessionId: "s", content: prompt, reason: "x", commandUuid: "c", deliveryId: "d" });
  const blob = JSON.stringify({ type: "api-request-blob", sessionId: "s", hash: "h", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  const assistant = JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: prompt }] } });
  const toolResult = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: prompt }] } });
  const sidechain = JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: prompt }] } });
  const attachment = JSON.stringify({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt, commandMode: "prompt" } });
  const stringUser = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: prompt } });
  const envelope = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: `<cross-session-message from-name="a@r">\n${prompt}\n</cross-session-message>` } });
  const pasted = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: `\n\n<pasted_content id="3052">\n${prompt}\n</pasted_content id="3052">\n` } });
  const quoted = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: `why ${marker("m-1")} twice?` } });

  for (const [name, line] of [["a queue-operation enqueue", enqueue], ["a queue-operation remove", remove], ["an api-request-blob", blob], ["an assistant record", assistant], ["a tool result", toolResult], ["a subagent's record", sidechain], ["a marker quoted mid-text", quoted]] as const) {
    it(`${name} is no prompt`, () => {
      const path = join(seat().home, "t.jsonl");
      writeFileSync(path, `${line}\n`);
      expect(transcriptMarkers(path)!.size).toBe(0);
    });
  }

  for (const [name, line] of [["a user record of text parts", userRecord(prompt)], ["a user record of a string", stringUser], ["a queued_command attachment", attachment], ["a sender's envelope", envelope], ["a multi-line paste's wrapper", pasted]] as const) {
    it(`${name} is a prompt`, () => {
      const path = join(seat().home, "t.jsonl");
      writeFileSync(path, `${line}\n`);
      expect([...transcriptMarkers(path)!.values()]).toEqual([{ id: "m-1", nonce: NONCE }]);
    });
  }

  it("a torn last line is not durable yet", () => {
    const path = join(seat().home, "t.jsonl");
    writeFileSync(path, userRecord(prompt));
    expect(transcriptMarkers(path)!.size).toBe(0);
  });

  it("no file is an empty answer; an unreadable one is no answer", () => {
    const s = seat();
    expect(transcriptMarkers(join(s.home, "absent"))!.size).toBe(0);
    const path = join(s.home, "t.jsonl");
    writeFileSync(path, "x");
    chmodSync(path, 0o000);
    cleanups.push(() => { chmodSync(path, 0o600); });
    expect(transcriptMarkers(path)).toBeNull();
  });
});
