// S2: the Pi and OMP gate's durable store, on real files. The kills are in seat-gate-crash.real.test.ts; this pins the rules between them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { piSeatGate } from "../src/adapters/seat-gate-readers.js";
import { gateLogRecord, gateTextSha, seatGateLogPath, sessionUserTextShas, SeatGateStore, userMessageText } from "../src/adapters/seat-gate-store.js";

const M = { id: "m1", nonce: "0123456789abcdef" };
const N = { id: "m2", nonce: "fedcba9876543210" };
const userLine = (text: unknown) => `${JSON.stringify({ type: "message", id: "e", message: { role: "user", content: text } })}\n`;

describe("SeatGateStore", () => {
  let dir: string;
  let log: string;
  let session: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    log = seatGateLogPath(dir);
    session = path.join(dir, "s.jsonl");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("a repeat is refused while in flight and after it was seen, across a reopen; another nonce is another message", () => {
    const store = SeatGateStore.open(log);
    const intent = store.admit([M], "hi", null)!;
    expect(store.admit([M], "hi", null)).toBeNull();
    store.seen(intent, "message_start");
    const again = SeatGateStore.open(log);
    expect(again.admit([M], "hi", null)).toBeNull();
    expect(again.open).toEqual([]);
    expect(again.admit([{ ...M, nonce: "aaaaaaaaaaaaaaaa" }], "hi", null)).not.toBeNull();
  });

  it("the intent is on disk before admit returns, and holds no message body", () => {
    const store = SeatGateStore.open(log);
    store.admit([M], "the secret body", null);
    const onDisk = fs.readFileSync(log, "utf8");
    expect(SeatGateStore.open(log).open).toHaveLength(1);
    expect(onDisk).not.toContain("secret body");
    expect(onDisk).toContain(gateTextSha("the secret body"));
  });

  it("a wake group passes when any row is new, and intends only the new row", () => {
    const store = SeatGateStore.open(log);
    store.seen(store.admit([M], "x", null)!, "t");
    expect(store.admit([M, N], "x", null)!.markers).toEqual([N]);
  });

  it("clear lets a resend pass, in this life and the next", () => {
    const store = SeatGateStore.open(log);
    store.clear(store.admit([M], "x", null)!, "refused");
    expect(SeatGateStore.open(log).admit([M], "x", null)).not.toBeNull();
  });

  it("reconcile reads only past the offset: the same text before the intent is an older message", () => {
    fs.writeFileSync(session, userLine("same"));
    const store = SeatGateStore.open(log);
    store.admit([M], "same", session);
    const again = SeatGateStore.open(log);
    expect(again.reconcile()).toBe(0);
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), M)).toBeNull();
    expect(again.admit([M], "same", session)).not.toBeNull();
  });

  it("reconcile finds a text past the offset, in a file that did not exist at the intent", () => {
    const store = SeatGateStore.open(log);
    store.admit([M], "landed", session);
    fs.writeFileSync(session, userLine([{ type: "text", text: "landed" }]));
    SeatGateStore.open(log).reconcile();
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), M)).not.toBeNull();
  });

  it("two intents of one text and one line in the session: the oldest got it, the other may pass", () => {
    const store = SeatGateStore.open(log);
    store.admit([M], "same", session);
    store.admit([N], "same", session);
    fs.writeFileSync(session, userLine("same"));
    SeatGateStore.open(log).reconcile();
    const text = fs.readFileSync(log, "utf8");
    expect([gateLogRecord(text, M) !== null, gateLogRecord(text, N) !== null]).toEqual([true, false]);
  });

  it("an unreadable session file settles nothing: the id stays in flight, never cleared", () => {
    const store = SeatGateStore.open(log);
    store.admit([M], "x", session);
    const again = SeatGateStore.open(log);
    expect(again.reconcile(() => null)).toBe(1);
    expect(again.open).toHaveLength(1);
    expect(again.admit([M], "x", session)).toBeNull();
  });

  it("a torn tail is cut on open, so the next record does not glue onto it", () => {
    const store = SeatGateStore.open(log);
    store.seen(store.admit([M], "x", null)!, "t");
    fs.appendFileSync(log, '{"op":"intent","mark');
    const again = SeatGateStore.open(log);
    again.seen(again.admit([N], "y", null)!, "t");
    const text = fs.readFileSync(log, "utf8");
    expect(gateLogRecord(text, M)).not.toBeNull();
    expect(gateLogRecord(text, N)).not.toBeNull();
    expect(text.split("\n").every((line) => line === "" || line.startsWith('{"op":"') && line.endsWith("}"))).toBe(true);
  });

  it("a log it cannot read refuses marked blocks rather than letting them through", () => {
    fs.mkdirSync(log);
    expect(() => SeatGateStore.open(log).admit([M], "x", null)).toThrow(/repair/);
  });

  it("a failed append poisons the store: nothing is admitted until it is reopened", () => {
    const store = SeatGateStore.open(log);
    fs.mkdirSync(log);
    expect(() => store.admit([M], "x", null)).toThrow();
    fs.rmdirSync(log);
    expect(() => store.admit([N], "y", null)).toThrow(/repair/);
    expect(SeatGateStore.open(log).admit([N], "y", null)).not.toBeNull();
  });

  it("gateLogRecord answers only for seen, not for an intent, a clear or another nonce", () => {
    const store = SeatGateStore.open(log);
    const intent = store.admit([M], "x", null)!;
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), M)).toBeNull();
    store.seen(intent, "t");
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), M)).not.toBeNull();
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), { ...M, nonce: "bbbbbbbbbbbbbbbb" })).toBeNull();
    store.clear(store.admit([N], "y", null)!, "t");
    expect(gateLogRecord(fs.readFileSync(log, "utf8"), N)).toBeNull();
  });
});

describe("the session file", () => {
  it("reads string and block content, skips other roles and a partial last line, and tells absent from unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session" })}\n${userLine("one")}${userLine([{ type: "text", text: "two" }, { type: "image" }])}${JSON.stringify({ type: "message", message: { role: "assistant", content: "no" } })}\n{"type":"mess`);
    expect(sessionUserTextShas(file, 0)).toEqual([gateTextSha("one"), gateTextSha("two")]);
    expect(sessionUserTextShas(path.join(dir, "absent"), 0)).toEqual([]);
    expect(sessionUserTextShas(dir, 0)).toBeNull();
    expect(userMessageText({ content: [{ type: "image" }] })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("piSeatGate, the SeatGate port", () => {
  it("is unavailable, not not_seen, when the log can't be read, and with no row nonce confirms nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const gate = piSeatGate({ stateRoot: root, nonceOf: (id) => (id === "m1" ? M.nonce : null) });
    expect(await gate.lookup("seat", messageId("m1"))).toEqual({ kind: "unavailable", cause: "ENOENT" });
    const store = SeatGateStore.open(seatGateLogPath(path.join(root, "seat")), () => "2026-02-03T04:05:06.000Z");
    store.seen(store.admit([M], "x", null)!, "t");
    expect(await gate.lookup("seat", messageId("m1"))).toEqual({ kind: "seen", record: { id: "m1", recordedAt: "2026-02-03T04:05:06.000Z", nonce: M.nonce } });
    expect(await gate.lookup("seat", messageId("m2"))).toEqual({ kind: "not_seen" });
    expect(gate.version).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
