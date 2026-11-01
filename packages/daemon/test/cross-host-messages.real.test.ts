// Seat Messaging S4h on two real daemons: createDaemon with its real routes and pump on each side, a private core, the real relay, and a stub
// agent. "Old" is a real older build, exported from git at OLD_BUILD (the S4a tip: the pump, no accept route and no capability), run from its own
// source on the same database, so a mixed pair is two builds, not a flag.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { crossHostMessageId } from "../src/domain/seat-messaging/far-daemon.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const OLD_BUILD = "72f894b1f0f5b0b80ffec3a60b847ca5b6ade741";
const here = dirname(fileURLToPath(import.meta.url));
const DAEMON_PACKAGE = resolve(here, "..");
const REPO = resolve(here, "../../..");
const CHILD = "test/helpers/delivery-daemon.ts";
const CLI = resolve(here, "../../cli/src/index.ts");
const SEATPY = resolve(here, "helpers/delivery-seat.py");
const RELAY = resolve(here, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const TOKEN = "cross-host-token";
const NEAR_HOST = "near-host";
const FAR_HOST = "far-host";
let serial = 0;
let port = 22100 + (process.pid % 500);

const gitHasOldBuild = spawnSync("git", ["-C", REPO, "cat-file", "-e", `${OLD_BUILD}^{commit}`]).status === 0;

describe.skipIf(!HC || !gitHasOldBuild)("a message across two real daemons", () => {
  const core = new PrivateCore("xh");
  let children: ChildProcess[] = [];
  let oldPackage = "";
  let CODEX_SEAT = "";

  beforeAll(() => {
    expect(Buffer.byteLength(core.socketPath)).toBeLessThan(103);
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    CODEX_SEAT = join(core.root, "codex-seat.py");
    copyFileSync(SEATPY, CODEX_SEAT);
    core.start();
    const old = join(core.root, "old");
    mkdirSync(old);
    const archive = join(core.root, "old.tar");
    expect(spawnSync("git", ["-C", REPO, "archive", "--format=tar", "-o", archive, OLD_BUILD, "packages/daemon", "tsconfig.base.json"]).status).toBe(0);
    expect(spawnSync("tar", ["-xf", archive, "-C", old]).status).toBe(0);
    symlinkSync(join(REPO, "node_modules"), join(old, "node_modules"));
    symlinkSync(join(DAEMON_PACKAGE, "node_modules"), join(old, "packages/daemon/node_modules"));
    oldPackage = join(old, "packages/daemon");
    expect(readFileSync(join(oldPackage, "src/server.ts"), "utf8")).not.toContain("messaging");
  });
  afterEach(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); children = []; });
  afterAll(() => core.stop());

  /** One daemon's folder: its database, its OPENRIG_HOME, its port. */
  function host(tag: string) {
    const dir = mkdtempSync(join(core.root, `${tag}-`));
    const home = join(dir, "home"); mkdirSync(home);
    for (const f of ["seat.log", "hop.log"]) writeFileSync(join(dir, f), "");
    const db = join(dir, "d.sqlite");
    const h = createDb(db); migrate(h, ALL_MIGRATIONS); h.close();
    const qport = ++port;
    const withDb = <T,>(fn: (c: ReturnType<typeof createDb>) => T): T => { const c = createDb(db); try { return fn(c); } finally { c.close(); } };
    return { dir, home, db, qport, withDb, name: tag === "near" ? NEAR_HOST : FAR_HOST,
      read: (id: string) => withDb((c) => c.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown> | undefined),
      count: () => withDb((c) => (c.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n),
      lines: (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean),
      registry: (entries: Array<{ id: string; url: string }>) => writeFileSync(join(home, "hosts.yaml"), `hosts:\n${entries.map((e) => `  - id: ${e.id}\n    transport: http\n    url: ${e.url}\n`).join("")}`),
    };
  }
  type Host = ReturnType<typeof host>;

  function daemon(h: Host, opts: { build?: string } = {}): ChildProcess {
    const cwd = opts.build ?? DAEMON_PACKAGE;
    const err: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", join(cwd, CHILD)], { cwd, stdio: ["ignore", "ignore", "pipe"], env: {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: h.home, MPD_DB: h.db, MPD_DIR: h.dir,
      CODEX_HOME: join(core.root, "h", "codex"), DELIVERY_PORT: String(h.qport), OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, OPENRIG_HOST_NAME: h.name,
    } });
    child.stderr?.on("data", (b: Buffer) => { err.push(b.toString()); if (err.length > 40) err.shift(); writeFileSync(join(h.dir, "stderr.log"), err.join("")); });
    child.on("exit", (code) => { if (code) writeFileSync(join(h.dir, "child-failed"), err.join("")); });
    children.push(child);
    return child;
  }
  const failed = (h: Host) => { if (existsSync(join(h.dir, "child-failed"))) throw new Error(`daemon died: ${readFileSync(join(h.dir, "child-failed"), "utf8").slice(0, 900)}`); };
  const booted = async (h: Host) => {
    const before = h.lines("hop.log").filter((l) => l === "booted").length;
    return async () => { await until(() => { failed(h); return h.lines("hop.log").filter((l) => l === "booted").length; }, (n) => n > before, `${h.name} boot`, 60_000); };
  };
  const start = async (h: Host, opts: { build?: string } = {}) => { const up = await booted(h); const child = daemon(h, opts); await up(); return child; };
  const kill = async (c: ChildProcess) => { expect(c.exitCode).toBeNull(); c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const http = (h: Host, path: string, body?: unknown, sender?: string) => {
    const bodyFile = join(h.dir, "req.json");
    if (body !== undefined) writeFileSync(bodyFile, JSON.stringify(body));
    const out = spawnSync("/usr/bin/curl", ["-s", "-w", "\n%{http_code}", ...(body === undefined ? [] : ["-X", "POST", "-H", "content-type: application/json", ...(sender ? ["-H", `x-openrig-session: ${sender}`] : []), "--data-binary", `@${bodyFile}`]), `http://127.0.0.1:${h.qport}${path}`], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
    const at = out.lastIndexOf("\n");
    const text = out.slice(0, at);
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a 404 from an old build is text */ }
    return { status: Number(out.slice(at + 1)), text, json };
  };
  /** The real CLI, as a seat on the near host runs it. */
  const rigSend = (near: Host, seat: string, text: string, sender: string, extra: string[] = []) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", CLI, "send", seat, text, "--host", "sparky", ...extra], { cwd: DAEMON_PACKAGE, encoding: "utf8", env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(core.root, "h"), OPENRIG_HOME: near.home, TMPDIR: join(core.root, "h"), OPENRIG_URL: `http://127.0.0.1:${near.qport}`, OPENRIG_SESSION_NAME: sender,
    } });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  };

  /** A rig with one stub Codex seat on the far host. */
  function seat(far: Host) {
    const id = ++serial; const name = `cx${id}@xr${id}`;
    const nodeId = far.withDb((c) => {
      const rigs = new RigRepository(c); const rig = rigs.createRig(`xr${id}`);
      const node = rigs.addNode(rig.id, `cx${id}`, { role: "worker", runtime: "codex" });
      const sessions = new SessionRegistry(c);
      sessions.updateStatus(sessions.registerSession(node.id, name).id, "running");
      sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name });
      return node.id;
    });
    const gateDir = join(seatGateRoot(far.home), seatGateFolder(name));
    const address = hcTerminalName(name);
    const launch = async () => {
      const env = [`OPENRIG_SESSION_NAME=${name}`, "OPENRIG_RUNTIME=codex", `OPENRIG_HOME=${far.home}`, `OPENRIG_NODE_ID=${nodeId}`, `OPENRIG_URL=http://127.0.0.1:${far.qport}`, `OPENRIG_ACTIVITY_HOOK_TOKEN=${TOKEN}`];
      const launcher = join(far.dir, "openrig-tmux-send-stub");
      writeFileSync(launcher, `/usr/bin/python3 -I ${CODEX_SEAT} "$@"\n:\n`);
      await core.client.call("terminal.run", { argv: ["/usr/bin/env", ...env, "/bin/sh", launcher, far.dir, RELAY, process.execPath, "codex"], name: address, labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true, cwd: far.dir });
      await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("Ask Codex"), "first paint");
      await until(() => existsSync(join(gateDir, "gate.json")), Boolean, "the relay's declaration");
    };
    return { name, nodeId, launch };
  }
  const agentCopies = (far: Host, id: string) => far.lines("seat.log").filter((l) => l.startsWith(`agent ${id} `));
  const state = (h: Host, id: string, want: string, ms = 30_000) => until(() => { failed(h); return h.read(id); }, (r) => r?.message_state === want, `${h.name} ${id} ${want}`, ms);
  const sender = (near: Host) => { const lead = `lead${++serial}@lead${serial}`; near.withDb((c) => { const rigs = new RigRepository(c); const [member, rig] = lead.split("@") as [string, string]; rigs.addNode(rigs.createRig(rig).id, member, { role: "worker", runtime: "terminal" }); }); return lead; };
  async function pair() {
    const near = host("near"); const far = host("far");
    near.registry([{ id: "sparky", url: `http://127.0.0.1:${far.qport}` }]);
    far.registry([{ id: "laptop", url: `http://127.0.0.1:${near.qport}` }]);
    return { near, far };
  }
  const nearId = (near: Host) => String(http(near, "/healthz").json["selfHostId"]);

  it("new to new: the CLI posts to its own daemon, the far pump carries it to the seat once, and a resend under the id is free", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(far); await start(near);
    await s.launch();
    expect(http(far, "/healthz").json["messaging"]).toBe(1);
    const run = rigSend(near, s.name, "across", lead, ["--id", "job-1"]);
    expect(run.out).toContain("Held by sparky (job-1)");
    expect(run.out).not.toContain("Sent to");
    expect(run.status).toBe(0);
    expect(near.read("job-1")).toMatchObject({ message_state: "received", ack_evidence: "far_accepted", sender_session: lead });
    const farId = crossHostMessageId(nearId(near), "job-1");
    await state(far, farId, "received");
    expect(far.read(farId)).toMatchObject({ destination_session: s.name, sender_session: `${lead}@${nearId(near)}`, ack_evidence: "gate_seen" });
    await until(() => agentCopies(far, farId), (l) => l.length > 0, "the agent's copy");
    const again = rigSend(near, s.name, "across", lead, ["--id", "job-1"]);
    expect(again.out).toContain("Held by sparky");
    await wait(800);
    expect(agentCopies(far, farId).length).toBe(1);
    expect(far.count()).toBe(1);
  }, 120_000);

  it("new to new: a repeated far accept after the seat took it adds no row and no copy, and a changed body is refused", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(far); await start(near);
    await s.launch();
    const send = { id: "m1", seat: s.name, body: "the text", class: "content", origin: { host: "laptop", sender: `${lead}@laptop` } };
    const farId = crossHostMessageId("laptop", "m1");
    expect(http(far, "/api/messages/accept", send).status).toBe(200);
    await state(far, farId, "received");
    expect(http(far, "/api/messages/accept", send).status).toBe(200);
    const conflict = http(far, "/api/messages/accept", { ...send, body: "another" });
    expect(conflict.status).toBe(409);
    expect(conflict.json["code"]).toBe("delivery_identity_conflict");
    await wait(800);
    expect(agentCopies(far, farId).length).toBe(1);
    expect(far.count()).toBe(1);
  }, 120_000);

  it("the sender's daemon killed after the far commit: on boot the row reads the far row, and the seat has one copy", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(far); const nearChild = await start(near);
    await s.launch();
    const id = nearId(near);
    const farId = crossHostMessageId(id, "m2");
    expect(http(near, "/api/messages/send-far", { host: "sparky", session: s.name, text: "survives", deliveryId: "m2", waitMs: 0 }, lead).json).toMatchObject({ messageId: "m2" });
    await until(() => far.read(farId), Boolean, "the far commit");
    await kill(nearChild);
    await start(near);
    await state(near, "m2", "received");
    await state(far, farId, "received");
    await wait(500);
    expect(agentCopies(far, farId).length).toBe(1);
  }, 120_000);

  it("the far daemon down: the row is held, and it goes when the far daemon is back, once", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    const farChild = await start(far); await start(near);
    await s.launch();
    expect(rigSend(near, s.name, "warm", lead, ["--id", "warm"]).out).toContain("Held by sparky");  // capability read while it answered
    await kill(farChild);
    const run = rigSend(near, s.name, "while down", lead, ["--id", "m3"]);
    expect(run.out).toContain("Accepted for");
    await until(() => near.read("m3"), (r) => r?.message_pause_reason === "gate_unavailable", "the pause", 30_000);
    expect(near.read("m3")).toMatchObject({ message_state: "attempting" });
    await start(far);
    await state(near, "m3", "received", 60_000);
    const farId = crossHostMessageId(nearId(near), "m3");
    await state(far, farId, "received");
    await wait(500);
    expect(agentCopies(far, farId).length).toBe(1);
  }, 180_000);

  it("new to old: the sender is told, nothing is held here, and today's path reaches the far seat", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(far, { build: oldPackage }); await start(near);
    await s.launch();
    expect(http(far, "/healthz").json).not.toHaveProperty("messaging");
    expect(http(far, "/api/messages/takes?seat=x").status).toBe(404);
    const run = rigSend(near, s.name, "to the old build", lead, ["--id", "m4"]);
    expect(run.out).toContain("at most once");
    expect(run.status).toBe(0);
    expect(near.count()).toBe(0);
    await until(() => far.read("m4"), Boolean, "today's row at the far end");
    expect(far.read("m4")).toMatchObject({ destination_session: s.name });
    await until(() => agentCopies(far, "m4"), (l) => l.length > 0, "the agent's copy");
  }, 120_000);

  it("a new CLI on an old local daemon: nothing is held here, and today's path reaches the far seat once", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(far); await start(near, { build: oldPackage });
    await s.launch();
    expect(http(near, "/healthz").json).not.toHaveProperty("messaging");
    const run = rigSend(near, s.name, "from beside an old daemon", lead, ["--id", "m8"]);
    expect(run.out).not.toContain("may hold");
    expect(run.status).toBe(0);
    expect(near.count()).toBe(0);
    await state(far, "m8", "received");
    expect(agentCopies(far, "m8").length).toBe(1);
  }, 120_000);

  it("old to new: an old CLI's POST to /api/transport/send still lands, row first, on the far pump", async () => {
    const { far } = await pair();
    const s = seat(far);
    await start(far);
    await s.launch();
    const res = http(far, "/api/transport/send", { session: s.name, text: "from an old cli", deliveryId: "m5" }, "lead@old");
    expect(res.status).toBe(200);
    expect(res.json["reason"]).toBe("handed_to_pump");
    await state(far, "m5", "received");
    expect(agentCopies(far, "m5").length).toBe(1);
  }, 120_000);

  it("the far daemon goes old mid-flight: the row is held and resumes on return, with no accept lost and no double", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    const newFar = await start(far); await start(near);
    await s.launch();
    expect(rigSend(near, s.name, "warm", lead, ["--id", "warm"]).out).toContain("Held by sparky");
    await kill(newFar);
    const oldFar = await start(far, { build: oldPackage });
    expect(http(far, "/healthz").json).not.toHaveProperty("messaging");
    const stuck = http(near, "/api/messages/send-far", { host: "sparky", session: s.name, text: "mid flight", deliveryId: "m6", waitMs: 0 }, lead);
    expect(stuck.json).toMatchObject({ outcome: "accepted", messageId: "m6" });  // the capability read while it was new is under its 30 s
    await until(() => near.read("m6"), (r) => r?.message_pause_reason === "gate_unavailable" || r?.message_last_refusal !== null, "held", 45_000);
    expect(near.read("m6")?.message_state).not.toBe("received");
    await kill(oldFar);
    await start(far);
    await state(near, "m6", "received", 60_000);
    const farId = crossHostMessageId(nearId(near), "m6");
    await state(far, farId, "received");
    await wait(500);
    expect(agentCopies(far, farId).length).toBe(1);
  }, 240_000);

  it("undeliverable at the far end goes back to the sender's queue on its own host, once", async () => {
    const { near, far } = await pair();
    const s = seat(far); const lead = sender(near);
    await start(near);
    const id = nearId(near);
    const farId = crossHostMessageId(id, "m7");
    far.withDb((c) => {
      new MessageStore(c).accept({ id: messageId(farId), seat: s.name, sender: `${lead}@laptop`, body: "never arrives", messageClass: "content" });
      c.prepare("UPDATE rigs SET archived_at = datetime('now')").run();
    });
    await start(far);
    await state(far, farId, "undeliverable");
    const items = near.withDb((c) => c.prepare("SELECT destination_session AS d, body FROM queue_items").all() as Array<{ d: string; body: string }>);
    expect(items.length).toBe(1);
    expect(items[0]!.d).toBe(lead);
    expect(items[0]!.body).toContain("never arrives");
    expect(far.read(farId)?.ack_detail).toMatch(/^qitem-returned-/);
  }, 120_000);
});
