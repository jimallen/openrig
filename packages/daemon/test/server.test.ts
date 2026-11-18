import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { createApp } from "../src/server.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const UI_INDEX_HTML = "<!doctype html><html><body><div id=\"root\">OpenRig UI</div></body></html>";

function createTempUiDist() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-ui-dist-"));
  fs.mkdirSync(nodePath.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "index.html"), UI_INDEX_HTML, "utf-8");
  fs.writeFileSync(nodePath.join(dir, "assets", "app.js"), "console.log('rig');", "utf-8");
  return dir;
}

function createAppWithUiDist(db: ReturnType<typeof createFullTestDb>, uiDistDir: string, extra: { terminalBearerToken?: string | null; missionControlBearerToken?: string | null } = {}) {
  const fullSetup = createTestApp(db);
  return createApp({
    rigRepo: fullSetup.rigRepo,
    sessionRegistry: fullSetup.sessionRegistry,
    eventBus: fullSetup.eventBus,
    nodeLauncher: fullSetup.nodeLauncher,
    tmuxAdapter: (fullSetup as any).tmuxAdapter ?? mockTmuxAdapter(),
    snapshotCapture: fullSetup.snapshotCapture,
    snapshotRepo: fullSetup.snapshotRepo,
    restoreOrchestrator: fullSetup.restoreOrchestrator,
    rigSpecExporter: fullSetup.rigSpecExporter,
    rigSpecPreflight: fullSetup.rigSpecPreflight,
    rigInstantiator: fullSetup.rigInstantiator,
    packageRepo: fullSetup.packageRepo,
    installRepo: fullSetup.installRepo,
    installEngine: fullSetup.installEngine,
    installVerifier: fullSetup.installVerifier,
    bootstrapOrchestrator: fullSetup.bootstrapOrchestrator,
    bootstrapRepo: fullSetup.bootstrapRepo,
    
    discoveryRepo: fullSetup.discoveryRepo,
    sessionReconciler: fullSetup.sessionReconciler,
    psProjectionService: fullSetup.psProjectionService,
    upRouter: fullSetup.upRouter,
    teardownOrchestrator: fullSetup.teardownOrchestrator,
    podInstantiator: fullSetup.podInstantiator,
    podBundleSourceResolver: fullSetup.podBundleSourceResolver,
    uiDistDir,
    webUiEnabled: true,
    ...extra,
  });
}

// workspaces-o9o.78: the web UI page is served without auth, so it carries the terminal token only to a page loaded from this machine.
// The peer is the connection's remote address (@hono/node-server's getConnInfo reads env.incoming.socket), given here as a request env.
describe("the web UI page hands the terminal token only to a loopback peer", () => {
  const TOKEN = "tok-" + "b".repeat(16);
  const page = (dir: string) => fs.writeFileSync(nodePath.join(dir, "index.html"), "<!doctype html><html><head><title>OpenRig</title></head><body></body></html>", "utf-8");
  const peer = (address: string) => ({ incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: address.includes(":") ? "IPv6" : "IPv4" } } });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("a page loaded from %s carries the token", async (address) => {
    const db = createFullTestDb(); const dir = createTempUiDist(); page(dir);
    const app = createAppWithUiDist(db, dir, { terminalBearerToken: TOKEN });
    const html = await (await app.request("/topology", {}, peer(address))).text();
    expect(html).toContain(TOKEN);
    fs.rmSync(dir, { recursive: true, force: true }); db.close();
  });

  it.each(["100.64.1.2", "192.168.1.9"])("a page loaded from another device (%s) carries no token", async (address) => {
    const db = createFullTestDb(); const dir = createTempUiDist(); page(dir);
    const app = createAppWithUiDist(db, dir, { terminalBearerToken: TOKEN });
    const res = await app.request("/topology", {}, peer(address));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>OpenRig</title>");
    expect(html).not.toContain(TOKEN);
    fs.rmSync(dir, { recursive: true, force: true }); db.close();
  });

  // workspaces-o9o.78 review F2: `/` (and /index.html) is the page itself, served from the file before the client-route fallback; it gets
  // the same loopback-only token that a deep link gets.
  it.each(["/", "/index.html"])("the page at %s carries the token for a loopback peer, and none for another device", async (path) => {
    const db = createFullTestDb(); const dir = createTempUiDist(); page(dir);
    const app = createAppWithUiDist(db, dir, { terminalBearerToken: TOKEN });
    expect(await (await app.request(path, {}, peer("127.0.0.1"))).text()).toContain(TOKEN);
    const remote = await app.request(path, {}, peer("100.64.1.2"));
    expect(remote.status).toBe(200);
    expect(await remote.text()).not.toContain(TOKEN);
    fs.rmSync(dir, { recursive: true, force: true }); db.close();
  });

  it("a page whose peer address cannot be read carries no token (fail closed)", async () => {
    const db = createFullTestDb(); const dir = createTempUiDist(); page(dir);
    const app = createAppWithUiDist(db, dir, { terminalBearerToken: TOKEN });
    expect(await (await app.request("/topology")).text()).not.toContain(TOKEN);
    fs.rmSync(dir, { recursive: true, force: true }); db.close();
  });
});

