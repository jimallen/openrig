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
    expect(leases.leases("dev-impl@seat-rig")).toEqual([{ holder: "ui-test-host", pid: process.pid, reason: "UI tests", alive: true }]);

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

  it("the launch's checks read the same store: a real launch through the route refuses under the lease the route registered, before anything is stopped", async () => {
    const seatDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o8-seat-"));
    const rig = setup.rigRepo.createRig("live-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.live", { runtime: "claude-code", model: "fable", cwd: seatDir });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-live@live-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-live@live-rig", tmuxPane: "%1" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
    const tmux = setup.tmuxAdapter;
    const killSession = vi.fn(async () => ({ ok: true as const }));
    Object.assign(tmux, {
      probeSession: vi.fn(async () => ({ state: "present" as const })),
      hasSession: vi.fn(async () => true),
      killSession,
      getPanePid: vi.fn(async () => null),
      listSessions: vi.fn(async () => [{ name: "dev-live@live-rig", windows: 1, created: "", attached: false }]),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: seatDir, width: 80, height: 24, active: true }]),
    });
    await post("lease", "dev.live", { holder: "ui-test-host", pid: process.pid });

    const res = await post("launch", "dev.live", { fresh: true, reason: "r", stop: true, startupFrom: "stored" });
    const body: { code?: string; message?: string } = await res.json();
    expect(body).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(body.message).toContain("ui-test-host");
    expect(killSession).not.toHaveBeenCalled();
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it.each([["launch", "launchFresh"], ["launch-plan", "planFresh"]] as const)("%s forwards despite", async (route, method) => {
    const spy = vi.spyOn(SeatLifecycleService.prototype, method).mockResolvedValueOnce({ ok: false, code: "no_session", message: "fixture" } as never);
    await post(route, "dev.impl", { fresh: true, reason: "r", stop: true, despite: ["lease", "children"] });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ despite: ["lease", "children"] }));
  });

  it.each([["lease"], [["all"]], [[1]], [null]])("launch refuses a despite that is not a list of check names (%j) with 400, without calling the service", async (despite) => {
    const spy = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const res = await post("launch", "dev.impl", { fresh: true, reason: "r", stop: true, despite });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid_despite" });
    expect(spy).not.toHaveBeenCalled();
  });
});
