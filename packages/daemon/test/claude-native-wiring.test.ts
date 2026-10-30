// Native comms step 3: the wiring around ClaudeNativeInbox, with fakes or scratch sockets only. Covers the outbox guards
// (finalize and startup reconciliation leave native rows to the ack and the sweeper), the launch-flag merge, the two
// activity routes, the relay payloads, the transport's native branch, the wake drain's native-pending result, and the
// OS adapters (a real Unix socket in a temp dir; a chunked file search).
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, WAKE_INTENT_PREFIX, type OutboxEntry } from "../src/domain/outbox-handler.js";
import { createNativeSettlementHandler, nativeFallbackOutcome, recordNativeFallback } from "../src/domain/native-inbox-settlement.js";
import { presentedNudgeResult } from "../src/domain/queue-repository.js";
import { ClaudeNativeInbox, ACCEPT_SETTING_ARGV_FRAGMENT, type ProcessRow } from "../src/domain/claude-native-inbox.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { transportRoutes } from "../src/routes/transport.js";
import { operationalLaunchArgs, withNativeInboxSettings } from "../src/adapters/kernel-authority.js";
import { fileIncludes, parseLsofTxtPath, resolveClaudeExecPath, writeSocketLines } from "../src/adapters/native-inbox-os.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildNativeEndpointPayload: (p: Record<string, unknown>, env: Record<string, string>) => Record<string, unknown> | null;
  buildNativeAckPayload: (p: Record<string, unknown>, env: Record<string, string>) => { markers: Array<{ id: string; nonce: string }> } | null;
};

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const SEAT = "dev-impl@rig1";
const SENDER = "dev-lead@rig1";

function db(): Database.Database {
  const d = createDb();
  migrate(d, ALL_MIGRATIONS);
  cleanups.push(() => d.close());
  d.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  for (const [node, logical, session] of [["node-a", "dev.impl", SEAT], ["node-b", "dev.lead", SENDER]] as const) {
    d.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-1', ?, 'claude-code')").run(node, logical);
    d.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(`s-${node}`, node, session);
    d.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES (?, ?, 'tmux', ?)").run(`b-${node}`, node, session);
  }
  return d;
}

