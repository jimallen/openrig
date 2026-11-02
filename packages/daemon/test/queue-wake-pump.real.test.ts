// Delivery S4d on a private core: a real daemon process, a real pty and the real ladder tick, with a stub agent. The seat's gate is the stub
// program's own, so what "arrived once" means here is that program's log. The design's case: the cap passes while the seat is stopped, the
// notice goes once, and the wake still arrives when the seat comes back, through a daemon crash in between.
//
// Boundary: a stub gate, hop and agent, so this proves the ladder and the pump, not a runtime. The daemon is createDaemon, not index.ts, and the
// ladder's clock is moved past the cap by the child, since a real cap is 15 minutes.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { WAKE_ESCALATION_TAG } from "../src/domain/queue-wake-ladder.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/wake-pump-daemon.ts");

/** The stub agent: its gate lives in it, and records an id before its "agent" line. */
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
        found = re.search(rb"\\[openrig-msg id=([^\\]]+)\\]", line)
        if not found:
            continue
        try:
            os.close(os.open(base + "/seen/" + found.group(1).decode(), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            log.write(b"agent " + found.group(1) + b"\\n")
        except FileExistsError:
            log.write(b"dropped " + found.group(1) + b"\\n")
    os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\\\x1b]7501;state=idle:app=stub\\x1b\\\\")
`;

describe.skipIf(!HC)("a wake past the cap, on a private core", () => {
  const core = new PrivateCore("wp");
  let children: ChildProcess[] = [];

  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterEach(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  it("cap passed with the seat stopped, daemon killed, seat back: the wake arrives once and there was one escalation", async () => {
    const dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "seen"));
    writeFileSync(join(dir, "seat.py"), SEAT_PROGRAM);
    writeFileSync(join(dir, "seat.log"), "");
    writeFileSync(join(dir, "hop.log"), "");
    const seat = "dev@wake-rig";
    const db = join(dir, "d.sqlite");
    const setup = createDb(db);
    migrate(setup, ALL_MIGRATIONS);
    const rigs = new RigRepository(setup);
    const rig = rigs.createRig("wake-rig");
    const sessions = new SessionRegistry(setup);
    for (const [logical, session] of [["dev", seat], ["relay", "relay@wake-rig"], ["sender", "sender@wake-rig"]] as const) {
      const node = rigs.addNode(rig.id, logical, { role: "worker", runtime: "claude-code" });
      sessions.updateStatus(sessions.registerSession(node.id, session).id, "running");
      sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: session });
    }
    setup.close();

    const read = <T>(query: (h: ReturnType<typeof createDb>) => T): T => { const h = createDb(db); try { return query(h); } finally { h.close(); } };
    const lines = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    const escalations = () => read((h) => h.prepare("SELECT state FROM queue_items WHERE tags LIKE ?").all(`%"${WAKE_ESCALATION_TAG}"%`) as Array<{ state: string }>);
    const wake = (id: string) => read((h) => h.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>);
    const item = (id: string) => read((h) => h.prepare("SELECT state, last_nudge_result FROM queue_items WHERE qitem_id = ?").get(id) as { state: string; last_nudge_result: string });

    const daemon = (extra: NodeJS.ProcessEnv): ChildProcess => {
      const env: NodeJS.ProcessEnv = {
        ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"),
        OPENRIG_TRANSPORT_MESSAGE_PUMP: "true", WPD_DB: db, WPD_DIR: dir, WPD_SEAT: seat, ...extra,
      };
      const stderr: string[] = [];
      const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
      child.on("exit", (code) => { if (code) writeFileSync(join(dir, "child-failed"), stderr.join("")); });
      children.push(child);
      return child;
    };
    const waitFor = <T>(read: () => T, test: (value: T) => boolean, what: string) => until(() => {
      if (existsSync(join(dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(dir, "child-failed"), "utf8").slice(0, 800)}`);
      return read();
    }, test, what, 40_000);

    // No terminal yet: the seat is stopped, and the hop says so.
    const first = daemon({ WPD_HANDOFF: JSON.stringify({ source: "sender@wake-rig", relay: "relay@wake-rig" }), WPD_LADDER: "1" });
    const handed = await waitFor(() => lines("hop.log"), (l) => l.some((x) => x.startsWith("handed ")), "the hand-off");
    const qitemId = handed.find((x) => x.startsWith("handed "))!.slice("handed ".length);
    const wakeId = `wake-intent-${qitemId}`;
    await waitFor(() => lines("hop.log"), (l) => l.includes(`stopped ${wakeId}`), "an attempt on the stopped seat");
    await waitFor(escalations, (e) => e.length === 1, "the notice");
    await waitFor(() => lines("hop.log"), (l) => l.filter((x) => x.startsWith("tick ")).length >= 6, "ticks past the notice");
    expect(escalations()).toEqual([{ state: "pending" }]);
    expect(wake(wakeId)).toMatchObject({ message_state: "attempting", delivery_state: "pending" });
    expect(item(qitemId)).toEqual({ state: "pending", last_nudge_result: "retained:pump" });

    expect(first.pid).toBeGreaterThan(0);
    first.kill("SIGKILL");
    await new Promise((r) => first.once("exit", r));
    expect(first.signalCode).toBe("SIGKILL");

    const address = hcTerminalName(seat);
    await core.client.call("terminal.run", { argv: ["/usr/bin/python3", "-I", join(dir, "seat.py"), dir], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the seat's first paint");

    daemon({ WPD_LADDER: "1" });
    await waitFor(() => wake(wakeId), (r) => r.message_state === "received", "the wake received");
    await waitFor(() => item(qitemId), (i) => i.last_nudge_result === "verified", "the item's own result");
    await waitFor(escalations, (e) => e.every((x) => x.state === "done"), "the notice retiring");

    expect(wake(wakeId)).toMatchObject({ delivery_state: "delivered", ack_evidence: "gate_seen" });
    expect(escalations()).toEqual([{ state: "done" }]);
    expect(lines("seat.log").filter((l) => l === `agent ${wakeId}`)).toHaveLength(1);
    expect(item(qitemId).state).toBe("pending");  // the wake arrived: the item is still the seat's to claim
  }, 120_000);
});
