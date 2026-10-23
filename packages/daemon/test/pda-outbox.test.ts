// pda runtime L1a (pda-runtime-design-9l Rev 2, "The outbox", "Status classification"): the durable outbox and
// its delivery loop, against test/helpers/fake-pda.ts. Rows T1, T2, T3, T4, T4b, T23 (A1), T24 (A2), T25 (A2),
// the status table, and the fake's own faithfulness controls.
//
// "Killed" here is an injected failure: a file-system wrapper that throws at a chosen operation, after which a
// NEW PdaOutbox is opened on the same files with the real fs. No SIGKILL of a process is exercised (that is the
// runner's, L1b); what is pinned is that every durable ordering the design depends on holds at each such point.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PdaOutbox, nodeOutboxFs, PDA_OUTBOX_COMPACT_THRESHOLD, type OutboxFs, type PdaAttemptOutcome } from "../src/adapters/pda-outbox.js";
import { createPdaClient, serializePdaMessage, PDA_MAX_BODY_BYTES, type PdaClient } from "../src/adapters/pda-client.js";
import type { PdaOutboxRecord } from "../src/adapters/pda-runner-protocol.js";
import { startFakePda, nonAllowlisted, type FakePda } from "./helpers/fake-pda.js";

const TOKEN = "OUTBOXtokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".slice(0, 43);
const T0 = Date.parse("2031-03-04T05:06:07.000Z"); // far from wall clock on purpose

class Crash extends Error {}

let dir: string;
const fakes: FakePda[] = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-outbox-")); clock.t = T0; });
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const seatRoot = () => path.join(dir, "seat");
const paths = () => ({ seatRoot: seatRoot(), outboxPath: path.join(seatRoot(), "outbox.log"), rejectedPath: path.join(seatRoot(), "rejected.log") });
const readLog = (): string => fs.readFileSync(paths().outboxPath, "utf8");
const logRecords = (): PdaOutboxRecord[] => readLog().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PdaOutboxRecord);

async function newFake(options: { dedupe?: boolean; agents?: string[] } = {}): Promise<FakePda> {
  const f = await startFakePda({ token: TOKEN, agents: options.agents ?? ["research", "other"], dedupe: options.dedupe });
  fakes.push(f);
  return f;
}
function clientFor(fake: FakePda, agent = "research"): PdaClient {
  return createPdaClient({ binding: { agent, baseUrl: fake.baseUrl }, readToken: () => ({ ok: true, token: TOKEN }), timeoutMs: 2000 });
}
const clock = { t: T0 };
function open(fake: FakePda, extra: { agent?: string; fs?: OutboxFs; launchId?: string; baseUrl?: string } = {}): PdaOutbox {
  return PdaOutbox.open({
    paths: paths(), binding: { agent: extra.agent ?? "research", baseUrl: extra.baseUrl ?? fake.baseUrl },
    nodeId: "node-1", launchId: extra.launchId ?? "launch-1", fs: extra.fs, now: () => new Date(clock.t),
  });
}
function instantSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}
const enqOk = (o: PdaOutbox, content: string): string => {
  const r = o.enqueue(content);
  if (!r.ok) throw new Error("enqueue refused");
  return r.requestId;
};
/** An fs that records every operation as `op:file` and throws Crash when `crashAt(op, file)` says so. */
function recordingFs(ops: string[], crashAt: (op: string, file: string, data?: string) => boolean = () => false): OutboxFs {
  const names = new Map<number, string>();
  const base = (p: string) => path.basename(p);
  const step = (op: string, file: string, data?: string) => { ops.push(`${op}:${file}`); if (crashAt(op, file, data)) throw new Crash(`${op}:${file}`); };
  return {
    mkdirPrivate: (d) => nodeOutboxFs.mkdirPrivate(d),
    readFile: (p) => nodeOutboxFs.readFile(p),
    open: (p, mode) => { step("open", `${base(p)}:${mode}`); const fd = nodeOutboxFs.open(p, mode); names.set(fd, base(p)); return fd; },
    write: (fd, data) => { step("write", names.get(fd) ?? "?", data); nodeOutboxFs.write(fd, data); },
    fsync: (fd) => { step("fsync", names.get(fd) ?? "?"); nodeOutboxFs.fsync(fd); },
    close: (fd) => { step("close", names.get(fd) ?? "?"); nodeOutboxFs.close(fd); },
    rename: (a, b) => { step("rename", `${base(a)}->${base(b)}`); nodeOutboxFs.rename(a, b); },
    fsyncDir: (d) => { step("fsyncDir", base(d)); nodeOutboxFs.fsyncDir(d); },
  };
}
const at = "2031-01-01T00:00:00.000Z";
const rec = {
  enq: (requestId: string, content = "c", agent = "research", baseUrl = "http://127.0.0.1:1"): PdaOutboxRecord => ({ op: "enq", requestId, agent, baseUrl, content, at }),
  ack: (requestId: string): PdaOutboxRecord => ({ op: "ack", requestId, submissionId: `s-${requestId}`, at }),
  reject: (requestId: string): PdaOutboxRecord => ({ op: "reject", requestId, status: 400, code: "pda_rejected", at }),
};
function seed(records: PdaOutboxRecord[], tornTail = ""): string {
  fs.mkdirSync(seatRoot(), { recursive: true, mode: 0o700 });
  const text = records.map((r) => `${JSON.stringify(r)}\n`).join("") + tornTail;
  fs.writeFileSync(paths().outboxPath, text, { mode: 0o600 });
  return text;
}