function inboxFor(d: Database.Database, opts?: { enabled?: boolean; write?: "none" | "all" | "partial"; onWrite?: (content: string) => void }) {
  const procs: ProcessRow[] = [{ pid: 100, ppid: 1, args: "-zsh" }, { pid: 4242, ppid: 100, args: `claude --settings {${ACCEPT_SETTING_ARGV_FRAGMENT}}` }];
  const outbox = new OutboxHandler(d);
  const inbox = new ClaudeNativeInbox({
    db: d, outbox, enabled: () => opts?.enabled ?? true, panePid: async () => 100, listProcesses: async () => procs,
    socketExists: () => true,
    write: async (_p, lines) => { opts?.onWrite?.((lines[0] as { message: { content: string } }).message.content); return opts?.write ?? "all"; },
    fileIncludes: () => false, probeBinary: async () => ({ version: "2.1.314", literal: true, replacedSinceStart: false }),
    liveGeneration: () => null, ackWindowMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return { inbox, outbox };
}

async function registered(d: Database.Database, inbox: ClaudeNativeInbox) {
  await inbox.registerEndpoint({ nodeId: "node-a", sessionName: SEAT, generation: null, socketPath: "/tmp/cc-socks/4242.sock",
    transcriptPath: "/t.jsonl", claudePid: 4242, execPath: "/bin/claude" });
}

describe("outbox guards: native rows are settled only by their ack or the sweeper", () => {
  it("finalizeDelivery does not move a native row awaiting its ack", () => {
    const d = db(); const outbox = new OutboxHandler(d);
    const id = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}n1`, senderSession: "queue@system", destinationSession: SEAT, body: "w" }).outboxId;
    outbox.claimForDelivery(id);
    expect(outbox.claimNative(id, "a".repeat(24), new Date().toISOString())).toBe(true);
    outbox.finalizeDelivery(id, "indeterminate", { path: "tmux", evidence: "render_unconfirmed" });
    expect(outbox.getById(id)).toMatchObject({ deliveryState: "sending", deliveryPath: "native", ackEvidence: "native_written" });
  });

  it("startup reconciliation leaves a native wake row to the sweeper, and still reconciles a tmux one", () => {
    const d = db(); const outbox = new OutboxHandler(d);
    const native = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}n2`, senderSession: "queue@system", destinationSession: SEAT, body: "w" }).outboxId;
    const tmux = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}t2`, senderSession: "queue@system", destinationSession: SEAT, body: "w" }).outboxId;
    outbox.claimForDelivery(native); outbox.claimForDelivery(tmux);
    outbox.claimNative(native, "b".repeat(24), new Date().toISOString());
    expect(outbox.reconcileAbandonedSending(WAKE_INTENT_PREFIX)).toBe(1);
    expect(outbox.getById(native)?.deliveryState).toBe("sending");
    expect(outbox.getById(tmux)?.deliveryState).toBe("indeterminate");
  });

  it("claimNative refuses a settled row and a row already native", () => {
    const d = db(); const outbox = new OutboxHandler(d);
    const done = outbox.record({ senderSession: SENDER, destinationSession: SEAT, body: "x" }).outboxId;
    outbox.markDelivered(done);
    expect(outbox.claimNative(done, "c".repeat(24), new Date().toISOString())).toBe(false);
    const fresh = outbox.record({ senderSession: SENDER, destinationSession: SEAT, body: "y" }).outboxId;
    expect(outbox.claimNative(fresh, "d".repeat(24), new Date().toISOString())).toBe(true);
    expect(outbox.claimNative(fresh, "e".repeat(24), new Date().toISOString())).toBe(false);
  });
});

describe("launch flag: the inbox setting merged into the ONE --settings (criterion 1)", () => {
  it("merges into an existing --settings JSON without changing its other keys", () => {
    const args = ["--settings", '{"skipDangerousModePermissionPrompt":true}', "--model", "x"];
    expect(withNativeInboxSettings(args)).toEqual(["--settings", '{"skipDangerousModePermissionPrompt":true,"crossSessionInbound":"accept"}', "--model", "x"]);
  });

  it("adds a --settings with only that key when there is none", () => {
    expect(withNativeInboxSettings(["--model", "x"])).toEqual(["--model", "x", "--settings", '{"crossSessionInbound":"accept"}']);
  });

  it("operationalLaunchArgs adds it only for Claude, only when enabled, and never a second --settings", () => {
    const team = { teamPermissionDefault: true } as const;
    const off = operationalLaunchArgs("claude-code", { ...team, nativeInbox: false });
    const on = operationalLaunchArgs("claude-code", { ...team, nativeInbox: true });
    expect(off.filter((a) => a === "--settings")).toHaveLength(1);
    expect(on.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(on[on.indexOf("--settings") + 1]!)).toMatchObject({ crossSessionInbound: "accept", permissions: expect.any(Object) });
    expect(JSON.parse(off[off.indexOf("--settings") + 1]!).crossSessionInbound).toBeUndefined();
    expect(operationalLaunchArgs("codex", { nativeInbox: true }).join(" ")).not.toContain("crossSessionInbound");
    expect(operationalLaunchArgs("claude-code", { nativeInbox: true })).toEqual(["--settings", '{"crossSessionInbound":"accept"}']);
  });
});

describe("routes: /api/activity/native-endpoint and /native-ack", () => {
  function app(d: Database.Database, inbox: ClaudeNativeInbox) {
    const store = new AgentActivityStore({ db: d, eventBus: new EventBus(d) });
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, store as never);
      c.set("activityHookToken" as never, "tok" as never);
      c.set("claudeNativeInbox" as never, inbox as never);
      await next();
    });
    a.route("/api/activity", activityRoutes);
    return a;
  }
  const post = (a: Hono, path: string, body: unknown, token = "tok") =>
    a.request(`/api/activity/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it("both refuse without the hook token", async () => {
    const d = db(); const { inbox } = inboxFor(d);
    expect((await post(app(d, inbox), "native-endpoint", { sessionName: SEAT, socketPath: "/s" }, "bad")).status).toBe(401);
    expect((await post(app(d, inbox), "native-ack", { sessionName: SEAT, markers: [] }, "bad")).status).toBe(401);
  });

  it("native-endpoint registers the seat's socket and records the launch probe", async () => {
    const d = db(); const { inbox } = inboxFor(d);
    const res = await post(app(d, inbox), "native-endpoint", { sessionName: SEAT, socketPath: "/tmp/cc-socks/4242.sock", transcriptPath: "/t", claudePid: 4242, execPath: "/bin/claude" });
    expect(await res.json()).toEqual({ ok: true, probe: "pass", version: "2.1.314" });
    expect(inbox.endpointFor("node-a")).toMatchObject({ socket_path: "/tmp/cc-socks/4242.sock", claude_pid: 4242, probe_result: "pass" });
  });

  it("native-ack acks a pending row and answers block for a duplicate", async () => {
    const d = db();
    let content = "";
    const { inbox, outbox } = inboxFor(d, { onWrite: (c) => { content = c; } });
    await registered(d, inbox);
    const e = await inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    const sent = await inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hi", endpoint: e.endpoint });
    const markers = relay.buildNativeAckPayload({ hook_event_name: "UserPromptSubmit", prompt: content }, { OPENRIG_RUNTIME: "claude-code", OPENRIG_SESSION_NAME: SEAT })!.markers;
    const a = app(d, inbox);
    expect(await (await post(a, "native-ack", { sessionName: SEAT, markers })).json()).toEqual({ ok: true, acked: sent.outboxIds, block: false });
    expect(outbox.getById(sent.outboxIds[0]!)?.deliveryState).toBe("delivered");
    expect(await (await post(a, "native-ack", { sessionName: SEAT, markers })).json()).toEqual({ ok: true, acked: [], block: true });
  });

  it("native-ack passes the prompt id: the same prompt's hook running twice is acked twice, never blocked", async () => {
    const d = db();
    let content = "";
    const { inbox } = inboxFor(d, { onWrite: (c) => { content = c; } });
    await registered(d, inbox);
    const e = await inbox.eligibility(SEAT, SENDER);
    if (!e.ok) throw new Error(e.reason);
    const sent = await inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hi", endpoint: e.endpoint });
    const markers = relay.buildNativeAckPayload({ hook_event_name: "UserPromptSubmit", prompt: content }, { OPENRIG_RUNTIME: "claude-code", OPENRIG_SESSION_NAME: SEAT })!.markers;
    const a = app(d, inbox);
    for (let i = 0; i < 2; i++) {
      expect(await (await post(a, "native-ack", { sessionName: SEAT, markers, promptId: "prompt-7" })).json()).toEqual({ ok: true, acked: sent.outboxIds, block: false });
    }
  });
});