// workspaces-o9o.78 review F3 (CoS): the terminal-token file is what peers are told to copy, so it must never authorise an operator route.
describe("the terminal token never authorises an operator (mission-control) route", () => {
  const OPERATOR = "op-" + "d".repeat(16);
  const TERMINAL = "tok-" + "e".repeat(16);
  const post = (app: ReturnType<typeof createAppWithUiDist>, token: string) =>
    app.request("/api/mission-control/action", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("a mission-control write with the terminal token is refused; with the operator token it passes the gate", async () => {
    const db = createFullTestDb(); const dir = createTempUiDist();
    const app = createAppWithUiDist(db, dir, { terminalBearerToken: TERMINAL, missionControlBearerToken: OPERATOR });
    expect((await post(app, TERMINAL)).status).toBe(401);
    expect((await post(app, OPERATOR)).status).not.toBe(401);
    fs.rmSync(dir, { recursive: true, force: true }); db.close();
  });
});

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", pid: process.pid });
    db.close();
  });

  it("unknown API routes return the JSON 404 contract for every method", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const app = createAppWithUiDist(db, uiDistDir);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      for (const requestPath of ["/api/unknown", "/api/unknown/deep"]) {
        const res = await app.request(requestPath, { method });
        expect(res.status, `${method} ${requestPath}`).toBe(404);
        expect(res.headers.get("content-type"), `${method} ${requestPath}`).toContain("application/json");
        const text = await res.text();
        expect(text, `${method} ${requestPath}`).not.toContain("OpenRig UI");
        if (method === "HEAD") {
          expect(text, `${method} ${requestPath}`).toBe("");
        } else {
          expect(JSON.parse(text), `${method} ${requestPath}`).toEqual({ error: "not_found", path: requestPath });
        }
      }
    }
    fs.rmSync(uiDistDir, { recursive: true, force: true });
    db.close();
  });

  it("serves index.html for root and SPA deep links when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const app = createAppWithUiDist(db, uiDistDir);

    const rootRes = await app.request("/");
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    expect(await rootRes.text()).toBe(UI_INDEX_HTML);

    const deepLinkRes = await app.request("/specs");
    expect(deepLinkRes.status).toBe(200);
    expect(deepLinkRes.headers.get("content-type")).toContain("text/html");
    expect(await deepLinkRes.text()).toBe(UI_INDEX_HTML);

    const dottedLogicalIdRes = await app.request("/rigs/rig-1/nodes/dev.impl");
    expect(dottedLogicalIdRes.status).toBe(200);
    expect(dottedLogicalIdRes.headers.get("content-type")).toContain("text/html");
    expect(await dottedLogicalIdRes.text()).toBe(UI_INDEX_HTML);

    for (const lookalikePath of ["/api", "/apiX", "/healthz-adjacent"]) {
      const lookalikeRes = await app.request(lookalikePath);
      expect(lookalikeRes.status, lookalikePath).toBe(200);
      expect(lookalikeRes.headers.get("content-type"), lookalikePath).toContain("text/html");
      expect(await lookalikeRes.text(), lookalikePath).toBe(UI_INDEX_HTML);
    }

    fs.rmSync(uiDistDir, { recursive: true, force: true });
    db.close();
  });

  it("serves built assets directly when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const app = createAppWithUiDist(db, uiDistDir);

    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("console.log('rig');");

    fs.rmSync(uiDistDir, { recursive: true, force: true });
    db.close();
  });

  it("production app mounts /api/rigs (not healthz-only)", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    db.close();
  });

  it("createApp throws if rigRepo and eventBus use different db handles", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    expect(() => createTestApp(db1, { appDeps: { eventBus: new EventBus(db2) } })).toThrow(/same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if snapshotRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build valid deps on db1, then swap snapshotRepo to db2
    expect(() => createTestApp(db1, { appDeps: { snapshotRepo: new SnapshotRepository(db2) } })).toThrow(/snapshotRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if snapshotCapture uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build a self-consistent snapshotCapture on db2
    const r2 = new RigRepository(db2);
    const s2 = new SessionRegistry(db2);
    const e2 = new EventBus(db2);
    const sr2 = new SnapshotRepository(db2);
    const cs2 = new CheckpointStore(db2);
    const otherCapture = new SnapshotCapture({ db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, snapshotRepo: sr2, checkpointStore: cs2 });

    // Build valid deps on db1, then swap snapshotCapture to db2
    expect(() => createTestApp(db1, { appDeps: { snapshotCapture: otherCapture } })).toThrow(/snapshotCapture.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if restoreOrchestrator uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    // Build a self-consistent orchestrator on db2
    const r2 = new RigRepository(db2);
    const s2 = new SessionRegistry(db2);
    const e2 = new EventBus(db2);
    const sr2 = new SnapshotRepository(db2);
    const cs2 = new CheckpointStore(db2);
    const cap2 = new SnapshotCapture({ db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, snapshotRepo: sr2, checkpointStore: cs2 });
    const tmux2 = mockTmuxAdapter();
    const nl2 = new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2, tmuxAdapter: tmux2 });
    const otherOrch = new RestoreOrchestrator({
      db: db2, rigRepo: r2, sessionRegistry: s2, eventBus: e2,
      snapshotRepo: sr2, snapshotCapture: cap2, checkpointStore: cs2,
      nodeLauncher: nl2, tmuxAdapter: tmux2,
      claudeResume: new ClaudeResumeAdapter(tmux2), codexResume: new CodexResumeAdapter(tmux2),
    });

    // Build valid deps on db1, then swap restoreOrchestrator to db2
    expect(() => createTestApp(db1, { appDeps: { restoreOrchestrator: otherOrch } })).toThrow(/restoreOrchestrator.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if packageRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    expect(() => createTestApp(db1, { appDeps: { packageRepo: new PackageRepository(db2) } })).toThrow(/packageRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if installRepo uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    expect(() => createTestApp(db1, { appDeps: { installRepo: new InstallRepository(db2) } })).toThrow(/installRepo.*same db handle/);

    db1.close();
    db2.close();
  });

  it("createApp throws if podInstantiator uses different db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    expect(() => createTestApp(db1, { appDeps: { podInstantiator: { db: db2 } as any } })).toThrow(/podInstantiator.*same db handle/);

    db1.close();
    db2.close();
  });
});
