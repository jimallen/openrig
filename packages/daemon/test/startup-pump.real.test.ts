// S4g on a real daemon: the real createDaemon, StartupOrchestrator, pump and delivery guard, a real private core, and a real program on a real pty as the seat,
// whose own gate records an id before its "agent" sees the text. Boundary: the gate, the hop and the runtime adapter are stubs
// (test/helpers/startup-pump-daemon.ts), and startNode is called directly, not through a route, so this proves startup's use of the pump, not any runtime: no real agent ran.
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
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/startup-pump-daemon.ts");

/** `gate` on: it records an id, then its "agent" reads the text. Off: it reads the text and records nothing, so a sender only ever sees bytes leave. */
const SEAT_PROGRAM = `
import os, re, sys, tty
base, gate = sys.argv[1:3]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h\\x1b]7501;state=idle:app=stub\\x1b\\\\READY\\r\\n")
log = open(base + "/seat.log", "ab", buffering=0)
open(base + "/ready.seat", "w").close()
pending = b""
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    pending += chunk.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"")
    while b"\\r" in pending:
        line, pending = pending.split(b"\\r", 1)
        if not line:
            continue
        found = re.search(rb"\\[openrig-msg id=([^\\]]+)\\] (.*)", line)
        if not found:
            log.write(b"unmarked " + line + b"\\n")
            continue
        if gate == "gate":
            open(base + "/seen/" + found.group(1).decode(), "x").close()
        log.write(b"agent " + found.group(2)[:60] + b"\\n")
`;

let serial = 0;

describe.skipIf(!HC)("startup text through the pump, on a real daemon and a private core", () => {
  const core = new PrivateCore("sp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  async function fixture(options: { gate: "gate" | "no-gate"; waitMs?: number; queued?: string; newOccupant?: boolean }) {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    writeFileSync(join(dir, "one.txt"), "file one");
    writeFileSync(join(dir, "two.txt"), "file two");
    const n = ++serial;
    const seat = `dev${n}@start-rig-${n}`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const rig = rigs.createRig(`start-rig-${n}`);
    const node = rigs.addNode(rig.id, `dev${n}`, { role: "worker", runtime: "stub", cwd: dir });
    const sessions = new SessionRegistry(handle);
    const session = sessions.registerSession(node.id, seat);
    sessions.updateStatus(session.id, "running");
    const shell = await core.client.call<{ id: string }>("terminal.run", { argv: ["/bin/sh"], name: hcTerminalName(seat), labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir });
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: shell.id });
    const tenure = sessions.currentOccupantTenure(node.id)!.generationUuid;
    handle.close();
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_TRANSPORT_MESSAGE_PUMP: "true",
      SPD_DB: db, SPD_DIR: dir, SPD_SEAT: seat, SPD_NODE: node.id, SPD_RIG: rig.id, SPD_SESSION: session.id,
      SPD_SEAT_COMMAND: `exec /usr/bin/python3 -I ${join(dir, "seat.py")} ${dir} ${options.gate}`,
      ...(options.waitMs ? { SPD_WAIT_MS: String(options.waitMs) } : {}), ...(options.queued ? { SPD_QUEUED_DURING_LAUNCH: options.queued } : {}),
      ...(options.newOccupant ? { SPD_NEW_OCCUPANT_DURING_LAUNCH: "1" } : {}),
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    child.on("exit", (code) => { if (code) writeFileSync(join(dir, "child-failed"), stderr.join("")); });
    children.push(child);
    const result = async () => {
      await until(() => lines("hop.log"), (l) => l.some((x) => x.startsWith("result ")) || existsSync(join(dir, "child-failed")), "startup's result", 60_000);
      if (existsSync(join(dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(dir, "child-failed"), "utf8").slice(0, 1500)}`);
      return JSON.parse(lines("hop.log").find((x) => x.startsWith("result "))!.slice("result ".length)) as Record<string, unknown>;
    };
    const query = <T>(sql: string): T => { const h = createDb(db); try { return h.prepare(sql).all() as T; } finally { h.close(); } };
    return { tenure, result, query, seatLog: () => lines("seat.log"), hopLog: () => lines("hop.log") };
  }

  type Row = Record<string, unknown>;
  const startupRows = (f: Awaited<ReturnType<typeof fixture>>) => f.query<Row[]>("SELECT * FROM outbox_entries WHERE sender_session = 'startup@system' ORDER BY rowid");

  it("two files and a queued message arrive file, file, message, each by the seat's gate, bound to the occupant", async () => {
    const f = await fixture({ gate: "gate", queued: "queued-1" });
    expect(await f.result()).toMatchObject({ ok: true, startupStatus: "ready" });
    await until(() => f.seatLog(), (l) => l.length >= 3, "the queued message");
    expect(f.seatLog()).toEqual(["agent file one", "agent file two", "agent queued text"]);
    expect(startupRows(f)).toMatchObject([
      { message_state: "received", class: "lifecycle", lane: 0, attempts: 1, ack_evidence: "gate_seen", occupant_generation: f.tenure },
      { message_state: "received", class: "lifecycle", lane: 0, attempts: 1, ack_evidence: "gate_seen", occupant_generation: f.tenure },
    ]);
  }, 90_000);

  it("a gate that never records: startup fails, the row ends, the next file never goes, and nothing more is typed", async () => {
    const f = await fixture({ gate: "no-gate", waitMs: 1_500 });
    expect(await f.result()).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(startupRows(f)).toMatchObject([{ message_state: "undeliverable", ack_evidence: "superseded", delivery_state: "failed", attempts: 1 }]);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(f.hopLog().filter((l) => l.startsWith("claimed "))).toHaveLength(1);
    expect(f.seatLog()).toEqual(["agent file one"]);
  }, 90_000);

  it("a new occupant during startup: its text never reaches that occupant, and startup fails", async () => {
    const f = await fixture({ gate: "gate", newOccupant: true });
    expect(await f.result()).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(startupRows(f)).toMatchObject([{ message_state: "undeliverable", occupant_generation: f.tenure, attempts: 0 }]);
    expect(f.seatLog()).toEqual([]);
  }, 90_000);
});