describe("relay: the native payloads", () => {
  const env = { OPENRIG_RUNTIME: "claude-code", OPENRIG_SESSION_NAME: SEAT, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/9.sock", CLAUDE_PID: "9",
    CLAUDE_CODE_EXECPATH: "/bin/claude", CLAUDE_CODE_MESSAGING_TOKEN: "SECRET-TOKEN-VALUE" };

  it("SessionStart reports socket, pid, binary and transcript, and never the messaging token", () => {
    const p = relay.buildNativeEndpointPayload({ hook_event_name: "SessionStart", transcript_path: "/t.jsonl" }, env);
    expect(p).toMatchObject({ sessionName: SEAT, socketPath: "/tmp/cc-socks/9.sock", claudePid: 9, execPath: "/bin/claude", transcriptPath: "/t.jsonl" });
    expect(JSON.stringify(p)).not.toContain("SECRET-TOKEN-VALUE");
  });

  it("only Claude seats with a socket, and only SessionStart, produce an endpoint", () => {
    expect(relay.buildNativeEndpointPayload({ hook_event_name: "SessionStart" }, { ...env, OPENRIG_RUNTIME: "codex" })).toBeNull();
    expect(relay.buildNativeEndpointPayload({ hook_event_name: "SessionStart" }, { ...env, CLAUDE_CODE_MESSAGING_SOCKET: "" })).toBeNull();
    expect(relay.buildNativeEndpointPayload({ hook_event_name: "Stop" }, env)).toBeNull();
  });

  it("UserPromptSubmit reports every marker; a prompt without one reports nothing", () => {
    const prompt = "a\n[openrig-msg wake-intent-1:0123456789abcdef01234567]\n[openrig-msg wake-intent-2:89abcdef0123456789abcdef]";
    expect(relay.buildNativeAckPayload({ hook_event_name: "UserPromptSubmit", prompt }, env)?.markers.map((m) => m.id)).toEqual(["wake-intent-1", "wake-intent-2"]);
    expect(relay.buildNativeAckPayload({ hook_event_name: "UserPromptSubmit", prompt: "plain" }, env)).toBeNull();
  });
});

