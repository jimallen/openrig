// OF-36 Q1 (Jim, 2026-10-20: "Skip that seat, warn"). One seat's saved startup context with a column that is not JSON
// used to fail the WHOLE rig's snapshot in every automatic capture (measured at 4728c079: rig down wrote no snapshot,
// the periodic tick wrote none, and the auto-rehydrate capture in POST /api/up, POST /api/rigs/:id/up and the startup
// route threw out of the route). Now that seat is captured with no copy, a warning says so, and the rest of the rig is
// captured. The manual `rig snapshot` capture is unchanged (not in the decision).
//
// Deployed entrypoints: routes/down.ts -> RigTeardownOrchestrator.teardown; startup.ts -> PeriodicSnapshotScheduler;
// routes/up.ts, routes/rigs.ts, routes/startup.ts -> auto-rehydrate captures.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { startupRevision } from "../src/routes/startup.js";
import { defaultProbeRuntimes } from "../src/domain/kernel-boot.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
vi.mock("../src/domain/kernel-boot.js", async (original) => ({ ...await original<typeof import("../src/domain/kernel-boot.js")>(), defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })) }));

const NOT_JSON = "{not json";
const WARNING = (kind: string, logicalId: string) => `Snapshot (${kind}) holds no copy of ${logicalId}'s saved startup context: a column of it is not JSON`;
const copyOf = (db: Database.Database, snapshotId: string, nodeId: string) =>
  (JSON.parse((db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string }).data).nodeStartupContext as Record<string, unknown>)[nodeId];

describe("rig down and the periodic capture skip a seat whose saved startup context is not JSON", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  it("rig down: the auto-pre-down snapshot is written, that seat has no copy, and the result warns", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    h.db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(NOT_JSON, seat.nodeId);

    const result = await new RigTeardownOrchestrator({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db) })
      .teardown(seat.rigId).catch((err: Error) => ({ thrown: err.message }) as never);

    expect(result.snapshotId, JSON.stringify(result)).toBeTruthy();
    expect(copyOf(h.db, result.snapshotId!, seat.nodeId)).toBeNull();
    // Re-check Q1: a warning, not an error, so `rig down` exits 0 when everything else succeeded.
    expect(result.warnings?.join("\n")).toContain(WARNING("auto-pre-down", "dev.impl"));
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
  });

  it("control: a readable context is copied and nothing is warned", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    expect(copyOf(h.db, snapshotId, seat.nodeId)).toMatchObject({ runtime: "claude-code" });
  });

  it("the periodic tick: the auto-periodic snapshot is written with no copy for that seat", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    h.db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(NOT_JSON, seat.nodeId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await new PeriodicSnapshotScheduler({ db: h.db, snapshotCapture: h.snapshotCapture, snapshotRepo: h.snapshotRepo }).tick();

    const snaps = h.snapshotRepo.listSnapshots(seat.rigId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(1);
    expect(copyOf(h.db, snaps[0]!.id, seat.nodeId)).toBeNull();
    expect(warn.mock.calls.flat().join("\n")).toContain(WARNING("auto-periodic", "dev.impl"));
    warn.mockRestore();
  });
});

