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
import { PdaOutbox, PdaOutboxPoisonedError, PdaOutboxSeqCorruptError, nodeOutboxFs, PDA_OUTBOX_COMPACT_THRESHOLD, type OutboxFs, type PdaAttemptOutcome } from "../src/adapters/pda-outbox.js";
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
type WriteFault = "throw_partial" | "short";
function recordingFs(
  ops: string[], crashAt: (op: string, file: string, data?: string) => boolean = () => false,
  writeFault: (file: string, data: string) => WriteFault | null = () => null,
): OutboxFs {
  const names = new Map<number, string>();
  const base = (p: string) => path.basename(p);
  const step = (op: string, file: string, data?: string) => { ops.push(`${op}:${file}`); if (crashAt(op, file, data)) throw new Crash(`${op}:${file}`); };
  return {
    mkdirPrivate: (d) => nodeOutboxFs.mkdirPrivate(d),
    readFile: (p) => nodeOutboxFs.readFile(p),
    open: (p, mode) => { step("open", `${base(p)}:${mode}`); const fd = nodeOutboxFs.open(p, mode); names.set(fd, base(p)); return fd; },
    write: (fd, data) => {
      const file = names.get(fd) ?? "?";
      step("write", file, data);
      const fault = writeFault(file, data);
      // Both faults put the first 20 bytes of the line on disk: that is the torn tail the next append would glue onto.
      if (fault === "throw_partial") { nodeOutboxFs.write(fd, data.slice(0, 20)); throw new Error("EIO injected"); }
      if (fault === "short") return nodeOutboxFs.write(fd, data.slice(0, Math.min(20, data.length - 1))); // fewer bytes than given
      return nodeOutboxFs.write(fd, data);
    },
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
    open(fake); // this open compacts the acked records away ...
    const second = open(fake); // ... so this one sees an empty log: nothing in it remembers a or b
    const c = enqOk(second, "c");
    expect([a, b]).not.toContain(c);
    await second.drain(clientFor(fake));
    expect(fake.entries("research").map((e) => e.content)).toEqual(["a", "b", "c"]);
  });

  async function sendAndAck(fake: FakePda, o: PdaOutbox, contents: string[]) {
    for (const c of contents) enqOk(o, c);
    expect(await o.drain(clientFor(fake))).toBe("empty");
  }

  it("N1 (reviewer's a2): a clock 1 ms BACKWARDS and two reopens under the same launch id never dedupes a new message as an old one", async () => {
    const fake = await newFake();
    await sendAndAck(fake, open(fake), ["old-0", "old-1", "old-2"]);
    clock.t = T0 - 1;
    open(fake); // compacts the three acked records away
    const third = open(fake);
    await sendAndAck(fake, third, ["NEW-A", "NEW-B"]);
    expect(fake.entries("research").map((e) => e.content)).toEqual(["old-0", "old-1", "old-2", "NEW-A", "NEW-B"]);
    expect(new Set(fake.entries("research").map((e) => e.requestId)).size).toBe(5);
  });

  it("N1 (reviewer's b2): a 65-message burst inside one millisecond, runtime compaction, then a restart: the next message is delivered", async () => {
    const fake = await newFake();
    const burst = open(fake);
    await sendAndAck(fake, burst, Array.from({ length: 65 }, (_, i) => `burst-${i}`));
    expect(logRecords()).toEqual([]); // runtime compaction emptied the log: nothing remembers any id
    clock.t = T0 + 10;
    const restarted = open(fake);
    await sendAndAck(fake, restarted, ["NEW-X"]);
    const entries = fake.entries("research");
    expect(entries).toHaveLength(66);
    expect(entries.at(-1)?.content).toBe("NEW-X");
    expect(new Set(entries.map((x) => x.requestId)).size).toBe(66);
  });

  it("N1: the next sequence is max(persisted + 1, log high-water + 1), from either source, and a junk seq file counts as 0", () => {
    seed([rec.enq("openrig/node-1/launch-1/5", "pending five", "research", "http://127.0.0.1:1")]);
    const o = PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "node-1", launchId: "launch-1", now: () => new Date(T0) });
    expect(enqOk(o, "x")).toBe("openrig/node-1/launch-1/6"); // no seq file: the log's high-water decides
    fs.writeFileSync(`${paths().outboxPath}.seq`, "40\n");
    const o2 = PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "node-1", launchId: "launch-1", now: () => new Date(T0) });
    expect(enqOk(o2, "y")).toBe("openrig/node-1/launch-1/41"); // persisted 40 beats the log's 6
  });

  it("D1: an existing .seq that does not parse is refused at open with a coded error, never read as 0 (even with a compacted log)", async () => {
    const fake = await newFake();
    await sendAndAck(fake, open(fake), ["old-0", "old-1"]);
    open(fake); // compacts: nothing in the log remembers the ids
    const seqFile = `${paths().outboxPath}.seq`;
    for (const junk of ["garbage", "", "-5", "12abc", "1e3", "9".repeat(16), "4 2"]) {
      fs.writeFileSync(seqFile, junk);
      let caught: unknown;
      try { open(fake); } catch (e) { caught = e; }
      expect(caught, JSON.stringify(junk)).toBeInstanceOf(PdaOutboxSeqCorruptError);
      expect((caught as PdaOutboxSeqCorruptError).code).toBe("pda_outbox_seq_corrupt");
      expect(String((caught as Error).message)).not.toContain("garbage");
    }
    expect(fs.readFileSync(seqFile, "utf8")).toBe("4 2"); // untouched: open refused before writing anything
    fs.writeFileSync(seqFile, "2\n");
    expect(enqOk(open(fake), "fine again")).toMatch(/\/3$/); // a valid mark opens, and continues above it
  });

  it("N1: each enqueue makes its sequence durable (tmp, fsync, rename, fsync dir) BEFORE the enq that uses it is appended", async () => {
    const fake = await newFake();
    const ops: string[] = [];
    const o = open(fake, { fs: recordingFs(ops) });
    ops.length = 0;
    const id = enqOk(o, "ordered");
    expect(ops).toEqual([
      "open:outbox.log.seq.tmp:write", "write:outbox.log.seq.tmp", "fsync:outbox.log.seq.tmp", "close:outbox.log.seq.tmp",
      "rename:outbox.log.seq.tmp->outbox.log.seq", "fsyncDir:seat",
      "open:outbox.log:append", "write:outbox.log", "fsync:outbox.log", "close:outbox.log",
    ]);
    expect(fs.readFileSync(`${paths().outboxPath}.seq`, "utf8").trim()).toBe(id.split("/").at(-1));
    expect(fs.statSync(`${paths().outboxPath}.seq`).mode & 0o777).toBe(0o600);
  });

  it("N1: a too-large message burns no sequence and writes no seq file", () => {
    const o = PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" }, nodeId: "n", launchId: "l", now: () => new Date(T0) });
    expect(o.enqueue("a".repeat(PDA_MAX_BODY_BYTES)).ok).toBe(false);
    expect(fs.existsSync(`${paths().outboxPath}.seq`)).toBe(false);
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

describe("N2: a failed or short append poisons the outbox, so a torn tail can never swallow a later acknowledged enqueue", () => {
  const fault = (which: WriteFault) => (file: string, data: string): WriteFault | null =>
    (file === "outbox.log" && data.includes('"content":"B"') ? which : null);

  async function acknowledgedThenFailed(which: WriteFault) {
    const fake = await newFake();
    const ops: string[] = [];
    const o = open(fake, { fs: recordingFs(ops, () => false, fault(which)) });
    const a = enqOk(o, "A");
    expect(() => o.enqueue("B")).toThrow(which === "short" ? /short write/ : /EIO injected/);
    return { fake, o, a };
  }

  it.each(["throw_partial", "short"] as const)("%s: later enqueues and attempts are refused, the torn bytes stay un-glued, and A survives a reopen", async (which) => {
    const { fake, o, a } = await acknowledgedThenFailed(which);
    expect(o.poisoned).toBe(true);
    const seqBefore = fs.readFileSync(`${paths().outboxPath}.seq`, "utf8");
    expect(() => o.enqueue("C")).toThrow(PdaOutboxPoisonedError);
    expect(fs.readFileSync(`${paths().outboxPath}.seq`, "utf8")).toBe(seqBefore); // refused before it burned a number
    await expect(o.attempt(clientFor(fake))).rejects.toBeInstanceOf(PdaOutboxPoisonedError);
    expect(fake.requests).toEqual([]);
    expect(readLog()).not.toContain('"content":"C"');
    // repair: reopening rewrites the log and drops the torn tail; A (acknowledged) is intact, B (which threw) is not
    const repaired = open(fake);
    expect(repaired.poisoned).toBe(false);
    expect(repaired.snapshot().pending).toBe(1);
    const d = enqOk(repaired, "D");
    expect(open(fake).snapshot().pending).toBe(2);
    await open(fake).drain(clientFor(fake));
    expect(fake.entries("research").map((x) => [x.requestId === a, x.content])).toEqual([[true, "A"], [false, "D"]]);
    expect(d).not.toBe(a);
  });

  it("a short write of the ack record poisons too: nothing more is attempted, and the replay after reopen is deduped by pda", async () => {
    const fake = await newFake();
    const o = open(fake, { fs: recordingFs([], () => false, (file, data) => (file === "outbox.log" && data.includes('"op":"ack"') ? "short" : null)) });
    const id = enqOk(o, "A");
    await expect(o.drain(clientFor(fake))).rejects.toThrow(/short write/);
    expect(o.poisoned).toBe(true);
    const restarted = open(fake);
    expect(restarted.snapshot().pending).toBe(1);
    expect(await restarted.drain(clientFor(fake))).toBe("empty");
    expect(fake.entries("research")).toHaveLength(1);
    expect(fake.postsByRequestId.get(id)).toBe(2);
  });

  it("release() on a poisoned outbox refuses, so the operator is not told it worked while the record is glued to torn bytes", async () => {
    const fake = await newFake();
    const o = open(fake, { fs: recordingFs([], () => false, fault("throw_partial")) });
    const held = enqOk(o, "A");
    fake.script({ action: "status", status: 409 });
    expect(await o.drain(clientFor(fake))).toBe("held");
    expect(() => o.enqueue("B")).toThrow(/EIO injected/); // poisons, leaving 20 torn bytes at the end of the log
    const before = readLog();
    expect(() => o.release()).toThrow(PdaOutboxPoisonedError);
    expect(readLog()).toBe(before); // nothing was appended after the torn bytes
    expect(o.snapshot().held).toMatchObject({ requestId: held }); // and the in-memory hold was not lifted
    const repaired = open(fake); // reopen repairs; the hold is still there for the operator to release
    expect(repaired.snapshot().held).toMatchObject({ requestId: held });
    expect(repaired.release()).toBe(held);
  });

  it("an ack that arrives after the outbox was poisoned mid-flight is not lost silently: attempt throws, and reopen replays it deduped", async () => {
    const fake = await newFake();
    const o = open(fake, { fs: recordingFs([], () => false, fault("throw_partial")) });
    const a = enqOk(o, "A");
    fake.onPost = () => { try { o.enqueue("B"); } catch { /* the injected append failure poisons the outbox while A's POST is in flight */ } };
    await expect(o.attempt(clientFor(fake))).rejects.toBeInstanceOf(PdaOutboxPoisonedError);
    expect(o.poisoned).toBe(true);
    expect(readLog()).not.toContain('"op":"ack"'); // no ack record was glued onto the torn bytes
    fake.onPost = undefined;
    const restarted = open(fake);
    expect(restarted.snapshot().pending).toBe(1); // A is still pending: replay is safe
    expect(await restarted.drain(clientFor(fake))).toBe("empty");
    expect(fake.entries("research").map((x) => x.content)).toEqual(["A"]); // pda deduped the replay
    expect(fake.postsByRequestId.get(a)).toBe(2);
  });

  it("a failed open() of the log for append poisons as well", () => {
    const fx = recordingFs([], (op, file) => op === "open" && file === "outbox.log:append");
    const o = PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "n", launchId: "l", fs: fx, now: () => new Date(T0) });
    expect(() => o.enqueue("A")).toThrow(Crash);
    expect(o.poisoned).toBe(true);
  });

  it("a short write of the compaction tmp file aborts BEFORE the rename: the old log is byte-intact", () => {
    const text = seed([rec.enq("p1", "pending"), rec.enq("a1"), rec.ack("a1")]);
    const ops: string[] = [];
    expect(() => PdaOutbox.open({
      paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "n", launchId: "l", now: () => new Date(T0),
      fs: recordingFs(ops, () => false, (file) => (file === "outbox.log.tmp" ? "short" : null)),
    })).toThrow(/short write/);
    expect(fs.readFileSync(paths().outboxPath, "utf8")).toBe(text);
    expect(ops.some((o) => o.startsWith("rename:"))).toBe(false);
  });

  it("a short write of the seq file burns nothing: no enq is appended and the old high-water stands", () => {
    const o = PdaOutbox.open({
      paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "n", launchId: "l", now: () => new Date(T0),
      fs: recordingFs([], () => false, (file) => (file === "outbox.log.seq.tmp" ? "short" : null)),
    });
    expect(() => o.enqueue("A")).toThrow(/short write/);
    expect(readLog()).toBe("");
    expect(fs.existsSync(`${paths().outboxPath}.seq`)).toBe(false);
    expect(o.poisoned).toBe(false); // nothing torn the log
  });

  it("rejected.log: a torn tail left by an interrupted copy does not swallow the next copied record", () => {
    seed([rec.enq("r1", "bad one", "research", "http://127.0.0.1:1"), rec.reject("r1")]);
    fs.writeFileSync(paths().rejectedPath, '{"requestId":"torn-by-a-crash', { mode: 0o600 });
    PdaOutbox.open({ paths: paths(), binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, nodeId: "n", launchId: "l", now: () => new Date(T0) });
    const lines = fs.readFileSync(paths().rejectedPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ requestId: "r1", content: "bad one" });
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