describe("transport: the native branch", () => {
  function transport(d: Database.Database, inbox: ClaudeNativeInbox) {
    // A real TmuxAdapter over a recording exec: every tmux command the transport issues is captured, none runs.
    const commands: string[] = [];
    const exec = async (cmd: string): Promise<string> => { commands.push(cmd); return ""; };
    const tmux = new TmuxAdapter(exec);
    const t = new SessionTransport({ db: d, rigRepo: new RigRepository(d), sessionRegistry: new SessionRegistry(d), tmuxAdapter: tmux, nativeInbox: inbox });
    const typed = () => commands.filter((c) => /send-keys|paste-buffer|load-buffer|set-buffer/.test(c));
    return { t, typed };
  }

  it("an eligible agent message goes native: nothing is typed into the pane", async () => {
    const d = db(); const { inbox } = inboxFor(d); await registered(d, inbox);
    const { t, typed } = transport(d, inbox);
    const r = await t.send(SEAT, "hello", { actorSession: SENDER });
    expect(r).toMatchObject({ ok: true, path: "native", outcome: "rendered-unconfirmed", verified: false });
    expect(typed()).toEqual([]);
  });

  it("forceTmux (the sweeper's fallback) never takes the native branch", async () => {
    const d = db(); const { inbox } = inboxFor(d); await registered(d, inbox);
    const { t } = transport(d, inbox);
    const r = await t.send(SEAT, "hello", { actorSession: SENDER, forceTmux: true });
    expect(r.path).toBeUndefined();
  });

  it("a human sender stays on tmux (criterion 5)", async () => {
    const d = db(); const { inbox } = inboxFor(d); await registered(d, inbox);
    const { t } = transport(d, inbox);
    const r = await t.send(SEAT, "hello", { actorSession: "human@kernel" });
    expect(r.path).toBeUndefined();
  });

  it("nothing written falls through to tmux in the same send", async () => {
    const d = db(); const { inbox } = inboxFor(d, { write: "none" }); await registered(d, inbox);
    const { t } = transport(d, inbox);
    const r = await t.send(SEAT, "hello", { actorSession: SENDER });
    expect(r.path).toBeUndefined();
  });
});

describe("send route: a native send keeps its one row", () => {
  it("the route does not record a second outbox row for a native send (the native row was claimed before the write)", async () => {
    const d = db(); const { inbox } = inboxFor(d); await registered(d, inbox);
    const exec = async (_cmd: string): Promise<string> => "";
    const t = new SessionTransport({ db: d, rigRepo: new RigRepository(d), sessionRegistry: new SessionRegistry(d), tmuxAdapter: new TmuxAdapter(exec), nativeInbox: inbox });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, t as never); c.set("outboxHandler" as never, new OutboxHandler(d) as never); await next(); });
    app.route("/api/transport", transportRoutes());
    const res = await app.request("/api/transport/send", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": SENDER },
      body: JSON.stringify({ session: SEAT, text: "hello" }) });
    const body = (await res.json()) as { path?: string; outboxIds?: string[] };
    expect(body.path).toBe("native"); // positive control: the native branch was taken
    const rows = d.prepare("SELECT outbox_id AS id, delivery_path AS path FROM outbox_entries").all();
    expect(rows).toEqual([{ id: body.outboxIds![0], path: "native" }]);
  });
});

