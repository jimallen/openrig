// OF-2 — every name-keyed "latest row" lookup resolves a session name live-first.
//
// Production consequence: an archived rig keeps its session rows. A rig recreated under the same seat
// name gets NEWER session rows, but a lookup that ignores the archive flag can still land on the
// archived predecessor (whichever row happens to sort last), so wake, queue ownership, fork, compaction,
// liveness and activity reads then act on a dead rig's node, runtime, cwd or resume token.
//
// Fixture shape for every row: the LIVE rig is created first and the ARCHIVED rig second, so the archived
// session row carries the NEWEST id. `ORDER BY id DESC LIMIT 1` therefore picks the archived row; only a
// live-first rule picks the live one. Live and archived nodes differ in runtime, cwd and resume token so
// each site's answer names which rig it resolved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { findBindingNodeLiveFirst, findLatestSessionNameMatch, isSessionNameRunning } from "../src/domain/latest-session-name-match.js";
import { resolveSessionNodeId } from "../src/domain/queue-owner.js";
import { nodeRuntimeOf } from "../src/domain/workflow-projector.js";
import { discoverResumeToken } from "../src/domain/agent-images/resume-token-discovery.js";
import { listWakeSessionsBySeat } from "../src/domain/wake-resolve-service.js";
import { resolveForkSourceNode } from "../src/routes/agent-images.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { OperatingPostureService } from "../src/domain/rig-mode/operating-posture.js";
import { QueueRepository as QueueRepositoryClass } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createFullTestDb } from "./helpers/test-app.js";

const NAME = "dev-impl@alpha";

