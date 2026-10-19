// OF-29 — restore-check recovery advice must follow tmux liveness, not only the DB.
// tmux is a test double (adapter-shaped, `hasSession`) or a real TmuxAdapter over an
// injected exec; no real tmux is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { createRestoreCheckService, RESTORE_CHECK_PROBE_TIMEOUT_MS } from "../src/routes/restore-check.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";

type Probe = "present" | "absent" | "throw" | "hang";

/** Adapter-shaped double: answers hasSession from a per-session table and records every probe. */
function tmuxWith(table: Record<string, Probe>): { adapter: TmuxAdapter; probed: string[] } {
  const probed: string[] = [];
  const base = mockTmuxAdapter() as unknown as Record<string, unknown>;
  const adapter = {
    ...base,
    hasSession: async (name: string) => {
      probed.push(name);
      const answer = table[name] ?? "absent";
      if (answer === "throw") throw new Error("tmux probe failed (injected)");
      if (answer === "hang") return await new Promise<boolean>(() => { /* never settles */ });
      return answer === "present";
    },
  } as unknown as TmuxAdapter;
  return { adapter, probed };
}

/** The REAL adapter over an injected exec: what tmux itself would say, classified by the adapter. */
function realTmux(kind: "no_server" | "session_absent" | "present" | "denied"): TmuxAdapter {
  return new TmuxAdapter(async () => {
    if (kind === "present") return "";
    if (kind === "no_server") throw new Error("no server running on /private/tmp/tmux-501/default");
    if (kind === "session_absent") throw new Error("can't find session: up@partly");
    throw new Error("permission denied");
  });
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
  let setupRef: ReturnType<typeof createTestApp>;
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

  /** Seed a rig of two seats "<rigName>": "up" and "down", with the given DB session states. */
  function seedRig(rigName: string, dbState: { up: "running" | "exited"; down: "running" | "exited" }): { rigName: string; rigId: string } {
    const rig = rigRepo.createRig(rigName);
    for (const [logical, state] of [["up", dbState.up], ["down", dbState.down]] as const) {
      const node = rigRepo.addNode(rig.id, logical, { runtime: "terminal" });
      const session = sessionRegistry.registerSession(node.id, `${logical}@${rigName}`);
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
    return { rigName, rigId: rig.id };
  }

  /** Partly-running rig: seat "up" is running/ready in the DB, seat "down" is exited in the DB. */
  function build(tmux: TmuxAdapter, dbState: { up: "running" | "exited"; down: "running" | "exited" } = { up: "running", down: "exited" }): { app: Hono; rigName: string; rigId: string } {
    setupRef = createTestApp(db, { tmux });
    rigRepo = setupRef.rigRepo;
    sessionRegistry = setupRef.sessionRegistry;
    snapshotRepo = setupRef.snapshotRepo;
    return { app: createApp(setupRef), ...seedRig("partly", dbState) };
  }

  async function restoreCheck(app: Hono, rigName: string) {
    const res = await app.request(`/api/restore-check?rig=${rigName}&noQueue=true&noHooks=true`);
    expect(res.status).toBe(200);
    return await res.json() as any;
  }

  it("control: DB-down seat with no tmux session still advises rig up --existing (decision is derived, not constant)", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }).adapter, { up: "exited", down: "exited" });
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).toBe("actionable");
    expect(body.recovery.actions.map((a: { command: string }) => a.command)).toEqual(["rig up --existing partly"]);
  });

  it("no tmux server running (reboot/crash): every seat is dead, so rig up --existing is still advised (restore proceeds on that reading)", async () => {
    const { app, rigName } = build(realTmux("no_server"));
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).toBe("actionable");
    expect(body.recovery.actions.map((a: { command: string }) => a.command)).toEqual(["rig up --existing partly"]);
    expect(body.recovery.unknown).toEqual([]);
  });

  it("DB says not running but tmux is live: never advises rig up --existing, and does not claim a 409 restore does not return", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "present" }).adapter, { up: "exited", down: "exited" });
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.status).toBe("blocked");
    const reason = body.recovery.blocked[0].reason as string;
    expect(reason).toContain("Seats live in tmux that the DB does not show running: down@partly");
    expect(reason).toContain("second session over a live one");
    expect(reason).toContain("rig ps --nodes");
    expect(reason).not.toContain("409");
    expect(reason).not.toContain("refused");
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.down@partly.readiness");
    expect(readiness.evidence).toContain("LIVE");
    expect(readiness.remediation).not.toMatch(/^Restore or relaunch/);
    expect(body.repairPacket.map((step: { command: string }) => step.command)).not.toContain("rig up --existing partly");
  });

  it("a DB-running seat that is live blocks with the true 409 reason, and names the per-seat fresh launch for each dead seat", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "present", "down@partly": "absent" }).adapter);
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.status).toBe("blocked");
    const reason = body.recovery.blocked[0].reason as string;
    expect(reason).toContain("Seats running in tmux: up@partly");
    expect(reason).toContain("rig_not_stopped, 409");
    expect(reason).not.toContain("DB does not show running");
    expect(reason).toContain(`rig seat launch 'down@partly' --fresh --reason "<why>"`);
    expect(reason).not.toContain("rig seat launch 'up@partly'");
    expect(reason).toContain("new one");
    expect(reason).toContain("rig down partly, then rig up partly --existing (this restarts every seat)");
  });

  it("DB says running but its tmux session is dead: the seat is treated as down and the rig is recoverable", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }).adapter);
    const body = await restoreCheck(app, rigName);
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.up@partly.readiness");
    expect(readiness.status).toBe("red");
    expect(readiness.evidence).toContain("tmux session up@partly is absent");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
    expect(body.recovery.status).toBe("actionable");
    expect(body.recovery.actions[0].command).toBe("rig up --existing partly");
  });

  it("DB says a lone seat is running/ready but tmux is dead: recovery is not 'not_needed'", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }).adapter, { up: "running", down: "running" });
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).not.toBe("not_needed");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
  });

  it("tmux probe throws: liveness is reported unknown and no command is advised", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "present", "down@partly": "throw" }).adapter);
    const body = await restoreCheck(app, rigName);
    expect(body.recovery.status).toBe("unknown");
    expect(body.recovery.actions).toEqual([]);
    expect(body.recovery.unknown[0].reason).toContain("tmux liveness is unknown for down@partly");
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.down@partly.readiness");
    expect(readiness.evidence).toContain("tmux liveness unknown");
  });

  it("DB-ready seat whose tmux probe throws is a caveat, not a silent ready", async () => {
    const { app, rigName } = build(tmuxWith({ "up@partly": "throw", "down@partly": "absent" }).adapter);
    const body = await restoreCheck(app, rigName);
    const readiness = body.checks.find((c: { check: string }) => c.check === "seat.up@partly.readiness");
    expect(readiness.status).toBe("yellow");
    expect(readiness.evidence).toContain("tmux liveness unknown");
    expect(body.rigs[0].runningReadyNodes).toBe(0);
    expect(body.recovery.status).toBe("unknown");
    expect(body.recovery.actions).toEqual([]);
  });

  it("a hung tmux probe is bounded: it resolves as unreadable within the deadline instead of stalling the route", async () => {
    expect(RESTORE_CHECK_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RESTORE_CHECK_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const { adapter } = tmuxWith({ "up@partly": "hang", "down@partly": "absent" });
    build(adapter);
    const service = createRestoreCheckService(rigRepo, snapshotRepo, adapter, { probeTimeoutMs: 50 });
    const started = Date.now();
    const settled = await Promise.race([
      service.checkWithLiveness({ rig: "partly", noQueue: true, noHooks: true }),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 1000)),
    ]);
    expect(settled).not.toBe("stalled");
    expect(Date.now() - started).toBeLessThan(1000);
    const result = settled as Exclude<typeof settled, "stalled">;
    expect(result.recovery.status).toBe("unknown");
    expect(result.recovery.actions).toEqual([]);
    expect(result.checks.find((c) => c.check === "seat.up@partly.readiness")?.evidence).toContain("tmux liveness unknown");
  });

  it("probe scope and count: only the checked rig's seats are probed, once each (restore-check and composed status)", async () => {
    const t = tmuxWith({});
    const { app, rigId } = build(t.adapter, { up: "exited", down: "exited" });
    seedRig("other", { up: "exited", down: "exited" });
    await restoreCheck(app, "partly");
    expect([...t.probed].sort()).toEqual(["down@partly", "up@partly"]);
    t.probed.length = 0;
    expect((await app.request(`/api/rigs/${rigId}/status`)).status).toBe(200);
    expect([...t.probed].sort()).toEqual(["down@partly", "up@partly"]);
  });

  it("a composed status poll does not take the all-ready shortcut for seats the DB calls ready but tmux says are dead", async () => {
    const { app, rigId } = build(tmuxWith({ "up@partly": "absent", "down@partly": "absent" }).adapter, { up: "running", down: "running" });
    const selection = vi.spyOn(snapshotRepo, "selectRestoreUsable");
    const res = await app.request(`/api/rigs/${rigId}/status`);
    expect(res.status).toBe(200);
    expect(selection).toHaveBeenCalled();
    const body = await res.json() as { src: string[] };
    expect(body.src).toContain("restore-check: actionable");
  });

  it("composed rig status folds the same tmux-aware restore-check (blocked, not an up --existing advice)", async () => {
    const { app, rigId } = build(tmuxWith({ "up@partly": "present", "down@partly": "present" }).adapter);
    const res = await app.request(`/api/rigs/${rigId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { src: string[] };
    expect(body.src).toContain("restore-check: blocked");
  });

  // The orchestrator's live/stale/unknown buckets and restore-check's reading of the SAME real-adapter
  // answer must agree: advice may never be stricter or looser than what `rig up --existing` will do.
  it.each([
    ["no_server", "stale", "dead"],
    ["session_absent", "stale", "dead"],
    ["present", "live", "live"],
    ["denied", "unknown", "unreadable"],
  ] as const)("parity with the restore orchestrator: real adapter, tmux says %s => orchestrator %s, restore-check %s", async (kind, bucket, liveness) => {
    const { rigId } = build(realTmux(kind));
    const classified = await (setupRef.restoreOrchestrator as unknown as {
      classifyRunningSessions(id: string): Promise<{ live: string[]; stale: string[]; unknown: string[] }>;
    }).classifyRunningSessions(rigId);
    expect({ live: classified.live.length, stale: classified.stale.length, unknown: classified.unknown.length })
      .toEqual({ live: bucket === "live" ? 1 : 0, stale: bucket === "stale" ? 1 : 0, unknown: bucket === "unknown" ? 1 : 0 });
    const result = await createRestoreCheckService(rigRepo, snapshotRepo, realTmux(kind)).checkWithLiveness({ rig: "partly", noQueue: true, noHooks: true });
    const evidence = result.checks.find((c) => c.check === "seat.up@partly.readiness")!;
    if (liveness === "dead") expect(evidence.evidence).toContain("is absent");
    else if (liveness === "unreadable") expect(evidence.evidence).toContain("tmux liveness unknown");
    else expect(evidence.status).toBe("green");
  });
});