describe("wake drain: a native wake is left to the ack or the sweeper", () => {
  it("native-pending rows stay sending, native / native_written; the nudge result says so", async () => {
    const d = db(); const outbox = new OutboxHandler(d);
    const repo = new QueueRepository(d, new EventBus(d), { validateRig: () => true });
    repo.attachOutbox(outbox);
    const source = await repo.create({ nudge: false, sourceSession: "planner@rig1", destinationSession: "driver@rig1", body: "x" });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig1", toSession: SEAT, body: "y" });
    const intent = outbox.listForSender("driver@rig1").find((e) => e.outboxId.startsWith(WAKE_INTENT_PREFIX))!;
    const native: QueueNudgeTransport = {
      async send(_s, _t, opts) {
        for (const id of opts?.committedOutboxIds ?? []) outbox.claimNative(id, "f".repeat(24), new Date().toISOString());
        return { ok: true, verified: false, path: "native", outcome: "rendered-unconfirmed" };
      },
    };
    repo.attachTransport(native);
    await repo.drainPendingWakeIntents();
    expect(outbox.getById(intent.outboxId)).toMatchObject({ deliveryState: "sending", deliveryPath: "native", ackEvidence: "native_written" });
    expect(repo.getById(created.qitemId)?.lastNudgeResult).toBe("native-ack-pending");
  });
});

describe("OS adapters", () => {
  function scratchSocket(onData: (s: string) => void): Promise<{ path: string; server: Server }> {
    const dir = mkdtempSync(join(tmpdir(), "nc3-sock-"));
    const path = join(dir, "inbox.sock");
    const server = createServer((c) => { let buf = ""; c.on("data", (b) => { buf += b.toString(); }); c.on("end", () => onData(buf)); });
    cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
    return new Promise((r) => server.listen(path, () => r({ path, server })));
  }

  it("writeSocketLines writes one JSON object per line to a real socket and reports all", async () => {
    let got = "";
    const done = new Promise<void>((r) => { void scratchSocket((s) => { got = s; r(); }).then(async ({ path }) => {
      expect(await writeSocketLines(path, [{ type: "user", message: { role: "user", content: "hi\n\n[openrig-msg x:0123456789abcdef01234567]" } }])).toBe("all");
    }); });
    await done;
    expect(got.endsWith("\n")).toBe(true);
    expect(JSON.parse(got.trim())).toEqual({ type: "user", message: { role: "user", content: "hi\n\n[openrig-msg x:0123456789abcdef01234567]" } });
  });

  it("writeSocketLines reports none when no socket answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc3-nosock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(await writeSocketLines(join(dir, "absent.sock"), [{ a: 1 }])).toBe("none");
  });

  it("fileIncludes finds a needle across a chunk edge and says false for an unreadable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nc3-file-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "x".repeat(10) + "NEEDLE" + "y".repeat(10));
    for (let chunk = 3; chunk <= 30; chunk++) expect(fileIncludes(p, "NEEDLE", chunk)).toBe(true);
    expect(fileIncludes(p, "ABSENT", 4)).toBe(false);
    expect(fileIncludes(join(dir, "missing"), "NEEDLE")).toBe(false);
  });
});

