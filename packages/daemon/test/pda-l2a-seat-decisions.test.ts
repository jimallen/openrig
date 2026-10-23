// pda runtime L2a: the seat decisions a runtime without a fresh start, and that withholds startup content, changes.
//   - D4 (census row 14): the startup orchestrator sends no identity prompt, preload, action or proof challenge.
//   - A4 (census row 25): `--fresh` is refused at the ONE shared fresh decision, so restore, restore-check, the plan
//     and `rig seat launch --fresh` refuse with the same words (T21b), and every other runtime is unchanged (T29).
//   - T29b: the stop-for-decision remedies for such a seat never name a `--fresh` command.
//   - census row 15: every handover source is refused for it, the dry-run plan included.
// The decisions read the adapter's declaration (`freshStart`, `startupContent`), never the runtime's name, so the
// harness rows below use the existing claude-code fixtures with an adapter that declares what pda declares.

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { resolveFreshSeatStartup } from "../src/domain/seat-startup-source.js";
import { decideListedFreshSeat, predictListedSeatRefusals } from "../src/domain/fresh-seat-restore-decision.js";
import { decideSeatPreLaunchGate } from "../src/domain/restore-seat-gates.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotData, StartupAction } from "../src/domain/types.js";

const withholding = (over: Partial<RuntimeAdapter> = {}): RuntimeAdapter => ({
  runtime: "pda",
  freshStart: "unsupported",
  startupContent: "withhold",
  listInstalled: vi.fn(async () => []),
  project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
  deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
  checkReady: vi.fn(async () => ({ ready: true })),
  launchHarness: vi.fn(async (_b, o) => ({ ok: true, ...(o.resumeToken ? { resumeToken: o.resumeToken, resumeType: "pda_agent" } : {}) })),
  ...over,
});

