// OF-22 — leftovers from the OF-19 review (archived-rig lookup, live-first).
//
//  - H6: hasTerminalTransport's legacy path for a name that is not `<seat>@<rig>` and that no session row answers.
//  - S1/S2: the two startup.ts wires of the live-first helpers, reached through the seams production startup already
//    has (the model-divergence monitor is a dynamically imported module; the classifier lease manager is on deps).
//  - lease: a relaunch of the classifier seat, measured against the real NodeLauncher.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { isSessionNameRunning } from "../src/domain/latest-session-name-match.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createDaemon } from "../src/startup.js";
import { migrate } from "../src/db/migrate.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { createFullTestDb } from "./helpers/test-app.js";

// The monitor's dependency bag is what startup.ts hands the constructor; capture it, run the real class.
const captured = vi.hoisted(() => ({ deps: null as null | { resolveOversightSeat(): string | null } }));
vi.mock("../src/domain/model-divergence/model-divergence-monitor.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/domain/model-divergence/model-divergence-monitor.js")>();
  class CapturingMonitor extends actual.ModelDivergenceMonitor {
    constructor(deps: ConstructorParameters<typeof actual.ModelDivergenceMonitor>[0]) {
      super(deps);
      captured.deps = deps as unknown as { resolveOversightSeat(): string | null };
    }
  }
  return { ...actual, ModelDivergenceMonitor: CapturingMonitor };
});

function terminalTransport(db: Database.Database, dest: string): boolean {
  const repo = Object.create(QueueRepository.prototype) as unknown as { db: Database.Database; hasTerminalTransport(d: string): boolean };
  repo.db = db;
  return repo.hasTerminalTransport(dest);
}

describe("hasTerminalTransport: the legacy path for names that are not <seat>@<rig> (OF-22 H6)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
    // Topology exists, so the empty-database fail-open is not what answers.
    const rig = new RigRepository(db).createRig("alpha");
    const node = new RigRepository(db).addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
    new SessionRegistry(db).registerSession(node.id, "dev-impl@alpha");
  });
  afterEach(() => db.close());

  it("a non-canonical name that no session row answers stays on the legacy path (pane-bound is assumed)", () => {
    expect(terminalTransport(db, "legacy-name-nobody-has")).toBe(true);
  });

  it("a non-canonical name answered by a session row with no tmux binding also stays on the legacy path (unlike a canonical external seat)", () => {
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "codex" });
    registry.registerSession(node.id, "r01-dev1-impl");
    registry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "ext" });
    expect(terminalTransport(db, "r01-dev1-impl")).toBe(true);
  });

  it("a canonical name that nothing answers is not pane-bound (so the row above is the legacy path, not a blanket true)", () => {
    expect(terminalTransport(db, "nobody@nowhere")).toBe(false);
  });
});

describe("startup wiring of the live-first helpers (OF-22 S1/S2)", () => {
  let scratch: string;
  let db: Database.Database;
  let deps: Awaited<ReturnType<typeof createDaemon>>["deps"];
  let stopMonitor: (() => void) | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "of22-wiring-"));
    for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) saved[k] = process.env[k];
    process.env["OPENRIG_HOME"] = path.join(scratch, "home");
    process.env["OPENRIG_DB"] = path.join(scratch, "wiring.sqlite");
    delete process.env["OPENRIG_URL"];
    delete process.env["OPENRIG_PORT"];
    process.env["OPENRIG_NO_KERNEL"] = "1";
    const result = await createDaemon({
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
      tmuxExec: async () => "",
      dbPath: process.env["OPENRIG_DB"]!,
    });
    db = result.db;
    deps = result.deps;
    stopMonitor = () => deps.modelDivergenceMonitor?.stop();
  }, 60000);

  afterAll(() => {
    stopMonitor?.();
    db?.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** A recreated rig: the archived predecessor kept a running row, the live seat has stopped. */
  function seatRows(name: string, rigName: string, logicalId: string, live: "running" | "exited") {
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const archivedRig = rigRepo.createRig(rigName);
    const archivedNode = rigRepo.addNode(archivedRig.id, logicalId, { role: "worker", runtime: "codex" });
    registry.updateStatus(registry.registerSession(archivedNode.id, name).id, "running");
    expect(rigRepo.archiveRig(archivedRig.id)).toBe(true);
    const liveRig = rigRepo.createRig(rigName);
    const liveNode = rigRepo.addNode(liveRig.id, logicalId, { role: "worker", runtime: "codex" });
    registry.updateStatus(registry.registerSession(liveNode.id, name).id, live);
  }

  it("the model-divergence monitor's oversight probe names the seat only while the live-first row is running", () => {
    expect(captured.deps, "startup must construct the model-divergence monitor").not.toBeNull();
    expect(captured.deps!.resolveOversightSeat()).toBeNull(); // no such seat yet
    seatRows("watch-lead@oversight", "oversight", "watch.lead", "running");
    expect(captured.deps!.resolveOversightSeat()).toBe("watch-lead@oversight");
    // The live seat stops; the archived predecessor's row is still 'running' and must not vouch for it.
    db.prepare(
      "UPDATE sessions SET status = 'exited' WHERE session_name = 'watch-lead@oversight' AND node_id IN (SELECT n.id FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE r.archived_at IS NULL)",
    ).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_name = 'watch-lead@oversight' AND status = 'running'").get()).toEqual({ n: 1 });
    expect(captured.deps!.resolveOversightSeat()).toBeNull();
  });

  it("the classifier lease's liveness check is the live-first helper, not the permissive default", () => {
    seatRows("classifier@lease", "lease", "classifier", "exited");
    const manager = deps.classifierLeaseManager!;
    manager.acquire("classifier@lease");
    // Alive-by-default (no check attached) would answer null; a stale running archived row must not vouch either.
    const expired = manager.evaluateDeadness();
    expect(expired?.state).toBe("expired");
  });
});

