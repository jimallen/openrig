// Native comms step 3 (design-native-comms-20261030 §8.1): ClaudeNativeInbox with every OS dependency faked. Nothing
// here reaches a live seat, socket, process or tmux server.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import {
  ClaudeNativeInbox, nativeMarker, parseNativeMarkers, ACCEPT_SETTING_ARGV_FRAGMENT, type NativeInboxDeps, type ProcessRow,
} from "../src/domain/claude-native-inbox.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const SEAT = "dev-impl@rig1";
const SENDER = "dev-lead@rig1";
const SOCK = "/tmp/cc-socks/4242.sock";
const TRANSCRIPT = "/fake/transcript.jsonl";
const ACCEPT_ARGS = `claude --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true,${ACCEPT_SETTING_ARGV_FRAGMENT}}`;

interface Fake {
  db: Database.Database; outbox: OutboxHandler; inbox: ClaudeNativeInbox;
  enabled: boolean; panePid: number | null; procs: ProcessRow[]; sockets: Set<string>;
  writes: Array<{ path: string; lines: unknown[] }>; writeResult: "none" | "all" | "partial"; onWrite?: () => void;
  files: Map<string, string>; liveGen: string | null; clock: { t: number };
  probe: { version: string | null; literal: boolean; replacedSinceStart: boolean };
  settled: Array<{ id: string; kind: string; detail: string | null }>;
}

function seed(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  for (const [node, logical, runtime, session] of [["node-a", "dev.impl", "claude-code", SEAT], ["node-b", "dev.lead", "claude-code", SENDER],
    ["node-h", "operator.human", "terminal", "operator-human@rig1"], ["node-c", "dev.codex", "codex", "dev-codex@rig1"]] as const) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-1', ?, ?)").run(node, logical, runtime);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(`s-${node}`, node, session);
  }
}

function make(over?: Partial<NativeInboxDeps>): Fake {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  seed(db);
  const f = {
    db, outbox: new OutboxHandler(db), enabled: true, panePid: 100,
    procs: [{ pid: 100, ppid: 1, args: "-zsh" }, { pid: 4242, ppid: 100, args: ACCEPT_ARGS }] as ProcessRow[],
    sockets: new Set([SOCK]), writes: [] as Array<{ path: string; lines: unknown[] }>, writeResult: "all" as "none" | "all" | "partial",
    files: new Map<string, string>(), liveGen: "gen-1", clock: { t: Date.parse("2026-10-30T12:00:00.000Z") },
    probe: { version: "2.1.314", literal: true, replacedSinceStart: false },
    settled: [] as Array<{ id: string; kind: string; detail: string | null }>,
  } as Fake;
  f.inbox = new ClaudeNativeInbox({
    db, outbox: f.outbox,
    enabled: () => f.enabled,
    panePid: async () => f.panePid,
    listProcesses: async () => f.procs,
    socketExists: (p) => f.sockets.has(p),
    write: async (path, lines) => { f.writes.push({ path, lines }); f.onWrite?.(); return f.writeResult; },
    fileIncludes: (p, needle) => (f.files.get(p) ?? "").includes(needle),
    probeBinary: async () => f.probe,
    liveGeneration: () => f.liveGen,
    now: () => new Date(f.clock.t),
    sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
    ackWindowMs: 50,
    deadlineMs: 120_000,
    hardDeadlineMs: 1_800_000,
    onSettled: (row, outcome) => { f.settled.push({ id: row.outboxId, kind: outcome.kind, detail: outcome.detail }); },
    ...over,
  });
  return f;
}

async function register(f: Fake, over?: Partial<{ generation: string | null; claudePid: number | null; execPath: string | null; sessionName: string }>) {
  return f.inbox.registerEndpoint({ nodeId: "node-a", sessionName: over?.sessionName ?? SEAT, generation: over?.generation === undefined ? "gen-1" : over.generation,
    socketPath: SOCK, transcriptPath: TRANSCRIPT, claudePid: over?.claudePid === undefined ? 4242 : over.claudePid, execPath: over?.execPath === undefined ? "/bin/claude" : over.execPath });
}

function contentOf(write: { lines: unknown[] }): string {
  const line = write.lines[0] as { type: string; message: { role: string; content: string } };
  expect(line.type).toBe("user");
  expect(line.message.role).toBe("user");
  return line.message.content;
}