describe("D4: the startup orchestrator withholds startup content from a withholding runtime (T15)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  function run(adapter: RuntimeAdapter, isRestore: boolean, resumeToken?: string) {
    db = createFullTestDb();
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: adapter.runtime });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true), capturePaneContent: vi.fn(async () => "❯ \n"), listPanes: vi.fn(async () => []),
    } as unknown as TmuxAdapter;
    const orch = new StartupOrchestrator({
      db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {},
      readinessSettings: { resolveOne: () => ({ value: 30, source: "default", defaultValue: 30 }) } as never,
    });
    const binding: NodeBinding = { id: "b1", nodeId: node.id, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
    const actions: StartupAction[] = [
      { type: "startup_proof", value: "authenticated", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true },
      { type: "send_text", value: "IDENTITY-CANARY", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, builtin: "session_identity" },
      { type: "send_text", value: "PRELOAD-CANARY load your skills", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true },
      { type: "slash_command", value: "/AFTER-FILES-CANARY", phase: "after_files", appliesOn: ["fresh_start", "restore"], idempotent: true },
    ];
    const files = [{ path: "role.md", absolutePath: "/nowhere/role.md", ownerRoot: "/nowhere", deliveryHint: "send_text" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] }];
    return {
      tmux, db, nodeId: node.id,
      result: orch.startNode({
        rigId: rig.id, nodeId: node.id, sessionId: session.id, binding, adapter,
        plan: { runtime: adapter.runtime, cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: files, startupActions: actions, isRestore, ...(resumeToken ? { resumeToken, resumeType: "pda_agent" } : {}),
      }),
    };
  }

  const events = (d: Database.Database, nodeId: string, type: string) =>
    (d.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = ?").get(nodeId, type) as { n: number }).n;

  it.each([
    ["a first launch", false, undefined],
    ["a restore replay (resume)", true, "http://127.0.0.1:8150/agents/research"],
  ] as const)("%s: 0 pastes, 0 keys, 0 challenges; the files go only to the adapter; it says what it withheld", async (_name, isRestore, token) => {
    const adapter = withholding();
    const { tmux, result, db: d, nodeId } = run(adapter, isRestore, token);
    const outcome = await result;
    expect(outcome.ok).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(events(d, nodeId, "node.startup_challenged")).toBe(0);
    if (!isRestore) expect(events(d, nodeId, "node.startup_proof_skipped")).toBe(1);
    expect(outcome.warnings?.join("\n")).toContain("3 startup actions were withheld");
    // The adapter is still asked to deliver the post-launch file (it delivers nothing and says so); never the pane.
    expect((adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[0] as unknown[]).length).toBeGreaterThan(0);
  });

  it("control: the same input to a delivering adapter does paste (the gate is the declaration, nothing else)", async () => {
    const { tmux, result, db: d, nodeId } = run(withholding({ startupContent: undefined, runtime: "pda" }), false);
    await result;
    expect((tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.length + (tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(events(d, nodeId, "node.startup_challenged")).toBe(1);
  });
});

describe("A4: --fresh is refused at the one shared fresh decision", () => {
  it("resolveFreshSeatStartup refuses before any source is read; a supporting adapter goes on to read one (T29 control)", async () => {
    const specReader = { readSeatStartupFromSpec: vi.fn(async () => ({ kind: "unrecorded" as const })) };
    const fullDb = createFullTestDb(); // in memory; the stored-context read of the control row needs real tables
    const deps = (adapter: RuntimeAdapter) => ({ db: fullDb, rigRepo: { getRigSpecSource: () => "/spec" }, specReader: specReader as never, runtimeAdapters: { pda: adapter } });
    const input = { rigId: "r", nodeId: "n", logicalId: "dev.research", runtime: "pda", cwd: ".", sessionName: "s", startupFrom: "spec" as const, refusalGuidance: "g" };
    const refused = await resolveFreshSeatStartup(deps(withholding()), input);
    expect(refused).toMatchObject({ ok: false, code: "fresh_start_unsupported" });
    expect(JSON.stringify(refused)).not.toContain("--fresh");
    expect(specReader.readSeatStartupFromSpec).not.toHaveBeenCalled();
    await resolveFreshSeatStartup(deps(withholding({ freshStart: undefined })), input);
    expect(specReader.readSeatStartupFromSpec).toHaveBeenCalledTimes(1);
  });

  it("T21b: restore's decision and every prediction's give the same refusal text for the seat", async () => {
    const rig = { rig: { name: "team" }, nodes: [{ id: "n1", logicalId: "dev.research", podId: "p", runtime: "pda", cwd: "." }] };
    const deps = { db: {} as never, rigRepo: { getRig: () => rig, getRigSpecSource: () => "/spec" }, specReader: null, runtimeAdapters: { pda: withholding() } };
    const restoreSays = await decideListedFreshSeat(deps, {
      rigId: "r", nodeId: "n1", logicalId: "dev.research", rigName: "team", runtime: "pda", cwd: ".", sessionName: "dev-research@team",
      startupFrom: "spec", snapshotCopy: null, exists: () => true,
    });
    const predicted = await predictListedSeatRefusals(deps, { rigId: "r", freshLogicalIds: ["dev.research"], startupFrom: "spec", snapshot: null, exists: () => true });
    expect(restoreSays.refusal).toContain("has no fresh start");
    expect(predicted.get("dev.research")).toBe(restoreSays.refusal);
  });

  describe("the real restore and the real restore-check over one seat (harness), listed with --fresh", () => {
    let h: RestoreHarness;
    afterEach(() => h?.cleanup());

    async function both(adapter: RuntimeAdapter) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      const snapshotId = await h.down(seat.rigId);
      const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": adapter }, specReader: h.inst });
      const check = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, freshLogicalIds: ["dev.impl"] } as never);
      const pre = check.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
      const launchesBefore = (h.tmux.createSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) }, freshLogicalIds: ["dev.impl"] } as never);
      if (!out.ok) throw new Error(`restore did not run: ${JSON.stringify(out)}`);
      const node = out.result.nodes.find((n) => n.logicalId === "dev.impl")!;
      return { pre, node, launched: (h.tmux.createSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length - launchesBefore };
    }

    it("refused alike: restore starts nothing and reports the refusal; the check is red with restore's own words", async () => {
      const { pre, node, launched } = await both({ ...createRestoreHarnessAdapterLike(), freshStart: "unsupported" });
      expect(node.status).toBe("failed");
      const refusal = /^Fresh start refused: (.*) No session was started\.$/s.exec(node.error ?? "")?.[1];
      expect(refusal).toContain("has no fresh start");
      expect(launched).toBe(0);
      expect(pre.status).toBe("red");
      expect(pre.evidence).toContain(refusal!);
    });

    it("control: the same seat with an adapter that supports a fresh start restores fresh and the check is not red", async () => {
      const { pre, node } = await both(createRestoreHarnessAdapterLike());
      expect(node.status).not.toBe("failed");
      expect(pre.status).not.toBe("red");
    });
  });
});

