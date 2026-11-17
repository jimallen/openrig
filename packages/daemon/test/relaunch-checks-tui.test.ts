// workspaces-o9o.71: the TUI's explicit fresh action (POST /api/startup/:rigId/:logicalId, action "fresh") launches a seat whose pane it
// observed stopped. Through the real route, the real service the route builds and the real lease store: a lease the seat's work still
// holds refuses that launch before anything is cleaned or started.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLeaseStore } from "../src/adapters/seat-lease-store.js";
import { startupRevision } from "../src/routes/startup.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

vi.mock("../src/domain/kernel-boot.js", async (original) => ({
  ...await original<typeof import("../src/domain/kernel-boot.js")>(),
  defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })),
}));

describe("o9o.71: the TUI's explicit fresh launch of a stopped-pane seat runs the lease check", () => {
  let db: Database.Database;
  let leaseRoot: string;
  let seatDir: string;
  let setup: ReturnType<typeof createTestApp>;
  let createSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    leaseRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o71-leases-"));
    seatDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o71-seat-"));
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "fresh-native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    setup = createTestApp(db, { adapters: { "claude-code": adapter }, appDeps: { seatLeases: new SeatLeaseStore(leaseRoot) } });
    createSession = vi.fn(async () => ({ ok: true as const }));
    Object.assign(setup.tmuxAdapter, {
      probeSession: vi.fn(async () => ({ state: "absent" as const })),
      hasSession: vi.fn(async () => false),
      createSession,
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(leaseRoot, { recursive: true, force: true });
    fs.rmSync(seatDir, { recursive: true, force: true });
  });

  it("a live lease refuses the TUI's fresh launch with relaunch_check_held, and no session is started", async () => {
    const rig = setup.rigRepo.createRig("tui-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", model: "fable", cwd: seatDir });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@tui-rig");
    setup.sessionRegistry.updateStatus(session.id, "exited");
    // A stopped seat keeps its last binding: that names the session the TUI observed stopped.
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
    const lease = await setup.app.request(`/api/seat/lease/${encodeURIComponent("dev-impl@tui-rig")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holder: "ui-test-host", pid: process.pid }),
    });
    expect(lease.status).toBe(200);

    const res = await setup.app.request(`/api/startup/${rig.id}/dev.impl`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fresh", revision: startupRevision(db, node) }),
    });
    const body: { code?: string; message?: string } = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(body.message).toContain("ui-test-host");
    expect(createSession).not.toHaveBeenCalled();
  });
});
