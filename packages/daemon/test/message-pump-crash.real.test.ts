// Seat Messaging S3: a real daemon process killed mid-attempt, on a private core. The daemon is the real createDaemon on a database file
// (test/helpers/message-pump-daemon.ts); the seat is a real program on a real pty, whose own gate records an id before its "agent" sees
// the text and drops a repeat. What "no double" means here is the program's own log: one `agent` line per id, whatever crossed the pty.
//
// Boundary: the gate and the hop are stubs, so this proves the pump, not any runtime (M1-M10 do that). The child boots createDaemon, not
// index.ts's server, so no HTTP route is exercised, and no sender is wired yet: rows are accepted through MessageStore, as S4 will.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/message-pump-daemon.ts");

/** The seat: a status-reporting program whose gate lives in it. `hold` keeps it from reading stdin until the file `go` exists, so a
 *  repeat can reach the pty before the first copy is read: the case a gate exists for. */
const SEAT_PROGRAM = `
import os, re, sys, time, tty
base = sys.argv[1]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h\\x1b]7501;state=idle:app=stub\\x1b\\\\READY\\r\\n")
log = open(base + "/seat.log", "ab", buffering=0)
if os.path.exists(base + "/hold"):
    while not os.path.exists(base + "/go"):
        time.sleep(0.02)
pending = b""
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    pending += chunk.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"")
    while b"\\r" in pending:
        line, pending = pending.split(b"\\r", 1)
        found = re.search(rb"\\[openrig-msg id=([^\\]]+)\\] (.*)", line)
        if not found:
            continue
        mid = found.group(1).decode()
        try:
            os.close(os.open(base + "/seen/" + mid, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            log.write(b"agent " + found.group(1) + b" " + found.group(2) + b"\\n")
        except FileExistsError:
            log.write(b"dropped " + found.group(1) + b"\\n")
    os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\\\x1b]7501;state=idle:app=stub\\x1b\\\\")
`;

const SEAT = "dev@pump-rig";
let serial = 0;

describe.skipIf(!HC)("the pump across a daemon crash, on a private core", () => {
  const core = new PrivateCore("mp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  interface Fixture { dir: string; db: string; seat: string; read(id: string): Record<string, unknown>; seatLog(): string[]; hopLog(): string[]; accept(id: string): void }

  async function fixture(options: { hold?: boolean } = {}): Promise<Fixture> {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    if (options.hold) writeFileSync(join(dir, "hold"), "");
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const seat = `dev${++serial}@pump-rig`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const rig = rigs.createRig(`pump-rig-${serial}`);
    const node = rigs.addNode(rig.id, `dev${serial}`, { role: "worker", runtime: "claude-code" });
    const sessions = new SessionRegistry(handle);
    sessions.updateStatus(sessions.registerSession(node.id, seat).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat });
    handle.close();
    const address = hcTerminalName(seat);
    await core.client.call("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the seat's first paint");
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    return {
      dir, db, seat,
      read: (id) => { const h = createDb(db); try { return h.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>; } finally { h.close(); } },
      seatLog: () => lines("seat.log"), hopLog: () => lines("hop.log"),
      accept: (id) => { const h = createDb(db); try { new MessageStore(h).accept({ id: messageId(id), seat, sender: "lead@pump-rig", body: `body of ${id}` }); } finally { h.close(); } },
    };
  }

  function daemon(f: Fixture, crash: "none" | "before_bytes" | "after_bytes", setting = "true"): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"),
      OPENRIG_TRANSPORT_MESSAGE_PUMP: setting, MPD_DB: f.db, MPD_DIR: f.dir, MPD_CRASH: crash,
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    child.on("exit", (code) => { if (code) writeFileSync(join(f.dir, "child-failed"), stderr.join("")); });
    children.push(child);
    return child;
  }

  const kill = async (child: ChildProcess) => {
    expect(child.pid, "our own child").toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.signalCode).toBe("SIGKILL");
  };
  const hopSaw = (f: Fixture, line: string) => until(() => f.hopLog(), (l) => l.includes(line) || existsSync(join(f.dir, "child-failed")), `hop line "${line}"`, 40_000)
    .then(() => { if (existsSync(join(f.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(f.dir, "child-failed"), "utf8").slice(0, 800)}`); });
  const count = (lines: string[], line: string) => lines.filter((l) => l === line).length;
  const received = (f: Fixture, id: string) => until(() => f.read(id), (r) => r.message_state === "received", `${id} received`, 40_000);

  it("killed after the claim and before any byte left: resends from the database, and the agent sees it once", async () => {
    const f = await fixture();
    f.accept("m1");
    const first = daemon(f, "before_bytes");
    await hopSaw(f, "claimed m1");
    expect(f.read("m1")).toMatchObject({ message_state: "attempting", attempts: 1, delivery_state: "pending" });
    await kill(first);

    daemon(f, "none");
    await received(f, "m1");
    expect(f.read("m1")).toMatchObject({ attempts: 2, delivery_state: "delivered", ack_evidence: "gate_seen" });
    expect(f.seatLog()).toEqual(["agent m1 body of m1"]);
  }, 90_000);

  it("killed after the bytes left and the gate recorded: the restart reads the record and sends nothing", async () => {
    const f = await fixture();
    f.accept("m1");
    const first = daemon(f, "after_bytes");
    await hopSaw(f, "sent m1");
    await until(() => f.seatLog(), (l) => l.length === 1, "the seat's record");
    await kill(first);

    daemon(f, "none");
    await received(f, "m1");
    expect(f.read("m1").attempts).toBe(1);
    expect(count(f.hopLog(), "claimed m1")).toBe(1);
    expect(f.seatLog()).toEqual(["agent m1 body of m1"]);
  }, 90_000);

  it("killed after the bytes left and before the seat read them: the restart sends again, the gate drops the repeat, and a new id still passes", async () => {
    const f = await fixture({ hold: true });
    f.accept("m1");
    f.accept("m2");
    const first = daemon(f, "after_bytes");
    await hopSaw(f, "sent m1");
    await kill(first);
    expect(f.seatLog()).toEqual([]);

    daemon(f, "none");
    await until(() => f.hopLog(), (l) => count(l, "sent m1") >= 2, "a repeat of m1");
    expect(count(f.hopLog(), "claimed m2")).toBe(0);  // FIFO holds across the crash: m2 waits for m1's record
    writeFileSync(join(f.dir, "go"), "");
    await received(f, "m1");
    await received(f, "m2");
    const log = f.seatLog();
    expect(log.filter((l) => l.startsWith("agent "))).toEqual(["agent m1 body of m1", "agent m2 body of m2"]);
    expect(log.filter((l) => l === "dropped m1").length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("with the setting off, the same daemon drives nothing", async () => {
    const f = await fixture();
    f.accept("m1");
    daemon(f, "none", "false");
    await hopSaw(f, "booted");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(f.read("m1")).toMatchObject({ message_state: "accepted", attempts: 0 });
    expect(f.hopLog()).toEqual(["booted"]);
  }, 60_000);
});
