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
  probe: { version: string | null; literal: boolean; replacedSinceStart: boolean; nameEnvelope?: boolean };
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

  // ncomms-3c: a hook's environment has CLAUDE_PID but not CLAUDE_CODE_EXECPATH (measured, 2.1.314 Linux and macOS), so
  // the binary is found from the pid; the relay's value is a fallback only.
  it("the binary is resolved from the claude pid when the relay reports none, and that path is probed and recorded", async () => {
    const probed: string[] = [];
    const f = make({ resolveExecPath: async (pid) => (pid === 4242 ? "/opt/claude/versions/2.1.314" : null),
      probeBinary: async (p) => { probed.push(p); return { version: "2.1.314", literal: true, replacedSinceStart: false }; } });
    const r = await register(f, { execPath: null });
    expect([r?.probe_result, r?.exec_path, probed]).toEqual(["pass", "/opt/claude/versions/2.1.314", ["/opt/claude/versions/2.1.314"]]);
  });

  it("an unresolvable binary (none from the pid, none from the relay) → fail:exec_path_unresolved; no pid → fail:no_claude_pid", async () => {
    const f = make({ resolveExecPath: async () => null });
    expect((await register(f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
    expect((await register(f, { claudePid: null }))?.probe_result).toBe("fail:no_claude_pid");
  });
});

// OF-191: every SessionStart (a /compact, /clear, /resume) re-posts the endpoint of the SAME claude process. The probe
// reads the binary file, so once the file was replaced or the host was too loaded for lsof/--version to answer, the
// re-registration downgraded a seat whose process had already passed, and its messages fell back to tmux for the rest
// of its life. Measured 2026-10-31: three seats re-registered as fail:exec_path_unresolved under their original pids.
describe("OF-191: a re-registration of the process that already passed keeps its pass", () => {
  const passing = { version: "2.1.316", literal: true, replacedSinceStart: false, nameEnvelope: true };
  const HOUR = 3_600_000;
  /** A seat that passed at launch (process started 1 h before the registration), then the file can no longer be read. */
  async function passedThen(over?: Partial<NativeInboxDeps>) {
    let resolves: string | null = "/opt/claude/bin/claude.exe";
    let probe: Awaited<ReturnType<NativeInboxDeps["probeBinary"]>> | "throw" = passing;
    let startedAt: Date | null | "throw" = null;
    const f = make({
      resolveExecPath: async () => resolves,
      probeBinary: async () => { if (probe === "throw") throw new Error("spawn timed out"); return probe; },
      processStartedAt: async () => { if (startedAt === "throw") throw new Error("ps failed"); return startedAt; },
      ...over,
    });
    startedAt = new Date(f.clock.t - HOUR);
    const first = await register(f, { execPath: null });
    expect(first?.probe_result).toBe("pass");
    f.clock.t += 2 * HOUR;
    return {
      f, first,
      unreadable: () => { resolves = null; },
      probeIs: (p: typeof probe) => { probe = p; },
      startedIs: (s: typeof startedAt) => { startedAt = s; },
    };
  }

  it("the binary file cannot be resolved from the pid (replaced on disk, or lsof timed out) → the pass, version, path and envelope stand; registered_at moves; the seat stays native-eligible", async () => {
    const s = await passedThen();
    s.unreadable();
    const r = await register(s.f, { execPath: null });
    expect([r?.probe_result, r?.claude_version, r?.exec_path, r?.name_envelope, r?.registered_at])
      .toEqual(["pass", "2.1.316", "/opt/claude/bin/claude.exe", 1, new Date(s.f.clock.t).toISOString()]);
    expect(s.f.inbox.endpointFor("node-a")).toMatchObject({ probe_result: "pass", claude_version: "2.1.316" });
    const e = await s.f.inbox.eligibility(SEAT, SENDER);
    expect(e.ok).toBe(true);
  });

  it("a kept pass still records the new transcript and socket facts of this registration (a /clear moves the transcript)", async () => {
    const s = await passedThen();
    s.unreadable();
    const r = await s.f.inbox.registerEndpoint({ nodeId: "node-a", sessionName: SEAT, generation: "gen-1", socketPath: SOCK,
      transcriptPath: "/fake/after-clear.jsonl", claudePid: 4242, execPath: null });
    expect([r?.probe_result, r?.transcript_path, s.f.inbox.endpointFor("node-a")?.transcript_path]).toEqual(["pass", "/fake/after-clear.jsonl", "/fake/after-clear.jsonl"]);
  });

  it.each([
    ["--version came back empty (timed out under load)", { version: null, literal: true, replacedSinceStart: false }],
    ["the file was replaced after the process started", { version: "2.1.316", literal: true, replacedSinceStart: true }],
    ["the probe threw", "throw"],
  ] as const)("%s → the pass stands", async (_label, probe) => {
    const s = await passedThen();
    s.probeIs(probe as never);
    const r = await register(s.f, { execPath: null });
    expect([r?.probe_result, r?.claude_version]).toEqual(["pass", "2.1.316"]);
  });

  it("a genuine inject-format failure still fails closed, even for the same process", async () => {
    const s = await passedThen();
    s.probeIs({ version: "2.1.316", literal: false, replacedSinceStart: false });
    expect((await register(s.f, { execPath: null }))?.probe_result).toBe("fail:inject_format_absent");
  });

  it("a readable binary is re-probed: the recorded version follows the probe, nothing is carried over", async () => {
    const s = await passedThen();
    s.probeIs({ version: "2.1.317", literal: true, replacedSinceStart: false, nameEnvelope: false });
    const r = await register(s.f, { execPath: null });
    expect([r?.probe_result, r?.claude_version, r?.name_envelope]).toEqual(["pass", "2.1.317", 0]);
  });

  it("a new process (new pid) is probed afresh: unreadable binary → fail; readable → its own version", async () => {
    const s = await passedThen();
    s.unreadable();
    expect((await register(s.f, { execPath: null, claudePid: 4343 }))?.probe_result).toBe("fail:exec_path_unresolved");
    const t = await passedThen();
    t.probeIs({ version: "2.1.400", literal: true, replacedSinceStart: false });
    expect(await register(t.f, { execPath: null, claudePid: 4343 })).toMatchObject({ probe_result: "pass", claude_version: "2.1.400" });
  });

  it("a recycled pid (the process started after the earlier registration) is not the process that passed", async () => {
    const s = await passedThen();
    s.unreadable();
    s.startedIs(new Date(s.f.clock.t - 60_000));
    expect((await register(s.f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it.each([["unknown start time", null], ["start time lookup failed", "throw"]] as const)("%s → nothing is kept", async (_label, started) => {
    const s = await passedThen();
    s.unreadable();
    s.startedIs(started as never);
    expect((await register(s.f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it("without a start-time lookup wired, nothing is kept", async () => {
    const s = await passedThen({ processStartedAt: undefined });
    s.unreadable();
    expect((await register(s.f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it.each([
    ["another generation", { generation: "gen-2" }],
    ["another session name", { sessionName: "other@rig1" }],
  ] as const)("%s → a different launch, nothing is kept", async (_label, over) => {
    const s = await passedThen();
    s.unreadable();
    expect((await register(s.f, { execPath: null, ...over }))?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it("another socket → nothing is kept", async () => {
    const s = await passedThen();
    s.unreadable();
    const r = await s.f.inbox.registerEndpoint({ nodeId: "node-a", sessionName: SEAT, generation: "gen-1", socketPath: "/tmp/cc-socks/9999.sock",
      transcriptPath: TRANSCRIPT, claudePid: 4242, execPath: null });
    expect(r?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it.each([
    ["inject_format_absent", { version: "2.1.316", literal: false, replacedSinceStart: false }, "fail:inject_format_absent"],
    ["binary_replaced_since_start", { version: "2.1.316", literal: true, replacedSinceStart: true }, "fail:binary_replaced_since_start"],
  ] as const)("an earlier %s (version and path known) is never turned into a pass by a later unreadable binary", async (_label, probe, earlier) => {
    let resolves: string | null = "/opt/claude/bin/claude.exe";
    const f = make({ resolveExecPath: async () => resolves, probeBinary: async () => probe, processStartedAt: async () => new Date(f.clock.t - HOUR) });
    expect((await register(f, { execPath: null }))?.probe_result).toBe(earlier);
    f.clock.t += HOUR;
    resolves = null;
    expect((await register(f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
  });

  it("an earlier failure is never turned into a pass by a later failure", async () => {
    const f = make({ resolveExecPath: async () => null, processStartedAt: async () => new Date(f.clock.t - HOUR) });
    expect((await register(f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
    f.clock.t += HOUR;
    expect((await register(f, { execPath: null }))?.probe_result).toBe("fail:exec_path_unresolved");
  });
});

describe("ncomms-3d: the sender-name envelope", () => {
  it.each([
    ["the probe passes and finds the parser", { version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: true }, 1],
    ["the parser literal is absent", { version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: false }, 0],
    ["an older probe result without the field", { version: "2.1.314", literal: true, replacedSinceStart: false }, 0],
    ["the parser is present but the probe fails", { version: "2.1.314", literal: false, replacedSinceStart: false, nameEnvelope: true }, 0],
  ] as const)("register: %s → name_envelope %s", async (_label, probe, expected) => {
    const f = make();
    f.probe = { ...probe };
    expect((await register(f))?.name_envelope).toBe(expected);
    expect(f.inbox.endpointFor("node-a")?.name_envelope).toBe(expected);
  });

  it("a re-registration takes the new probe's answer (a seat relaunched on a binary without the parser)", async () => {
    const f = make();
    f.probe = { version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: true };
    await register(f);
    f.probe = { version: "2.1.320", literal: true, replacedSinceStart: false, nameEnvelope: false };
    await register(f, { generation: "gen-2" });
    expect(f.inbox.endpointFor("node-a")?.name_envelope).toBe(0);
  });

  async function deliverWith(probe: Fake["probe"], text: string) {
    const f = make();
    f.probe = probe;
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    const res = await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text, endpoint: e.endpoint });
    const id = res.outboxIds[0]!;
    return { f, id, content: contentOf(f.writes[0]!), marker: nativeMarker(id, row(f.db, id)!.nonce!) };
  }

  it("an endpoint that parses it: the content is wrapped with the sender's seat name; the marker is inside and is acked", async () => {
    const { f, id, content, marker } = await deliverWith({ version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: true }, "hello");
    expect(content).toBe(`<cross-session-message from-name="${SENDER}">\nhello\n\n${marker}\n</cross-session-message>`);
    const nonce = row(f.db, id)!.nonce!;
    expect(parseNativeMarkers(content)).toEqual([{ id, nonce }]);
    expect(f.inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: parseNativeMarkers(content) }).acked).toEqual([id]);
  });

  it("an endpoint that does not parse it: plain content, as before", async () => {
    const { content, marker } = await deliverWith({ version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: false }, "hello");
    expect(content).toBe(`hello\n\n${marker}`);
  });

  it("a body holding a closing-tag lookalike goes out plain even to an endpoint that parses the envelope", async () => {
    const text = "see </cross-session-message> here";
    const { content, marker } = await deliverWith({ version: "2.1.314", literal: true, replacedSinceStart: false, nameEnvelope: true }, text);
    expect(content).toBe(`${text}\n\n${marker}`);
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
    expect(r.fallbacks).toEqual([{ outboxId: id, outboxIds: [id], sessionName: SEAT, senderSession: SENDER, body: "hello", auditPointer: null, wake: false }]);
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

// OF-181 N2: which binary path is probed when the pid and the relay both offer one.
describe("OF-181 N2: the pid-derived binary beats the relay's", () => {
  const passing = { version: "2.1.314", literal: true, replacedSinceStart: false };
  it("both offered → the path found from the pid is probed and recorded, never the relay's", async () => {
    const probed: string[] = [];
    const f = make({ resolveExecPath: async () => "/from-pid/claude", probeBinary: async (p) => { probed.push(p); return passing; } });
    const r = await register(f, { execPath: "/from-relay/claude" });
    expect([r?.exec_path, probed]).toEqual(["/from-pid/claude", ["/from-pid/claude"]]);
  });
  it("the pid gives none (null) → the relay's path is the fallback", async () => {
    const probed: string[] = [];
    const f = make({ resolveExecPath: async () => null, probeBinary: async (p) => { probed.push(p); return passing; } });
    const r = await register(f, { execPath: "/from-relay/claude" });
    expect([r?.exec_path, probed]).toEqual(["/from-relay/claude", ["/from-relay/claude"]]);
  });
  it("the pid lookup throws → the relay's path is the fallback", async () => {
    const probed: string[] = [];
    const f = make({ resolveExecPath: async () => { throw new Error("lsof failed"); }, probeBinary: async (p) => { probed.push(p); return passing; } });
    const r = await register(f, { execPath: "/from-relay/claude" });
    expect([r?.exec_path, probed]).toEqual(["/from-relay/claude", ["/from-relay/claude"]]);
  });
});

// OF-181 N3: the ack window's default.
describe("OF-181 N3: the default ack window is 1.5 s", () => {
  it("with no ackWindowMs given, a send waits for its ack 1500 ms (the CLI request is 5 s)", async () => {
    const waits: number[] = [];
    const f = make({ ackWindowMs: undefined, sleep: async (ms) => { waits.push(ms); } });
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    expect(waits).toEqual([1_500]);
  });
});

// OF-180 N7: a wake group that fails over is resent once, as the text it was written as.
describe("OF-180 N7: a wake group's tmux fallback is one message", () => {
  type Eligible = Extract<Awaited<ReturnType<ClaudeNativeInbox["eligibility"]>>, { ok: true }>;
  async function wakeGroup(f: Fake, names: string[], sender: string, eligibleFor: Eligible) {
    const ids = names.map((s) => f.outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}${s}`, senderSession: sender, destinationSession: SEAT, body: s }).outboxId);
    for (const id of ids) f.outbox.claimForDelivery(id);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: sender, text: names.join("\n"), endpoint: eligibleFor.endpoint, committedOutboxIds: ids });
    return ids;
  }
  async function eligibleFor(f: Fake, sender: string): Promise<Eligible> {
    const e = await f.inbox.eligibility(SEAT, sender);
    if (!e.ok) throw new Error(e.reason);
    return e;
  }
  it("two rows written together are one fallback (their bodies, one per line); another group and a plain send stay separate", async () => {
    const f = make(); await register(f);
    const plain = (await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "plain", endpoint: (await eligibleFor(f, SENDER)).endpoint })).outboxIds[0]!;
    const g1 = await wakeGroup(f, ["w1", "w2"], "queue@system", await eligibleFor(f, "queue@system"));
    f.clock.t += 2_000;
    const g2 = await wakeGroup(f, ["w3"], "queue@system", await eligibleFor(f, "queue@system"));
    recordActivity(f.db, "Stop", new Date(f.clock.t + 3_000).toISOString());
    f.clock.t += 130_000;
    const fallbacks = f.inbox.sweep().fallbacks.sort((a, b) => a.outboxId.localeCompare(b.outboxId));
    expect(fallbacks).toEqual([
      { outboxId: plain, outboxIds: [plain], sessionName: SEAT, senderSession: SENDER, body: "plain", auditPointer: null, wake: false },
      { outboxId: g1[0], outboxIds: g1, sessionName: SEAT, senderSession: "queue@system", body: "w1\nw2", auditPointer: null, wake: true },
      { outboxId: g2[0], outboxIds: g2, sessionName: SEAT, senderSession: "queue@system", body: "w3", auditPointer: null, wake: true },
    ]);
    for (const id of [plain, ...g1, ...g2]) expect(row(f.db, id)).toMatchObject({ state: "failed", evidence: "native_unconfirmed" });
  });
  // OF-190: only wake rows merge. Two ordinary sends to one seat from one sender with one write time (same clock tick)
  // are two messages; merging them would resend them as one text and settle both rows on one send.
  it("two plain rows with the same destination, sender and write time stay two fallbacks", async () => {
    const f = make(); await register(f);
    const e = await eligibleFor(f, SENDER);
    const one = (await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "first", endpoint: e.endpoint })).outboxIds[0]!;
    const two = (await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "second", endpoint: e.endpoint })).outboxIds[0]!;
    const writtenAt = (id: string) => (f.db.prepare("SELECT native_written_at AS at FROM outbox_entries WHERE outbox_id = ?").get(id) as { at: string | null }).at;
    expect(writtenAt(one)).not.toBeNull();
    expect(writtenAt(one)).toBe(writtenAt(two)); // the premise: one write time
    recordActivity(f.db, "Stop", new Date(f.clock.t + 3_000).toISOString());
    f.clock.t += 130_000;
    const fallbacks = f.inbox.sweep().fallbacks.sort((a, b) => a.body.localeCompare(b.body));
    expect(fallbacks.map((x) => [x.outboxIds.length, x.body, x.wake])).toEqual([[1, "first", false], [1, "second", false]]);
    expect(new Set(fallbacks.flatMap((x) => x.outboxIds))).toEqual(new Set([one, two]));
  });
  // OF-190: the resend text must read in the order the wake was written (staging order), not in outbox-id string order,
  // where "blocker-10" sorts before "blocker-9". A resent wake that lists a later blocker first misleads the seat.
  it("a wake group resent over tmux reads in the order it was written, not in id order (blocker-9 before blocker-10)", async () => {
    const f = make(); await register(f);
    const e = await eligibleFor(f, "queue@system");
    const staged = ["blocker-9", "blocker-10", "blocker-11"]; // staged (and written) in this order
    const ids = staged.map((s) => f.outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}${s}`, senderSession: "queue@system", destinationSession: SEAT, body: s }).outboxId);
    for (const id of ids) f.outbox.claimForDelivery(id);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: "queue@system", text: staged.join("\n"), endpoint: e.endpoint, committedOutboxIds: ids });
    recordActivity(f.db, "Stop", new Date(f.clock.t + 3_000).toISOString());
    f.clock.t += 130_000;
    const fallbacks = f.inbox.sweep().fallbacks;
    expect(fallbacks.map((x) => [x.outboxIds, x.body])).toEqual([[ids, "blocker-9\nblocker-10\nblocker-11"]]);
  });
  // OF-190 (unsettled claim, now measured): two wake groups to one seat from one sender written in the same millisecond
  // carry the same (destination, sender, write time). Nothing stored tells the groups apart, so they come back as ONE
  // fallback holding both texts in write order, and every row of both settles on that one send. Nothing is lost or
  // reordered across groups; the two sends become one message. Telling them apart needs a stored group id (a migration).
  it("two wake groups written in the same millisecond come back as one fallback, both texts in write order, every row settled", async () => {
    const f = make(); await register(f);
    const e = await eligibleFor(f, "queue@system");
    const g1 = await wakeGroup(f, ["w1", "w2"], "queue@system", e);
    const g2 = await wakeGroup(f, ["w3"], "queue@system", e); // clock not advanced: the same write time
    recordActivity(f.db, "Stop", new Date(f.clock.t + 3_000).toISOString());
    f.clock.t += 130_000;
    const fallbacks = f.inbox.sweep().fallbacks;
    expect(fallbacks.map((x) => [x.outboxIds, x.body])).toEqual([[[...g1, ...g2], "w1\nw2\nw3"]]);
  });
  it("wake rows of one write time but another sender are not merged", async () => {
    const f = make(); await register(f);
    const a = await wakeGroup(f, ["a1"], "queue@system", await eligibleFor(f, "queue@system"));
    const b = await wakeGroup(f, ["b1"], "watchdog@system", await eligibleFor(f, "watchdog@system"));
    recordActivity(f.db, "Stop", new Date(f.clock.t + 3_000).toISOString());
    f.clock.t += 130_000;
    expect(f.inbox.sweep().fallbacks.map((x) => x.outboxIds)).toEqual([a, b]);
  });
  it("wake rows of one write time and sender for different seats are not merged", async () => {
    const f = make(); await register(f);
    const e = await eligibleFor(f, "queue@system");
    const mk = (id: string, dest: string) => f.outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}${id}`, senderSession: "queue@system", destinationSession: dest, body: id }).outboxId;
    const a = mk("a1", SEAT); const b = mk("b1", SENDER); // SENDER is a second running claude seat (node-b)
    f.outbox.claimForDelivery(a); f.outbox.claimForDelivery(b);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: "queue@system", text: "a1", endpoint: e.endpoint, committedOutboxIds: [a] });
    await f.inbox.deliver({ sessionName: SENDER, senderSession: "queue@system", text: "b1", endpoint: e.endpoint, committedOutboxIds: [b] });
    const stop = new Date(f.clock.t + 3_000).toISOString();
    for (const node of ["node-a", "node-b"]) {
      f.db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', ?, 'agent.activity', ?)")
        .run(node, JSON.stringify({ type: "agent.activity", activity: { rawEvent: "Stop", eventAt: stop, state: "idle", evidenceSource: "runtime_hook" } }));
    }
    f.clock.t += 130_000;
    expect(f.inbox.sweep().fallbacks.map((x) => [x.sessionName, x.outboxIds])).toEqual([[SEAT, [a]], [SENDER, [b]]]);
  });
});

// OF-180 N2: a native row that sits unacked with no boundary is named once (a managed override would look like this).
describe("OF-180 N2: a stalled native row is named once", () => {
  async function stalled(over?: Partial<NativeInboxDeps>) {
    const calls: Array<{ id: string; ageMs: number }> = [];
    const f = make({ onStalled: (r, ageMs) => { calls.push({ id: r.outboxId, ageMs }); }, ...over });
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    const id = (await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint })).outboxIds[0]!;
    return { f, calls, id };
  }
  it("not before the deadline; once past it with no boundary, with the row's age; not again on the next sweep", async () => {
    const { f, calls, id } = await stalled();
    f.clock.t += 60_000; f.inbox.sweep();
    expect(calls).toEqual([]);
    f.clock.t += 70_000; f.inbox.sweep(); f.inbox.sweep();
    expect(calls).toEqual([{ id, ageMs: 130_000 }]);
    expect(row(f.db, id)?.state).toBe("sending"); // naming it settles nothing
  });
  it("not when the seat has had a boundary (that row fails over instead), nor once the hard deadline settles it", async () => {
    const a = await stalled();
    recordActivity(a.f.db, "Stop", new Date(a.f.clock.t + 1_000).toISOString());
    a.f.clock.t += 130_000; a.f.inbox.sweep();
    expect(a.calls).toEqual([]);
    const b = await stalled();
    b.f.clock.t += 1_800_000; b.f.inbox.sweep();
    expect(b.calls).toEqual([]);
  });
  it("a callback that throws does not stop the sweep", async () => {
    const f = make({ onStalled: () => { throw new Error("log failed"); } });
    await register(f);
    const e = await f.inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    await f.inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hello", endpoint: e.endpoint });
    f.clock.t += 130_000;
    expect(() => f.inbox.sweep()).not.toThrow();
  });
});
