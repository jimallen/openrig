// pda L2a round 2: `rig seat pda-release`, the daemon side. POST /api/sessions/:sessionName/pda-release asks the seat's
// pda-runner to retry its held message once more by creating `release.request` in the seat's OWN state dir. Fail-closed
// constraints from the L2a security review (section 10): the seat is resolved only through the registry (the canonical
// session name from the database, never a path from the request), it must be a pda seat, its state dir must be a real
// directory directly under the pda state root, the sidecar must show a held head, a reason is required, the file is
// created exclusively (O_EXCL, O_NOFOLLOW, 0600) and a second request while one is pending is refused. One audit event,
// with no message content. The last row drives the REAL runner against L1a's fake pda through the route.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { pdaSeatPaths, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import { makeRig, waitFor, type Rig } from "./helpers/pda-runner-rig.js";

const SEAT = "dev-research@rig";
let db: Database.Database;
let dir: string;
let stateRoot: string;
let rigObj: Rig | null = null;

beforeEach(() => {
  db = createFullTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-release-"));
  stateRoot = path.join(dir, "state", "pda");
  fs.mkdirSync(stateRoot, { recursive: true });
});
afterEach(async () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); await rigObj?.cleanup(); rigObj = null; });

function seat(name: string, runtime = "pda"): string {
  const repo = new RigRepository(db);
  const rig = repo.createRig(`rig-${Math.random().toString(36).slice(2, 8)}`);
  const node = repo.addNode(rig.id, `dev.${name.replace(/[^a-z]/g, "").slice(0, 8) || "x"}`, { runtime });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerSession(node.id, name);
  sessions.updateStatus(session.id, "running");
  return node.id;
}
function sidecar(name: string, over: Partial<PdaRunnerState> = {}, root = stateRoot): void {
  const paths = pdaSeatPaths(root, name);
  fs.mkdirSync(paths.seatRoot, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
    ready: true, launchId: "l1", updatedAt: at, aliveAt: at, agent: "research", baseUrl: "http://127.0.0.1:8150",
    connected: true, busy: false, outboxPending: 1, held: { requestId: "openrig/n/l/1", code: "pda_message_held", at }, ...over,
  }));
}

function app(root = stateRoot) {
  const eventBus = new EventBus(db);
  const pda = new PdaRuntimeAdapter({
    tmux: {} as never, stateRoot: root, runnerEntryPath: "/x", tokenFile: () => "/nope",
    fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: () => null },
  });
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("sessionRegistry" as never, new SessionRegistry(db) as never);
    c.set("rigRepo" as never, new RigRepository(db) as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("runtimeAdapters" as never, { pda } as never);
    c.set("terminalBearerToken" as never, "term-token" as never);
    await next();
  });
  hono.route("/api/sessions", sessionAdminRoutes);
  const post = (name: string, body: Record<string, unknown>, auth = "Bearer term-token") => hono.request(`/api/sessions/${encodeURIComponent(name)}/pda-release`, {
    method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body),
  });
  return { post };
}
const releaseFile = (name: string, root = stateRoot) => pdaSeatPaths(root, name).releaseRequestPath;
const events = () => db.prepare("SELECT type, payload FROM events WHERE type = 'seat.pda_release_requested'").all() as Array<{ type: string; payload: string }>;