function row(db: Database.Database, id: string) {
  return db.prepare("SELECT delivery_state AS state, delivery_path AS path, ack_evidence AS evidence, ack_detail AS detail, native_nonce AS nonce FROM outbox_entries WHERE outbox_id = ?").get(id) as
    { state: string; path: string | null; evidence: string | null; detail: string | null; nonce: string | null } | undefined;
}

function recordActivity(db: Database.Database, rawEvent: string, eventAt: string) {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', 'node-a', 'agent.activity', ?)")
    .run(JSON.stringify({ type: "agent.activity", sessionName: SEAT, activity: { rawEvent, eventAt, state: "idle", evidenceSource: "runtime_hook" } }));
}

describe("markers", () => {
  it("a marker carries the row id and its nonce, and is parsed back out of a prompt with other text", () => {
    const m = nativeMarker("outbox-20261030-ab12", "0123456789abcdef01234567");
    expect(parseNativeMarkers(`hello\n\n${m}`)).toEqual([{ id: "outbox-20261030-ab12", nonce: "0123456789abcdef01234567" }]);
    expect(parseNativeMarkers("no marker here [openrig-msg x:short]")).toEqual([]);
  });
});

describe("registerEndpoint: the launch probe of the seat's claude binary (criterion 2)", () => {
  it.each([
    ["pass", { version: "2.1.314", literal: true, replacedSinceStart: false }, "pass"],
    ["unknown version", { version: null, literal: true, replacedSinceStart: false }, "fail:version_unknown"],
    ["binary replaced after the process started", { version: "2.1.314", literal: true, replacedSinceStart: true }, "fail:binary_replaced_since_start"],
    ["no inject literal", { version: "2.1.314", literal: false, replacedSinceStart: false }, "fail:inject_format_absent"],
  ] as const)("%s → %s", async (_label, probe, expected) => {
    const f = make();
    f.probe = { ...probe };
    const r = await register(f);
    expect([r?.probe_result, r?.claude_version]).toEqual([expected, probe.version]);
  });

  it("no exec path → fail:no_exec_path, recorded", async () => {
    const f = make();
    expect((await register(f, { execPath: null }))?.probe_result).toBe("fail:no_exec_path");
  });
});

describe("eligibility: every condition, or tmux (criteria 4 and 5)", () => {
  it("control: a registered, probed, live seat with the accept setting is eligible for an agent sender", async () => {
    const f = make(); await register(f);
    expect(await f.inbox.eligibility(SEAT, SENDER)).toMatchObject({ ok: true, nodeId: "node-a" });
  });

  it.each([
    ["the daemon's own identity", "watchdog@system", true],
    ["daemon@kernel", "daemon@kernel", true],
    ["a codex agent seat", "dev-codex@rig1", true],
    ["a human terminal seat", "operator-human@rig1", false],
    ["the operator's inbox address", "human@kernel", false],
    ["no sender", null, false],
    ["an unknown sender", "unknown", false],
    ["an unregistered name", "nobody@nowhere", false],
  ] as const)("sender %s → native %s", async (_label, sender, ok) => {
    const f = make(); await register(f);
    const r = await f.inbox.eligibility(SEAT, sender);
    expect(r.ok).toBe(ok);
    if (!ok) expect(r).toMatchObject({ reason: "sender_not_native" });
  });

  it.each([
    ["the setting is off", (f: Fake) => { f.enabled = false; }, "native_disabled"],
    ["the seat is not running", (f: Fake) => { f.db.prepare("UPDATE sessions SET status='stopped' WHERE session_name=?").run(SEAT); }, "seat_not_running"],
    ["the seat is not Claude", (f: Fake) => { f.db.prepare("UPDATE nodes SET runtime='codex' WHERE id='node-a'").run(); }, "runtime_not_claude"],
    ["the probe failed", (f: Fake) => { f.db.prepare("UPDATE seat_native_endpoints SET probe_result='fail:inject_format_absent'").run(); }, "probe_fail:inject_format_absent"],
    ["the endpoint names an older occupant", (f: Fake) => { f.liveGen = "gen-2"; }, "endpoint_generation_stale"],
    ["the socket is gone", (f: Fake) => { f.sockets.clear(); }, "socket_missing"],
    ["the pane pid is unknown", (f: Fake) => { f.panePid = null; }, "pane_pid_unknown"],
    ["the claude pid is dead (a stale socket file, measured after SIGKILL)", (f: Fake) => { f.procs = f.procs.filter((p) => p.pid !== 4242); }, "claude_pid_dead"],
    ["the claude pid is not in the seat's pane (pid reuse, another session)", (f: Fake) => { f.procs = [{ pid: 100, ppid: 1, args: "-zsh" }, { pid: 4242, ppid: 999, args: ACCEPT_ARGS }]; }, "claude_not_in_seat_pane"],
    ["the running claude lacks the accept setting (launched before it was enabled)", (f: Fake) => { f.procs = [{ pid: 100, ppid: 1, args: "-zsh" }, { pid: 4242, ppid: 100, args: "claude --dangerously-skip-permissions" }]; }, "seat_lacks_accept_setting"],
  ])("%s → tmux (%s)", async (_label, mutate, reason) => {
    const f = make(); await register(f);
    mutate(f);
    expect(await f.inbox.eligibility(SEAT, SENDER)).toEqual({ ok: false, reason });
  });

  it("no endpoint registered → tmux", async () => {
    const f = make();
    expect(await f.inbox.eligibility(SEAT, SENDER)).toEqual({ ok: false, reason: "no_endpoint" });
  });
});

