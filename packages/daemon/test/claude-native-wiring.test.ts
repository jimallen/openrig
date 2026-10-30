// Native comms step 3: the wiring around ClaudeNativeInbox, with fakes or scratch sockets only. Covers the outbox guards
// (finalize and startup reconciliation leave native rows to the ack and the sweeper), the launch-flag merge, the two
// activity routes, the relay payloads, the transport's native branch, the wake drain's native-pending result, and the
// OS adapters (a real Unix socket in a temp dir; a chunked file search).
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { ClaudeNativeInbox, ACCEPT_SETTING_ARGV_FRAGMENT, type ProcessRow } from "../src/domain/claude-native-inbox.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { operationalLaunchArgs, withNativeInboxSettings } from "../src/adapters/kernel-authority.js";
import { fileIncludes, writeSocketLines } from "../src/adapters/native-inbox-os.js";
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