// ── The fake's own faithfulness (the controls the design requires) ───────────

describe("fake pda: faithfulness controls", () => {
  it("positive: two distinct sends add two entries; a repeated requestId adds none and returns the same submission", async () => {
    const fake = await newFake();
    const c = clientFor(fake);
    const a = await c.postMessage(serializePdaMessage({ content: "one", requestId: "x1" }));
    const b = await c.postMessage(serializePdaMessage({ content: "two", requestId: "x2" }));
    const again = await c.postMessage(serializePdaMessage({ content: "one", requestId: "x1" }));
    expect(fake.entries("research")).toHaveLength(2);
    expect(again).toEqual(a);
    expect(b.ok && a.ok && b.value.submissionId !== a.value.submissionId).toBe(true);
  });

  it("negative: with dedupe off the same repeated requestId adds a second entry", async () => {
    const fake = await newFake({ dedupe: false });
    const c = clientFor(fake);
    await c.postMessage(serializePdaMessage({ content: "one", requestId: "x1" }));
    await c.postMessage(serializePdaMessage({ content: "one", requestId: "x1" }));
    expect(fake.entries("research")).toHaveLength(2);
  });

  it("admit_then_drop commits the submission before the socket dies, and the log holds every request before routing", async () => {
    const fake = await newFake();
    fake.script({ action: "admit_then_drop" });
    const r = await clientFor(fake).postMessage(serializePdaMessage({ content: "one", requestId: "x1" }));
    expect(r).toEqual({ ok: false, kind: "unreachable" });
    expect(fake.entries("research")).toHaveLength(1);
    await fetch(`${fake.baseUrl}/agents/research/abort`, { method: "POST" });
    expect(nonAllowlisted(fake.requests).map((q) => q.path)).toEqual(["/agents/research/abort"]);
  });
});

// ── Exactly-once scenarios, run against a dedup-ON and a dedup-OFF fake ──────

interface Outcome { entries: number; posts: number }
function expectExactlyOnce(o: Outcome): void {
  expect(o.entries).toBe(1);
  expect(o.posts).toBe(2);
}

async function dropAfterAdmitScenario(fake: FakePda): Promise<Outcome> {
  const outbox = open(fake);
  const id = enqOk(outbox, "hello");
  fake.script({ action: "admit_then_drop" });
  const { sleep } = instantSleep();
  expect(await outbox.drain(clientFor(fake), { sleep })).toBe("empty");
  return { entries: fake.entries("research").length, posts: fake.postsByRequestId.get(id) ?? 0 };
}