describe("deliver: the row first, then the write (R1)", () => {
  async function eligible(f: Fake) {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    return e.endpoint;
  }

  it("a plain send creates and claims its row before the write; the text carries the row's marker; an in-window ack settles it", async () => {
    const f = make();
    const endpoint = await eligible(f);
    let idAtWrite: string | undefined;
    f.onWrite = () => {
      idAtWrite = f.outbox.listNativePending()[0]?.outboxId; // the row exists and is claimed when the bytes leave
      const r = row(f.db, idAtWrite!)!;
      setTimeout(() => f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id: idAtWrite!, nonce: r.nonce! }] }), 0);
    };
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint });
    expect(res).toMatchObject({ kind: "written", write: "all", acked: true });
    expect(res.outboxIds).toEqual([idAtWrite]);
    const content = contentOf(f.writes[0]!);
    expect(content.startsWith("hello\n\n")).toBe(true);
    expect(parseNativeMarkers(content)).toEqual([{ id: idAtWrite, nonce: row(f.db, idAtWrite!)!.nonce }]);
    expect(row(f.db, idAtWrite!)).toMatchObject({ state: "delivered", path: "native", evidence: "native_hook_delivered" });
  });

  it("no ack within the window → returned unconfirmed; the row stays sending, native / native_written", async () => {
    const f = make();
    const endpoint = await eligible(f);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint });
    expect(res).toMatchObject({ kind: "written", acked: false });
    expect(row(f.db, res.outboxIds[0]!)).toMatchObject({ state: "sending", path: "native", evidence: "native_written" });
  });

  it("nothing written → no row is left behind and the caller uses tmux", async () => {
    const f = make();
    const endpoint = await eligible(f);
    f.writeResult = "none";
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint });
    expect(res).toMatchObject({ kind: "fallback", reason: "socket_write_failed" });
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({ n: 0 });
  });

  it("a partial write → indeterminate, native_unconfirmed / write_partial, never re-sent by the sweeper", async () => {
    const f = make();
    const endpoint = await eligible(f);
    f.writeResult = "partial";
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint });
    expect(res).toMatchObject({ kind: "written", write: "partial", acked: false });
    expect(row(f.db, res.outboxIds[0]!)).toMatchObject({ state: "indeterminate", path: "native", evidence: "native_unconfirmed", detail: "write_partial" });
    f.clock.t += 3_600_000;
    expect(f.inbox.sweep().fallbacks).toEqual([]);
  });

  it("committed wake rows are adopted (one marker each); nothing written returns them to sending, unlabelled", async () => {
    const f = make();
    const endpoint = await eligible(f);
    const ids = ["w1", "w2"].map((s) => f.outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}${s}`, senderSession: "queue@system", destinationSession: SEAT, body: s }).outboxId);
    for (const id of ids) f.outbox.claimForDelivery(id);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: "queue@system", text: "w1\nw2", endpoint, committedOutboxIds: ids });
    expect(res.outboxIds).toEqual(ids);
    expect(parseNativeMarkers(contentOf(f.writes[0]!)).map((m) => m.id)).toEqual(ids);
    const f2 = make();
    const endpoint2 = await eligible(f2);
    const ids2 = ["w3"].map((s) => f2.outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}${s}`, senderSession: "queue@system", destinationSession: SEAT, body: s }).outboxId);
    for (const id of ids2) f2.outbox.claimForDelivery(id);
    f2.writeResult = "none";
    await f2.inbox.deliver({ sessionName: SEAT, senderSession: "queue@system", text: "w3", endpoint: endpoint2, committedOutboxIds: ids2 });
    expect(row(f2.db, ids2[0]!)).toMatchObject({ state: "sending", path: null, evidence: null, nonce: null });
  });

  it("a held (retained) or retired id is refused, so the caller keeps today's path (its readback sends nothing)", async () => {
    const f = make();
    const endpoint = await eligible(f);
    const binding = { nodeId: "node-a", session: SEAT, occupant: null, pane: null };
    const id = f.outbox.retain({ outboxId: "guard-watchdog-1", senderSession: "watchdog@system", destinationSession: SEAT, body: "x" }, binding).outboxId;
    await expect(f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "x", endpoint, deliveryId: id })).rejects.toThrow(/not claimable/);
    f.outbox.retire(id, "operator@rig1", "done");
    await expect(f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "x", endpoint, deliveryId: id })).rejects.toThrow(/not claimable/);
    expect(f.writes).toHaveLength(0);
  });
});