/** The harness's own adapter shape (it launches and is always ready), without the harness instance. */
function createRestoreHarnessAdapterLike(): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async (files) => ({ delivered: files.length, failed: [] }),
    launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
    checkReady: async () => ({ ready: true }),
  };
}

describe("T29b: the stop-for-decision remedies of a pda seat never name --fresh", () => {
  const data = (session: Record<string, unknown>, extra: Partial<SnapshotData> = {}): SnapshotData => ({
    sessions: [{ id: "s1", nodeId: "n1", status: "running", ...session }], activeSessionIdByNode: { n1: "s1" }, nodes: [], checkpoints: {}, ...extra,
  }) as unknown as SnapshotData;
  const gate = (d: SnapshotData, runtime: string) => decideSeatPreLaunchGate({
    data: d, snapshotNodeId: "n1", logicalId: "dev.research", live: { runtime }, freshRequested: false, rigName: "team", continuityStatus: null,
  });

  it("no_token: the pda remedy records the binding's token and resumes; the claude remedy is unchanged", () => {
    const noToken = data({ restorePolicy: "resume_if_possible", resumeType: "pda_agent", resumeToken: null });
    const pda = gate(noToken, "pda");
    expect(pda).toMatchObject({ kind: "stop", gate: "no_token", status: "awaiting-decision" });
    const text = (pda as { error: string }).error;
    expect(text).toContain("has no fresh start");
    expect(text).toContain("rig seat set-resume-token 'dev.research@team' --token-stdin");
    expect(text).not.toContain("--fresh");
    const claude = gate(data({ restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: null }), "claude-code");
    expect((claude as { error: string }).error).toContain("rig seat launch 'dev.research@team' --fresh");
  });

  it("absent_history: the same, for a seat whose earlier occupant left a token", () => {
    const absent = data({ status: "exited", resumeType: "pda_agent", resumeToken: "http://127.0.0.1:8150/agents/research" }, { activeOccupantsByNode: { n1: { kind: "absent" } } } as never);
    const pda = gate(absent, "pda");
    expect(pda).toMatchObject({ kind: "stop", gate: "absent_history" });
    expect((pda as { error: string }).error).toContain("has no fresh start");
    expect((pda as { error: string }).error).not.toContain("--fresh");
    expect((pda as { error: string }).error).not.toContain("http://127.0.0.1:8150/agents/research"); // never quoted from the snapshot
    expect((gate(absent, "claude-code") as { error: string }).error).toContain("--fresh");
  });
});

describe("census row 15: a seat whose runtime has no fresh start has no handover", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it.each(["fresh", "fork", "rebuild", "discovered:whatever"])("source %s is refused before anything (dry run too); a codex seat is not", async (source) => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const tmuxCalls: string[] = [];
    const tmux = new Proxy({}, { get: (_t, name) => async () => { tmuxCalls.push(String(name)); return { ok: true }; } }) as TmuxAdapter;
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus: new EventBus(db), tmuxAdapter: tmux,
      runtimeAdapters: { pda: withholding(), codex: { runtime: "codex" } as unknown as RuntimeAdapter }, sleep: async () => {},
    });
    const rig = rigRepo.createRig("seat-rig");
    for (const [logical, runtime] of [["dev.research", "pda"], ["dev.impl", "codex"]] as const) {
      const node = rigRepo.addNode(rig.id, logical, { runtime, cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, `${logical.replace(".", "-")}@seat-rig`);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: `${logical.replace(".", "-")}@seat-rig`, tmuxPane: "%0" });
    }
    const rows = () => JSON.stringify(["nodes", "sessions", "bindings", "events"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    const before = rows();
    for (const dryRun of [false, true]) {
      const result = await service.handover({ seatRef: "dev-research@seat-rig", reason: "test", source, dryRun });
      expect(result).toMatchObject({ ok: false, code: "handover_unsupported_runtime" });
    }
    expect(tmuxCalls).toEqual([]);
    expect(rows()).toBe(before);
    const codex = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "test", source, dryRun: true });
    expect(codex).not.toMatchObject({ code: "handover_unsupported_runtime" });
  });
});