describe("name-keyed latest-row lookups resolve a live rig before an archived one (OF-2)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let live: { nodeId: string; sessionId: string; rigId: string };
  let archived: { nodeId: string; sessionId: string; rigId: string };

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);

    const liveRig = rigRepo.createRig("alpha");
    const liveNode = rigRepo.addNode(liveRig.id, "dev.impl", { role: "worker", runtime: "codex", cwd: "/live/cwd" });
    const liveSession = registry.registerSession(liveNode.id, NAME);
    // created_at is set explicitly (archived strictly newer): sessions created within one second share a
    // created_at, which would let a created_at-ordered revert pass by insertion-order accident.
    db.prepare("UPDATE sessions SET resume_token = 'LIVE-TOKEN', status = 'running', created_at = '2026-01-01 00:00:00' WHERE id = ?").run(liveSession.id);
    live = { nodeId: liveNode.id, sessionId: liveSession.id, rigId: liveRig.id };

    const oldRig = rigRepo.createRig("alpha-old");
    const oldNode = rigRepo.addNode(oldRig.id, "dev.impl", { role: "worker", runtime: "claude-code", cwd: "/archived/cwd" });
    const oldSession = registry.registerSession(oldNode.id, NAME);
    db.prepare("UPDATE sessions SET resume_token = 'ARCHIVED-TOKEN', status = 'running', created_at = '2026-06-01 00:00:00' WHERE id = ?").run(oldSession.id);
    expect(rigRepo.archiveRig(oldRig.id)).toBe(true);
    archived = { nodeId: oldNode.id, sessionId: oldSession.id, rigId: oldRig.id };

    // Fixture control: the archived row really is the newest, so a bare id-DESC pick would choose it.
    expect(oldSession.id > liveSession.id).toBe(true);
  });

  afterEach(() => db.close());

  it("session-registry.currentOccupantGenerationForSession reads the live node's generation", () => {
    const liveGen = registry.currentOccupantTenure(live.nodeId)?.generationUuid;
    const oldGen = registry.currentOccupantTenure(archived.nodeId)?.generationUuid;
    expect(liveGen).toBeTruthy();
    expect(oldGen).toBeTruthy();
    expect(liveGen).not.toBe(oldGen);
    expect(registry.currentOccupantGenerationForSession(NAME)).toBe(liveGen);
  });

  it("session-registry.findResumeContextByName names the live node", () => {
    const ctx = registry.findResumeContextByName(NAME);
    expect(ctx?.nodeId).toBe(live.nodeId);
    expect(ctx?.sessionId).toBe(live.sessionId);
    expect(ctx?.runtime).toBe("codex");
  });

  it("queue-owner.resolveSessionNodeId (also the startup activity reader) names the live node", () => {
    expect(resolveSessionNodeId(db, NAME)).toBe(live.nodeId);
  });

  it("workflow-projector.nodeRuntimeOf reports the live node's runtime", () => {
    expect(nodeRuntimeOf(db, NAME)).toBe("codex");
  });

  it("resume-token-discovery returns the live seat's native thread id", () => {
    const outcome = discoverResumeToken(db, NAME);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.runtime).toBe("codex");
      expect(outcome.result.nativeId).toBe("LIVE-TOKEN");
      expect(outcome.result.nodeCwd).toBe("/live/cwd");
    }
  });

  it("wake listing offers the live session first and leaves the archived one out", () => {
    const rows = listWakeSessionsBySeat(db, NAME);
    expect(rows.map((r) => r.id)).toEqual([live.sessionId]);
    expect(rows[0]!.resumeToken).toBe("LIVE-TOKEN");
  });

  it("agent-images fork source mirrors the live seat's launch shape", () => {
    expect(resolveForkSourceNode(db, NAME)?.cwd).toBe("/live/cwd");
    expect(resolveForkSourceNode(db, NAME)?.runtime).toBe("codex");
  });

  it("agent-activity-store.resolveSession names the live node and session", () => {
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
    const resolved = store.resolveSession({ sessionName: NAME });
    expect(resolved?.nodeId).toBe(live.nodeId);
    expect(resolved?.sessionId).toBe(live.sessionId);
    expect(resolved?.rigId).toBe(live.rigId);
  });

  it("claim-service session-name fallback maps to the live node", () => {
    const svc = Object.create(ClaimService.prototype) as unknown as { db: Database.Database; resolveNodeIdForSessionName(n: string): string | null };
    svc.db = db;
    expect(svc.resolveNodeIdForSessionName(NAME)).toBe(live.nodeId);
  });

  it("workflow seat-liveness probe judges the live seat, not the archived one", () => {
    // Live seat has exited; the archived predecessor is (stale) 'running'.
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(live.sessionId);
    const eventBus = new EventBus(db);
    const runtime = new WorkflowRuntime({ db, eventBus, queueRepo: new QueueRepository(db, eventBus, { validateRig: () => true }) });
    const probe = (runtime as unknown as { seatLivenessCheck(ref: string): { alive: boolean; reason?: string } }).seatLivenessCheck;
    expect(probe(NAME)).toEqual({ alive: false, reason: "session_status_exited" });
  });

  it("seat-attention-reconciler latest-session lookup names the live node", () => {
    const svc = Object.create(SeatAttentionReconciler.prototype) as unknown as { deps: unknown; findLatestSessionByName(n: string): { nodeId: string; rigId: string; runtime: string | null } | null };
    svc.deps = { sessionRegistry: { db } };
    const found = svc.findLatestSessionByName(NAME);
    expect(found?.nodeId).toBe(live.nodeId);
    expect(found?.rigId).toBe(live.rigId);
    expect(found?.runtime).toBe("codex");
  });

  it("rig-lifecycle fallback validation judges the live seat's status", async () => {
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(live.sessionId);
    const svc = Object.create(RigLifecycleService.prototype) as unknown as { db: Database.Database; validateFallbackDestination(d: string, t: Set<string>): Promise<{ code: string } | null> };
    svc.db = db;
    // Target set names the ARCHIVED node: judged against the archived row this would be 'fallback_in_target'.
    const failure = await svc.validateFallbackDestination(NAME, new Set([archived.nodeId]));
    expect(failure?.code).toBe("fallback_not_running");
  });

  it("session-transport session meta (runtime, node) comes from the live seat", () => {
    const svc = Object.create(SessionTransport.prototype) as unknown as { db: Database.Database; getSessionMeta(n: string): { runtime: string | null; nodeId: string | null; resumeToken: string | null } };
    svc.db = db;
    const meta = svc.getSessionMeta(NAME);
    expect(meta.nodeId).toBe(live.nodeId);
    expect(meta.runtime).toBe("codex");
    expect(meta.resumeToken).toBe("LIVE-TOKEN");
  });

  it("operating-posture infers the working folder from the live seat", () => {
    const svc = Object.create(OperatingPostureService.prototype) as unknown as { db: Database.Database; inferenceSignals(ctx: unknown, dest: string | null): { cwd: string | null } };
    svc.db = db;
    expect(svc.inferenceSignals({}, NAME).cwd).toBe("/live/cwd");
  });

  it("a partial schema without rigs/nodes still answers with the newest row (pre-topology fixtures)", () => {
    const bare = new Database(":memory:");
    bare.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT, session_name TEXT)");
    bare.prepare("INSERT INTO sessions VALUES ('01A', 'n1', 'x@y'), ('01B', 'n2', 'x@y')").run();
    expect(findLatestSessionNameMatch(bare, "x@y")?.node_id).toBe("n2");
    expect(findLatestSessionNameMatch(bare, "absent@y")).toBeNull();
    bare.close();
  });

  it("isSessionNameRunning judges the live seat: a stale running archived row cannot vouch for a stopped live seat", () => {
    expect(isSessionNameRunning(db, NAME)).toBe(true);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(live.sessionId);
    expect(isSessionNameRunning(db, NAME)).toBe(false);
    expect(isSessionNameRunning(db, "nobody@nowhere")).toBe(false);
  });

  it("queue terminal-transport check follows the live seat's binding, not an archived tmux binding", () => {
    // Live seat attaches externally (no tmux); the archived predecessor had a tmux binding.
    registry.updateBinding(archived.nodeId, { tmuxSession: NAME });
    registry.updateBinding(live.nodeId, { attachmentType: "external_cli", externalSessionName: "ext" });
    const repo = Object.create(QueueRepositoryClass.prototype) as unknown as { db: Database.Database; hasTerminalTransport(d: string): boolean };
    repo.db = db;
    expect(repo.hasTerminalTransport(NAME)).toBe(false);
  });

  it("with two live rigs holding the name, the NEWEST live row answers (not the oldest, not an archived one)", () => {
    const newerRig = rigRepo.createRig("alpha-2");
    const newerNode = rigRepo.addNode(newerRig.id, "dev.impl", { role: "worker", runtime: "codex", cwd: "/newer/cwd" });
    registry.registerSession(newerNode.id, NAME);
    expect(resolveSessionNodeId(db, NAME)).toBe(newerNode.id);
    expect(nodeRuntimeOf(db, NAME)).toBe("codex");
  });
});

