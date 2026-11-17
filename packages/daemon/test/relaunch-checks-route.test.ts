// workspaces-o9o.8: the HTTP surface of the relaunch checks. `rig seat lease` registers and releases a seat's lease through
// POST /api/seat/lease/:seatRef, the daemon's lease store holds it, and a fresh launch's checks read that same store (the route wires both
// from the one store). `despite` reaches the service, and anything but a list of check names is refused before the service is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatLeaseStore } from "../src/adapters/seat-lease-store.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("o9o.8: POST /api/seat/lease and the launch's despite", () => {
  let db: Database.Database;
  let leaseRoot: string;
  let leases: SeatLeaseStore;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    leaseRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o8-leases-"));
    leases = new SeatLeaseStore(leaseRoot);
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "fresh-native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    setup = createTestApp(db, { adapters: { "claude-code": adapter }, appDeps: { seatLeases: leases } });
    const rig = setup.rigRepo.createRig("seat-rig");
    setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", model: "fable" });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(leaseRoot, { recursive: true, force: true }); });

  const post = (path: string, seatRef: string, body: Record<string, unknown>) => setup.app.request(`/api/seat/${path}/${encodeURIComponent(seatRef)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("a lease registered by logical ref is held under the seat's canonical name, which the launch checks read; release removes it", async () => {
    const res = await post("lease", "dev.impl", { holder: "ui-test-host", pid: process.pid, reason: "UI tests" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seat: "dev-impl@seat-rig", lease: { holder: "ui-test-host", pid: process.pid, reason: "UI tests" } });
    expect(leases.leases("dev-impl@seat-rig")).toEqual([{ holder: "ui-test-host", pid: process.pid, reason: "UI tests", liveness: "alive" }]);

    const released = await post("lease", "dev-impl@seat-rig", { holder: "ui-test-host", release: true });
    expect(await released.json()).toMatchObject({ ok: true, released: true });
    expect(leases.leases("dev-impl@seat-rig")).toEqual([]);
    const again = await post("lease", "dev-impl@seat-rig", { holder: "ui-test-host", release: true });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ ok: false, code: "lease_not_found" });
  });

  it.each([
    [{ holder: "../escape", pid: 4242 }, "invalid_lease_holder"],
    [{ holder: "ui-test-host" }, "invalid_lease_pid"],
    [{ holder: "ui-test-host", pid: "4242" }, "invalid_lease_pid"],
    [{ holder: "ui-test-host", pid: 1 }, "invalid_lease_pid"],
    [{ pid: 4242 }, "invalid_lease_holder"],
  ])("a lease that cannot be recorded is refused with 400 (%j)", async (body, code) => {
    const res = await post("lease", "dev.impl", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code });
    expect(fs.readdirSync(leaseRoot)).toEqual([]);
  });

  /** A live managed seat the route's real service can judge: its pane pid is `panePid`. */
  function liveSeat(panePid: number | null) {
    const seatDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o8-seat-"));
    const rig = setup.rigRepo.createRig("live-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.live", { runtime: "claude-code", model: "fable", cwd: seatDir });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-live@live-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-live@live-rig", tmuxPane: "%1" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
    const tmux = setup.tmuxAdapter;
    const killSession = vi.fn(async () => ({ ok: true as const }));
    const respawnPane = vi.fn(async () => ({ ok: true as const }));
    Object.assign(tmux, {
      respawnPane,
      probeSession: vi.fn(async () => ({ state: "present" as const })),
      hasSession: vi.fn(async () => true),
      killSession,
      getPanePid: vi.fn(async () => panePid),
      listSessions: vi.fn(async () => [{ name: "dev-live@live-rig", windows: 1, created: "", attached: false }]),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: seatDir, width: 80, height: 24, active: true }]),
    });
    return { seatDir, killSession, respawnPane };
  }

  it("the launch's checks read the same store: a real launch through the route refuses under the lease the route registered, before anything is stopped", async () => {
    const { seatDir, killSession } = liveSeat(null);
    await post("lease", "dev.live", { holder: "ui-test-host", pid: process.pid });

    const res = await post("launch", "dev.live", { fresh: true, reason: "r", stop: true, startupFrom: "stored" });
    const body: { code?: string; message?: string } = await res.json();
    expect(body).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(body.message).toContain("ui-test-host");
    expect(killSession).not.toHaveBeenCalled();
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  // o9o.8 finding 6: the route wires the daemon's process lister into the service's port, so the children check reads the real process
  // table: a pane pid no process has is reported as missing from that table, not as an unwired lister.
  it("the route wires the process lister: the children check reads the real process table", async () => {
    const { seatDir } = liveSeat(2 ** 22 + 12345);
    const res = await post("launch-plan", "dev.live", { fresh: true, stop: true, startupFrom: "stored" });
    const plan: { relaunchChecks?: { children?: { verdict?: string; cause?: string } } } = await res.json();
    expect(plan.relaunchChecks?.children).toEqual({ verdict: "unknown", cause: "the process table does not show the seat's pane process" });
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it.each([["launch", "launchFresh"], ["launch-plan", "planFresh"]] as const)("%s forwards despite", async (route, method) => {
    const spy = vi.spyOn(SeatLifecycleService.prototype, method).mockResolvedValueOnce({ ok: false, code: "no_session", message: "fixture" } as never);
    await post(route, "dev.impl", { fresh: true, reason: "r", stop: true, despite: ["lease", "children"] });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ despite: ["lease", "children"] }));
  });

  // workspaces-o9o.93: a handover's successor replaces the live retiree in its pane, so the route's real handover is judged by the same
  // lifecycle service, lease store and process lister as a launch.
  it("a handover through the route refuses under the lease the route registered, before anything is replaced", async () => {
    const { seatDir, respawnPane } = liveSeat(null);
    await post("lease", "dev.live", { holder: "ui-test-host", pid: process.pid });
    const res = await post("handover", "dev-live@live-rig", { reason: "context-wall", source: "fresh" });
    const body: { code?: string; message?: string; guidance?: string } = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(body.message).toContain("ui-test-host");
    expect(body.guidance).toContain("--despite lease");
    expect(respawnPane).not.toHaveBeenCalled();
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it("a handover dry run through the route carries the held lease as a blocker", async () => {
    const { seatDir, respawnPane } = liveSeat(null);
    await post("lease", "dev.live", { holder: "ui-test-host", pid: process.pid });
    const res = await post("handover", "dev-live@live-rig", { reason: "context-wall", source: "fresh", dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ blockers: [{ code: "relaunch_check_held", message: expect.stringContaining("ui-test-host") }] });
    expect(respawnPane).not.toHaveBeenCalled();
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it("the route's real judgement takes the handover's despite: a held lease named in it is no blocker", async () => {
    const { seatDir } = liveSeat(null);
    await post("lease", "dev.live", { holder: "ui-test-host", pid: process.pid });
    const res = await post("handover", "dev-live@live-rig", { reason: "context-wall", source: "fresh", dryRun: true, despite: ["lease"] });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("blockers");
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it("the route's real judgement reads the retiree's live pane: one the process table does not show is warned about", async () => {
    const { seatDir } = liveSeat(2 ** 22 + 12345);
    const res = await post("handover", "dev-live@live-rig", { reason: "context-wall", source: "fresh", dryRun: true });
    const plan: { warnings?: string[]; blockers?: unknown } = await res.json();
    expect(plan.blockers).toBeUndefined();
    expect((plan.warnings ?? []).join(" ")).toContain("does not show the seat's pane process");
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it("the handover route forwards despite to the service", async () => {
    const spy = vi.spyOn(SeatHandoverService.prototype, "handover").mockResolvedValueOnce({ ok: false, code: "missing_reason", message: "fixture", guidance: "" } as never);
    await post("handover", "dev-impl@seat-rig", { reason: "r", source: "fresh", despite: ["lease", "children"] });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ despite: ["lease", "children"] }));
  });

  it.each([["lease"], [["all"]], [[1]], [null]])("the handover route refuses a despite that is not a list of check names (%j) with 400, without calling the service", async (despite) => {
    const spy = vi.spyOn(SeatHandoverService.prototype, "handover");
    const res = await post("handover", "dev-impl@seat-rig", { reason: "r", source: "fresh", despite });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid_despite" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([["lease"], [["all"]], [[1]], [null]])("launch refuses a despite that is not a list of check names (%j) with 400, without calling the service", async (despite) => {
    const spy = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const res = await post("launch", "dev.impl", { fresh: true, reason: "r", stop: true, despite });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid_despite" });
    expect(spy).not.toHaveBeenCalled();
  });
});
