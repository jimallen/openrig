// hc-w46 (QA F2), on a PRIVATE hc core (test/hc-private-core.ts: own HOME, HC_SESSION and XDG paths): a broadcast to seats that
// report status and start no run. hc holds each such send ~5 s waiting for `working`; delivered serially, N seats took N x 5.5 s
// (QA: 3 seats 15.6 s). Delivered eight at a time, 10 seats take two waves. Measured through the REAL route (transportRoutes), the
// real SessionTransport, the real HcDelivery and a real OutboxHandler, so the outcome rows and the outbox rows are the production ones.
//
// What it shows: the wait, one result per recipient in the recipient order, one outbox row per recipient (delivered, the sender and
// body as before), and that each seat received ITS message once and only its own (the stub logs what it is typed).
//
// Not shown: real agents (the stubs only report status and echo), more than 10 seats, a host with a slow disk.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcDelivery } from "../src/adapters/hc-delivery.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { transportRoutes } from "../src/routes/transport.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { tmuxStub } from "./helpers/tmux-stub.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

/** A status-reporting program on a pty that starts no run: idle at rest, it echoes what it is typed and stays idle. */
const STUB = `
import os, sys, tty
log_path = sys.argv[1]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h")
os.write(1, b"\\x1b]7501;state=idle:app=stub\\x1b\\\\")
os.write(1, b"READY\\r\\n")
log = open(log_path, "ab", buffering=0)
while True:
    try:
        b = os.read(0, 65536)
    except InterruptedError:
        continue
    if not b:
        break
    log.write(b.hex().encode() + b"\\n")
    os.write(1, b.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"").replace(b"\\r", b"\\r\\n"))
`;

const N = 10;
const RIG = "bcr-rig";
const SEATS = Array.from({ length: N }, (_, i) => `s${String(i + 1).padStart(2, "0")}@${RIG}`);

describe.skipIf(!HC)("a broadcast to seats that start no run, on a private hc core", () => {
  const core = new PrivateCore("bcr");
  const attach = new HcAttach(core.socketPath);
  let db: Database.Database;
  let app: Hono;
  let outbox: OutboxHandler;
  const logOf = (seat: string) => join(core.root, "w", `${seat.split("@")[0]}.log`);
  const typed = (seat: string) => readFileSync(logOf(seat), "utf8").split("\n").filter(Boolean).map((hex) => Buffer.from(hex, "hex").toString("latin1")).join("");

  beforeAll(async () => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
    mkdirSync(join(core.root, "w"), { recursive: true });
    const stub = join(core.root, "w", "stub.py");
    writeFileSync(stub, STUB);
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig(RIG);
    for (const seat of SEATS) {
      writeFileSync(logOf(seat), "");
      await core.client.call("terminal.run", { argv: ["python3", "-I", stub, logOf(seat)], name: hcTerminalName(seat), labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
      const node = rigRepo.addNode(rig.id, seat.split("@")[0]!, { role: "worker", runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, seat);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat });
    }
    for (const seat of SEATS) await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(seat) })).text, (t) => t.includes("READY"), `${seat} first paint`);
    const delivery = new HcDelivery(core.client, new HcInput(core.client, attach));
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, hcDelivery: delivery, sleep: async () => undefined,
      tmuxAdapter: tmuxStub({
        hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        capturePaneContent: async () => "idle\n❯ ", listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
        getPanePid: async () => null, getPaneCommand: async () => null,
      }),
    });
    outbox = new OutboxHandler(db);
    app = new Hono();
    app.use("*", async (c, next) => {
      (c.set.bind(c) as (k: string, v: unknown) => void)("sessionTransport", transport);
      (c.set.bind(c) as (k: string, v: unknown) => void)("outboxHandler", outbox);
      await next();
    });
    app.route("/api/transport", transportRoutes());
  }, 120_000);
  afterAll(() => { db?.close(); core.stop(); });

  it(`${N} seats: two waves, not ${N} in a row; one result and one outbox row per recipient; each seat gets the message once`, async () => {
    const started = Date.now();
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json", "X-OpenRig-Session": `boss@${RIG}` },
      body: JSON.stringify({ sessions: SEATS, text: "BROADCAST-BODY", envelopeSender: "ignored" }),
    });
    const elapsed = Date.now() - started;
    const body = await res.json() as { total: number; sent: number; failed: number; results: Array<{ ok: boolean; sessionName: string; outcome?: string; path?: string }> };
    expect(res.status).toBe(200);
    // serial delivery measured ~5.5 s per seat (55 s here); eight at a time is two waves
    expect(elapsed, `took ${elapsed} ms`).toBeLessThan(30_000);
    expect(elapsed, "positive control: hc really did hold the sends (this is not a no-op)").toBeGreaterThan(4_500);
    expect(body).toMatchObject({ total: N, sent: N, failed: 0 });
    expect(body.results.map((r) => r.sessionName)).toEqual(SEATS);
    expect(body.results.every((r) => r.ok && r.path === "hc")).toBe(true);

    const rows = db.prepare("SELECT destination_session AS d, sender_session AS s, body, delivery_state AS state FROM outbox_entries ORDER BY destination_session").all() as Array<{ d: string; s: string; body: string; state: string }>;
    expect(rows.map((r) => r.d)).toEqual([...SEATS].sort());
    expect(new Set(rows.map((r) => r.s))).toEqual(new Set([`boss@${RIG}`]));
    expect(rows.every((r) => r.state === "delivered" && r.body === "BROADCAST-BODY")).toBe(true);

    for (const seat of SEATS) {
      const got = typed(seat);
      expect(got.split("BROADCAST-BODY").length - 1, `${seat} got its message once`).toBe(1);
      expect(got, `${seat} got the envelope with the sender`).toContain(`From: boss@${RIG}`);
      expect(got.split("From: ").length - 1, `${seat} got ONE envelope`).toBe(1);
    }
  }, 120_000);
});