describe("claim-service binding lookup is live-first (OF-2)", () => {
  const BOUND = "dev-impl@alpha";
  function resolve(db: Database.Database): string | null {
    const svc = Object.create(ClaimService.prototype) as unknown as { db: Database.Database; resolveNodeIdForSessionName(n: string): string | null };
    svc.db = db;
    return svc.resolveNodeIdForSessionName(BOUND);
  }
  function seed(archivedFirst: boolean) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const make = (rigName: string, archive: boolean) => {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
      registry.registerSession(node.id, BOUND);
      registry.updateBinding(node.id, { tmuxSession: BOUND });
      if (archive) expect(rigRepo.archiveRig(rig.id)).toBe(true);
      return node.id;
    };
    const first = archivedFirst ? make("alpha-old", true) : make("alpha", false);
    const second = archivedFirst ? make("alpha", false) : make("alpha-old", true);
    return { db, liveNodeId: archivedFirst ? second : first, archivedNodeId: archivedFirst ? first : second };
  }

  it("a recreated live rig's binding wins over the archived predecessor's older binding", () => {
    const { db, liveNodeId, archivedNodeId } = seed(true);
    expect(liveNodeId).not.toBe(archivedNodeId);
    expect(resolve(db)).toBe(liveNodeId);
    db.close();
  });

  it("the live binding wins when the archived rig's binding is the newer one", () => {
    const { db, liveNodeId } = seed(false);
    expect(resolve(db)).toBe(liveNodeId);
    db.close();
  });
});

describe("running-seat lookups by session name with the archived rig created FIRST (OF-2)", () => {
  const BOUND = "dev-impl@alpha";
  function seed() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const make = (rigName: string, archive: boolean, pane: string) => {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
      const session = registry.registerSession(node.id, BOUND);
      db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
      registry.updateBinding(node.id, { tmuxSession: BOUND, tmuxPane: pane });
      if (archive) expect(rigRepo.archiveRig(rig.id)).toBe(true);
      return node.id;
    };
    const archivedNodeId = make("alpha-old", true, "%9");
    const liveNodeId = make("alpha", false, "%1");
    return { db, archivedNodeId, liveNodeId };
  }

  it("session-transport absence probe targets the live running seat, not the archived one", () => {
    const { db, liveNodeId, archivedNodeId } = seed();
    expect(liveNodeId).not.toBe(archivedNodeId);
    const svc = Object.create(SessionTransport.prototype) as unknown as { db: Database.Database; absenceProbeTarget(n: string): { node_id: string; tmux_pane: string | null } | undefined };
    svc.db = db;
    const target = svc.absenceProbeTarget(BOUND);
    expect(target?.node_id).toBe(liveNodeId);
    expect(target?.tmux_pane).toBe("%1");
    db.close();
  });

  it("with two live rigs bound to the name, the newest binding answers deterministically", () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const bind = (rigName: string) => {
      const node = rigRepo.addNode(rigRepo.createRig(rigName).id, "dev.impl", { role: "worker", runtime: "codex" });
      registry.registerSession(node.id, BOUND);
      registry.updateBinding(node.id, { tmuxSession: BOUND });
      return node.id;
    };
    bind("alpha-a");
    const newer = bind("alpha-b");
    expect(findBindingNodeLiveFirst(db, BOUND)).toBe(newer);
    db.close();
  });
});
