// The census crash table (census-delivery-guarantees-20261101, Q3) against the wired pump. A real daemon process with its real ports, real
// CodexSeatHop, real gate reader and real hook-store layout, on a private core. The seat is a stub on a real pty that plays Codex: it draws
// the composer `readCodexComposer` reads and records and blocks as the relay does, in the same files. So what is stubbed is the agent.
//
// "Once" here is the stub's own log: one `agent` line per id, whatever crossed the pty. Boundary: no real agent ran, so this proves the
// wiring and the pump, not a runtime; a P1 is the program ignoring its first Enter, not a raced core kill (s0 M8 measured the race).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/message-pump-census-daemon.ts");

/** Plays Codex. Files in its folder steer it: `hold` keeps stdin unread until `go`; `lose-enter` ignores the first Enter, leaving the text
 *  staged (over 1000 chars it shows collapsed, marker hidden, as Codex does); `compacting` refuses a prompt with nothing recorded; `die-after-record` records, then dies before the prompt is durable. */
const SEAT_PROGRAM = `
import hashlib, json, os, re, sys, time, tty
base, seen = sys.argv[1], sys.argv[2]
tty.setraw(0)
log = open(base + "/seat.log", "ab", buffering=0)
rollout = base + "/rollout.jsonl"
MARK = re.compile(rb"\\n\\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\\]\\s*$")
composer = b""
lost = False
def status(state):
    os.write(1, b"\\x1b]7501;state=" + state + b":app=stub\\x1b\\\\")
def draw():
    shown = composer.decode("utf8", "replace")
    if len(shown) > 1000:
        shown = "[Pasted Content %d chars]" % len(shown)
    lines = shown.split("\\n")
    text = "\\x1b[2J\\x1b[H\\r\\n"
    text += "\\u203a " + lines[0] if composer else "\\u203a Ask Codex to do anything"
    for line in lines[1:]:
        text += "\\r\\n  " + line
    text += "\\r\\n\\r\\n  stub low \\u00b7 /work\\r\\n"
    os.write(1, text.encode("utf8"))
def submit():
    global composer
    found = MARK.search(composer)
    if os.path.exists(base + "/compacting"):
        log.write(b"refused\\n")
        composer = b""
        return
    if not found:
        log.write(b"unmarked " + composer + b"\\n")
        composer = b""
        return
    mid, nonce = found.group(1), found.group(2)
    text = composer[:found.start()]
    name = hashlib.sha256(mid + b":" + nonce).hexdigest()
    os.makedirs(seen, exist_ok=True)
    try:
        fd = os.open(seen + "/" + name, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, json.dumps({"id": mid.decode(), "nonce": nonce.decode(), "recordedAt": "1999-01-01T00:00:00.000Z", "via": "hook", "agentPid": None, "transcriptPath": rollout, "durable": False}).encode())
        os.close(fd)
    except FileExistsError:
        log.write(b"dropped " + mid + b"\\n")
        composer = b""
        return
    if os.path.exists(base + "/die-after-record"):
        os.remove(base + "/die-after-record")
        os._exit(9)
    log.write(b"agent " + mid + b" " + text + b"\\n")
    with open(rollout, "a") as f:
        f.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": composer.decode()}]}}) + "\\n")
    composer = b""
status(b"idle")
draw()
if os.path.exists(base + "/hold"):
    while not os.path.exists(base + "/go"):
        time.sleep(0.02)
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    if b"\\x15" in chunk:
        log.write(b"ctrl-u\\n")
        composer = b""
        chunk = chunk.split(b"\\x15", 1)[1]
    chunk = chunk.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"")
    while chunk:
        before, sep, chunk = chunk.partition(b"\\r")
        composer += before.replace(b"\\r", b"")
        if sep:
            if os.path.exists(base + "/lose-enter") and not lost:
                lost = True
            else:
                submit()
    draw()
    status(b"done")
`;

let serial = 0;