describe("the auto-rehydrate captures skip a seat whose saved startup context is not JSON", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  /** A stopped seat with durable current state (as up-route.test.ts's auto-rehydrate row), plus a sibling. */
  function seed(name: string) {
    const rig = setup.rigRepo.createRig(name);
    const nodes = ["dev.impl", "dev.qa"].map((logicalId) => {
      const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
      const session = setup.sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@${name}`);
      setup.sessionRegistry.updateStatus(session.id, "stopped");
      setup.sessionRegistry.updateStartupStatus(session.id, "failed");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
      return node;
    });
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(NOT_JSON, nodes[0]!.id);
    return { rig, impl: nodes[0]!, qa: nodes[1]! };
  }
  const rehydrated = (rigId: string) => db.prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = 'auto-rehydrate'").all(rigId) as Array<{ id: string }>;

  for (const [route, request] of [
    ["POST /api/up", (rig: { id: string; name: string }) => setup.app.request("/api/up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: rig.name }) })],
    ["POST /api/rigs/:id/up", (rig: { id: string; name: string }) => setup.app.request(`/api/rigs/${rig.id}/up`, { method: "POST" })],
  ] as const) {
    it(`${route}: the snapshot is captured with no copy for that seat, the sibling's copy kept, and the response warns`, async () => {
      const { rig, impl, qa } = seed(`rehydrate-${route.length}`);

      const res = await request(rig);
      const body = await res.json().catch(() => ({}));

      expect(res.status, JSON.stringify(body)).not.toBe(500);
      const snaps = rehydrated(rig.id);
      expect(snaps).toHaveLength(1);
      expect(copyOf(db, snaps[0]!.id, impl.id)).toBeNull();
      expect(copyOf(db, snaps[0]!.id, qa.id)).toMatchObject({ runtime: "claude-code" });
      expect(JSON.stringify(body)).toContain(WARNING("auto-rehydrate", "dev.impl"));
    });
  }

  it("the startup route's capture after an explicit fresh start: the snapshot is captured with no copy for that seat", async () => {
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" });
    const rig = setup.rigRepo.createRig("selected");
    const node = setup.rigRepo.addNode(rig.id, "operator.agent", { runtime: "codex", model: "m" });
    const session = setup.sessionRegistry.registerSession(node.id, "operator-agent@selected");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1" });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'codex')").run(node.id, NOT_JSON);
    vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockResolvedValue({ ok: true } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await setup.app.request(`/api/startup/${rig.id}/operator.agent`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fresh", revision: startupRevision(db, node) }) });

    expect(res.status).toBe(200);
    const snaps = rehydrated(rig.id);
    expect(snaps).toHaveLength(1);
    expect(copyOf(db, snaps[0]!.id, node.id)).toBeNull();
    expect(warn.mock.calls.flat().join("\n")).toContain(WARNING("auto-rehydrate", "operator.agent"));
  });
});

// Re-check Q1e2 / Q1e3 (5ffd9b97): the two other startup-route auto-rehydrate captures, on a rig where ANOTHER seat's
// saved startup context is not JSON.
describe("the startup route's other auto-rehydrate captures skip a seat whose saved startup context is not JSON", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  const rehydrated = (rigId: string) => db.prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = 'auto-rehydrate'").all(rigId) as Array<{ id: string }>;
  const post = (rigId: string, logicalId: string, body: object) => setup.app.request(`/api/startup/${rigId}/${logicalId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("Q1e2: a never-occupied built-in seat's launch returns the launch result, not 500, and writes the snapshot", async () => {
    db = createFullTestDb();
    setup = createTestApp(db, { podInstantiatorFsOps: { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") } });
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" });
    const kernel = await (await setup.app.request("/api/startup/kernel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: "codex" }) })).json() as { rigId: string };
    const rig = setup.rigRepo.getRig(kernel.rigId)!;
    const other = rig.nodes.find((n) => n.logicalId === "operator.human")!;
    const seat = rig.nodes.find((n) => n.logicalId === "advisor.lead")!;
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', ?)").run(other.id, NOT_JSON, other.runtime ?? "codex");
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    vi.spyOn(PodRigInstantiator.prototype, "launchBinding").mockResolvedValue({ status: "launched" } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await post(rig.rig.id, seat.logicalId, { action: "start", revision: startupRevision(db, seat) });

    expect(res.status, await res.clone().text()).not.toBe(500);
    const snaps = rehydrated(rig.rig.id);
    expect(snaps).toHaveLength(1);
    expect(copyOf(db, snaps[0]!.id, other.id)).toBeNull();
    expect(warn.mock.calls.flat().join("\n")).toContain(WARNING("auto-rehydrate", "operator.human"));
  });

  it("Q1e3: a resume with no restore-usable snapshot reaches the resume decision, not 500, and writes the snapshot", async () => {
    db = createFullTestDb();
    setup = createTestApp(db);
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" });
    const rig = setup.rigRepo.createRig("resume-rig");
    const [seat, other] = ["dev.impl", "dev.qa"].map((logicalId) => {
      const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "codex" });
      const session = setup.sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@resume-rig`);
      setup.sessionRegistry.updateStatus(session.id, "stopped");
      setup.sessionRegistry.updateStartupStatus(session.id, "failed");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'codex')").run(node.id);
      return node;
    });
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(NOT_JSON, other!.id);
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await post(rig.id, seat!.logicalId, { action: "resume", revision: startupRevision(db, seat!) });

    expect(res.status, await res.clone().text()).not.toBe(500);
    const snaps = rehydrated(rig.id);
    expect(snaps).toHaveLength(1);
    expect(copyOf(db, snaps[0]!.id, other!.id)).toBeNull();
  });
});