describe("ack: only the matching native row, at the hooking seat (R2); late duplicates are blocked (R4)", () => {
  async function pending(f: Fake) {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    const id = res.outboxIds[0]!;
    return { id, nonce: row(f.db, id)!.nonce! };
  }

  it("a wrong nonce (a quoted or forwarded marker) acks nothing and blocks nothing", async () => {
    const f = make(); const { id } = await pending(f);
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce: "f".repeat(24) }] })).toEqual({ acked: [], block: false });
    expect(row(f.db, id)?.state).toBe("sending");
  });

  it("the right marker at ANOTHER seat acks nothing", async () => {
    const f = make(); const { id, nonce } = await pending(f);
    expect(f.inbox.ack({ nodeId: "node-b", sessionName: SENDER, markers: [{ id, nonce }] })).toEqual({ acked: [], block: false });
  });

  it("the right marker at the seat acks once; a second copy is blocked as a duplicate", async () => {
    const f = make(); const { id, nonce } = await pending(f);
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [id], block: false });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [], block: true });
  });

  it("a copy arriving while its tmux fallback is in flight is blocked", async () => {
    const f = make(); const { id, nonce } = await pending(f);
    f.outbox.settleNative(id, "failed", { path: "native", evidence: "native_unconfirmed" });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] }).block).toBe(true);
  });

  it("a copy arriving after the tmux fallback FAILED is the delivery: acked, not blocked", async () => {
    const f = make(); const { id, nonce } = await pending(f);
    f.outbox.settleNative(id, "failed", { path: "native", evidence: "native_unconfirmed" });
    f.outbox.settleFallback(id, "failed", { path: "tmux", evidence: "send_failed", detail: "target_needs_input" });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [id], block: false });
    expect(row(f.db, id)).toMatchObject({ state: "delivered", path: "native", evidence: "native_hook_delivered" });
  });

  it("a prompt with one new and one duplicate marker is let through (not every marker is a duplicate)", async () => {
    const f = make(); const a = await pending(f); const b = await pending(f);
    f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [a] });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [a, b] })).toEqual({ acked: [b.id], block: false });
  });
});