// Review F2, driven through the real SessionTransport: a repeat of a fixed delivery id while the first native write
// awaits its ack is coalesced: one socket write, nothing typed into the pane.
describe("review F2 through SessionTransport: a repeated delivery id while pending", () => {
  it("the second send returns the pending native row, writes nothing, types nothing", async () => {
    const d = db();
    let writes = 0;
    const { inbox } = inboxFor(d, { onWrite: () => { writes++; } });
    await registered(d, inbox);
    const commands: string[] = [];
    const tmux = new TmuxAdapter(async (cmd: string) => { commands.push(cmd); return ""; });
    const t = new SessionTransport({ db: d, rigRepo: new RigRepository(d), sessionRegistry: new SessionRegistry(d), tmuxAdapter: tmux, nativeInbox: inbox });
    const first = await t.send(SEAT, "wake", { actorSession: "watchdog@system", deliveryId: "guard-watchdog-occ1" });
    const second = await t.send(SEAT, "wake", { actorSession: "watchdog@system", deliveryId: "guard-watchdog-occ1" });
    expect(first).toMatchObject({ ok: true, path: "native", outboxIds: ["guard-watchdog-occ1"] });
    expect(second).toMatchObject({ ok: true, path: "native", sent: false, outboxIds: ["guard-watchdog-occ1"] });
    expect(writes).toBe(1);
    expect(commands.filter((c) => /send-keys|paste-buffer|load-buffer|set-buffer/.test(c))).toEqual([]);
  });
});

describe("settlement: the queue write-back and the sender notice (review F3, R3)", () => {
  const row = (over: Partial<OutboxEntry>): OutboxEntry => ({ outboxId: "o1", senderSession: SENDER, destinationSession: SEAT, body: "b", tags: null,
    urgency: "routine", tsDispatched: "t", deliveryState: "sending", deliveredAt: null, auditPointer: null, nativeWrittenAt: "2026-10-30T12:00:00.000Z", ...over });
  function deps() {
    const recorded: Array<[string, string]> = []; const notices: Array<[string, string]> = [];
    return { recorded, notices, d: { recordNudgeAttempt: (q: string, r: string) => { recorded.push([q, r]); }, sendNotice: async (to: string, text: string) => { notices.push([to, text]); },
      isAgentSeat: (s: string) => s === SENDER } };
  }

  it("delivered: the qitem records verified; no notice", () => {
    const x = deps();
    createNativeSettlementHandler(x.d)(row({ auditPointer: "qitem-1" }), { kind: "delivered", evidence: "native_hook_delivered", detail: null });
    expect([x.recorded, x.notices]).toEqual([[["qitem-1", "verified"]], []]);
  });

  it("unconfirmed: the qitem records an indeterminate: result the ladder escalates, and an agent sender is told", () => {
    const x = deps();
    createNativeSettlementHandler(x.d)(row({ auditPointer: "qitem-1" }), { kind: "unconfirmed", evidence: "native_unconfirmed", detail: "no_boundary_by_hard_deadline" });
    expect(x.recorded).toEqual([["qitem-1", "indeterminate:native_unconfirmed:no_boundary_by_hard_deadline"]]);
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]![0]).toBe(SENDER);
    expect(x.notices[0]![1]).toMatch(/UNCONFIRMED \(no_boundary_by_hard_deadline\).*not re-sent.*It may still arrive\. Before resending, check the seat \(rig capture dev-impl@rig1\), so it is not sent twice\./);
    expect(x.notices[0]![1]).not.toMatch(/send it again/);
  });

  it("the notice is stripped like any system text (OF-169): a control character in a reason never reaches the pane", () => {
    const x = deps();
    createNativeSettlementHandler(x.d)(row({}), { kind: "unconfirmed", evidence: "native_unconfirmed", detail: "bad\u001b[201~reason\u0007" });
    expect(x.notices[0]![1]).toContain("bad[201~reason");
    expect(x.notices[0]![1]).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  });

  it("unconfirmed from the daemon's own identity: recorded on the qitem, no pane notice", () => {
    const x = deps();
    createNativeSettlementHandler(x.d)(row({ senderSession: "queue@system", auditPointer: "qitem-1" }), { kind: "unconfirmed", evidence: "native_unconfirmed", detail: "write_partial" });
    expect([x.recorded.length, x.notices.length]).toEqual([1, 0]);
  });

  it("a failed fallback: the qitem records failed:, the sender is told it was NOT delivered; a held fallback names its held row", async () => {
    const x = deps();
    const failed = nativeFallbackOutcome({ ok: false, reason: "target_needs_input" }, { path: "tmux", evidence: "send_failed", detail: "target_needs_input" });
    await recordNativeFallback(x.d, row({ auditPointer: "qitem-2" }), { ok: false, reason: "target_needs_input" }, failed);
    expect(failed.state).toBe("failed");
    expect(x.recorded).toEqual([["qitem-2", "failed:target_needs_input"]]);
    expect(x.notices[0]![1]).toMatch(/was not confirmed delivered.*target_needs_input/);
    expect(x.notices[0]![1]).toMatch(/It may still arrive\. Before resending, check the seat \(rig capture dev-impl@rig1\)/);
    const held = nativeFallbackOutcome({ ok: true, outcome: "retained", outboxIds: ["guard-send-x"] }, { path: "tmux", evidence: "retained" });
    expect([held.state, held.label.detail, held.nudgeResult, held.undelivered]).toEqual(["failed", "fallback held by the typing guard as guard-send-x", "retained:typing_guard", false]);
  });
});

