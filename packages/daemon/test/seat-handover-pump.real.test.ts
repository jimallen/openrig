// S4f on a real daemon: the real createDaemon and `/api/seat/handover` route, the real successor launcher, a real private core, and a real program on a
// real pty as the seat, whose own gate records an id before its "agent" sees the text. Boundary: the gate, the hop and the runtime adapter are stubs
// (test/helpers/seat-handover-pump-daemon.ts), so this proves the handover's use of the pump, not any runtime: no real agent ran.
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
const CHILD = resolve(here, "helpers/seat-handover-pump-daemon.ts");

/** `gate` on: it records an id, then its "agent" reads the text. Off: it reads the text and records nothing, so a sender only ever sees bytes leave. */
const SEAT_PROGRAM = `
import os, re, sys, time, tty
base, role, gate = sys.argv[1:4]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h\\x1b]7501;state=idle:app=stub\\x1b\\\\READY\\r\\n")
log = open(base + "/seat.log", "ab", buffering=0)
open(base + "/ready." + role, "w").close()
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
            log.write(role.encode() + b" unmarked " + line + b"\\n")
            continue
        mid = found.group(1).decode()
        if gate == "gate":
            open(base + "/seen/" + mid, "x").close()
        log.write(role.encode() + b" agent " + found.group(1) + b" " + found.group(2)[:60] + b"\\n")
`;

let serial = 0;
const SESSION_DAEMON_ENV = (core: PrivateCore): NodeJS.ProcessEnv => ({
  ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_TRANSPORT_MESSAGE_PUMP: "true",
});

describe.skipIf(!HC)("a handover's packet through the pump, on a real daemon and a private core", () => {
  const core = new PrivateCore("hp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  async function fixture(options: { gate: "gate" | "no-gate"; backoffMs?: number; queued?: string }) {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const n = ++serial;
    const seat = `dev${n}@hand-rig-${n}`;
    const db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const rigs = new RigRepository(handle);
    const rig = rigs.createRig(`hand-rig-${n}`);
    const node = rigs.addNode(rig.id, `dev${n}`, { role: "worker", runtime: "stub", cwd: dir });
    const sessions = new SessionRegistry(handle);
    const session = sessions.registerSession(node.id, seat);
    sessions.updateStatus(session.id, "running");
    sessions.updateStartupStatus(session.id, "ready", "2026-11-01T12:00:00Z");
    const address = hcTerminalName(seat);
    const retiree = await core.client.call<{ id: string }>("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir, "retiree", "gate"], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir });
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: retiree.id });
    const tenure = sessions.mintOccupantTenure(node.id, "fresh").generationUuid;
    handle.close();
    await until(() => existsSync(join(dir, "ready.retiree")), Boolean, "the retiree's first paint");
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const env: NodeJS.ProcessEnv = {
      ...SESSION_DAEMON_ENV(core), HPD_DB: db, HPD_DIR: dir, HPD_SEAT: seat, HPD_SEAT_COMMAND: `exec /usr/bin/python3 -I ${join(dir, "seat.py")} ${dir} successor ${options.gate}`,
      ...(options.backoffMs ? { HPD_BACKOFF_MS: String(options.backoffMs) } : {}), ...(options.queued ? { HPD_QUEUED_DURING_LAUNCH: options.queued } : {}),
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    child.on("exit", (code) => { if (code) writeFileSync(join(dir, "child-failed"), stderr.join("")); });
    children.push(child);
    const route = async () => {
      await until(() => lines("hop.log"), (l) => l.some((x) => x.startsWith("route ")) || existsSync(join(dir, "child-failed")), "the route's answer", 60_000);
      if (existsSync(join(dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(dir, "child-failed"), "utf8").slice(0, 1500)}`);
      const line = lines("hop.log").find((x) => x.startsWith("route "))!;
      const [, status, body] = /^route (\d+) (.*)$/.exec(line)!;
      return { status: Number(status), body: JSON.parse(body!) as Record<string, unknown> };
    };
    const query = <T>(sql: string, ...args: unknown[]): T => { const h = createDb(db); try { return h.prepare(sql).all(...args) as T; } finally { h.close(); } };
    return { dir, seat, nodeId: node.id, tenure, route, query, seatLog: () => lines("seat.log"), hopLog: () => lines("hop.log") };
  }

  type Row = Record<string, unknown>;
  const packets = (f: Awaited<ReturnType<typeof fixture>>) => f.query<Row[]>("SELECT * FROM outbox_entries WHERE sender_session = 'handover@system'");

  it("the successor takes the packet once, by its gate, and the handover commits only after the record", async () => {
    const f = await fixture({ gate: "gate" });
    const answer = await f.route();
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });
    const [generation] = f.query<Array<{ g: string }>>("SELECT generation_uuid AS g FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1", f.nodeId);
    expect(generation!.g).not.toBe(f.tenure);
    const id = `seat-msg-handover-${generation!.g}-restore`;
    expect(packets(f)).toMatchObject([{ outbox_id: id, message_state: "received", class: "lifecycle", lane: 0, attempts: 1, ack_evidence: "gate_seen" }]);
    expect(f.seatLog()).toHaveLength(1);
    expect(f.seatLog()[0]).toContain(`successor agent ${id} `);
  }, 90_000);

  it("a gate that never records: the handover fails, the candidate unwinds, the row ends, and the next attempt time passes with nothing typed", async () => {
    const f = await fixture({ gate: "no-gate", backoffMs: 13_500 });
    const answer = await f.route();
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 500, body: { code: "context_delivery_failed" } });
    expect(packets(f)).toMatchObject([{ message_state: "undeliverable", ack_evidence: "superseded", delivery_state: "failed", attempts: 1 }]);
    expect(f.query<Row[]>("SELECT status FROM discovered_sessions WHERE tmux_session = ?", f.seat)).toEqual([{ status: "vanished" }]);
    expect(f.query<Row[]>("SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1", f.nodeId)).toEqual([{ generation_uuid: f.tenure }]);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(f.hopLog().filter((l) => l.startsWith("claimed "))).toHaveLength(1);
    expect(f.seatLog()).toHaveLength(1);
  }, 90_000);

  it("a message queued during the launch reaches the successor after its packet, and never blocks it", async () => {
    const f = await fixture({ gate: "gate", queued: "queued-1" });
    const answer = await f.route();
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });
    await until(() => f.seatLog(), (l) => l.length >= 2, "the queued message");
    expect(f.seatLog().map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual([expect.stringMatching(/^successor agent seat-msg-handover-.*-restore$/), "successor agent queued-1"]);
  }, 90_000);
});