describe("sweep: the deadline rule (R3)", () => {
  async function pending(f: Fake) {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    return res.outboxIds[0]!;
  }
  const at = (f: Fake, ms: number) => new Date(f.clock.t + ms).toISOString();

  it("before the deadline nothing moves, even after a boundary", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "Stop", at(f, 5_000));
    f.clock.t += 60_000;
    expect(f.inbox.sweep()).toEqual({ fallbacks: [], settled: [] });
    expect(row(f.db, id)?.state).toBe("sending");
  });

  it("past the deadline with NO boundary since the write, the row waits (it may still be queued) and is never re-sent", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "Stop", at(f, -5_000)); // a boundary BEFORE the write does not count
    f.clock.t += 300_000;
    expect(f.inbox.sweep().fallbacks).toEqual([]);
    expect(row(f.db, id)?.state).toBe("sending");
  });

  it("past the HARD deadline with no boundary → indeterminate, no_boundary_by_hard_deadline, no fallback", async () => {
    const f = make(); const id = await pending(f);
    f.clock.t += 1_800_000;
    expect(f.inbox.sweep().fallbacks).toEqual([]);
    expect(row(f.db, id)).toMatchObject({ state: "indeterminate", evidence: "native_unconfirmed", detail: "no_boundary_by_hard_deadline" });
  });

  it("a boundary since the write and the marker IN the transcript → delivered, native_transcript (the ack was lost), no fallback", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "Stop", at(f, 5_000));
    f.files.set(TRANSCRIPT, `{"type":"user","message":{"content":"hello\\n\\n${nativeMarker(id, row(f.db, id)!.nonce!)}"}}`);
    f.clock.t += 130_000;
    const r = f.inbox.sweep();
    expect(r.fallbacks).toEqual([]);
    expect(row(f.db, id)).toMatchObject({ state: "delivered", path: "native", evidence: "native_transcript" });
  });

  it("a boundary since the write and NO marker in the transcript → failed native_unconfirmed, returned for the tmux path", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "UserPromptSubmit", at(f, 5_000));
    f.files.set(TRANSCRIPT, "unrelated");
    f.clock.t += 130_000;
    const r = f.inbox.sweep();
    expect(r.fallbacks).toEqual([{ outboxId: id, sessionName: SEAT, senderSession: SENDER, body: "hello", auditPointer: null, wake: false }]);
    expect(row(f.db, id)).toMatchObject({ state: "failed", evidence: "native_unconfirmed", detail: "boundary_without_ack" });
    // a second sweep does not return it again
    expect(f.inbox.sweep().fallbacks).toEqual([]);
  });

  it("a PostToolUse is not a boundary (the queued message is taken right after it, measured)", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "PostToolUse", at(f, 5_000));
    f.clock.t += 300_000;
    expect(f.inbox.sweep().fallbacks).toEqual([]);
    expect(row(f.db, id)?.state).toBe("sending");
  });

  it("works from the database alone: a fresh inbox (a daemon restart) settles rows the old one wrote", async () => {
    const f = make(); const id = await pending(f);
    recordActivity(f.db, "Stop", at(f, 5_000));
    f.clock.t += 130_000;
    const restarted = new ClaudeNativeInbox({ db: f.db, outbox: new OutboxHandler(f.db), enabled: () => true, panePid: async () => 100,
      listProcesses: async () => f.procs, socketExists: () => true, write: async () => "all", fileIncludes: () => false,
      probeBinary: async () => f.probe, liveGeneration: () => "gen-1", now: () => new Date(f.clock.t) });
    expect(restarted.sweep().fallbacks.map((x) => x.outboxId)).toEqual([id]);
  });
});

// Review F1 (blocking): a late native copy of an `indeterminate` row is the delivery, never a duplicate to block.
describe("review F1: a late copy of an indeterminate row is acked, not blocked", () => {
  async function written(f: Fake, write: "all" | "partial" = "all") {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    f.writeResult = write;
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    return { id: res.outboxIds[0]!, nonce: row(f.db, res.outboxIds[0]!)!.nonce! };
  }

  it("indeterminate after the hard deadline (the seat parked at a prompt > 30 min), then taken: acked, delivered (late)", async () => {
    const f = make(); const { id, nonce } = await written(f);
    f.clock.t += 1_800_000;
    f.inbox.sweep();
    expect(row(f.db, id)?.state).toBe("indeterminate"); // positive control: the cause happened
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [id], block: false });
    expect(row(f.db, id)).toMatchObject({ state: "delivered", evidence: "native_hook_delivered", detail: "late, after indeterminate (no_boundary_by_hard_deadline)" });
  });

  it("indeterminate after a partial write, then taken: acked, delivered (late)", async () => {
    const f = make(); const { id, nonce } = await written(f, "partial");
    expect(row(f.db, id)?.state).toBe("indeterminate");
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [id], block: false });
    expect(row(f.db, id)?.state).toBe("delivered");
  });

  it("the same prompt's hook running twice is one delivery (not a self-block); another prompt with it is a duplicate", async () => {
    const f = make(); const { id, nonce } = await written(f);
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }], promptId: "p-1" })).toEqual({ acked: [id], block: false });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }], promptId: "p-1" })).toEqual({ acked: [id], block: false });
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }], promptId: "p-2" })).toEqual({ acked: [], block: true });
  });
});

