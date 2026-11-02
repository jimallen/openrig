// S4b and S4c on a real daemon process and a private core: the post-restart wake and a watchdog wake go in through the daemon's own wiring
// (its event bus, its watchdog engine), and the pump carries them to a real program on a real pty, whose gate records an id before its
// "agent" sees the text. What counts is that program's log.
//
// Boundary: the gate and hop are stubs and the seat is no real agent, so this proves the consumers' wiring and the pump, not any runtime.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { postRestartDeliveryId } from "../src/domain/post-restart-notifier.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-pump.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/consumer-pump-daemon.ts");

const SEAT_PROGRAM = `
import os, re, sys, tty
base = sys.argv[1]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h\\x1b]7501;state=idle:app=stub\\x1b\\\\READY\\r\\n")
log = open(base + "/seat.log", "ab", buffering=0)
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
            log.write(b"unmarked " + line + b"\\n")
            continue
        mid = found.group(1).decode()
        try:
            os.close(os.open(base + "/seen/" + mid, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            log.write(b"agent " + found.group(1) + b"\\n")
        except FileExistsError:
            log.write(b"dropped " + found.group(1) + b"\\n")
    os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\\\x1b]7501;state=idle:app=stub\\x1b\\\\")
`;

let serial = 0;

describe.skipIf(!HC)("S4b and S4c through a real daemon, on a private core", () => {
  const core = new PrivateCore("cp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    expect(Buffer.byteLength(core.socketPath)).toBeLessThan(103);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  async function fixture() {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const n = ++serial;
    const seat = `dev${n}@consumer-rig-${n}`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const rig = rigs.createRig(`consumer-rig-${n}`);
    const node = rigs.addNode(rig.id, `dev${n}`, { role: "worker", runtime: "claude-code" });
    const sessions = new SessionRegistry(handle);
    sessions.updateStatus(sessions.registerSession(node.id, seat).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat });
    const generation = sessions.currentOccupantGenerationForSession(seat);
    expect(generation, "the seat's fixture has a tenure, so the generation rules are not vacuous").not.toBeNull();
    handle.close();
    const address = hcTerminalName(seat);
    await core.client.call("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the seat's first paint");
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const on = <T>(use: (h: ReturnType<typeof createDb>) => T): T => { const h = createDb(db); try { return use(h); } finally { h.close(); } };
    return {
      dir, db, seat, rigId: rig.id, nodeId: node.id, generation, on, seatLog: () => lines("seat.log"), hopLog: () => lines("hop.log"),
      rows: () => on((h) => h.prepare("SELECT * FROM outbox_entries ORDER BY rowid").all() as Array<Record<string, unknown>>),
      /** A new occupant of the seat: a later launch, as `rig seat launch --fresh` registers one. */
      relaunch: () => on((h) => { const s = new SessionRegistry(h); s.updateStatus(s.registerSession(node.id, seat).id, "running"); }),
      job: (input: { targetGenerationUuid?: string | null } = {}) => on((h) => new WatchdogJobsRepository(h).register({ policy: "periodic-reminder", specYaml: JSON.stringify({ target: { session: seat }, message: "stand by" }), targetSession: seat, intervalSeconds: 60, registeredBySession: "test@rig", ...input }).jobId),
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function daemon(f: Fixture, action?: object, firstDelayMs = 0): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_TRANSPORT_MESSAGE_PUMP: "true",
      CPD_DB: f.db, CPD_DIR: f.dir, CPD_FIRST_DELAY_MS: String(firstDelayMs), ...(action ? { CPD_ACT: JSON.stringify(action) } : {}),
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    child.on("exit", (code) => { if (code) writeFileSync(join(f.dir, "child-failed"), stderr.join("")); });
    children.push(child);
    return child;
  }
  const kill = async (child: ChildProcess) => {
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.signalCode).toBe("SIGKILL");
  };
  const hopSaw = (f: Fixture, line: string) => until(() => f.hopLog(), (l) => l.includes(line) || existsSync(join(f.dir, "child-failed")), `hop line "${line}"`, 40_000)
    .then(() => { if (existsSync(join(f.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(f.dir, "child-failed"), "utf8").slice(0, 800)}`); });
  const eachRow = (f: Fixture, id: string, want: (r: Record<string, unknown>) => boolean, what: string) => until(() => f.rows().find((r) => r.outbox_id === id) ?? {}, want, what, 40_000);
  const seq = (f: Fixture) => f.on((h) => (h.prepare("SELECT max(seq) AS seq FROM events WHERE type = 'restore.completed'").get() as { seq: number }).seq);

  it("post-restart: killed after the accept and before the first attempt, the boot makes one row and one send", async () => {
    const f = await fixture();
    const first = daemon(f, { restore: { rigId: f.rigId, nodeId: f.nodeId } }, 4_000);
    await hopSaw(f, "restored");
    const id = postRestartDeliveryId(seq(f), f.nodeId);
    await kill(first);
    expect(f.rows().map((r) => [r.outbox_id, r.message_state, r.attempts, r.lane, r.occupant_generation])).toEqual([[id, "accepted", 0, 2, f.generation]]);
    expect(f.hopLog().filter((l) => l.startsWith("claimed"))).toEqual([]);

    daemon(f);
    await eachRow(f, id, (r) => r.message_state === "received", "the wake received");
    await new Promise((r) => setTimeout(r, 500));
    expect(f.rows()).toHaveLength(1);
    expect(f.hopLog().filter((l) => l.startsWith("claimed"))).toEqual([`claimed ${id}`]);
    expect(f.seatLog()).toEqual([`agent ${id}`]);
  }, 90_000);

  it("post-restart: a session started after the restore ends the row, with no notice and nothing at the seat (the check is wired in startup)", async () => {
    const f = await fixture();
    daemon(f, { restore: { rigId: f.rigId, nodeId: f.nodeId } }, 1_500);
    await hopSaw(f, "restored");
    const id = postRestartDeliveryId(seq(f), f.nodeId);
    f.relaunch();
    await eachRow(f, id, (r) => r.message_state === "undeliverable", "the wake ended");
    await new Promise((r) => setTimeout(r, 300));
    expect(f.rows()).toMatchObject([{ outbox_id: id, ack_evidence: "superseded", attempts: 0, message_previous_occupant: null }]);
    expect(f.seatLog()).toEqual([]);
  }, 90_000);

  it("watchdog: a seat out across 3 scans and a daemon restart gets one row per occurrence and one delivery, and every scan reads sent", async () => {
    const f = await fixture();
    writeFileSync(join(f.dir, "stopped"), "");
    const jobId = f.job();
    const first = daemon(f, { scan: { jobIds: [jobId], times: 3 } });
    await hopSaw(f, "scanned");
    expect(f.hopLog().filter((l) => l.startsWith("scan "))).toEqual(["scan ok sent", "scan ok sent", "scan ok sent"]);
    const rows = f.rows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.audit_pointer))).toEqual(new Set([jobId]));
    await kill(first);

    rmSync(join(f.dir, "stopped"));
    daemon(f);
    const newest = rows[2]!.outbox_id as string;
    await eachRow(f, newest, (r) => r.message_state === "received", "the newest occurrence received");
    await new Promise((r) => setTimeout(r, 500));
    expect(f.rows().map((r) => r.message_state)).toEqual(["undeliverable", "undeliverable", "received"]);
    expect(f.hopLog().filter((l) => l.startsWith("claimed"))).toEqual([`claimed ${newest}`]);
    expect(f.seatLog()).toEqual([`agent ${newest}`]);
  }, 90_000);

  it("watchdog: a generation-bound wake stops at a target that handed over after the fire; a role-bound one goes on, labelled", async () => {
    const f = await fixture();
    writeFileSync(join(f.dir, "stopped"), "");
    const bound = f.job({ targetGenerationUuid: f.generation });
    const role = f.job();
    daemon(f, { scan: { jobIds: [bound, role], times: 1 } });
    await hopSaw(f, "scanned");
    const [boundId, roleId] = f.rows().map((r) => r.outbox_id as string) as [string, string];
    f.relaunch();
    await eachRow(f, boundId, (r) => r.message_state === "undeliverable", "the bound wake ended");
    expect(f.rows()[0]).toMatchObject({ ack_evidence: "superseded", attempts: 0 });
    await eachRow(f, roleId, (r) => r.message_previous_occupant === f.generation, "the role-bound wake relabelled");

    rmSync(join(f.dir, "stopped"));
    await eachRow(f, roleId, (r) => r.message_state === "received", "the role-bound wake received");
    expect(f.seatLog()).toEqual([`agent ${roleId}`]);
    expect(f.hopLog().find((l) => l.startsWith(`body ${roleId}`))).toContain(PREVIOUS_OCCUPANT_LABEL);
  }, 90_000);
});