describe("classifier lease across a relaunch of the classifier seat (OF-22 lease)", () => {
  let NAME = "";
  let db: Database.Database;
  let registry: SessionRegistry;
  let manager: ClassifierLeaseManager;
  let launcher: NodeLauncher;
  let rigId: string;
  let homes: string;
  let probes: Array<{ at: string; running: boolean; anyRowRunning: boolean }>;
  let duringGap: () => void;

  const anyRowRunning = (): boolean =>
    db.prepare("SELECT 1 FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1").get(NAME) !== undefined;
  const probe = (at: string): void => { probes.push({ at, running: isSessionNameRunning(db, NAME), anyRowRunning: anyRowRunning() }); };

  beforeAll(() => {
    homes = fs.mkdtempSync(path.join(os.tmpdir(), "of22-homes-"));
    fs.mkdirSync(path.join(homes, "codex"), { recursive: true });
    fs.writeFileSync(path.join(homes, "codex", "auth.json"), "{}");
    process.env["OPENRIG_HOME"] = path.join(homes, "openrig");
    process.env["CODEX_HOME_DEFAULT"] = path.join(homes, "codex");
  });
  afterAll(() => {
    delete process.env["OPENRIG_HOME"];
    delete process.env["CODEX_HOME_DEFAULT"];
    fs.rmSync(homes, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db = createFullTestDb();
    migrate(db, [classifierLeasesSchema]); // not part of the shared fixture
    probes = [];
    duringGap = () => {};
    const rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    manager = new ClassifierLeaseManager(db, eventBus);
    manager.attachIsAlive((session) => isSessionNameRunning(db, session)); // the wire startup.ts makes (pinned above)
    const rig = rigRepo.createRig("alpha");
    rigId = rig.id;
    rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const tmux = {
      createSession: async (): Promise<TmuxResult> => { duringGap(); return { ok: true }; },
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    } as unknown as TmuxAdapter;
    launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux });
    // The classifier seat is up and holds the lease.
    const first = await launcher.launchNode(rigId, "dev.impl");
    if (!first.ok) throw new Error("first launch failed");
    NAME = first.sessionName; // whatever name the launcher derives; the relaunch reuses it
    manager.acquire(NAME);
    probe("running, before the stop");
    const row = db.prepare("SELECT id FROM sessions WHERE session_name = ?").get(NAME) as { id: string };
    registry.updateStatus(row.id, "exited"); // the stop that precedes a relaunch ...
    db.prepare("DELETE FROM bindings WHERE node_id = (SELECT node_id FROM sessions WHERE id = ?)").run(row.id); // ... releases the binding
  });
  afterEach(() => db.close());

  async function relaunch(): Promise<void> {
    const result = await launcher.launchNode(rigId, "dev.impl");
    if (!result.ok) throw new Error(`relaunch failed: ${JSON.stringify(result)}`);
  }

  const expiredCount = (): number => (db.prepare("SELECT COUNT(*) AS n FROM classifier_leases WHERE state = 'expired'").get() as { n: number }).n;

  it("a deadness tick after the relaunch returns expires nothing: no committed state has the newest live row not yet running", async () => {
    duringGap = () => probe("inside the relaunch, before its transaction");
    await relaunch();
    probe("after the relaunch");

    expect(manager.evaluateDeadness()).toBeNull();
    expect(expiredCount()).toBe(0);
    // The only dead moment is the gap between the stop and the launch's single transaction, as with any-row-running.
    expect(probes.map((p) => [p.at, p.running])).toEqual([
      ["running, before the stop", true],
      ["inside the relaunch, before its transaction", false],
      ["after the relaunch", true],
    ]);
    // The live-first meaning and the old any-row-running meaning agree at every probe of a relaunch: the OF-19 change
    // adds no dead window to this sequence (they differ only when an older row of the name is still running).
    expect(probes.filter((p) => p.running !== p.anyRowRunning)).toHaveLength(0);
  });

  it("a deadness tick inside the stop-to-launch gap does expire the lease: one expiry, the same as before the change", async () => {
    let tickResult: ReturnType<ClassifierLeaseManager["evaluateDeadness"]> = null;
    duringGap = () => { tickResult = manager.evaluateDeadness(); };
    await relaunch();
    expect(tickResult).not.toBeNull();
    expect(expiredCount()).toBe(1);
    // The seat is back, and the next acquire is a fresh lease, not a block.
    expect(manager.evaluateDeadness()).toBeNull();
    expect(manager.acquire(NAME).state).toBe("active");
  });
});
