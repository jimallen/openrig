import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { codexSeatHomePath } from "../src/domain/codex-seat-home.js";
import { shimDir } from "../src/domain/git-worktree-shim.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { hostCodexWithTrustedHook, secondDaemonPolicyFor, type HostCodexFixture } from "./helpers/codex-shared-config-fixture.js";
import type { CodexConfigWritePolicy } from "../src/domain/codex-config-write-policy.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(overrides?: {
  createSession?: (name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>;
  killSession?: (name: string) => Promise<TmuxResult>;
  listPanes?: (target: string) => Promise<Array<{ id: string }>>;
}): TmuxAdapter {
  return {
    createSession: overrides?.createSession ?? (async () => ({ ok: true as const })),
    killSession: overrides?.killSession ?? (async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: overrides?.listPanes ?? (async () => []),
    hasSession: async () => false,
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("NodeLauncher", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let fakeHomes: string;

  beforeAll(async () => {
    // Hermeticity: codex seat homes are seeded on LAUNCH — point the module's
    // env-resolved roots at a per-suite temp dir so tests never touch the
    // operator's real ~/.openrig / ~/.codex.
    fakeHomes = await fs.mkdtemp(path.join(os.tmpdir(), "nl-homes-"));
    await fs.mkdir(path.join(fakeHomes, "codex"), { recursive: true });
    await fs.writeFile(path.join(fakeHomes, "codex", "auth.json"), "{}");
    process.env["OPENRIG_HOME"] = path.join(fakeHomes, "openrig");
    process.env["CODEX_HOME_DEFAULT"] = path.join(fakeHomes, "codex");
  });

  afterAll(async () => {
    delete process.env["OPENRIG_HOME"];
    delete process.env["CODEX_HOME_DEFAULT"];
    await fs.rm(fakeHomes, { recursive: true, force: true });
  });

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function createLauncher(
    tmux?: TmuxAdapter,
    sessionEnv?: Record<string, string | undefined>,
    tmuxOptionDefaults?: TmuxOptionDefaultsApplier,
  ) {
    return new NodeLauncher({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux ?? mockTmuxAdapter(),
      sessionEnv,
      tmuxOptionDefaults,
    });
  }

  function seedRigWithNode() {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", {
      role: "worker",
      runtime: "claude-code",
    });
    return { rig, node };
  }

  it("a missing pane at registration immediately projects attention", async () => {
    const { rig } = seedRigWithNode();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // SQLite keeps its real clock; freeze registration safely after that floor.
      vi.setSystemTime(Date.now() + 60_000);
      const result = await createLauncher().launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      expect(getNodeInventory(db, rig.id)[0]).toMatchObject({
        startupStatus: "attention_required", identityVerdict: { verdict: "pane_missing", reason: "pane_pid_gone" },
      });
    } finally { vi.useRealTimers(); }
  });

  it("happy path: derives name, creates tmux, persists session+binding+event in one txn, notifies", async () => {
    const { rig } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();

    // DB: session exists
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("running");

    // DB: binding exists
    const fullRig = rigRepo.getRig(rig.id);
    const launchedNode = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(launchedNode!.binding).not.toBeNull();

    // DB: event exists
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber notified
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("node.launched");
  });

  // OF-183: the seat's CODEX_HOME symlinks the host-wide config.toml, so a launch used to mirror hook trust into it.
  describe("OF-183 the shared Codex config.toml on a codex launch", () => {
    let fx: HostCodexFixture;
    beforeEach(() => { fx = hostCodexWithTrustedHook("nl-of183-"); });
    afterEach(() => { fx.cleanup(); });

    const launchCodexSeat = async (policy?: CodexConfigWritePolicy) => {
      const rig = rigRepo.createRig("of183-rig");
      rigRepo.addNode(rig.id, "verify-qa", { role: "qa", runtime: "codex" });
      const launcher = new NodeLauncher({
        db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: mockTmuxAdapter(),
        sessionEnv: { OPENRIG_HOME: fx.scratchOpenrigHome, CODEX_HOME: fx.codexHome },
        ...(policy ? { codexConfigWritePolicy: policy } : {}),
      });
      const result = await launcher.launchNode(rig.id, "verify-qa");
      expect(result.ok).toBe(true);
    };

    it("a launch by a daemon that is not the host's installed one leaves the shared config.toml byte-identical", async () => {
      const before = await fs.readFile(fx.config);
      await launchCodexSeat(secondDaemonPolicyFor(fx));
      expect((await fs.readFile(fx.config)).equals(before)).toBe(true);
    });

    it("CONTROL: with no restriction the same launch mirrors the seat's hook trust into the shared file", async () => {
      const before = await fs.readFile(fx.config);
      await launchCodexSeat();
      expect((await fs.readFile(fx.config)).equals(before)).toBe(false);
    });
  });

  it("codex seats launch with a per-seat CODEX_HOME; claude seats get none", async () => {
    const rig = rigRepo.createRig("identity-rig");
    rigRepo.addNode(rig.id, "verify-qa", { role: "qa", runtime: "codex" });
    rigRepo.addNode(rig.id, "build-impl", { role: "worker", runtime: "claude-code" });

    const captured: Array<{ name: string; env?: Record<string, string> }> = [];
    const createSession = vi.fn(
      async (name: string, _cwd?: string, env?: Record<string, string>) => {
        captured.push({ name, env });
        return { ok: true as const };
      },
    );
    const launcher = createLauncher(mockTmuxAdapter({ createSession }));

      const codexLaunch = await launcher.launchNode(rig.id, "verify-qa");
      expect(codexLaunch.ok).toBe(true);
      const codexSession = codexLaunch.ok ? codexLaunch.sessionName : "";
      const codexEnv = captured.find((c) => c.name === codexSession)?.env;
      // long session names hash-compact to respect the SUN_LEN socket limit —
      // expect via the same helper, not the raw name
      expect(codexEnv?.["CODEX_HOME"]).toBe(
        codexSeatHomePath(process.env["OPENRIG_HOME"]!, codexSession),
      );
      // identity stamps still present alongside the new CODEX_HOME
      expect(codexEnv?.["OPENRIG_SESSION_NAME"]).toBe(codexSession);
      // the seat home is real and carries the shared auth by symlink
      const auth = await fs.lstat(path.join(codexEnv!["CODEX_HOME"]!, "auth.json"));
      expect(auth.isSymbolicLink()).toBe(true);

      const claudeLaunch = await launcher.launchNode(rig.id, "build-impl");
      expect(claudeLaunch.ok).toBe(true);
      const claudeSession = claudeLaunch.ok ? claudeLaunch.sessionName : "";
      const claudeEnv = captured.find((c) => c.name === claudeSession)?.env;
      expect(claudeEnv?.["CODEX_HOME"]).toBeUndefined();
  });

  it("adds runtime-scoped launch env (OMP provider keys) to that runtime's seats only", async () => {
    const rig = rigRepo.createRig("r02");
    rigRepo.addNode(rig.id, "omp-worker", { role: "worker", runtime: "omp" });
    rigRepo.addNode(rig.id, "claude-worker", { role: "worker", runtime: "claude-code" });
    const envs: Record<string, Record<string, string> | undefined> = {};
    const launcher = new NodeLauncher({
      db, rigRepo, sessionRegistry, eventBus,
      tmuxAdapter: mockTmuxAdapter({ createSession: async (name, _cwd, env) => { envs[name] = env; return { ok: true }; } }),
      sessionEnv: { OPENRIG_HOME: "/home" },
      runtimeSessionEnv: { omp: { MISTRAL_API_KEY: "omp-only" } },
    });
    const omp = await launcher.launchNode(rig.id, "omp-worker");
    const claude = await launcher.launchNode(rig.id, "claude-worker");
    expect(omp.ok && claude.ok).toBe(true);
    if (!omp.ok || !claude.ok) return;
    expect(envs[omp.sessionName]).toMatchObject({ OPENRIG_HOME: "/home", MISTRAL_API_KEY: "omp-only" });
    expect(envs[claude.sessionName]).toMatchObject({ OPENRIG_HOME: "/home" });
    expect(envs[claude.sessionName]).not.toHaveProperty("MISTRAL_API_KEY");
  });

  it("launchNode commits the created session's sole live pane with its session and binding", async () => {

    const { rig, node } = seedRigWithNode();
    const listPanes = vi.fn(async () => [{ id: "%fresh" }]);
    const launcher = createLauncher(mockTmuxAdapter({ listPanes }));

    const result = await launcher.launchNode(rig.id, "dev1-impl", { occupantKind: "fresh" });

    expect(result.ok).toBe(true);
    expect(listPanes).toHaveBeenCalledWith(result.ok ? result.sessionName : "");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%fresh");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.kind).toBe("fresh");
  });

  it("derived session name is correct (rig.name + '-' + logicalId)", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(createSpy.mock.calls[0]![0]).toBe("r01-dev1-impl");
  });

  it("passes runtime hook env to tmux session creation without putting it in provider config", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev-qa", {
      role: "worker",
      runtime: "codex",
    });
    const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }), {
      OPENRIG_URL: "http://127.0.0.1:7644",
      OPENRIG_ACTIVITY_HOOK_TOKEN: "secret-token",
    });

    await launcher.launchNode(rig.id, "dev-qa");

    expect(createSpy.mock.calls[0]![2]).toEqual({
      OPENRIG_NODE_ID: expect.any(String),
      OPENRIG_SESSION_NAME: "r00-test-rig-dev-qa",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_OCCUPANT_GENERATION: expect.any(String),
      OPENRIG_URL: "http://127.0.0.1:7644",
      OPENRIG_ACTIVITY_HOOK_TOKEN: "secret-token",
      CODEX_HOME: expect.any(String),
    });
  });

  it("carries the exact prelaunch reservation into tmux and registers that same generation", async () => {
    const { rig, node } = seedRigWithNode();
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async (_name, _cwd, env) => {
          launchEnv = env;
          return { ok: true };
        },
      }),
      { OPENRIG_OCCUPANT_GENERATION: "stale-ambient-generation" },
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv?.OPENRIG_OCCUPANT_GENERATION).toMatch(/^[0-9a-f-]{36}$/i);
    expect(launchEnv?.OPENRIG_OCCUPANT_GENERATION).not.toBe("stale-ambient-generation");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.generationUuid)
      .toBe(launchEnv?.OPENRIG_OCCUPANT_GENERATION);
  });

  it("keeps launch fail-open and omits generation when the tenure ledger is unavailable", async () => {
    const { rig } = seedRigWithNode();
    db.exec("DROP TABLE occupant_tenures");
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(mockTmuxAdapter({
      createSession: async (_name, _cwd, env) => {
        launchEnv = env;
        return { ok: true };
      },
    }));

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv).not.toHaveProperty("OPENRIG_OCCUPANT_GENERATION");
    expect(sessionRegistry.getSessionsForRig(rig.id)).toHaveLength(1);
  });

  it("explicit sessionName override used when provided", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl", { sessionName: "r99-custom1-worker" });

    expect(createSpy.mock.calls[0]![0]).toBe("r99-custom1-worker");
  });

  it("valid logical IDs 'orchestrator' and 'worker' produce launchable names", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const r1 = await launcher.launchNode(rig.id, "orchestrator");
    const r2 = await launcher.launchNode(rig.id, "worker");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r01-orchestrator");
    expect(createSpy.mock.calls[1]![0]).toBe("r01-worker");
  });

  it("non-managed rig name is normalized to a managed session name", async () => {
    const rig = rigRepo.createRig("badname");
    rigRepo.addNode(rig.id, "worker");
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "worker");

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r00-badname-worker");
  });

  it("node not found -> error", async () => {
    const rig = rigRepo.createRig("r01");
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("node_not_found");
    }
  });

  it("node already bound -> error", async () => {
    const { rig, node } = seedRigWithNode();
    // Pre-bind the node
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("already_bound");
    }
  });

  it("tmux createSession fails -> no DB rows", async () => {
    const { rig } = seedRigWithNode();
    const killSpy = vi.fn(async () => ({ ok: true as const }));
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({
          ok: false as const,
          code: "duplicate_session",
          message: "duplicate session",
        }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);

    // No session/binding/event rows
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(0);
    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).toBeNull();
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("DB transaction fails after session+binding but before event -> rollback all, killSession attempted", async () => {
    const { rig } = seedRigWithNode();
    const killSpy = vi.fn<(name: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });

    // Sabotage the events table so persistWithinTransaction fails AFTER
    // session + binding inserts have already executed within the transaction.
    // This proves rollback removes the session and binding rows too.
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    // killSession was attempted (tmux cleanup)
    expect(killSpy).toHaveBeenCalledOnce();
    // No partial session rows (rolled back)
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);
    // No partial binding rows (rolled back)
    const bindings = db.prepare("SELECT * FROM bindings").all();
    expect(bindings).toHaveLength(0);
    // No event rows (insert failed)
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("event row exists in DB after launch (atomic with session+binding)", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched' AND rig_id = ?")
      .all(rig.id) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("node.launched");
    expect(payload.rigId).toBe(rig.id);
    expect(payload.logicalId).toBe("dev1-impl");
  });

  it("emitted event has correct rigId, nodeId, logicalId, sessionName", async () => {
    const { rig, node } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(notifications).toHaveLength(1);
    const event = notifications[0]!;
    expect(event.type).toBe("node.launched");
    if (event.type === "node.launched") {
      expect(event.rigId).toBe(rig.id);
      expect(event.nodeId).toBe(node.id);
      expect(event.logicalId).toBe("dev1-impl");
      expect(event.sessionName).toBe("r01-dev1-impl");
    }
  });

  it("after launch, getRig shows binding for node", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).not.toBeNull();
    expect(node!.binding!.tmuxSession).toBe("r01-dev1-impl");
  });

  it("after launch, getSessionsForRig shows session with correct name", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("r01-dev1-impl");
  });

  it("returns the newly created session when older sessions already exist for the node", async () => {
    const { rig, node } = seedRigWithNode();
    const older = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(older.id, "exited");

    const launcher = createLauncher();
    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.id).not.toBe(older.id);
    expect(result.session.status).toBe("running");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    const newest = sessions.reduce((latest, session) => (session.id > latest.id ? session : latest));
    expect(result.session.id).toBe(newest.id);
  });

  it("exactly 1 event row and exactly 1 subscriber notification (no duplication)", async () => {
    const { rig } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    // Exactly 1 DB row
    const eventRows = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(eventRows).toHaveLength(1);

    // Exactly 1 subscriber notification
    expect(notifications).toHaveLength(1);
  });

  it("canonical session name with @ accepted when passed as opts.sessionName", async () => {
    const rig = rigRepo.createRig("auth-feats");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "dev.impl", {
      sessionName: "dev-impl@auth-feats",
    });

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("dev-impl@auth-feats");

    // Session persisted with canonical name
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("dev-impl@auth-feats");
  });

  it("constructor throws if services use mismatched db handles", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRepo = new RigRepository(otherDb);

    expect(
      () =>
        new NodeLauncher({
          db,
          rigRepo: otherRepo, // different handle
          sessionRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter(),
        })
    ).toThrow(/same db handle/);

    otherDb.close();
  });

  describe("transcript integration", () => {
    it("starts the transcript rotation timer on successful launch when TranscriptStore is enabled", async () => {
      const {
        getActiveRotationCount,
        clearAllTranscriptRotationsForTest,
      } = await import("../src/domain/transcript-rotation.js");
      clearAllTranscriptRotationsForTest();
      const { rig } = seedRigWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

      const launcher = new NodeLauncher({
        db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      // Rotation timer registered for the launched session.
      expect(getActiveRotationCount()).toBeGreaterThan(0);
      if (result.ok) {
        expect(result.warnings).toBeUndefined();
      }
      clearAllTranscriptRotationsForTest();
    });

    it("warns and still succeeds when the transcript directory cannot be created", async () => {
      const { rig } = seedRigWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(false);

      const launcher = new NodeLauncher({
        db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBe(1);
        expect(result.warnings![0]).toContain("Transcript directory creation failed");
      }
    });
  });

  describe("env var projection", () => {
    it("passes OPENRIG_NODE_ID and OPENRIG_SESSION_NAME to createSession", async () => {
      const { rig, node } = seedRigWithNode();
      const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
        .mockResolvedValue({ ok: true });
      const tmux = mockTmuxAdapter({ createSession: createSpy });
      const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      expect(createSpy).toHaveBeenCalledOnce();

      const envArg = createSpy.mock.calls[0]![2];
      expect(envArg).toBeDefined();
      expect(envArg!.OPENRIG_NODE_ID).toBe(node.id);
      expect(envArg!.OPENRIG_SESSION_NAME).toContain("dev1-impl");
    });
  });

  // The fork's seat setup (worktree placement shim, per-seat CODEX_HOME) is fail-open: a failure must not
  // stop the launch, but the operator is told through the launch result. Each failure is made real on disk
  // (a regular file where the directory must go) so the production code, not a stub, raises it.
  describe("fork seat-setup warnings reach the launch result", () => {
    const SHIM_MARKER = "worktree shim materialization failed";
    const CODEX_MARKER = "codex per-seat CODEX_HOME seeding failed";

    async function homeWithBlockedDirs(blocks: { shim?: boolean; codex?: boolean }): Promise<string> {
      const home = await fs.mkdtemp(path.join(fakeHomes, "warn-home-"));
      if (blocks.shim) await fs.writeFile(shimDir(home), "not a directory");
      if (blocks.codex) await fs.writeFile(path.join(home, "codex-seats"), "not a directory");
      return home;
    }

    function launchWith(runtime: "codex" | "claude-code", home: string, createSession?: () => Promise<TmuxResult>) {
      const rig = rigRepo.createRig(`warn-${runtime}`);
      rigRepo.addNode(rig.id, "seat-a", { role: "worker", runtime });
      const launcher = createLauncher(mockTmuxAdapter(createSession ? { createSession } : undefined), { OPENRIG_HOME: home });
      return launcher.launchNode(rig.id, "seat-a");
    }

    it("a failed worktree shim is reported and the launch still succeeds", async () => {
      const result = await launchWith("claude-code", await homeWithBlockedDirs({ shim: true }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings?.filter((w) => w.includes(SHIM_MARKER))).toHaveLength(1);
      expect(result.warnings?.some((w) => w.includes(CODEX_MARKER))).toBe(false);
    });

    it("a failed per-seat CODEX_HOME is reported and the launch still succeeds", async () => {
      const result = await launchWith("codex", await homeWithBlockedDirs({ codex: true }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings?.filter((w) => w.includes(CODEX_MARKER))).toHaveLength(1);
      expect(result.warnings?.some((w) => w.includes(SHIM_MARKER))).toBe(false);
    });

    // OF-115: a profile withheld for carrying a seat identity, and a shared config.toml that sets one, used to be
    // logged on the daemon console only. The launch result now says it, with names and never values.
    it("a profile withheld for carrying a seat identity is reported in the launch result, never its value", async () => {
      const shared = process.env["CODEX_HOME_DEFAULT"]!;
      const profile = path.join(shared, "of115.config.toml");
      await fs.writeFile(profile, 'approval_policy = "never"\n[shell_environment_policy.set]\nOPENRIG_SESSION_NAME = "other-seat-value@rig"\n');
      try {
        const result = await launchWith("codex", await homeWithBlockedDirs({}));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        const told = (result.warnings ?? []).filter((w) => w.includes("of115.config.toml"));
        expect(told).toHaveLength(1);
        expect(told[0]).toContain("OPENRIG_SESSION_NAME");
        expect(told[0]).not.toContain("other-seat-value");
      } finally {
        await fs.rm(profile, { force: true });
      }
    });

    it("a shared config.toml that sets a seat identity is reported in the launch result", async () => {
      const config = path.join(process.env["CODEX_HOME_DEFAULT"]!, "config.toml");
      await fs.writeFile(config, '[shell_environment_policy.set]\nOPENRIG_NODE_ID = "other-node-value"\n');
      try {
        const result = await launchWith("codex", await homeWithBlockedDirs({}));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        const told = (result.warnings ?? []).filter((w) => w.includes("config.toml"));
        expect(told).toHaveLength(1);
        expect(told[0]).toContain("OPENRIG_NODE_ID");
        expect(told[0]).not.toContain("other-node-value");
      } finally {
        await fs.rm(config, { force: true });
      }
    });

    it("a healthy launch carries neither warning", async () => {
      const result = await launchWith("codex", await homeWithBlockedDirs({}));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings).toBeUndefined();
    });

    it("keeps the fork's warnings and upstream's tmux warnings together", async () => {
      const result = await launchWith(
        "codex",
        await homeWithBlockedDirs({ shim: true, codex: true }),
        async () => ({ ok: true as const, warnings: ["identity cleanup skipped: boom"] }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Order is not part of the contract: every consumer of launchNode warnings forwards or spreads them
      // (none indexes by position), so assert the set, each exactly once.
      const warnings = result.warnings ?? [];
      expect(warnings).toHaveLength(3);
      expect(warnings.filter((w) => w.includes(SHIM_MARKER))).toHaveLength(1);
      expect(warnings.filter((w) => w.includes(CODEX_MARKER))).toHaveLength(1);
      expect(warnings.filter((w) => w === "identity cleanup skipped: boom")).toHaveLength(1);
    });
  });

  // OPR.0.4.6.02 S1 — the shared tmux option-defaults applier is invoked on the
  // JUST-CREATED session, and its warnings fold into the launch result.
  describe("tmux option defaults (OPR.0.4.6.02 S1)", () => {
    it("applies option defaults to the created session and folds applier warnings", async () => {
      const { rig } = seedRigWithNode();
      const applyToFreshSession = vi.fn(async () => ['tmux "mouse" option not set for r01-dev1-impl: boom']);
      const applier = { applyToFreshSession } as unknown as TmuxOptionDefaultsApplier;

      const result = await createLauncher(undefined, undefined, applier).launchNode(rig.id, "dev1-impl");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Applied exactly once, to the just-created session name (never a pre-existing one).
      expect(applyToFreshSession).toHaveBeenCalledTimes(1);
      expect(applyToFreshSession).toHaveBeenCalledWith(result.sessionName);
      // The applier's non-fatal warnings ride the launch result.
      expect(result.warnings).toContain('tmux "mouse" option not set for r01-dev1-impl: boom');
    });

    it("folds the session's own non-fatal warnings (the #771 identity cleanup) into the launch result", async () => {
      const { rig } = seedRigWithNode();
      const createSession = vi.fn(async () => ({ ok: true as const, warnings: ["identity cleanup skipped: boom"] }));
      const result = await createLauncher(mockTmuxAdapter({ createSession })).launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings).toContain("identity cleanup skipped: boom");
    });

    it("without an applier injected, launch succeeds and applies nothing (existing-behavior safety)", async () => {
      const { rig } = seedRigWithNode();
      const result = await createLauncher().launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings).toBeUndefined();
    });
  });

  // OF-69: tmux starts a session whose `-c` folder is missing in $HOME with no error. Every launch (first start, restore,
  // relaunch, up --existing, --startup-from stored, the TUI) goes through launchNode, so the folder is judged there.
  describe("seat cwd (OF-69)", () => {
    function seatWithCwd(cwd: string | undefined) {
      const rig = rigRepo.createRig("r01");
      rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "claude-code", ...(cwd === undefined ? {} : { cwd }) });
      return rig;
    }
    let scratch: string;
    beforeEach(async () => { scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nl-cwd-")); });
    afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

    it("a deleted seat folder is refused before tmux, with the folder named and nothing recorded", async () => {
      const gone = path.join(scratch, "deleted-after-first-launch");
      const rig = seatWithCwd(gone);
      const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

      const result = await createLauncher(mockTmuxAdapter({ createSession: createSpy })).launchNode(rig.id, "dev1-impl");

      expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
      expect(!result.ok && result.message).toContain(`its cwd '${gone}' does not exist, and a seat launched there would silently start in $HOME`);
      expect(!result.ok && result.message).toContain(`Create the folder ${gone}, then launch it again.`);
      expect(createSpy).not.toHaveBeenCalled();
      expect(sessionRegistry.getSessionsForRig(rig.id)).toHaveLength(0);
      expect(rigRepo.getRig(rig.id)!.nodes[0]!.binding).toBeNull();
    });

    it("a seat folder that is a file is refused with what is wrong, not told to create it", async () => {
      const file = path.join(scratch, "a-file");
      await fs.writeFile(file, "x");
      const rig = seatWithCwd(file);
      const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

      const result = await createLauncher(mockTmuxAdapter({ createSession: createSpy })).launchNode(rig.id, "dev1-impl");

      expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
      expect(!result.ok && result.message).toContain(`Fix ${file}: it is not a directory`);
      expect(!result.ok && result.message).not.toContain("Create the folder");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("an explicit launch cwd is judged in place of the recorded one", async () => {
      const gone = path.join(scratch, "explicit-gone");
      const rig = seatWithCwd(scratch);
      const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

      const result = await createLauncher(mockTmuxAdapter({ createSession: createSpy })).launchNode(rig.id, "dev1-impl", { cwd: gone });

      expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
      expect(!result.ok && result.message).toContain(`its cwd '${gone}'`);
      expect(createSpy).not.toHaveBeenCalled();
    });

    // OF-124: the one folder a launch may make is a project rig's own `.workspaces/<pod>-<member>` (daemon-owned, made by `rig up`).
    describe("a project rig's own workspace (OF-124)", () => {
      function projectSeat(rigName: string, seatDir: string) {
        const rig = rigRepo.createRig(rigName);
        rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", cwd: seatDir });
        return rig;
      }
      const launch = async (rigId: string, createSpy: ReturnType<typeof vi.fn>) =>
        createLauncher(mockTmuxAdapter({ createSession: createSpy as never })).launchNode(rigId, "dev.impl");

      it("a missing workspace folder is made again, then the seat starts in it", async () => {
        const project = path.join(scratch, "myproj");
        await fs.mkdir(project);
        const seatDir = path.join(project, ".workspaces", "dev-impl");
        const rig = projectSeat("myproj", seatDir);
        const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

        const result = await launch(rig.id, createSpy);

        expect(result.ok).toBe(true);
        expect((await fs.stat(seatDir)).isDirectory()).toBe(true);
        expect(createSpy.mock.calls[0]![1]).toBe(seatDir);
      });

      const refused: Array<[string, () => { rigName: string; project: string; seatDir: string }]> = [
        ["a rig not named for the project folder", () => ({ rigName: "someone-else", project: path.join(scratch, "myproj"), seatDir: path.join(scratch, "myproj", ".workspaces", "dev-impl") })],
        ["another seat's folder under .workspaces", () => ({ rigName: "myproj", project: path.join(scratch, "myproj"), seatDir: path.join(scratch, "myproj", ".workspaces", "dev-other") })],
        ["a folder outside .workspaces", () => ({ rigName: "myproj", project: path.join(scratch, "myproj"), seatDir: path.join(scratch, "myproj", "elsewhere", "dev-impl") })],
      ];
      for (const [title, shape] of refused) {
        it(`${title}: refused as before, and nothing is created`, async () => {
          const { rigName, project, seatDir } = shape();
          await fs.mkdir(project);
          const rig = projectSeat(rigName, seatDir);
          const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

          const result = await launch(rig.id, createSpy);

          expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
          expect(createSpy).not.toHaveBeenCalled();
          expect(await fs.readdir(project)).toEqual([]);
        });
      }

      it("a project folder that is gone is not made", async () => {
        const project = path.join(scratch, "myproj");
        const rig = projectSeat("myproj", path.join(project, ".workspaces", "dev-impl"));
        const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });

        expect(await launch(rig.id, createSpy)).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
        await expect(fs.stat(project)).rejects.toMatchObject({ code: "ENOENT" });
      });
    });

    it("an existing folder launches there; a seat recorded with no cwd is left to tmux's default", async () => {
      const withDir = seatWithCwd(scratch);
      const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });
      expect((await createLauncher(mockTmuxAdapter({ createSession: createSpy })).launchNode(withDir.id, "dev1-impl")).ok).toBe(true);
      expect(createSpy.mock.calls[0]![1]).toBe(scratch);

      db.close();
      db = setupDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      eventBus = new EventBus(db);
      const noCwd = seatWithCwd(undefined);
      const secondSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>().mockResolvedValue({ ok: true });
      expect((await createLauncher(mockTmuxAdapter({ createSession: secondSpy })).launchNode(noCwd.id, "dev1-impl")).ok).toBe(true);
      expect(secondSpy.mock.calls[0]![1]).toBeUndefined();
    });
  });

});
