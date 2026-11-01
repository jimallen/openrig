// Seat Messaging S4e: a real daemon process killed in the middle of a compaction sequence, on a private core. The daemon is the real createDaemon
// with its real enforcer and pump (test/helpers/compaction-pump-daemon.ts); the seat is a real program on a real pty whose own gate records an id
// before its "agent" sees the text. "Once" is the program's own log: one `agent` line per id, whatever crossed the pty.
//
// Boundary: the gate and the hop are stubs and no real agent ran, so this proves the enforcer's order across a crash, not a runtime, and says
// nothing of compaction itself. The parent stands in for ContextMonitor, one drain per `tick` file. `/compact` is not in this file.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CompactionStageStore } from "../src/domain/compaction-stage-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/compaction-pump-daemon.ts");

/** The stub agent. `hold` keeps it from reading stdin until the file `go` exists, so a message can be on the pty and not yet recorded. */
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
        found = re.search(rb"\\[openrig-msg id=([^\\]]+)\\]", line)
        if not found:
            log.write(b"unmarked\\n")
            continue
        mid = found.group(1).decode()
        try:
            os.close(os.open(base + "/seen/" + mid, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            log.write(b"agent " + found.group(1) + b"\\n")
        except FileExistsError:
            log.write(b"dropped " + found.group(1) + b"\\n")
`;

const CYCLE = "cycle-1";
const RESTORE = `seat-msg-compaction-${CYCLE}-restore_prompt`;
const COMPLIANCE = `seat-msg-compaction-${CYCLE}-compliance_prompt`;
let serial = 0;

describe.skipIf(!HC)("the compaction sequence across a daemon crash, on a private core", () => {
  const core = new PrivateCore("cp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  interface Fixture { dir: string; db: string; seat: string; read(id: string): Record<string, unknown> | undefined; stage(): string | null | undefined; seatLog(): string[]; hopLog(): string[]; acceptContent(id: string): void }

  async function fixture(options: { hold?: boolean } = {}): Promise<Fixture> {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    if (options.hold) writeFileSync(join(dir, "hold"), "");
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const id = ++serial;
    const seat = `dev${id}@compact-rig`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const node = rigs.addNode(rigs.createRig(`compact-rig-${id}`).id, `dev${id}`, { role: "worker", runtime: "claude-code" });
    const sessions = new SessionRegistry(handle);
    sessions.updateStatus(sessions.registerSession(node.id, seat).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat });
    // As `sendPreparedCompact` leaves it. An operator's manual sequence, so the default policy (disabled) drains it.
    new CompactionStageStore(handle).save({
      sessionName: seat, stage: "restore_prompt", stageGeneration: sessions.currentOccupantGenerationForSession(seat), stageCycle: CYCLE,
      manual: { stage: "compact-sent", updatedAt: 1, operatorInitiated: true }, preparation: null,
    });
    handle.close();
    const address = hcTerminalName(seat);
    await core.client.call("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the seat's first paint");
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const withDb = <T,>(fn: (h: ReturnType<typeof createDb>) => T): T => { const h = createDb(db); try { return fn(h); } finally { h.close(); } };
    return {
      dir, db, seat,
      read: (mid) => withDb((h) => h.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(mid) as Record<string, unknown> | undefined),
      stage: () => withDb((h) => new CompactionStageStore(h).loadAll().find((s) => s.sessionName === seat)?.stage),
      seatLog: () => lines("seat.log"), hopLog: () => lines("hop.log"),
      acceptContent: (mid) => withDb((h) => { new MessageStore(h).accept({ id: messageId(mid), seat, sender: "lead@compact-rig", body: `body of ${mid}` }); }),
    };
  }

  function daemon(f: Fixture, crash: "none" | "before_bytes" = "none"): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"),
      OPENRIG_TRANSPORT_MESSAGE_PUMP: "true", MPD_DB: f.db, MPD_DIR: f.dir, MPD_SEAT: f.seat, MPD_CRASH: crash,
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
  const count = (lines: string[], line: string) => lines.filter((l) => l === line).length;
  /** Waits for the nth copy of a line, so a repeat of a line from before a restart is seen as new. */
  const hopSaw = (f: Fixture, line: string, nth = 1) => until(() => f.hopLog(), (l) => count(l, line) >= nth || existsSync(join(f.dir, "child-failed")), `hop line "${line}"`, 40_000)
    .then(() => { if (existsSync(join(f.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(f.dir, "child-failed"), "utf8").slice(0, 800)}`); });
  const poll = async (f: Fixture, expected: string) => {
    const nth = count(f.hopLog(), `drained ${expected}`) + 1;
    writeFileSync(join(f.dir, "tick"), "");
    await hopSaw(f, `drained ${expected}`, nth);
  };
  const received = (f: Fixture, id: string) => until(() => f.read(id), (r) => r?.message_state === "received", `${id} received`, 40_000);

  it("killed between the restore's record and the compliance: after boot compliance goes, restore does not, and a message queued now waits behind them", async () => {
    const f = await fixture();
    const first = daemon(f);
    await hopSaw(f, "booted");
    await poll(f, "triggered");
    await received(f, RESTORE);
    await kill(first);
    expect(f.stage()).toBe("restore_prompt");   // the stage moves on a read of the record, and no poll ran: the crash window

    daemon(f);
    await hopSaw(f, "booted", 2);
    f.acceptContent("m1");
    await until(() => f.read("m1"), (r) => r?.message_pause_reason === "lane_held", "m1 held by the restored sequence", 20_000);
    await poll(f, "triggered");
    await received(f, COMPLIANCE);
    await received(f, "m1");
    await poll(f, "triggered");
    expect(f.stage() ?? null).toBeNull();
    expect(count(f.hopLog(), `claimed ${RESTORE}`)).toBe(1);
    expect(f.seatLog()).toEqual([`agent ${RESTORE}`, `agent ${COMPLIANCE}`, "agent m1"]);
  }, 120_000);

  it("killed with the restore on the pty and unread: the stage stays, the next poll accepts nothing, and the agent sees each prompt once", async () => {
    const f = await fixture({ hold: true });
    const first = daemon(f);
    await hopSaw(f, "booted");
    await poll(f, "triggered");
    await hopSaw(f, `sent ${RESTORE}`);
    await poll(f, "stage_in_flight");
    expect(f.stage()).toBe("restore_prompt");
    await kill(first);

    daemon(f);
    await hopSaw(f, "booted", 2);
    await poll(f, "stage_in_flight");
    expect(f.read(COMPLIANCE)).toBeUndefined();
    writeFileSync(join(f.dir, "go"), "");
    await received(f, RESTORE);
    await poll(f, "triggered");
    await received(f, COMPLIANCE);
    expect(f.seatLog().filter((l) => l.startsWith("agent "))).toEqual([`agent ${RESTORE}`, `agent ${COMPLIANCE}`]);
  }, 120_000);

  it("killed after the claim and before any byte left: the new daemon's pump sends it, and the sequence goes on", async () => {
    const f = await fixture();
    const first = daemon(f, "before_bytes");
    await hopSaw(f, "booted");
    await poll(f, "triggered");
    await hopSaw(f, `claimed ${RESTORE}`);
    await kill(first);
    expect(f.seatLog()).toEqual([]);

    daemon(f);
    await hopSaw(f, "booted", 2);
    await received(f, RESTORE);
    expect(f.read(RESTORE)).toMatchObject({ attempts: 2 });
    await poll(f, "triggered");
    await received(f, COMPLIANCE);
    expect(f.seatLog()).toEqual([`agent ${RESTORE}`, `agent ${COMPLIANCE}`]);
  }, 120_000);
});
