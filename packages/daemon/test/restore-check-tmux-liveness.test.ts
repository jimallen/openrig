// OF-29 — restore-check recovery advice must follow tmux liveness, not only the DB.
// tmux is a test double (adapter-shaped, `probeSession`); no real tmux is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";

type Probe = "present" | "absent" | "transport_unavailable" | "throw";

/** Adapter-shaped double: answers probeSession from a per-session table. */
function tmuxWith(table: Record<string, Probe>): TmuxAdapter {
  const base = mockTmuxAdapter() as unknown as Record<string, unknown>;
  return {
    ...base,
    probeSession: async (name: string) => {
      const answer = table[name] ?? "absent";
      if (answer === "throw") throw new Error("tmux probe failed (injected)");
      if (answer === "transport_unavailable") return { state: "transport_unavailable", cause: "no server running (injected)" };
      return { state: answer };
    },
  } as unknown as TmuxAdapter;
}

function insertStartupContextRow(db: Database.Database, nodeId: string) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'terminal')",
  ).run(nodeId);
}

describe("restore-check advice follows tmux liveness (OF-29)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;
  let openRigHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["OPENRIG_HOME"];
    openRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-liveness-home-"));
    process.env["OPENRIG_HOME"] = openRigHome;
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
    if (previousHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = previousHome;
    fs.rmSync(openRigHome, { recursive: true, force: true });
  });

  /** Partly-running rig: seat "up" is running/ready in the DB, seat "down" is exited in the DB. */
  function build(tmux: TmuxAdapter, dbState: { up: "running" | "exited"; down: "running" | "exited" } = { up: "running", down: "exited" }): { app: Hono; rigName: string; rigId: string } {
    const setup = createTestApp(db, { tmux });
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
    const rig = rigRepo.createRig("partly");
    for (const [logical, state] of [["up", dbState.up], ["down", dbState.down]] as const) {
      const node = rigRepo.addNode(rig.id, logical, { runtime: "terminal" });
      const session = sessionRegistry.registerSession(node.id, `${logical}@partly`);
      sessionRegistry.updateStatus(session.id, state);
      if (state === "running") sessionRegistry.updateStartupStatus(session.id, "ready");
      insertStartupContextRow(db, node.id);
    }
    const full = rigRepo.getRig(rig.id)!;
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    snapshotRepo.createSnapshot(rig.id, "auto-pre-down", {
      rig: full.rig, nodes: full.nodes, edges: full.edges, sessions, checkpoints: {},
      activeSessionIdByNode: Object.fromEntries(sessions.map((s) => [s.nodeId, s.id])),
    });
    return { app: createApp(setup), rigName: rig.name, rigId: rig.id };
  }

  async function restoreCheck(app: Hono, rigName: string) {
    const res = await app.request(`/api/restore-check?rig=${rigName}&noQueue=true&noHooks=true`);
    expect(res.status).toBe(200);
    return await res.json() as any;
  }

  it("control: DB-down seat with no tmux session still advises rig up --existing (decision is derived, not constant)", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }), { up: "exited", down: "exited" });
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).toBe("actionable");
    expect(body.recovery.actions.map((a: { command: string }) => a.command)).toEqual(["rig up --existing partly"]);
  });

  it("DB says not running but tmux is live: never advises rig up --existing (it would be refused 409)", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "present", "down@partly": "present" }));
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.status).toBe("blocked");
    expect(body.recovery.blocked[0].reason).toContain("down@partly");
    expect(body.recovery.blocked[0].reason).toContain("live in tmux");
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.down@partly.readiness");
    expect(readiness.evidence).toContain("LIVE");
    expect(readiness.remediation).not.toMatch(/^Restore or relaunch/);
    expect(body.repairPacket.map((step: { command: string }) => step.command)).not.toContain("rig up --existing partly");
  });

  it("a DB-running seat that is live in tmux also blocks the advice: restore refuses a rig with ANY live seat", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "present", "down@partly": "absent" }));
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.status).toBe("blocked");
    expect(body.recovery.blocked[0].reason).toContain("up@partly");
    expect(body.recovery.blocked[0].reason).not.toContain("down@partly");
  });

  it("DB says running but its tmux session is dead: the seat is treated as down and the rig is recoverable", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }));
    const body = await restoreCheck(app, rigName);
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.up@partly.readiness");
    expect(readiness.status).toBe("red");
    expect(readiness.evidence).toContain("tmux session up@partly is absent");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
    expect(body.recovery.status).toBe("actionable");
    expect(body.recovery.actions[0].command).toBe("rig up --existing partly");
  });

  it("DB says a lone seat is running/ready but tmux is dead: recovery is not 'not_needed'", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }), { up: "running", down: "running" });
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).not.toBe("not_needed");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
  });

  it.each<Probe>(["transport_unavailable", "throw"])("tmux unreadable (%s): liveness is reported unknown and no command is advised", async (mode) => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "present", "down@partly": mode }));
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).toBe("unknown");
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.unknown[0].reason).toContain("tmux liveness is unknown for down@partly");
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.down@partly.readiness");
    expect(readiness.evidence).toContain("tmux liveness unknown");
  });

  it("DB-ready seat whose tmux is unreadable is a caveat, not a silent ready", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "transport_unavailable", "down@partly": "absent" }));
    const body = await restoreCheck(app, rigName);
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.up@partly.readiness");
    expect(readiness.status).toBe("yellow");
    expect(readiness.evidence).toContain("tmux liveness unknown");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
    expect(body.recovery.status).toBe("unknown");
    expect(body.recovery.actions).toEqual([]);
  });

  it("a composed status poll does not take the all-ready shortcut for seats the DB calls ready but tmux says are dead", async () => {
    const { app, rigId } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }), { up: "running", down: "running" });
    const selection = vi.spyOn(snapshotRepo, "selectRestoreUsable");
    const res = await app.request(`/api/rigs/${rigId}/status`);
    expect(res.status).toBe(200);
    expect(selection).toHaveBeenCalled();
    const body = await res.json() as { src: string[] };
    expect(body.src).toContain("restore-check: actionable");
  });

  it("composed rig status folds the same tmux-aware restore-check (blocked, not an up --existing advice)", async () => {
    const { app, rigId } = build(tmuxWith({ "up@partly": "present", "down@partly": "present" }));
    const res = await app.request(`/api/rigs/${rigId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { src: string[] };
    expect(body.src).toContain("restore-check: blocked");
  });
});