async function crashBeforeAckScenario(fake: FakePda): Promise<Outcome> {
  const crashing = open(fake, { fs: recordingFs([], (op, _f, data) => op === "write" && (data ?? "").includes('"op":"ack"')) });
  const id = enqOk(crashing, "hello");
  await expect(crashing.drain(clientFor(fake))).rejects.toBeInstanceOf(Crash); // pda replied 202; the ack never reached disk
  const restarted = open(fake); // same files, real fs
  expect(restarted.snapshot().pending).toBe(1);
  expect(await restarted.drain(clientFor(fake))).toBe("empty");
  expect(restarted.snapshot().pending).toBe(0);
  return { entries: fake.entries("research").length, posts: fake.postsByRequestId.get(id) ?? 0 };
}

describe("T3: a retry after a dropped reply reuses the requestId", () => {
  it("drop after admit: the same id is posted twice, pda holds one entry", async () => {
    const fake = await newFake();
    const o = await dropAfterAdmitScenario(fake);
    expectExactlyOnce(o);
    expect(fake.postBodies.map((b) => (JSON.parse(b) as { requestId: string }).requestId)).toHaveLength(2);
    expect(new Set(fake.postBodies.map((b) => (JSON.parse(b) as { requestId: string }).requestId)).size).toBe(1);
  });

  it("negative control: against a pda WITHOUT dedupe the same scenario is two entries, so the exactly-once check fails", async () => {
    const fake = await newFake({ dedupe: false });
    const o = await dropAfterAdmitScenario(fake);
    expect(o).toEqual({ entries: 2, posts: 2 });
    expect(() => expectExactlyOnce(o)).toThrow();
  });
});

describe("T4b: a crash after pda replied 202, before the ack was appended", () => {
  it("the restart replays under the same id: pda sees it twice, holds one entry, and the outbox ends empty", async () => {
    const fake = await newFake();
    expectExactlyOnce(await crashBeforeAckScenario(fake));
  });

  it("negative control: against a pda WITHOUT dedupe the replay is a second entry, so the exactly-once check fails", async () => {
    const fake = await newFake({ dedupe: false });
    const o = await crashBeforeAckScenario(fake);
    expect(o).toEqual({ entries: 2, posts: 2 });
    expect(() => expectExactlyOnce(o)).toThrow();
  });
});

describe("T4: the enq is durable before the POST", () => {
  it("killed after the enq fsync and before any POST: the restart delivers it, once", async () => {
    const fake = await newFake();
    const first = open(fake);
    const id = enqOk(first, "survives a crash");
    // `first` is abandoned here: no POST was ever made.
    expect(fake.requests).toEqual([]);
    const restarted = open(fake);
    expect(restarted.snapshot().pending).toBe(1);
    expect(await restarted.drain(clientFor(fake))).toBe("empty");
    expect(fake.entries("research").map((e) => ({ requestId: e.requestId, content: e.content }))).toEqual([{ requestId: id, content: "survives a crash" }]);
  });

  it("at the moment pda receives the POST, the enq record is already on disk and its fsync has already returned", async () => {
    const fake = await newFake();
    const ops: string[] = [];
    let opsAtPost: string[] | null = null;
    let onDiskAtPost: boolean | null = null;
    const o = open(fake, { fs: recordingFs(ops) });
    const id = enqOk(o, "durable first");
    fake.onPost = () => {
      opsAtPost = [...ops];
      onDiskAtPost = fs.readFileSync(paths().outboxPath, "utf8").includes(id);
    };
    await o.drain(clientFor(fake));
    expect(onDiskAtPost).toBe(true);
    const seen = opsAtPost as string[] | null;
    expect(seen).not.toBeNull();
    expect(seen!.indexOf("write:outbox.log")).toBeGreaterThanOrEqual(0);
    expect(seen!.indexOf("fsync:outbox.log")).toBeGreaterThan(seen!.indexOf("write:outbox.log"));
  });
});