describe.skipIf(!HC)("the census crash table, on the wired pump", () => {
  const core = new PrivateCore("cn");
  let children: ChildProcess[] = [];
  const HOME = join(core.root, "h", "openrig");

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  interface Seat { dir: string; db: string; name: string; nodeId: string; acceptBody(id: string, body: string): void; seen: string; read(id: string): Record<string, unknown>; log(): string[]; hop(): string[]; accept(id: string): void; flag(name: string): void; launch(): Promise<void> }

  async function seatFixture(flags: string[] = [], runtime = "codex"): Promise<Seat> {
    const dir = mkdtempSync(join(core.root, "w-"));
    for (const flag of flags) writeFileSync(join(dir, flag), "");
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const id = ++serial;
    const name = `cx${id}@cr${id}`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const node = rigs.addNode(rigs.createRig(`cr${id}`).id, `cx${id}`, { role: "worker", runtime });
    const sessions = new SessionRegistry(handle);
    sessions.updateStatus(sessions.registerSession(node.id, name).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name });
    handle.close();
    const gateDir = join(seatGateRoot(HOME), seatGateFolder(name));
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(join(gateDir, "gate.json"), JSON.stringify({ version: 1 }));
    const seen = join(gateDir, "seen");
    const address = hcTerminalName(name);
    const launch = async () => {
      await core.client.call("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir, seen], name: address, labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true });
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("Ask Codex"), "the seat's first paint");
    };
    await launch();
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    return {
      dir, db, name, nodeId: node.id, seen, launch,
      acceptBody: (key, body) => { const h = createDb(db); try { new MessageStore(h).accept({ id: messageId(key), seat: name, sender: "lead@cr", body }); } finally { h.close(); } }, log: () => lines("seat.log"), hop: () => lines("hop.log"), flag: (f) => writeFileSync(join(dir, f), ""),
      read: (key) => { const h = createDb(db); try { return h.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(key) as Record<string, unknown>; } finally { h.close(); } },
      accept: (key) => { const h = createDb(db); try { new MessageStore(h).accept({ id: messageId(key), seat: name, sender: "lead@cr", body: `body of ${key}` }); } finally { h.close(); } },
    };
  }

  function daemon(s: Seat, crash: "none" | "before_bytes" | "after_bytes" = "none", send?: { id: string; body: string }): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: HOME, MPD_DB: s.db, MPD_DIR: s.dir, MPD_CRASH: crash, MPD_SEAT: s.name,
      ...(send ? { MPD_SEND: JSON.stringify({ seat: s.name, ...send }) } : {}),
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); writeFileSync(join(s.dir, "stderr.log"), stderr.join("")); });
    child.on("exit", (code) => { if (code) writeFileSync(join(s.dir, "child-failed"), stderr.join("")); });
    children.push(child);
    return child;
  }

  const kill = async (child: ChildProcess) => {
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.signalCode).toBe("SIGKILL");
  };
  const failed = (s: Seat) => { if (existsSync(join(s.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(s.dir, "child-failed"), "utf8").slice(0, 900)}`); };
  const hopSaw = async (s: Seat, line: string) => {
    try { await until(() => { failed(s); return s.hop(); }, (l) => l.includes(line), `hop line "${line}"`, 12_000); }
    catch (e) { const r = s.read("m1"); throw new Error(`${(e as Error).message}\nROW ${JSON.stringify(r ? { st: r.message_state, ds: r.delivery_state, p: r.message_pause_reason, a: r.attempts, n: r.message_next_attempt_ms, next: r.next_attempt_at } : null)}\nSTDERR ${existsSync(join(s.dir, "stderr.log")) ? readFileSync(join(s.dir, "stderr.log"), "utf8").slice(-1500) : ""}`); }
  };
  const received = async (s: Seat, id: string) => { await until(() => { failed(s); return s.read(id); }, (r) => r.message_state === "received", `${id} received`, 40_000); };
  const settleLook = () => new Promise((r) => setTimeout(r, 700));
  const lines = (s: Seat, prefix: string) => s.log().filter((l) => l.startsWith(prefix));
  const agentOnce = (s: Seat, id: string) => expect(lines(s, `agent ${id} `)).toHaveLength(1);
  /** A restart of the core with the seat alive: the terminal survives in its holder. */
  const restartCore = () => spawnSync(HC, ["server", "restart"], { env: core.env, stdio: "ignore", timeout: 20_000 });

  describe("the daemon dies", () => {
    it("P0, after the claim and before a byte: the restart resends, once", async () => {
      const s = await seatFixture();
      s.accept("m1");
      const first = daemon(s, "before_bytes");
      await hopSaw(s, "claimed m1");
      expect(s.read("m1").attempts).toBe(1);
      await kill(first);
      expect(s.log()).toEqual([]);
      daemon(s);
      await received(s, "m1");
      agentOnce(s, "m1");
      expect(lines(s, "unmarked")).toEqual([]);
    }, 90_000);

    it("P1, staged with its Enter lost: the restart sees this marker on the composer and presses Enter alone", async () => {
      const s = await seatFixture(["lose-enter"]);
      s.accept("m1");
      const first = daemon(s, "after_bytes");
      await hopSaw(s, "sent m1");
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text, (t) => t.includes("[openrig-msg m1:"), "the staged marker");
      await kill(first);
      expect(s.log()).toEqual([]);
      daemon(s);
      await received(s, "m1");
      agentOnce(s, "m1");
      expect(lines(s, "dropped")).toEqual([]);  // Enter alone: no second copy was typed
    }, 90_000);

    it("P1, staged and collapsed with its Enter lost: it cannot be told from a person's paste, so it holds as a draft, shows on health, and goes the moment it clears", async () => {
      const s = await seatFixture(["lose-enter"]);
      s.acceptBody("long", "x".repeat(1500));
      const first = daemon(s, "after_bytes");
      await hopSaw(s, "sent long");
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text, (t) => t.includes("[Pasted Content"), "the collapsed copy");
      await kill(first);
      daemon(s);
      await hopSaw(s, "paused:draft long");
      expect(s.read("long")).toMatchObject({ message_pause_reason: "draft", message_state: "attempting" });
      expect(lines(s, "ctrl-u")).toEqual([]);
      await core.client.call("terminal.keys", { terminal: hcTerminalName(s.name), keys: ["ctrl+u"] });  // the person clears it
      await received(s, "long");
      agentOnce(s, "long");
    }, 90_000);

    it("a person's collapsed paste of exactly that size, with no paste of ours behind it, is left alone", async () => {
      const s = await seatFixture();
      const size = `${"x".repeat(1500)}\n[openrig-msg long:${"0".repeat(32)}]`.length;
      expect(await new HcInput(core.client, new HcAttach(core.socketPath)).sendText(s.name, "y".repeat(size), undefined, { bracketed: true })).toMatchObject({ ok: true });
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text, (t) => t.includes("[Pasted Content"), "their paste");
      s.acceptBody("long", "x".repeat(1500));
      daemon(s);
      await hopSaw(s, "paused:draft long");
      await settleLook();
      expect(s.log()).toEqual([]);
      expect((await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text).toContain("[Pasted Content");
    }, 60_000);

    it("P2, landed and recorded: the restart reads the record and sends nothing", async () => {
      const s = await seatFixture();
      s.accept("m1");
      const first = daemon(s, "after_bytes");
      await hopSaw(s, "sent m1");
      await until(() => s.log(), (l) => l.length === 1, "the seat's record");
      await kill(first);
      daemon(s);
      await received(s, "m1");
      expect(s.hop().filter((l) => l === "claimed m1")).toHaveLength(1);
      agentOnce(s, "m1");
    }, 90_000);

    it("P2, landed and unread: the restart repeats it under the same id and nonce, the gate drops the repeat, and the next message passes", async () => {
      const s = await seatFixture(["hold"]);
      s.accept("m1");
      s.accept("m2");
      const first = daemon(s, "after_bytes");
      await hopSaw(s, "sent m1");
      await kill(first);
      daemon(s);
      await until(() => s.hop(), (l) => l.filter((x) => x === "claimed m1").length >= 2, "a repeat of m1", 30_000);
      expect(s.hop()).not.toContain("claimed m2");
      s.flag("go");
      await received(s, "m1");
      await received(s, "m2");
      agentOnce(s, "m1");
      agentOnce(s, "m2");
    }, 90_000);

    it("a send through SessionTransport survives the same crash: the transport wrote nothing", async () => {
      const s = await seatFixture();
      const first = daemon(s, "after_bytes", { id: "t1", body: "from a sender" });
      await hopSaw(s, "sent t1");
      await until(() => s.log(), (l) => l.length === 1, "the seat's record");
      await kill(first);
      daemon(s);
      await received(s, "t1");
      await settleLook();
      expect(s.log()).toEqual(["agent t1 from a sender"]);
    }, 90_000);
  });

  describe("the core restarts, the seat alive", () => {
    it("P0, before the attempt: the attempt pauses, then goes, once", async () => {
      const s = await seatFixture();
      daemon(s);
      await hopSaw(s, "booted");
      restartCore();
      s.accept("m1");
      await received(s, "m1");
      agentOnce(s, "m1");
    }, 90_000);

    it("P1, staged with its Enter lost: Enter alone after the restart, one copy", async () => {
      const s = await seatFixture(["lose-enter"]);
      s.accept("m1");
      daemon(s);
      await hopSaw(s, "sent m1");
      restartCore();
      await received(s, "m1");
      agentOnce(s, "m1");
      expect(lines(s, "dropped")).toEqual([]);
    }, 90_000);

    it("P2, landed: the record stands, and nothing is sent again", async () => {
      const s = await seatFixture();
      s.accept("m1");
      daemon(s);
      await received(s, "m1");
      restartCore();
      await settleLook();
      expect(s.hop().filter((l) => l === "claimed m1")).toHaveLength(1);
      agentOnce(s, "m1");
    }, 90_000);
  });

  describe("the seat restarts", () => {
    it("a held text dies with the process: the new process gets it, once", async () => {
      const s = await seatFixture(["hold"]);
      s.accept("m1");
      daemon(s);
      await hopSaw(s, "sent m1");
      await core.client.call("terminal.kill", { terminal: hcTerminalName(s.name) });
      await core.client.call("terminal.rm", { terminal: hcTerminalName(s.name) });
      expect(s.log()).toEqual([]);
      s.flag("go");
      await s.launch();
      await received(s, "m1");
      agentOnce(s, "m1");
    }, 90_000);

    it("M5, recorded and never durable: reconcile clears it, the row reopens, and the resend reaches the agent once", async () => {
      const s = await seatFixture(["die-after-record"]);
      s.accept("m1");
      daemon(s);
      await received(s, "m1");  // the gate's record is all the pump can know
      expect(s.log()).toEqual([]);
      s.flag("reconcile");
      await until(() => existsSync(join(s.dir, "reconcile.done")), Boolean, "reconcile");
      await s.launch();
      await until(() => s.read("m1"), (r) => r.message_state === "received" && lines(s, "agent m1 ").length === 1, "the resend", 40_000);
      agentOnce(s, "m1");
    }, 90_000);
  });

  it("Claude: a new process reconciles through the daemon's own onGateCleared, and a row recorded but never durable opens again", async () => {
    const s = await seatFixture([], "claude-code");
    s.accept("m1");
    daemon(s);
    await hopSaw(s, "claimed m1");
    const nonce = await until(() => s.read("m1").native_nonce, Boolean, "the row's nonce") as string;
    const transcript = join(s.dir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const gone = spawnSync("/usr/bin/true").pid;
    mkdirSync(s.seen, { recursive: true });
    const name = createHash("sha256").update(`m1:${nonce}`).digest("hex");
    writeFileSync(join(s.seen, name), JSON.stringify({ id: "m1", nonce, recordedAt: "1999-01-01T00:00:00.000Z", via: "hook", agentPid: gone, transcriptPath: transcript, durable: false }));
    await received(s, "m1");
    writeFileSync(join(s.dir, "register-claude"), JSON.stringify({ nodeId: s.nodeId, sessionName: s.name, transcriptPath: transcript }));
    await hopSaw(s, "registered");
    await until(() => s.read("m1"), (r) => r.delivery_state === "pending" && r.message_state === "attempting", "the row reopened");
    expect(s.read("m1").native_nonce).toBe(nonce);
    expect(existsSync(join(s.seen, name))).toBe(false);
  }, 60_000);

  describe("compaction", () => {
    it("M6: refused while compacting, nothing recorded: the pump's next attempt lands, once", async () => {
      const s = await seatFixture(["compacting"]);
      s.accept("m1");
      daemon(s);
      await until(() => s.log(), (l) => l.includes("refused"), "a refusal");
      spawnSync("/bin/rm", ["-f", join(s.dir, "compacting")]);
      await received(s, "m1");
      agentOnce(s, "m1");
    }, 90_000);
  });

  it("a person's draft holds the attempt, across a daemon crash too: nothing is added or submitted", async () => {
    const s = await seatFixture();
    const input = new HcInput(core.client, new HcAttach(core.socketPath));
    expect(await input.sendText(s.name, "half a thought", undefined, { bracketed: false })).toMatchObject({ ok: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text, (t) => t.includes("half a thought"), "the draft");
    s.accept("m1");
    const first = daemon(s);
    await hopSaw(s, "paused:draft m1");
    await kill(first);
    daemon(s);
    await until(() => s.hop().filter((l) => l === "paused:draft m1"), (l) => l.length >= 2, "the restarted pump holding it too", 30_000);
    expect(s.read("m1").message_state).toBe("attempting");
    expect(s.log()).toEqual([]);
    const screen = (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(s.name) })).text;
    expect(screen).toContain("half a thought");
    expect(screen).not.toContain("openrig-msg");
  }, 60_000);
});