// Review M21: the relay process itself prints `decision: block` when the daemon answers block, and nothing otherwise.
describe("relay process: the block answer reaches Claude's stdout", () => {
  const RELAY = fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));
  async function runRelay(reply: unknown): Promise<{ stdout: string; acks: unknown[] }> {
    const acks: unknown[] = [];
    const server = createHttpServer((req, res) => {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.url === "/api/activity/native-ack") acks.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url === "/api/activity/native-ack" ? reply : { ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "nc3-relay-"));
    cleanups.push(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
    const child = spawn(process.execPath, [RELAY], { env: { PATH: process.env.PATH ?? "", HOME: home, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${port}`,
      OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_RUNTIME: "claude-code", OPENRIG_SESSION_NAME: SEAT }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; child.stdout.on("data", (c) => { stdout += c; });
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt_id: "p-9", prompt: "hi\n\n[openrig-msg outbox-1:0123456789abcdef01234567]" }));
    await new Promise((r) => child.on("close", r));
    return { stdout, acks };
  }

  it("block: true → one JSON object with decision block on stdout; the ack carried the marker and the prompt id", async () => {
    const r = await runRelay({ ok: true, acked: [], block: true });
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: "block" });
    expect(r.acks).toEqual([expect.objectContaining({ promptId: "p-9", markers: [{ id: "outbox-1", nonce: "0123456789abcdef01234567" }] })]);
  });

  it("control: block: false → nothing on stdout", async () => {
    const r = await runRelay({ ok: true, acked: ["outbox-1"], block: false });
    expect(r.stdout).toBe("");
  });
});

describe("ncomms-3b: fallback outcomes that may have landed, and the gaps the re-check named", () => {
  const row = (over: Partial<OutboxEntry>): OutboxEntry => ({ outboxId: "o1", senderSession: SENDER, destinationSession: SEAT, body: "b", tags: null,
    urgency: "routine", tsDispatched: "t", deliveryState: "sending", deliveredAt: null, auditPointer: null, nativeWrittenAt: "2026-10-30T12:00:00.000Z", ...over });
  function deps() {
    const recorded: Array<[string, string]> = []; const notices: Array<[string, string]> = [];
    return { recorded, notices, d: { recordNudgeAttempt: (q: string, r: string) => { recorded.push([q, r]); }, sendNotice: async (to: string, text: string) => { notices.push([to, text]); },
      isAgentSeat: (s: string) => s === SENDER } };
  }

  it("G1's twin: a fallback that TIMED OUT settles indeterminate / send_timeout (it may have landed), the qitem records indeterminate:, the sender is told UNCONFIRMED", async () => {
    const x = deps();
    const o = nativeFallbackOutcome({ ok: false, reason: "verify timeout waiting for render ack" }, { path: "tmux", evidence: "send_failed" });
    expect([o.state, o.label.evidence, o.nudgeResult, o.undelivered, o.unconfirmed]).toEqual(["indeterminate", "send_timeout", "indeterminate:verify timeout waiting for render ack", false, true]);
    await recordNativeFallback(x.d, row({ auditPointer: "qitem-3" }), { ok: false, reason: "verify timeout waiting for render ack" }, o);
    expect(x.recorded).toEqual([["qitem-3", "indeterminate:verify timeout waiting for render ack"]]);
    expect(x.notices[0]![1]).toMatch(/UNCONFIRMED: the tmux fallback timed out/);
  });

  it("D16: a fallback the typing guard HELD sends no notice and is not counted undelivered", async () => {
    const x = deps();
    const held = nativeFallbackOutcome({ ok: true, outcome: "retained", outboxIds: ["guard-send-x"] }, { path: "tmux", evidence: "retained" });
    await recordNativeFallback(x.d, row({ auditPointer: "qitem-4" }), { ok: true }, held);
    expect([x.recorded, x.notices]).toEqual([[["qitem-4", "retained:typing_guard"]], []]);
  });

  it("D18: a claimed row presents native-ack-pending as claimed; unclaimed it stays native-ack-pending", () => {
    expect(presentedNudgeResult("native-ack-pending", "2026-10-30T12:00:00.000Z")).toBe("claimed");
    expect(presentedNudgeResult("native-ack-pending", null)).toBe("native-ack-pending");
  });
});

describe("ncomms-3b G1: a late native copy after a tmux fallback that may have landed is blocked", () => {
  async function failedOver() {
    const d = db();
    const { inbox, outbox } = inboxFor(d);
    await registered(d, inbox);
    const e = await inbox.eligibility(SEAT, SENDER); if (!e.ok) throw new Error(e.reason);
    const sent = await inbox.deliver({ sessionName: SEAT, senderSession: SENDER, text: "hi", endpoint: e.endpoint });
    const id = sent.outboxIds[0]!;
    const nonce = (d.prepare("SELECT native_nonce AS n FROM outbox_entries WHERE outbox_id = ?").get(id) as { n: string }).n;
    outbox.settleNative(id, "failed", { path: "native", evidence: "native_unconfirmed" });
    return { inbox, outbox, id, nonce };
  }

  it.each([
    ["pasted, render unconfirmed", "indeterminate", { path: "tmux", evidence: "render_unconfirmed" }],
    ["timed out", "indeterminate", { path: "tmux", evidence: "send_timeout" }],
    ["delivered (control: blocked before too)", "delivered", { path: "tmux", evidence: "render_verified" }],
  ] as const)("fallback %s → the late native copy is blocked", async (_label, state, label) => {
    const { inbox, outbox, id, nonce } = await failedOver();
    outbox.settleFallback(id, state, label);
    expect(inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [], block: true });
  });

  it("control: a fallback that FAILED outright (nothing landed) → the late native copy is the delivery", async () => {
    const { inbox, outbox, id, nonce } = await failedOver();
    outbox.settleFallback(id, "failed", { path: "tmux", evidence: "send_failed", detail: "target_needs_input" });
    expect(inbox.ack({ nodeId: "node-a", sessionName: SEAT, markers: [{ id, nonce }] })).toEqual({ acked: [id], block: false });
  });
});

describe("ncomms-3c: the executable of a running process, from its pid", () => {
  it("parses lsof's txt entry (macOS, measured shape) and refuses a bare name", () => {
    expect(parseLsofTxtPath("p14524\nftxt\nn/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe\n"))
      .toBe("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    expect(parseLsofTxtPath("p1\nftxt\nnclaude\n")).toBeNull();
    expect(parseLsofTxtPath("")).toBeNull();
  });

  it("positive control: resolves this test process's own executable to an existing file", async () => {
    const p = await resolveClaudeExecPath(process.pid);
    expect(p).not.toBeNull();
    expect(statSync(p!).isFile()).toBe(true);
  });

  it("a pid that does not exist resolves to null", async () => {
    expect(await resolveClaudeExecPath(2 ** 22 + 12345)).toBeNull();
  });
});