describe("POST /api/sessions/:sessionName/pda-release", () => {
  it("creates release.request in the seat's own state dir (regular file, 0600), audits it without content, and says it may duplicate", async () => {
    const nodeId = seat(SEAT);
    sidecar(SEAT);
    const res = await app().post(SEAT, { reason: "pda restarted", operator: "ops@kernel" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, sessionName: SEAT, heldCode: "pda_message_held", runnerAlive: true });
    expect(String(body.message)).toContain("may be delivered twice");
    const st = fs.lstatSync(releaseFile(SEAT));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBeLessThanOrEqual(4096);
    const audit = events();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payload)).toMatchObject({ nodeId, sessionName: SEAT, heldRequestId: "openrig/n/l/1", reason: "pda restarted", actor: "ops@kernel" });
  });

  it("refuses, writing nothing: no reason (400), unknown seat (404), not a pda seat (409), nothing held (409), a release already pending (409)", async () => {
    seat(SEAT);
    sidecar(SEAT);
    const a = app();
    expect((await a.post(SEAT, { reason: "  " })).status).toBe(400);
    expect((await a.post("nobody@rig", { reason: "x" })).status).toBe(404);
    seat("dev-codex@rig", "codex");
    sidecar("dev-codex@rig");
    const notPda = await a.post("dev-codex@rig", { reason: "x" });
    expect(notPda.status).toBe(409);
    expect(await notPda.json()).toMatchObject({ code: "not_a_pda_seat" });
    expect(fs.existsSync(releaseFile("dev-codex@rig"))).toBe(false);
    seat("dev-idle@rig");
    sidecar("dev-idle@rig", { held: undefined });
    const idle = await a.post("dev-idle@rig", { reason: "x" });
    expect(idle.status).toBe(409);
    expect(await idle.json()).toMatchObject({ code: "no_held_message" });
    expect(fs.existsSync(releaseFile("dev-idle@rig"))).toBe(false);
    expect((await a.post(SEAT, { reason: "first" })).status).toBe(200);
    const again = await a.post(SEAT, { reason: "second" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "release_pending" });
    expect(events()).toHaveLength(1);
  });

  it("the path is the seat's own: a symlinked seat dir, a symlink at release.request, or a session name that is not one path segment is refused", async () => {
    seat(SEAT);
    const elsewhere = path.join(dir, "elsewhere");
    sidecar(SEAT, {}, elsewhere);
    fs.symlinkSync(pdaSeatPaths(elsewhere, SEAT).seatRoot, pdaSeatPaths(stateRoot, SEAT).seatRoot);
    const linked = await app().post(SEAT, { reason: "x" });
    expect(linked.status).toBe(409);
    expect(await linked.json()).toMatchObject({ code: "seat_state_unsafe" });
    expect(fs.existsSync(releaseFile(SEAT, elsewhere))).toBe(false);

    seat("dev-trap@rig");
    sidecar("dev-trap@rig");
    const target = path.join(dir, "victim");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, releaseFile("dev-trap@rig"));
    const trap = await app().post("dev-trap@rig", { reason: "x" });
    expect(trap.status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");

    // The registry refuses such a name at registration; a hand-edited row is the only way to get one.
    seat("dev-escape@rig");
    db.prepare("UPDATE sessions SET session_name = '../escape' WHERE session_name = 'dev-escape@rig'").run();
    const escape = await app().post("../escape", { reason: "x" });
    expect(escape.status).toBe(409);
    expect(await escape.json()).toMatchObject({ code: "seat_state_unsafe" });
  });

  it("is behind the terminal bearer: a wrong token is 401 and nothing is written", async () => {
    seat(SEAT);
    sidecar(SEAT);
    expect((await app().post(SEAT, { reason: "x" }, "Bearer wrong")).status).toBe(401);
    expect(fs.existsSync(releaseFile(SEAT))).toBe(false);
  });
});

describe("end to end: the real runner retries its held message after the route's release", () => {
  it("held after 6 failed attempts -> POST pda-release -> the runner's tick applies it -> the message is delivered once", async () => {
    rigObj = await makeRig({ realStreams: true, sessionName: "dev-research@rig" });
    const r = rigObj;
    r.fake.script(...Array.from({ length: 6 }, () => ({ action: "status" as const, status: 500 })));
    void r.start();
    await waitFor(() => r.pane().includes("READY"), "attach");
    r.runner.submit("poison or not");
    await waitFor(() => r.sidecar().held !== undefined, "the head to be held", 10_000);
    expect(r.pane()).toContain("Resolve with: rig seat pda-release");
    seat(r.args.sessionName);
    const res = await app(r.args.stateRoot).post(r.args.sessionName, { reason: "pda is healthy again" });
    expect(res.status).toBe(200);
    await waitFor(() => r.pane().includes("release requested: retrying the held message"), "the runner to apply the release", 10_000);
    await waitFor(() => r.fake.entries("research").length === 1, "the message to be admitted", 10_000);
    expect(r.fake.entries("research")[0]!.content).toBe("poison or not");
    expect(fs.existsSync(releaseFile(r.args.sessionName, r.args.stateRoot))).toBe(false);
  });
});