describe("T1 and T2: one message is one POST, and text is only text", () => {
  it("T1: a multi-line message is one enq and one POST, content byte-equal (not split on LF)", async () => {
    const fake = await newFake();
    const o = open(fake);
    const content = "line one\nline two\n\nline four é";
    enqOk(o, content);
    await o.drain(clientFor(fake));
    expect(fake.postBodies).toHaveLength(1);
    expect(fake.entries("research").map((e) => e.content)).toEqual([content]);
    expect(logRecords().filter((r) => r.op === "enq")).toHaveLength(1);
  });

  it.each(["/abort", "/reset", "/compact", "!x", "/quit", "/abort\n/reset\n/compact"])("T2: %j is posted as followUp content", async (text) => {
    const fake = await newFake();
    const o = open(fake);
    enqOk(o, text);
    await o.drain(clientFor(fake));
    expect(fake.entries("research").map((e) => e.content)).toEqual([text]);
    expect(JSON.parse(fake.postBodies[0] ?? "{}")).toMatchObject({ content: text, mode: "followUp" });
    expect(nonAllowlisted(fake.requests)).toEqual([]);
    expect(fake.requests.filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/agents/research/messages"]);
  });

  it("positive control: two distinct messages are two POSTs, in order", async () => {
    const fake = await newFake();
    const o = open(fake);
    enqOk(o, "first");
    enqOk(o, "second");
    await o.drain(clientFor(fake));
    expect(fake.entries("research").map((e) => e.content)).toEqual(["first", "second"]);
  });

  it("an over-limit message is refused at enqueue and writes nothing; a message at the limit is accepted", () => {
    const o = PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" }, nodeId: "n", launchId: "l", now: () => new Date(T0) });
    const before = readLog();
    expect(o.enqueue("a".repeat(PDA_MAX_BODY_BYTES))).toEqual({ ok: false, reason: "too_large" });
    expect(readLog()).toBe(before);
    expect(o.enqueue("ok").ok).toBe(true);
  });
});

describe("request ids", () => {
  it("are openrig/<node>/<launch>/<seq>, in the order enqueued, and survive a restart under the SAME launch id without reuse", async () => {
    const fake = await newFake();
    const first = open(fake);
    const a = enqOk(first, "a");
    const b = enqOk(first, "b");
    expect(a).toMatch(/^openrig\/node-1\/launch-1\/\d+$/);
    expect(Number(b.split("/").at(-1))).toBe(Number(a.split("/").at(-1)) + 1);
    await first.drain(clientFor(fake)); // acked
    clock.t = T0 + 5000;
    open(fake); // this open compacts the acked records away ...
    const second = open(fake); // ... so this one sees an empty log: nothing remembers a or b
    const c = enqOk(second, "c");
    expect([a, b]).not.toContain(c);
    await second.drain(clientFor(fake));
    expect(fake.entries("research").map((e) => e.content)).toEqual(["a", "b", "c"]);
    clock.t = T0;
  });

  it("onAck reports the requestId and the submissionId pda returned", async () => {
    const fake = await newFake();
    const o = open(fake);
    const seen: Array<[string, string]> = [];
    o.onAck = (r, s) => seen.push([r, s]);
    const id = enqOk(o, "x");
    await o.drain(clientFor(fake));
    expect(seen).toEqual([[id, fake.entries("research")[0]!.submissionId]]);
  });
});

describe("T23 (A1): records are scoped to the binding", () => {
  it("a record read for agent `research` is never posted for agent `other`, stays in the log, and does not block other's queue", async () => {
    const fake = await newFake();
    const forResearch = open(fake);
    const stranded = enqOk(forResearch, "meant for research");
    const forOther = open(fake, { agent: "other" });
    expect(forOther.snapshot()).toEqual({ pending: 0, setAside: 1, held: null });
    const own = enqOk(forOther, "meant for other");
    await forOther.drain(clientFor(fake, "other"));
    expect(fake.entries("research")).toEqual([]);
    expect(fake.entries("other").map((e) => e.content)).toEqual(["meant for other"]);
    expect(fake.requests.filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/agents/other/messages"]);
    // still on disk, untouched, after the compaction that open performs
    const kept = logRecords().find((r) => r.op === "enq" && r.requestId === stranded);
    expect(kept).toMatchObject({ content: "meant for research", agent: "research" });
    expect(own).not.toBe(stranded);
    expect(forOther.snapshot()).toEqual({ pending: 0, setAside: 1, held: null });
  });

  it("the same agent at a different base URL is another binding: set aside, 0 POSTs to either server", async () => {
    const a = await newFake();
    const b = await newFake();
    const forA = open(a);
    enqOk(forA, "for server a");
    const forB = open(b); // same agent name, other port
    expect(forB.snapshot()).toMatchObject({ pending: 0, setAside: 1 });
    expect(await forB.drain(clientFor(b))).toBe("empty");
    expect(a.requests).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it("returning to the original binding delivers the set-aside record", async () => {
    const fake = await newFake();
    enqOk(open(fake), "waiting");
    open(fake, { agent: "other" });
    const back = open(fake);
    expect(back.snapshot().pending).toBe(1);
    await back.drain(clientFor(fake));
    expect(fake.entries("research").map((e) => e.content)).toEqual(["waiting"]);
  });

  it("an outbox refuses a client bound to a different agent than its own", async () => {
    const fake = await newFake();
    const o = open(fake);
    enqOk(o, "x");
    await expect(o.attempt(clientFor(fake, "other"))).rejects.toThrow(RangeError);
    expect(fake.requests).toEqual([]);
  });
});

describe("T24 (A2): 5xx is bounded, then held; a held head is never skipped, reordered or dropped", () => {
  async function heldScenario() {
    const fake = await newFake();
    const o = open(fake);
    const m1 = enqOk(o, "poison");
    const m2 = enqOk(o, "behind it");
    fake.script(...Array.from({ length: 6 }, () => ({ action: "status" as const, status: 500 })));
    const { sleep, slept } = instantSleep();
    const outcomes: PdaAttemptOutcome[] = [];
    const end = await o.drain(clientFor(fake), { sleep, onOutcome: (x) => outcomes.push(x) });
    return { fake, o, m1, m2, end, slept, outcomes };
  }

  it("after exactly 6 attempts with a 5xx the head is held; the message behind it is not posted", async () => {
    const { fake, o, m1, m2, end, outcomes } = await heldScenario();
    expect(end).toBe("held");
    expect(fake.postsByRequestId.get(m1)).toBe(6);
    expect(fake.postsByRequestId.get(m2)).toBeUndefined();
    expect(fake.entries("research")).toEqual([]);
    expect(outcomes.at(-1)).toEqual({ kind: "held", requestId: m1, code: "pda_message_held", status: 500 });
    expect(o.snapshot().held).toMatchObject({ requestId: m1, code: "pda_message_held" });
    expect(logRecords().filter((r) => r.op === "hold")).toEqual([{ op: "hold", requestId: m1, code: "pda_message_held", status: 500, attempts: 6, at: new Date(T0).toISOString() }]);
  });

  it("a held head stays held across drain calls and across a runner restart, with no further POSTs", async () => {
    const { fake, o, m1 } = await heldScenario();
    expect(await o.drain(clientFor(fake))).toBe("held");
    expect(await o.attempt(clientFor(fake))).toEqual({ kind: "blocked", requestId: m1, code: "pda_message_held" });
    const restarted = open(fake);
    expect(restarted.snapshot().held).toMatchObject({ requestId: m1 });
    expect(await restarted.drain(clientFor(fake))).toBe("held");
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(6);
  });

  it("release retries the held head first, then the one behind it; nothing is dropped and the order is kept", async () => {
    const { fake, o, m1 } = await heldScenario();
    expect(o.release()).toBe(m1);
    expect(logRecords().some((r) => r.op === "release" && r.requestId === m1)).toBe(true);
    expect(await o.drain(clientFor(fake))).toBe("empty");
    expect(fake.entries("research").map((e) => e.content)).toEqual(["poison", "behind it"]);
    expect(o.release()).toBeNull();
  });

  it("a hold survives TWO restarts: the second reads the log the first one compacted", async () => {
    const { fake, m1 } = await heldScenario();
    open(fake);
    expect(open(fake).snapshot().held).toMatchObject({ requestId: m1, code: "pda_message_held" });
    expect(logRecords().map((r) => r.op)).toEqual(["enq", "hold", "enq"]);
  });

  it("a release survives a restart: the reopened outbox is not held", async () => {
    const { fake, o } = await heldScenario();
    o.release();
    expect(open(fake).snapshot().held).toBeNull();
  });

  it("a reconnect after a pda restart un-holds in memory only: no record is written, so a runner restart reads the hold again", async () => {
    const { fake, o, m1 } = await heldScenario();
    const before = readLog();
    expect(o.retryHeldAfterReconnect()).toBe(true);
    expect(readLog()).toBe(before);
    expect(o.snapshot().held).toBeNull();
    expect(open(fake).snapshot().held).toMatchObject({ requestId: m1 });
    expect(o.retryHeldAfterReconnect()).toBe(false);
  });

  it("the second failure cycle after a release needs 6 fresh attempts, not 1", async () => {
    const { fake, o, m1 } = await heldScenario();
    o.release();
    fake.script(...Array.from({ length: 5 }, () => ({ action: "status" as const, status: 503 })));
    const { sleep } = instantSleep();
    expect(await o.drain(clientFor(fake), { sleep })).toBe("empty"); // 5 failures, then the 6th is a success
    expect(fake.postsByRequestId.get(m1)).toBe(6 + 5 + 1);
  });

  it("backoff doubles from 0.5 s to a 10 s cap, and keeps the same id the whole time", async () => {
    const fake = await newFake();
    const o = open(fake);
    const id = enqOk(o, "retry me");
    fake.script(...Array.from({ length: 5 }, () => ({ action: "status" as const, status: 502 })));
    const { sleep, slept } = instantSleep();
    await o.drain(clientFor(fake), { sleep });
    expect(slept).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(fake.postsByRequestId.get(id)).toBe(6);
  });

  it("the backoff caps at 10 s and resets after a success", async () => {
    const fake = await newFake();
    const o = open(fake);
    enqOk(o, "a");
    enqOk(o, "b");
    // 8 drops on message 1 (each admits it; pda dedups), the 9th POST is acked, then message 2 drops once.
    fake.script(...Array.from({ length: 8 }, () => ({ action: "admit_then_drop" as const })), { action: "admit" }, { action: "admit_then_drop" });
    const { sleep, slept } = instantSleep();
    await o.drain(clientFor(fake), { sleep });
    expect(slept).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 500]);
  });
});

describe("status classification: every status is derived, none is a constant", () => {
  async function one(status: number | "drop" | "no-id") {
    const fake = await newFake();
    const o = open(fake);
    const first = enqOk(o, "first");
    const second = enqOk(o, "second");
    if (status === "drop") fake.script({ action: "admit_then_drop" });
    else if (status === "no-id") fake.script(...Array.from({ length: 6 }, () => ({ action: "status" as const, status: 200, body: {} })));
    // A 401 is retried once by the client after a token re-read, so a REFUSED token needs two scripted 401s.
    else fake.script(...Array.from({ length: status === 401 ? 2 : 1 }, () => ({ action: "status" as const, status, body: { error: `scripted ${status}` } })));
    const { sleep } = instantSleep();
    const end = await o.drain(clientFor(fake), { sleep });
    return { fake, o, first, second, end };
  }

  it.each([
    [404, "pda_agent_missing"], [401, "pda_unauthorized"], [409, "pda_message_held"], [403, "pda_message_held"], [418, "pda_message_held"],
  ] as const)("%i holds the head with %s after ONE attempt and stops posting", async (status, code) => {
    const { fake, o, first, second, end } = await one(status);
    expect(end).toBe("held");
    expect(o.snapshot().held).toMatchObject({ requestId: first, code });
    expect(fake.postsByRequestId.get(first)).toBe(status === 401 ? 2 : 1); // 401 is re-read once by the client
    expect(fake.postsByRequestId.get(second)).toBeUndefined();
    expect(logRecords().find((r) => r.op === "hold")).toMatchObject({ code, status, attempts: 0 });
  });

  it.each([400, 413] as const)("%i is a definitive reject: kept, not retried, and the next message proceeds", async (status) => {
    const { fake, o, first, second, end } = await one(status);
    expect(end).toBe("empty");
    expect(fake.postsByRequestId.get(first)).toBe(1);
    expect(fake.entries("research").map((e) => e.content)).toEqual(["second"]);
    expect(o.snapshot()).toEqual({ pending: 0, setAside: 0, held: null });
    expect(logRecords().find((r) => r.op === "reject")).toMatchObject({ requestId: first, status, code: "pda_rejected" });
    expect(fake.postsByRequestId.get(second)).toBe(1);
  });

  it("a rejected message is copied to rejected.log (0600) when the log is compacted, once, and the log forgets it", async () => {
    const { fake, first } = await one(400);
    const reopened = open(fake);
    const copy = fs.readFileSync(paths().rejectedPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(copy).toEqual([expect.objectContaining({ requestId: first, content: "first", status: 400, agent: "research" })]);
    expect(fs.statSync(paths().rejectedPath).mode & 0o777).toBe(0o600);
    expect(readLog()).not.toContain(first);
    open(fake); // compacting again must not duplicate the copy
    expect(fs.readFileSync(paths().rejectedPath, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(reopened.snapshot().pending).toBe(0);
  });

  it("a connection that dies after admit is retried without limit and never held (it is the outage case)", async () => {
    const fake = await newFake();
    const o = open(fake);
    const id = enqOk(o, "x");
    fake.script(...Array.from({ length: 20 }, () => ({ action: "admit_then_drop" as const })));
    const { sleep } = instantSleep();
    expect(await o.drain(clientFor(fake), { sleep })).toBe("empty");
    expect(fake.postsByRequestId.get(id)).toBe(21);
    expect(logRecords().filter((r) => r.op === "hold")).toEqual([]);
  });

  it("an unusable token file is transient: nothing is posted, the record stays pending", async () => {
    const fake = await newFake();
    const o = open(fake);
    enqOk(o, "x");
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken: () => ({ ok: false, kind: "token", code: "pda_token_format", problem: "format" }) });
    expect(await o.attempt(client)).toMatchObject({ kind: "transient", reason: "token" });
    expect(fake.requests).toEqual([]);
    expect(o.snapshot().pending).toBe(1);
  });

  it("a 2xx without a submissionId is bounded like a 5xx: held after 6, never acked", async () => {
    const { fake, o, first, end } = await one("no-id");
    expect(end).toBe("held");
    expect(fake.postsByRequestId.get(first)).toBe(6);
    expect(o.snapshot().held).toMatchObject({ code: "pda_message_held" });
  });

  it("a record that is too large for the wire (written by an older revision) is rejected 413 with zero requests", async () => {
    const fake = await newFake();
    seed([rec.enq("openrig/node-1/old/1", "a".repeat(PDA_MAX_BODY_BYTES), "research", fake.baseUrl)]);
    const o = open(fake);
    expect(await o.attempt(clientFor(fake))).toEqual({ kind: "rejected", requestId: "openrig/node-1/old/1", status: 413 });
    expect(fake.requests).toEqual([]);
  });
});

describe("T25 (A2): the log is compacted by atomic rewrite", () => {
  const original = () => seed([
    rec.enq("p1", "pending one", "research", "http://127.0.0.1:1"), rec.enq("a1", "done"), rec.ack("a1"),
    rec.enq("r1", "bad"), rec.reject("r1"), rec.enq("p2", "pending two"),
  ], '{"op":"enq","requestId":"torn"');
  const fakeUrl = "http://127.0.0.1:1";
  const openSeeded = (fsx?: OutboxFs) => PdaOutbox.open({
    paths: paths(), binding: { agent: "research", baseUrl: fakeUrl }, nodeId: "node-1", launchId: "launch-1", fs: fsx, now: () => new Date(T0),
  });

  it("the durable order is: rejected.log, tmp write, tmp fsync, rename over the log, fsync of the directory", () => {
    original();
    const ops: string[] = [];
    openSeeded(recordingFs(ops));
    expect(ops.filter((o) => !o.startsWith("mkdir"))).toEqual([
      "open:rejected.log:append", "write:rejected.log", "fsync:rejected.log", "close:rejected.log",
      "open:outbox.log.tmp:write", "write:outbox.log.tmp", "fsync:outbox.log.tmp", "close:outbox.log.tmp",
      "rename:outbox.log.tmp->outbox.log", "fsyncDir:seat",
    ]);
  });

  it("killed before the rename: the old log is byte-intact, pending is unchanged, and the torn line is ignored", () => {
    const text = original();
    expect(() => openSeeded(recordingFs([], (op) => op === "rename"))).toThrow(Crash);
    expect(fs.readFileSync(paths().outboxPath, "utf8")).toBe(text);
    const reopened = openSeeded();
    expect(reopened.snapshot()).toMatchObject({ pending: 2, setAside: 0 });
    expect(logRecords().filter((r) => r.op === "enq").map((r) => r.requestId)).toEqual(["p1", "p2"]);
  });

  it("killed after the rename (before the directory fsync): the new log is complete and correct", () => {
    original();
    expect(() => openSeeded(recordingFs([], (op) => op === "fsyncDir"))).toThrow(Crash);
    expect(logRecords().map((r) => `${r.op}:${r.requestId}`)).toEqual(["enq:p1", "enq:p2"]);
    expect(openSeeded().snapshot().pending).toBe(2);
  });

  it("killed between the rejected.log copy and the rename: the copy exists once, even after the retry", () => {
    original();
    expect(() => openSeeded(recordingFs([], (op) => op === "rename"))).toThrow(Crash);
    openSeeded();
    const lines = fs.readFileSync(paths().rejectedPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ requestId: "r1", content: "bad" });
  });

  it("a torn last line is dropped by the rewrite, so the next append does not glue onto it", () => {
    original();
    const o = openSeeded();
    const r = o.enqueue("after the tear");
    if (!r.ok) throw new Error("refused");
    const again = openSeeded();
    expect(again.snapshot().pending).toBe(3);
    expect(readLog().split("\n").filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
  });

  it("a garbage line in the middle is skipped without losing its neighbours", () => {
    fs.mkdirSync(seatRoot(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths().outboxPath, `${JSON.stringify(rec.enq("p1"))}\nnot json at all\n${JSON.stringify(rec.enq("p2"))}\n`, { mode: 0o600 });
    expect(openSeeded().snapshot().pending).toBe(2);
  });

  it("the compacted log and rejected.log are private (0600) and the directory is 0700", () => {
    original();
    openSeeded();
    expect(fs.statSync(paths().outboxPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths().rejectedPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(seatRoot()).mode & 0o777).toBe(0o700);
  });

  it("open() itself creates the seat directory 0700 and the log 0600", () => {
    expect(fs.existsSync(seatRoot())).toBe(false);
    openSeeded();
    expect(fs.statSync(seatRoot()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths().outboxPath).mode & 0o777).toBe(0o600);
  });

  it(`at run time, compaction happens when acked and rejected records exceed ${PDA_OUTBOX_COMPACT_THRESHOLD}: not at ${PDA_OUTBOX_COMPACT_THRESHOLD}`, async () => {
    const fake = await newFake();
    const o = open(fake);
    const client = clientFor(fake);
    for (let i = 0; i < PDA_OUTBOX_COMPACT_THRESHOLD; i++) enqOk(o, `m${i}`);
    await o.drain(client);
    expect(logRecords().filter((r) => r.op === "ack")).toHaveLength(PDA_OUTBOX_COMPACT_THRESHOLD); // exactly 64 terminal: no compaction yet
    enqOk(o, "the 65th");
    await o.drain(client);
    expect(logRecords()).toEqual([]); // 65 terminal: rewritten with nothing pending
    expect(fake.entries("research")).toHaveLength(PDA_OUTBOX_COMPACT_THRESHOLD + 1);
  });

  it("compaction keeps a live hold with its enq, and drops a released one", async () => {
    const fake = await newFake();
    const o = open(fake);
    const id = enqOk(o, "stuck");
    fake.script({ action: "status", status: 409 });
    await o.drain(clientFor(fake));
    expect(open(fake).snapshot().held).toMatchObject({ requestId: id });
    expect(logRecords().map((r) => r.op)).toEqual(["enq", "hold"]);
    o.release();
    open(fake);
    expect(logRecords().map((r) => r.op)).toEqual(["enq"]);
  });
});