describe("review F2 at the inbox: a repeated delivery id", () => {
  async function endpoint(f: Fake) {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, "watchdog@system");
    if (!e.ok) throw new Error(e.reason);
    return e.endpoint;
  }

  it("while the first native write awaits its ack, a repeat coalesces: nothing is written again", async () => {
    const f = make(); const ep = await endpoint(f);
    const first = await f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "wake", endpoint: ep, deliveryId: "guard-watchdog-job1" });
    const again = await f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "wake", endpoint: ep, deliveryId: "guard-watchdog-job1" });
    expect([first.kind, again.kind, again.outboxIds, f.writes.length]).toEqual(["written", "pending", ["guard-watchdog-job1"], 1]);
  });

  it("after the first settled, a repeat is a new attempt with its own row (<id>.r1) and is written natively", async () => {
    const f = make(); const ep = await endpoint(f);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "wake", endpoint: ep, deliveryId: "guard-watchdog-job1" });
    const first = row(f.db, "guard-watchdog-job1")!;
    f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id: "guard-watchdog-job1", nonce: first.nonce! }] });
    const again = await f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "wake", endpoint: ep, deliveryId: "guard-watchdog-job1" });
    expect([again.kind, again.outboxIds, f.writes.length]).toEqual(["written", ["guard-watchdog-job1.r1"], 2]);
    expect(row(f.db, "guard-watchdog-job1.r1")).toMatchObject({ state: "sending", path: "native", evidence: "native_written" });
    // D4: a second repeat after .r1 settled is .r2, not .r1 again
    f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id: "guard-watchdog-job1.r1", nonce: row(f.db, "guard-watchdog-job1.r1")!.nonce! }] });
    const third = await f.inbox.deliver({ sessionName: SEAT, senderSession: "watchdog@system", text: "wake", endpoint: ep, deliveryId: "guard-watchdog-job1" });
    expect([third.kind, third.outboxIds, f.writes.length]).toEqual(["written", ["guard-watchdog-job1.r2"], 3]);
  });
});

describe("review N3 and N5", () => {
  it("N3: after a /clear moved the seat to a new transcript, the marker is still found in the transcript of the write", async () => {
    const f = make(); await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    const id = res.outboxIds[0]!;
    f.files.set(TRANSCRIPT, `...${nativeMarker(id, row(f.db, id)!.nonce!)}...`);
    await f.inbox.registerEndpoint({ nodeId: "node-a", sessionName: SEAT, generation: "gen-1", socketPath: SOCK, transcriptPath: "/fake/after-clear.jsonl", claudePid: 4242, execPath: "/bin/claude" });
    recordActivity(f.db, "Stop", new Date(f.clock.t + 5_000).toISOString());
    f.clock.t += 130_000;
    expect(f.inbox.sweep().fallbacks).toEqual([]);
    expect(row(f.db, id)).toMatchObject({ state: "delivered", evidence: "native_transcript" });
  });

  it("N5: a socket named for another pid than the endpoint's claude → tmux", async () => {
    const f = make();
    await f.inbox.registerEndpoint({ nodeId: "node-a", sessionName: SEAT, generation: "gen-1", socketPath: "/tmp/cc-socks/9999.sock", transcriptPath: TRANSCRIPT, claudePid: 4242, execPath: "/bin/claude" });
    f.sockets.add("/tmp/cc-socks/9999.sock");
    expect(await f.inbox.eligibility(SEAT, SENDER)).toEqual({ ok: false, reason: "socket_pid_mismatch" });
  });
});

describe("settlement notifications (review F3 and the R3 notice)", () => {
  async function pending(f: Fake) {
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    return { id: res.outboxIds[0]!, nonce: row(f.db, res.outboxIds[0]!)!.nonce! };
  }

  it("each settlement is reported once, with its kind", async () => {
    const f = make();
    const a = await pending(f);
    f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [a] });
    f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [a] }); // duplicate: no second report
    const b = await pending(f);
    f.clock.t += 1_800_000;
    f.inbox.sweep();
    f.inbox.sweep();
    const c = await pending(f);
    recordActivity(f.db, "Stop", new Date(f.clock.t + 1_000).toISOString());
    f.clock.t += 130_000;
    f.inbox.sweep();
    expect(f.settled).toEqual([
      { id: a.id, kind: "delivered", detail: null },
      { id: b.id, kind: "unconfirmed", detail: "no_boundary_by_hard_deadline" },
      { id: c.id, kind: "failing_over", detail: "boundary_without_ack" },
    ]);
  });

  it("D12: a partial write is reported unconfirmed (write_partial), once", async () => {
    const f = make(); await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    f.writeResult = "partial";
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    f.clock.t += 3_600_000;
    f.inbox.sweep();
    expect(f.settled).toEqual([{ id: res.outboxIds[0], kind: "unconfirmed", detail: "write_partial" }]);
  });
});
