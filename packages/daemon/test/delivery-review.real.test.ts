// The combined reviews' findings, on a real daemon (createDaemon with its real RuntimeSeatPorts and HTTP routes), a private core, the REAL
// relay run as a process for every event, and, for Pi and OMP, the REAL runner. Only the agent is a stub. The kit is the QA reviewer's.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { fakePi } from "./helpers/fake-pi.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/delivery-daemon.ts");
const SEATPY = resolve(here, "helpers/delivery-seat.py");
const RELAY = resolve(here, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const SHIM = resolve(here, "helpers/delivery-relay-delay.cjs");
const RUNNER = resolve(here, "../src/adapters/pi-runner.ts");
const TOKEN = "delivery-token";
let serial = 0;
/** A port the OS says is free. A number derived from the pid collides with another run on the same host, and the child then dies of EADDRINUSE. */
const freePort = (): number => Number(spawnSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" }).stdout.trim());

describe.skipIf(!HC)("the combined reviews' findings, on a real daemon", () => {
  const core = new PrivateCore("dr");
  let children: ChildProcess[] = [];
  const HOME = join(core.root, "h", "openrig");
  // The stub goes by the agent's name: the hop looks for the agent in the terminal, as it must on a real seat.
  let CODEX_SEAT = ""; let CLAUDE_SEAT = "";
  beforeAll(() => {
    CODEX_SEAT = join(core.root, "codex-seat.py"); CLAUDE_SEAT = join(core.root, "claude-seat.py");
    copyFileSync(SEATPY, CODEX_SEAT); copyFileSync(SEATPY, CLAUDE_SEAT);
    expect(Buffer.byteLength(core.socketPath)).toBeLessThan(103);
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  function fixture(flags: string[] = [], runtime = "codex") {
    const dir = mkdtempSync(join(core.root, "w-"));
    for (const f of flags) writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "seat.log"), ""); writeFileSync(join(dir, "hop.log"), "");
    const id = ++serial; const name = `cx${id}@dr${id}`; const db = join(dir, "d.sqlite");
    const h = createDb(db); migrate(h, ALL_MIGRATIONS);
    const rigs = new RigRepository(h); const rig = rigs.createRig(`dr${id}`);
    const node = rigs.addNode(rig.id, `cx${id}`, { role: "worker", runtime });
    const leadRig = rigs.createRig(`lead${id}`);
    rigs.addNode(leadRig.id, "lead", { role: "worker", runtime: "terminal" });
    const sessions = new SessionRegistry(h);
    sessions.updateStatus(sessions.registerSession(node.id, name).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name });
    h.close();
    const lead = `lead@lead${id}`;
    const gateDir = join(seatGateRoot(HOME), seatGateFolder(name));
    const seen = join(gateDir, "seen");
    const address = hcTerminalName(name);
    const qport = freePort();
    const launch = async (ackDelay: number | null = null) => {
      const env = [...(ackDelay !== null ? [`NODE_OPTIONS=--require ${SHIM}`, `DELIVERY_ACK_DELAY_MS=${ackDelay}`, `DELIVERY_ACK_LOG=${join(dir, "ack.log")}`] : []),
        `OPENRIG_SESSION_NAME=${name}`, `OPENRIG_RUNTIME=${runtime}`, `OPENRIG_HOME=${HOME}`, `OPENRIG_NODE_ID=${node.id}`, `OPENRIG_URL=http://127.0.0.1:${qport}`, `OPENRIG_ACTIVITY_HOOK_TOKEN=${TOKEN}`];
      const launcher = join(dir, "openrig-tmux-send-stub");  // a real Codex seat's foreground: our launch script, with the agent its child
      writeFileSync(launcher, `/usr/bin/python3 -I ${runtime === "codex" ? CODEX_SEAT : CLAUDE_SEAT} "$@"\n:\n`);
      await core.client.call("terminal.run", { argv: ["/usr/bin/env", ...env, "/bin/sh", launcher, dir, RELAY, process.execPath, runtime], name: address, labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir });
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes(flags.includes("no-composer") ? "Select a model" : runtime === "codex" ? "Ask Codex" : "❯"), "first paint");
      await until(() => existsSync(join(gateDir, "gate.json")), Boolean, "the relay's declaration");
    };
    const lines = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    const withDb = <T,>(fn: (c: ReturnType<typeof createDb>) => T): T => { const c = createDb(db); try { return fn(c); } finally { c.close(); } };
    return { dir, db, name, lead, seen, gateDir, address, qport, rigId: rig.id, nodeId: node.id, launch, withDb,
      log: () => lines("seat.log"), hop: () => lines("hop.log"), flag: (f: string, text = "") => writeFileSync(join(dir, f), text),
      read: (key: string) => withDb((c) => c.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(key) as Record<string, unknown>),
      accept: (key: string, body = `body of ${key}`, extra: { sender?: string; occupantGeneration?: string } = {}) => withDb((c) => { new MessageStore(c).accept({ id: messageId(key), seat: name, sender: extra.sender ?? lead, body, occupantGeneration: extra.occupantGeneration }); }),
    };
  }
  type F = ReturnType<typeof fixture>;
  function daemon(s: F, crash = "none", env: NodeJS.ProcessEnv = {}): ChildProcess {
    const err: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), stdio: ["ignore", "ignore", "pipe"], env: {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: HOME, MPD_DB: s.db, MPD_DIR: s.dir, MPD_CRASH: crash,
      CODEX_HOME: join(core.root, "h", "codex"), DELIVERY_PORT: String(s.qport), OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, ...env,
    } });
    child.stderr?.on("data", (b: Buffer) => { err.push(b.toString()); if (err.length > 40) err.shift(); writeFileSync(join(s.dir, "stderr.log"), err.join("")); });
    child.on("exit", (code) => { if (code) writeFileSync(join(s.dir, "child-failed"), err.join("")); });
    children.push(child);
    return child;
  }
  const failed = (s: F) => { if (existsSync(join(s.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(s.dir, "child-failed"), "utf8").slice(-1800)}`); };
  const hopSaw = async (s: F, line: string, ms = 20_000) => { await until(() => { failed(s); return s.hop(); }, (l) => l.includes(line), `hop ${line}`, ms); };
  const state = (s: F, id: string, want: string, ms = 20_000) => until(() => { failed(s); return s.read(id); }, (r) => r?.message_state === want, `${id} ${want}`, ms);
  const agent = (s: F, id: string) => s.log().filter((l) => l.startsWith(`agent ${id} `));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const kill = async (c: ChildProcess) => { expect(c.exitCode).toBeNull(); c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };
  const screen = async (s: F) => (await core.client.call<{ text: string }>("terminal.read", { terminal: s.address })).text;
  const queueItems = (s: F) => s.withDb((c) => c.prepare("SELECT destination_session AS d, body FROM queue_items").all() as Array<{ d: string; body: string }>);
  /** curl, a real client: the suite's guard refuses fetch to a port it did not register. */
  const http = (s: F, path: string, body?: unknown, as: string | null = s.lead) => {
    const bodyFile = join(s.dir, "req.json");
    if (body !== undefined) writeFileSync(bodyFile, JSON.stringify(body));
    const out = spawnSync("/usr/bin/curl", ["-s", "-w", "\n%{http_code}", ...(as === null ? [] : ["-H", `x-openrig-session: ${as}`]), ...(body === undefined ? [] : ["-X", "POST", "-H", "content-type: application/json", "--data-binary", `@${bodyFile}`]), `http://127.0.0.1:${s.qport}${path}`], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
    const at = out.lastIndexOf("\n");
    return { status: Number(out.slice(at + 1)), text: out.slice(0, at) };
  };
  /** A Claude seat with an endpoint, so its prompts have a known transcript, as every registered seat has. */
  const withEndpoint = async (s: F) => {
    daemon(s); await hopSaw(s, "booted");
    s.flag("register-claude", JSON.stringify({ nodeId: s.nodeId, sessionName: s.name, transcriptPath: join(s.dir, "transcript.jsonl") }));
    await hopSaw(s, "registered");
  };
  const recordSeen = (s: F, id: string, nonce: string, extra: Record<string, unknown>) => {
    mkdirSync(s.seen, { recursive: true });
    writeFileSync(join(s.seen, createHash("sha256").update(`${id}:${nonce}`).digest("hex")), JSON.stringify({ id, nonce, recordedAt: "1999-01-01T00:00:00.000Z", via: "hook", durable: false, ...extra }));
  };
  const deadPid = () => spawnSync("/usr/bin/true").pid;
  const userRecord = (text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "text", text }] }, uuid: "u", timestamp: "1999-01-01T00:00:00.000Z", sessionId: "s" });

  describe("sec F1: a queued Claude message is not a received one", () => {
    it("an enqueue line alone does not read as received; the hook and the user record do", async () => {
      const s = fixture(["queued"], "claude-code"); await s.launch();
      await withEndpoint(s);
      s.accept("m1");
      await until(() => s.log(), (l) => l.includes("enqueued m1"), "the enqueue");
      await until(() => s.hop(), (l) => l.some((x) => /^(sent|refused|paused)/.test(x) && x.endsWith(" m1")), "the attempt's return", 30_000);
      await wait(600);
      expect(readFileSync(join(s.dir, "transcript.jsonl"), "utf8")).toContain("queue-operation");
      expect(s.read("m1").message_state).toBe("attempting");
      s.flag("take");
      await state(s, "m1", "received");
      await until(() => agent(s, "m1"), (l) => l.length > 0, "the agent's copy");
      expect(agent(s, "m1")).toHaveLength(1);
    }, 60_000);

    it("a seat killed while it was queued: the row stays open, and the new process gets it once", async () => {
      const s = fixture(["die-queued"], "claude-code"); await s.launch();
      await withEndpoint(s);
      s.accept("m1");
      await until(() => s.log(), (l) => l.includes("died queued"), "the seat's death");
      await wait(600);
      expect(s.read("m1").message_state).toBe("attempting");
      await core.client.call("terminal.rm", { terminal: s.address }).catch(() => undefined);
      await s.launch();
      await state(s, "m1", "received");
      await until(() => agent(s, "m1"), (l) => l.length > 0, "the agent's copy");
      expect(agent(s, "m1")).toHaveLength(1);
    }, 60_000);

    it("a message taken as a queued_command attachment is received: it never gets a user record", async () => {
      const s = fixture(["as-attachment", "queued"], "claude-code"); await s.launch();
      s.flag("take");
      await withEndpoint(s);
      s.accept("m1");
      await state(s, "m1", "received");
      expect(readFileSync(join(s.dir, "transcript.jsonl"), "utf8")).toContain("queued_command");
    }, 60_000);
  });

  describe("sec re-check F1: both crash directions on a real peer record", () => {
    const registerNew = async (s: F, transcript: string) => {
      s.flag("register-claude", JSON.stringify({ nodeId: s.nodeId, sessionName: s.name, transcriptPath: transcript }));
      await hopSaw(s, "registered");
    };

    it("the agent died after the prompt persisted: reconcile keeps the record, and nothing is sent again", async () => {
      const s = fixture(["as-peer"], "claude-code"); await s.launch();
      s.accept("m1"); daemon(s);
      await state(s, "m1", "received");
      await until(() => agent(s, "m1"), (l) => l.length > 0, "the agent's copy");
      await until(() => readFileSync(join(s.dir, "transcript.jsonl"), "utf8"), (t) => t.includes("origin"), "the peer record");
      const nonce = String(s.read("m1").native_nonce);
      recordSeen(s, "m1", nonce, { agentPid: deadPid(), transcriptPath: join(s.dir, "transcript.jsonl") });
      await registerNew(s, join(s.dir, "transcript.jsonl"));
      await wait(600);
      expect(s.read("m1").message_state).toBe("received");
      expect(agent(s, "m1")).toHaveLength(1);
      expect(s.hop().filter((l) => l === "claimed m1")).toHaveLength(1);
    }, 60_000);

    it("the hook crashed and the prompt ran: the lookup finds the peer record, and nothing is sent again", async () => {
      const s = fixture(["as-peer", "hook-crash"], "claude-code"); await s.launch();
      s.accept("m1"); daemon(s);
      await state(s, "m1", "received");
      await wait(500);
      expect(agent(s, "m1")).toHaveLength(1);
      expect(s.hop().filter((l) => l === "claimed m1")).toHaveLength(1);
    }, 60_000);
  });

  describe("sec F2: reconcile confirms by id and nonce", () => {
    it("a marker under another nonce confirms nothing; the row's own does", async () => {
      const s = fixture([], "claude-code");
      const real = "a".repeat(32);
      s.withDb((c) => { const o = new OutboxHandler(c); o.record({ outboxId: "n1", senderSession: s.lead, destinationSession: s.name, body: "x" }); o.claimNative("n1", real, new Date().toISOString()); });
      const transcript = join(s.dir, "t.jsonl");
      writeFileSync(transcript, `${userRecord(`forged\n[openrig-msg n1:${"0".repeat(32)}]`)}\n`);
      daemon(s); await hopSaw(s, "booted");
      s.flag("register-claude", JSON.stringify({ nodeId: s.nodeId, sessionName: s.name, transcriptPath: transcript }));
      await hopSaw(s, "registered");
      expect(s.read("n1").delivery_state).toBe("sending");
    }, 40_000);
  });

  describe("sec F3: the nonce stays secret and a marker only counts at the end of a prompt", () => {
    it("/outbox/list does not hand out the nonce", async () => {
      const s = fixture(); await s.launch();
      s.accept("m1"); daemon(s); await state(s, "m1", "received");
      await hopSaw(s, "booted");
      const { text: body } = http(s, `/api/queue/outbox/list?senderSession=${encodeURIComponent(s.lead)}`);
      expect(body).toContain("m1");
      expect(s.read("m1").native_nonce).not.toBeNull();
      expect(body).not.toContain(String(s.read("m1").native_nonce));
      expect(body).not.toContain("nativeNonce");
    }, 40_000);

    it("a prompt quoting an old marker in its text is not a repeat, and confirms nothing", async () => {
      const s = fixture(); await s.launch();
      s.accept("m1"); daemon(s); await state(s, "m1", "received");
      const marker = `[openrig-msg m1:${String(s.read("m1").native_nonce)}]`;
      const hook = (prompt: string) => spawnSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: "s-1", transcript_path: join(s.dir, "rollout.jsonl") }), encoding: "utf8",
        env: { PATH: core.env.PATH, HOME: core.env.HOME, OPENRIG_SESSION_NAME: s.name, OPENRIG_RUNTIME: "codex", OPENRIG_HOME: HOME, OPENRIG_URL: `http://127.0.0.1:${s.qport}`, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN } });
      expect(hook(`Jim here: why did you get ${marker} twice? Please stop the deploy.`).stdout).not.toContain("block");
      expect(hook(`${marker}\nthat line opened this message`).stdout).not.toContain("block");
      expect(hook(`trailing, so a real repeat\n${marker}`).stdout).toContain("block");
    }, 40_000);
  });

  describe("sec F4: no message can block a seat for good", () => {
    it("a body that is only a marker, or only space, is refused at the door, and the seat goes on", async () => {
      const s = fixture(); await s.launch();
      daemon(s); await hopSaw(s, "booted"); await wait(300);
      for (const text of [`[openrig-msg z:${"0".repeat(16)}]`, "   \n  "]) {
        const res = http(s, "/api/transport/send", { session: s.name, text });
        expect(res.status).toBe(400);
        expect((JSON.parse(res.text) as { reason: string }).reason).toBe("empty_message");
      }
      s.accept("m2");
      await state(s, "m2", "received");
    }, 40_000);

    it("an operator can end a stuck message by id: rig seat cancel-message's route, and the seat goes on", async () => {
      const s = fixture(["hold"]); await s.launch();
      s.accept("stuck"); s.accept("next"); daemon(s);
      await hopSaw(s, "claimed stuck");
      await hopSaw(s, "booted");  // the pump starts inside createDaemon, before the port is bound: an attempt proves nothing about the listener
      expect(http(s, `/api/transport/cancel-message/${encodeURIComponent(s.name)}/stuck`, {}).status).toBe(400);
      expect(http(s, `/api/transport/cancel-message/${encodeURIComponent("other@rig")}/stuck`, { reason: "x" }).status).toBe(404);
      expect(http(s, `/api/transport/cancel-message/${encodeURIComponent(s.name)}/stuck`, { reason: "poison" }).status).toBe(200);
      expect(s.read("stuck")).toMatchObject({ message_state: "undeliverable", message_closed_reason: "poison" });
      await hopSaw(s, "claimed next", 45_000);
    }, 70_000);
  });

  describe("sec F5, QA F3: decision 1 on the real ports", () => {
    const archive = (s: F) => s.withDb((c) => c.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), s.rigId));
    it("a message to an archived rig's seat goes back to its sender", async () => {
      const s = fixture(["hold"]); await s.launch();
      s.accept("m1"); daemon(s); await hopSaw(s, "claimed m1");
      archive(s);
      await state(s, "m1", "undeliverable");
      expect(queueItems(s).map((q) => q.d)).toEqual([s.lead]);
      expect(queueItems(s)[0]!.body).toContain("body of m1");
    }, 40_000);

    it("a record beats the archive: a message that arrived is not returned", async () => {
      const s = fixture(); await s.launch();
      s.accept("m1"); daemon(s); await state(s, "m1", "received");
      archive(s); await wait(400);
      expect(queueItems(s)).toEqual([]);
    }, 40_000);

    it("a message to a seat whose record was deleted goes back too", async () => {
      const s = fixture(["hold"]); await s.launch();
      s.accept("m1"); daemon(s); await hopSaw(s, "claimed m1");
      s.withDb((c) => { c.pragma("foreign_keys = OFF"); c.prepare("DELETE FROM bindings WHERE node_id = ?").run(s.nodeId); c.prepare("DELETE FROM nodes WHERE id = ?").run(s.nodeId); });
      await state(s, "m1", "undeliverable");
      expect(queueItems(s).map((q) => q.d)).toEqual([s.lead]);
    }, 40_000);

    it("a held message on an archived seat goes back, with the guard still on", async () => {
      const s = fixture(); await s.launch();
      s.withDb((c) => {
        c.prepare("INSERT INTO seat_delivery_guards (node_id, desired, effective, actor, reason, changed_at) VALUES (?, 1, 1, 'a', 'r', 't')").run(s.nodeId);
        new OutboxHandler(c).retain({ outboxId: "h1", senderSession: s.lead, destinationSession: s.name, body: "held" }, { nodeId: s.nodeId, session: s.name, occupant: null, pane: null });
      });
      daemon(s); await hopSaw(s, "booted"); await wait(300);
      expect(s.read("h1").delivery_state).toBe("retained");
      archive(s);
      await state(s, "h1", "undeliverable");
    }, 40_000);

    it("a seat with no gate and a send path's crash-left row is still left alone when its rig is archived: nobody can know what reached it", async () => {
      const s = fixture([], "terminal");
      s.withDb((c) => { new OutboxHandler(c).record({ outboxId: "left", senderSession: s.lead, destinationSession: s.name, body: "x", messageState: "attempting" }); });
      archive(s); daemon(s); await hopSaw(s, "booted"); await wait(400);
      expect(s.read("left").message_state).toBe("attempting");
      expect(queueItems(s)).toEqual([]);
    }, 40_000);
  });

  describe("QA F1: the relay's ack never blocks a copy the gate passed", () => {
    for (const delay of [0, 60, 200]) {
      it(`ack ${delay} ms after the record, the pump reading first: the agent has it`, async () => {
        const s = fixture([], "claude-code"); await s.launch(delay);
        daemon(s, "fast_hop"); await hopSaw(s, "booted"); await wait(300);
        s.accept("m1");
        await state(s, "m1", "received");
        await wait(1200);
        expect(agent(s, "m1")).toHaveLength(1);
        expect(s.log().filter((l) => l.startsWith("dropped"))).toEqual([]);
      }, 40_000);
    }
  });

  describe("QA F2: a fresh Pi or OMP seat, the real runner", () => {
    for (const runtime of ["pi", "omp"] as const) {
      it(`${runtime}: the first message reaches the agent through the pump, text only; a refusal during compaction is retried; a marker-only row does not stop the seat`, async () => {
        const s = fixture([], runtime);
        const pi = fakePi(s.dir);
        const root = join(HOME, "state", runtime);
        const flags = runtime === "omp" ? ["--runtime", "omp", "--approval-mode", "yolo"] : ["--no-approve", "--model", "openrouter/fixture"];
        await core.client.call("terminal.run", {
          argv: [process.execPath, "--import", "tsx", RUNNER, "--session-name", s.name, "--state-root", root, "--cwd", s.dir, "--launch-id", "l1", ...flags], name: s.address, cwd: resolve(here, ".."),
          env: { PATH: `${pi.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, OPENRIG_HOME: join(s.dir, "home") }, labels: { "openrig.seat": s.name }, no_parent: true, no_notify: true, outlive_parent: true,
        });
        await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: s.address })).text, (t) => t.includes(`[${runtime}-runner] READY`), "READY", 30_000);
        const effects = () => readFileSync(pi.effects, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
        s.accept("m1", "first");
        daemon(s);
        await state(s, "m1", "received", 30_000);
        expect(effects()).toEqual(["first"]);

        writeFileSync(pi.compacting, "");
        s.accept("m2", "during compaction");
        await hopSaw(s, "sent m2");
        await wait(500);
        expect(s.read("m2").message_state).not.toBe("received");
        spawnSync("/bin/rm", ["-f", pi.compacting]);
        await state(s, "m2", "received", 30_000);
        expect(effects()).toEqual(["first", "during compaction"]);

        s.accept("m3", `[openrig-msg z:${"0".repeat(16)}]`);
        s.accept("m4", "after it");
        await state(s, "m4", "received", 30_000);
        expect(effects()).toEqual(["first", "during compaction", "after it"]);
      }, 120_000);
    }
  });

  describe("real proof F3: the pump never types into a seat whose agent is not there", () => {
    it("a Pi seat at a login shell, with a sidecar still saying ready: nothing is typed, so nothing runs; the runner comes back and it arrives once", async () => {
      const s = fixture([], "pi");
      const pi = fakePi(s.dir);
      const root = join(HOME, "state", "pi");
      const canary = join(s.dir, "it-ran");
      mkdirSync(join(root, s.name), { recursive: true });
      writeFileSync(join(root, s.name, "runner-state.json"), JSON.stringify({ ready: true, updatedAt: new Date().toISOString(), aliveAt: new Date().toISOString(), seatGate: 1 }));
      await core.client.call("terminal.run", { argv: ["/bin/bash", "-l"], name: s.address, cwd: s.dir, env: { PATH: `${pi.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(core.root, "h"), HISTFILE: join(s.dir, "history") }, labels: { "openrig.seat": s.name }, no_parent: true, no_notify: true, outlive_parent: true });
      await until(async () => (await core.client.call<{ foreground?: { name: string } | null }>("terminal.get", { terminal: s.address })).foreground, Boolean, "the shell");
      s.accept("m1", `touch ${canary}`);
      daemon(s);
      await hopSaw(s, "paused:agent_absent m1");
      await wait(600);
      expect(existsSync(canary)).toBe(false);
      expect(s.read("m1")).toMatchObject({ message_state: "attempting", attempts: 0, message_pause_reason: "agent_absent" });
      expect(await screen(s)).not.toContain("openrig-msg");

      await core.client.call("terminal.send", { terminal: s.address, text: `cd ${resolve(here, "..")} && exec node --import tsx ${RUNNER} --session-name ${s.name} --state-root ${root} --cwd ${s.dir} --launch-id l2 --no-approve --model openrouter/fixture`, force: true });
      await until(() => screen(s), (t) => t.includes("[pi-runner] READY"), "the runner back", 30_000);
      await state(s, "m1", "received", 40_000);
      expect(readFileSync(pi.effects, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
      expect(existsSync(canary)).toBe(false);
    }, 120_000);

    // The launch `hc-input.ts` types for a sourced seat: `( . cmd )`, so the agent runs inside a forked subshell, whose argv is the login shell's.
    // Live seats on Sparky show this: claude pgid 2149701 tpgid 2149701, under a zsh of that pid, under the login zsh.
    const shellSeat = async (s: F, shell: string, runtime: string) => {
      writeFileSync(join(core.root, "h", ".zshrc"), "");  // an empty HOME gets zsh's new-user install screen on Linux, not a prompt
      const seatEnv = { PATH: `${dirname(HC)}:/usr/bin:/bin`, HOME: join(core.root, "h"), OPENRIG_SESSION_NAME: s.name, OPENRIG_RUNTIME: runtime, OPENRIG_HOME: HOME, OPENRIG_NODE_ID: s.nodeId, OPENRIG_URL: `http://127.0.0.1:${s.qport}`, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN };
      await core.client.call("terminal.run", { argv: [shell, "-l"], name: s.address, cwd: s.dir, env: seatEnv, labels: { "openrig.seat": s.name }, no_parent: true, no_notify: true, outlive_parent: true });
      await until(async () => (await core.client.call<{ foreground?: { name: string } | null }>("terminal.get", { terminal: s.address })).foreground, Boolean, "the shell");
      await wait(400);
    };
    const agentCommand = (s: F, runtime: string, name: string) => `exec -a ${name} /usr/bin/python3 -I ${runtime === "codex" ? CODEX_SEAT : CLAUDE_SEAT} ${s.dir} ${RELAY} ${process.execPath} ${runtime}`;

    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      it(`a healthy Claude launched sourced under ${shell}: hc reads the shell, the agent is in the foreground group, and the paste goes`, async () => {
        const s = fixture([], "claude-code");
        await shellSeat(s, shell, "claude-code");
        // No `exec` in the subshell, as a non-managed launch has none: `:` keeps it from turning the last command into one.
        // The macOS python3 shim drops an `exec -a` name, so the group gets a process that really is called claude.
        const named = join(s.dir, "claude");
        spawnSync("/bin/ln", ["-s", "/bin/sleep", named]);
        s.flag("launch.sh", `${named} 600 &\n${agentCommand(s, "claude-code", "claude").replace("exec -a claude ", "")}\n:\n`);
        await core.client.call("terminal.send", { terminal: s.address, text: `( . ${join(s.dir, "launch.sh")} )`, force: true });
        await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: s.address })).text, (t) => t.includes("❯"), "the agent's composer");
        const seat = await until(() => core.client.call<{ pid: number; foreground?: { pid: number; name: string; argv: string[] } | null }>("terminal.get", { terminal: s.address }), (t) => t.foreground?.pid !== t.pid, "the subshell to lead the foreground", 8_000);
        expect(seat.foreground?.argv).toEqual([shell, "-l"]);  // the shape QA measured, and Sparky's live seats show: the leader's argv says shell
        s.accept("m1"); daemon(s);
        await state(s, "m1", "received", 30_000);
        await until(() => agent(s, "m1"), (l) => l.length > 0, "the agent's copy");
        expect(agent(s, "m1")).toHaveLength(1);
      }, 70_000);
    }

    it("a bare prompt with the agent backgrounded is still a bare prompt: nothing is typed", async () => {
      const s = fixture([], "claude-code");
      await shellSeat(s, "/bin/bash", "claude-code");
      mkdirSync(s.gateDir, { recursive: true }); writeFileSync(join(s.gateDir, "gate.json"), JSON.stringify({ version: 1 }));
      s.flag("hold");
      s.flag("launch.sh", `( ${agentCommand(s, "claude-code", "claude")} ) </dev/null >/dev/null 2>&1 &\n`);
      const named = join(s.dir, "claude");
      spawnSync("/bin/ln", ["-s", "/bin/sleep", named]);
      s.flag("launch.sh", `( ${named} 600 ) </dev/null >/dev/null 2>&1 &\n`);
      await core.client.call("terminal.send", { terminal: s.address, text: `. ${join(s.dir, "launch.sh")}`, force: true });
      await wait(800);
      const canary = join(s.dir, "it-ran");
      s.accept("m1", `touch ${canary}`);
      daemon(s);
      await hopSaw(s, "paused:agent_absent m1");
      await until(() => s.read("m1"), (r) => r.message_pause_reason === "agent_absent" && r.attempts === 0, "the pause on the row");
      await wait(400);
      expect(existsSync(canary)).toBe(false);
    }, 60_000);

    it("health names a seat with no agent at once, not after 15 minutes", async () => {
      const s = fixture([], "codex");
      await shellSeat(s, "/bin/bash", "codex");
      mkdirSync(s.gateDir, { recursive: true }); writeFileSync(join(s.gateDir, "gate.json"), JSON.stringify({ version: 1 }));
      s.accept("m1"); daemon(s);
      await hopSaw(s, "paused:agent_absent m1");
      await hopSaw(s, "booted");
      expect(http(s, "/api/health").text).toContain("its agent is not running");
    }, 50_000);

    it("a Codex seat back at its login shell: nothing is typed", async () => {
      const s = fixture();
      await core.client.call("terminal.run", { argv: ["/bin/bash", "-l"], name: s.address, cwd: s.dir, env: { PATH: "/usr/bin:/bin", HOME: join(core.root, "h"), PS1: "\u203a " }, labels: { "openrig.seat": s.name }, no_parent: true, no_notify: true, outlive_parent: true });
      await until(async () => (await core.client.call<{ foreground?: { name: string } | null }>("terminal.get", { terminal: s.address })).foreground, Boolean, "the shell");
      mkdirSync(s.gateDir, { recursive: true }); writeFileSync(join(s.gateDir, "gate.json"), JSON.stringify({ version: 1 }));
      const canary = join(s.dir, "it-ran");
      s.accept("m1", `touch ${canary}`);
      daemon(s);
      await hopSaw(s, "paused:agent_absent m1");
      await wait(400);
      expect(existsSync(canary)).toBe(false);
    }, 60_000);
  });

  describe("real proof: lifecycle text with no sender to return to", () => {
    for (const sender of ["unknown", "watchdog@system", "daemon@kernel"]) {
      it(`from ${sender}: no queue item for nobody; the row ends, and health says so with its text kept`, async () => {
        const s = fixture(); await s.launch();
        s.withDb((c) => {
          new OutboxHandler(c).retain({ outboxId: "l1", senderSession: sender, destinationSession: s.name, body: "lifecycle text", messageClass: "lifecycle" }, { nodeId: s.nodeId, session: s.name, occupant: "the-old-occupant", pane: null });
        });
        daemon(s);
        await state(s, "l1", "undeliverable");
        await hopSaw(s, "booted");
        expect(queueItems(s)).toEqual([]);
        expect(String(s.read("l1").message_closed_reason)).toContain("no sender");
        expect(s.read("l1").body).toBe("lifecycle text");
        const health = http(s, "/api/health").text;
        expect(health).toContain("no sender to return them to");
        expect(health).toContain("l1");
      }, 40_000);
    }

    it("a lifecycle message with a real sender goes back to that sender", async () => {
      const s = fixture(); await s.launch();
      s.withDb((c) => {
        new OutboxHandler(c).retain({ outboxId: "l2", senderSession: s.lead, destinationSession: s.name, body: "lifecycle text", messageClass: "lifecycle" }, { nodeId: s.nodeId, session: s.name, occupant: "the-old-occupant", pane: null });
      });
      daemon(s);
      await state(s, "l2", "undeliverable");
      expect(queueItems(s).map((q) => q.d)).toEqual([s.lead]);
    }, 40_000);
  });

  describe("a long message: a short paste, and the gate hook adds its text", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const context = (s: F, id: string) => s.log().filter((l) => l.startsWith(`context ${id} `));
    const spoolFiles = (s: F) => (existsSync(join(s.gateDir, "spool")) ? readdirSync(join(s.gateDir, "spool")) : []);

    it("claude-code, decision 35: with no socket it is never pasted, health names it at once, and the lane waits behind it", async () => {
      const s = fixture([], "claude-code"); await s.launch();
      s.accept("long", "x".repeat(1500)); s.accept("next"); daemon(s);
      await until(() => s.read("long"), (r) => r?.message_pause_reason === "long_no_socket", "the pause");
      await hopSaw(s, "booted");
      expect(http(s, "/api/health").text).toContain("too long to paste");
      await wait(1000);
      expect(s.log().filter((l) => l.startsWith("agent") || l.startsWith("unmarked"))).toEqual([]);
      expect(spoolFiles(s)).toEqual([]);
      expect(s.read("long")).toMatchObject({ message_state: "attempting", delivery_state: "pending", message_parts: null });
      expect(s.read("next").attempts).toBe(0);
    }, 60_000);

    it("claude-code: a short message still pastes", async () => {
      const s = fixture([], "claude-code"); await s.launch();
      s.accept("short"); daemon(s);
      await state(s, "short", "received");
      expect(agent(s, "short")).toHaveLength(1);
    }, 40_000);

    for (const runtime of ["codex"]) {
      it(`${runtime}: the agent gets the body from the hook, in the turn of a short paste, and that record is the arrival`, async () => {
        const s = fixture([], runtime); await s.launch();
        const body = "x".repeat(1500);
        s.accept("long", body); s.accept("next"); daemon(s);
        await state(s, "long", "received");
        const seen = agent(s, "long");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.length).toBeLessThan(400);
        expect(seen[0]).not.toContain("xxxx");
        expect(context(s, "long")).toEqual([`context long ${sha(body)} 1500`]);
        expect(s.read("long")).toMatchObject({ delivery_state: "delivered", ack_evidence: "gate_seen", message_parts: 1 });
        await hopSaw(s, "claimed next");
        await state(s, "next", "received");
        expect(spoolFiles(s)).toEqual([]);  // its text does not stay on disk
        expect(http(s, `/api/transport/read-message/${encodeURIComponent(s.name)}/long`, undefined, s.name).status).toBe(404);
      }, 60_000);

      it(`${runtime}: a hook that crashed let only the note run: the row stays open though the prompt is on file, and the next attempt carries the body`, async () => {
        const s = fixture(["hook-crash"], runtime); await s.launch();
        const body = "y".repeat(1500);
        s.accept("long", body); daemon(s);
        await until(() => agent(s, "long"), (l) => l.length === 1, "the note ran");
        await wait(800);
        expect(s.read("long").message_state).toBe("attempting");
        expect(context(s, "long")).toEqual([]);
        await state(s, "long", "received", 30_000);
        expect(context(s, "long")).toEqual([`context long ${sha(body)} 1500`]);
        expect(s.log().filter((l) => l.startsWith("dropped"))).toEqual([]);
      }, 70_000);
    }

    it("past 9000 characters: numbered parts, each its own id and turn, in order, whole, and received only when all are", async () => {
      const s = fixture(); await s.launch();
      const body = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      s.accept("big", body); s.accept("next"); daemon(s);
      await state(s, "big", "received", 40_000);
      const turns = s.log().filter((l) => l.startsWith("context "));
      expect(turns).toEqual([
        `context big.part1of3 ${sha(body.slice(0, 9000))} 9000`,
        `context big.part2of3 ${sha(body.slice(9000, 18_000))} 9000`,
        `context big.part3of3 ${sha(body.slice(18_000))} 2000`,
      ]);
      expect(s.read("big")).toMatchObject({ message_parts: 3, message_parts_done: 2, ack_evidence: "gate_seen" });
      await hopSaw(s, "claimed next");
    }, 70_000);

    it("a part that has not arrived holds the message open, and the parts before it are not sent again", async () => {
      const s = fixture(); await s.launch();
      const body = "z".repeat(10_000);
      s.accept("big", body); s.flag("hook-crash-after", "big.part1of2"); daemon(s);
      await until(() => agent(s, "big.part2of2"), (l) => l.length === 1, "the second part's note");
      await wait(800);
      expect(s.read("big").message_state).toBe("attempting");
      await state(s, "big", "received", 30_000);
      expect(context(s, "big.part1of2")).toHaveLength(1);
      expect(context(s, "big.part2of2")).toHaveLength(1);
    }, 70_000);

    it("staged with its Enter lost, it is finished with Enter alone", async () => {
      const s = fixture(["lose-enter"]); await s.launch();
      s.accept("long", "x".repeat(1500)); daemon(s);
      await state(s, "long", "received", 30_000);
      expect(s.log().filter((l) => l.startsWith("dropped"))).toEqual([]);
      expect(context(s, "long")).toHaveLength(1);
    }, 60_000);

    it("a seat whose relay declared an older gate gets the message whole: a short paste there would lose the text", async () => {
      const s = fixture(); await s.launch();
      writeFileSync(join(s.gateDir, "gate.json"), JSON.stringify({ version: 1 }));
      s.accept("long", "x".repeat(1500)); daemon(s);
      await state(s, "long", "received");
      expect(agent(s, "long")[0]).toContain("x".repeat(1500));
      expect(context(s, "long")).toEqual([]);
    }, 60_000);
  });

  describe("a seat that cannot take a message right now is named at once", () => {
    it("a screen with no composer, such as a picker: nothing is typed, and health says what it is", async () => {
      const s = fixture(["no-composer"]); await s.launch();
      s.accept("m1"); daemon(s);
      await hopSaw(s, "paused:screen_unreadable m1");
      await hopSaw(s, "booted");
      expect(s.log()).toEqual([]);
      expect(http(s, "/api/health").text).toContain("shows no composer");
    }, 50_000);

    it("a terminal that has gone, in a rig still live: health says so at once", async () => {
      const s = fixture(); await s.launch();
      await core.client.call("terminal.kill", { terminal: s.address });
      await until(async () => (await core.client.call<{ state: string }>("terminal.get", { terminal: s.address })).state, (v) => v !== "live", "the terminal gone");
      s.accept("m1"); daemon(s);
      await hopSaw(s, "paused:seat_stopped m1");
      await hopSaw(s, "booted");
      expect(http(s, "/api/health").text).toContain("its terminal is not running");
    }, 50_000);
  });

  describe("a real approval dialog", () => {
    it("pauses as blocked, and health names it at once", async () => {
      const s = fixture([], "codex"); await s.launch();
      s.flag("start-blocked");
      await until(async () => (await core.client.call<{ status?: { state: string } | null }>("terminal.get", { terminal: s.address })).status?.state, (v) => v === "blocked", "the dialog");
      s.accept("m1"); daemon(s);
      await hopSaw(s, "paused:blocked m1");
      await hopSaw(s, "booted");
      expect(http(s, "/api/health").text).toContain("waiting on a dialog");
      s.flag("unblock");
      await state(s, "m1", "received", 30_000);
    }, 60_000);
  });

  describe("real proof F4: a draft shows on rig health at once", () => {
    it("/api/health names the draft while the row is minutes old, and the message goes when it clears", async () => {
      const s = fixture(); await s.launch();
      expect(await new HcInput(core.client, new HcAttach(core.socketPath)).sendText(s.name, "half a thought", undefined, { bracketed: false })).toMatchObject({ ok: true });
      await until(() => screen(s), (t) => t.includes("half a thought"), "the draft");
      s.accept("m1"); daemon(s);
      await hopSaw(s, "paused:draft m1");
      await hopSaw(s, "booted");
      expect(http(s, "/api/health").text).toContain("wait behind a draft");
      await core.client.call("terminal.keys", { terminal: s.address, keys: ["ctrl+u"] });
      await state(s, "m1", "received", 30_000);
    }, 70_000);
  });

  describe("QA F4: a lost Enter never needs a person, whatever the body looks like", () => {
    for (const [name, body] of [["a blank line", "para one\n\npara two"], ["a line with ' · '", "From: a@b\nSent: 11-01 · gen 12345678\n---\nhello"], ["an unindented look", "one\n\n\nthree\n\n· four"]] as const) {
      it(`Codex, a body with ${name}: Enter alone`, async () => {
        const s = fixture(["lose-enter"]); await s.launch();
        s.accept("m1", body); daemon(s);
        await state(s, "m1", "received");
        await until(() => agent(s, "m1"), (l) => l.length > 0, "the agent's copy");
        expect(agent(s, "m1")).toHaveLength(1);
        expect(s.log().filter((l) => l.startsWith("dropped"))).toEqual([]);
      }, 40_000);
    }
  });

  describe("QA F5: reconcile has no gaps", () => {
    it("a Claude seat that restarted while the daemon was down: the boot reconciles it, and the row opens again", async () => {
      const s = fixture([], "claude-code");
      const nonce = "b".repeat(32);
      const transcript = join(s.dir, "t.jsonl");
      writeFileSync(transcript, "");
      s.withDb((c) => {
        const store = new MessageStore(c);
        store.accept({ id: messageId("m1"), seat: s.name, sender: s.lead, body: "x" });
        c.prepare("UPDATE outbox_entries SET native_nonce = ? WHERE outbox_id = 'm1'").run(nonce);
        store.recordReceived({ id: messageId("m1"), recordedAt: "1999-01-01T00:00:00.000Z", nonce }, 1);
        c.prepare(`INSERT INTO seat_native_endpoints (node_id, session_name, socket_path, transcript_path, claude_pid, registered_at) VALUES (?, ?, ?, ?, ?, ?)`).run(s.nodeId, s.name, join(s.dir, "no.sock"), transcript, deadPid(), "1999-01-01T00:00:00.000Z");
      });
      recordSeen(s, "m1", nonce, { agentPid: deadPid(), transcriptPath: transcript });
      mkdirSync(s.gateDir, { recursive: true }); writeFileSync(join(s.gateDir, "gate.json"), JSON.stringify({ version: 1 }));
      daemon(s); await hopSaw(s, "booted");
      await until(() => s.read("m1"), (r) => r.delivery_state === "pending", "the row reopened");
    }, 40_000);
  });

  describe("QA F6: a hook that crashed, with the thread's rollout unknown", () => {
    it("the path the relay declared finds the prompt: no second copy", async () => {
      const s = fixture(["hook-crash"]); await s.launch();
      s.accept("m1"); daemon(s);
      await state(s, "m1", "received");
      await wait(500);
      expect(agent(s, "m1")).toHaveLength(1);
      expect(s.hop().filter((l) => l === "claimed m1")).toHaveLength(1);
    }, 40_000);
  });

  describe("sec F6, F7: what rests on disk", () => {
    it("the database is the owner's alone, and a body past the limit is refused", async () => {
      const s = fixture(); await s.launch();
      daemon(s); await hopSaw(s, "booted"); await wait(300);
      expect(statSync(s.db).mode & 0o777).toBe(0o600);
      const res = http(s, "/api/transport/send", { session: s.name, text: "x".repeat(1024 * 1024 + 1) });
      expect(res.status).toBe(413);
      expect((JSON.parse(res.text) as { reason: string }).reason).toBe("message_too_large");
      expect(s.withDb((c) => (c.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n)).toBe(0);
    }, 40_000);
  });
});
