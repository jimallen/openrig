// `rig edge add|list` (daemon side): put an edge back between existing seats after `rig remove` + `rig add` lost the cross-pod ones.
// Each row names the consequence for the kernel: stuck-item escalation reads delegates_to edges, restore orders launches by them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb, mockTmuxAdapter } from "./helpers/test-app.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RigEdgeService } from "../src/domain/rig-edge-service.js";
import { defaultResolveOrchestrator } from "../src/domain/queue-owner.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";

const WORK_DIR = existingRigRoot("work");

describe("rig edge add / list", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let eventBus: EventBus;
  let service: RigEdgeService;
  let rigId: string;

  const seats = ["advisor.lead", "operator.agent", "queue.worker"];

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    eventBus = new EventBus(db);
    service = new RigEdgeService({ db, rigRepo, eventBus });
    const rig = rigRepo.createRig("kernel");
    rigId = rig.id;
    for (const logicalId of seats) rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime: "codex", cwd: WORK_DIR });
  });
  afterEach(() => db.close());

  const edgeCount = () => rigRepo.getRig(rigId)!.edges.length;
  const auditEvents = () => db.prepare("SELECT payload FROM events WHERE type = 'rig.edge_added' ORDER BY seq").pluck().all().map((p) => JSON.parse(String(p)));
  const add = (from: string, to: string, kind: string) => service.add({ rigId, from, to, kind });

  it("restores the three edges a seat move lost, and the read-back lists exactly them by seat logical id", () => {
    expect(add("advisor.lead", "operator.agent", "delegates_to").ok).toBe(true);
    expect(add("advisor.lead", "queue.worker", "delegates_to").ok).toBe(true);
    expect(add("queue.worker", "advisor.lead", "escalates_to").ok).toBe(true);
    const listed = service.list(rigId);
    expect(listed.ok && listed.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort()).toEqual([
      "advisor.lead delegates_to operator.agent",
      "advisor.lead delegates_to queue.worker",
      "queue.worker escalates_to advisor.lead",
    ]);
  });

  it("adding an edge that exists changes nothing: same edge id, no second row, no second audit event", () => {
    const first = add("advisor.lead", "queue.worker", "delegates_to");
    const again = add("advisor.lead", "queue.worker", "delegates_to");
    expect(first.ok && again.ok && first.created && !again.created && first.edge.id === again.edge.id).toBe(true);
    expect(edgeCount()).toBe(1);
    expect(auditEvents()).toHaveLength(1);
  });

  it("the same pair under another kind is a different edge", () => {
    add("advisor.lead", "queue.worker", "delegates_to");
    expect(add("advisor.lead", "queue.worker", "can_observe").ok).toBe(true);
    expect(edgeCount()).toBe(2);
  });

  it("takes node ids as well as logical ids", () => {
    const [lead, worker] = [rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "advisor.lead")!, rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "queue.worker")!];
    const r = add(lead.id, worker.id, "delegates_to");
    expect(r.ok && r.edge).toMatchObject({ from: "advisor.lead", to: "queue.worker" });
  });

  it("tells live subscribers about the add, once, and not about a repeat", () => {
    const seen: string[] = [];
    eventBus.subscribe((e) => { seen.push(e.type); });
    add("advisor.lead", "queue.worker", "delegates_to");
    add("advisor.lead", "queue.worker", "delegates_to");
    expect(seen).toEqual(["rig.edge_added"]);
  });

  it("refuses a self-edge, writing nothing", () => {
    const r = add("queue.worker", "queue.worker", "escalates_to");
    expect(!r.ok && r.code).toBe("self_edge");
    expect(edgeCount()).toBe(0);
    expect(auditEvents()).toHaveLength(0);
  });

  it.each([["ghost.seat", "queue.worker"], ["advisor.lead", "ghost.seat"]])("refuses an endpoint that is not a seat of the rig (%s -> %s)", (from, to) => {
    const r = add(from, to, "delegates_to");
    expect(!r.ok && r.code).toBe("node_not_found");
    expect(!r.ok && r.message).toContain("ghost.seat");
    expect(edgeCount()).toBe(0);
  });

  it("refuses an unknown rig and a bad kind, and names the kinds that exist", () => {
    const rig = service.add({ rigId: "nope", from: "a", to: "b", kind: "delegates_to" });
    expect(!rig.ok && rig.code).toBe("rig_not_found");
    const bad = add("advisor.lead", "queue.worker", "friends_with");
    expect(!bad.ok && bad.code).toBe("invalid_kind");
    expect(!bad.ok && bad.message).toContain("escalates_to");
    expect(edgeCount()).toBe(0);
  });

  it.each([[{ from: "", to: "queue.worker", kind: "delegates_to" }], [{ from: "advisor.lead", to: 7, kind: "delegates_to" }], [{ from: "advisor.lead", to: "queue.worker", kind: undefined }]])("refuses a malformed request %j", (body) => {
    const r = service.add({ rigId, ...body });
    expect(!r.ok && r.code).toBe("validation_failed");
    expect(edgeCount()).toBe(0);
  });

  describe("launch-order cycles", () => {
    it("refuses delegates_to that closes a loop, directly and through a third seat", () => {
      add("advisor.lead", "queue.worker", "delegates_to");
      const direct = add("queue.worker", "advisor.lead", "delegates_to");
      expect(!direct.ok && direct.code).toBe("would_cycle");
      add("queue.worker", "operator.agent", "delegates_to");
      const indirect = add("operator.agent", "advisor.lead", "delegates_to");
      expect(!indirect.ok && indirect.code).toBe("would_cycle");
      expect(edgeCount()).toBe(2);
    });

    it("reads spawned_by in the opposite direction: the target launches first", () => {
      add("advisor.lead", "queue.worker", "delegates_to"); // lead launches before worker
      const r = add("advisor.lead", "queue.worker", "spawned_by"); // would make worker launch before lead
      expect(!r.ok && r.code).toBe("would_cycle");
      expect(add("queue.worker", "advisor.lead", "spawned_by").ok).toBe(true); // same order as the delegates_to: fine
    });

    it("control: kinds that only record (escalates_to, collaborates_with) may point both ways, as the kernel's own pair does", () => {
      add("advisor.lead", "queue.worker", "delegates_to");
      expect(add("queue.worker", "advisor.lead", "escalates_to").ok).toBe(true);
      expect(add("advisor.lead", "queue.worker", "collaborates_with").ok).toBe(true);
      expect(add("queue.worker", "advisor.lead", "collaborates_with").ok).toBe(true);
    });
  });

  it("audits the add once, with the rig, the seats, the kind, the reason and the operator, and not for a refusal", () => {
    service.add({ rigId, from: "advisor.lead", to: "queue.worker", kind: "delegates_to", reason: "restore after pi move", operator: "engineer@kernel" });
    add("queue.worker", "queue.worker", "delegates_to");
    expect(auditEvents()).toEqual([{
      type: "rig.edge_added", rigId, edgeId: expect.any(String), from: "advisor.lead", to: "queue.worker", kind: "delegates_to",
      reason: "restore after pi move", operator: "engineer@kernel",
    }]);
  });

  describe("what reads edges sees the added one", () => {
    it("stuck-item escalation: the destination's orchestrator is the delegating seat's session once the edge is back", () => {
      const nodes = rigRepo.getRig(rigId)!.nodes;
      const bind = (logicalId: string, session: string) => db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(`s-${logicalId}`, nodes.find((n) => n.logicalId === logicalId)!.id, session);
      bind("advisor.lead", "advisor-lead@kernel");
      bind("queue.worker", "queue-worker@kernel");
      expect(defaultResolveOrchestrator(db, "queue-worker@kernel")).toBeNull();
      add("advisor.lead", "queue.worker", "delegates_to");
      expect(defaultResolveOrchestrator(db, "queue-worker@kernel")).toBe("advisor-lead@kernel");
    });

    it("restore order and the snapshot: the added edge is in the snapshot and makes its source launch first", async () => {
      const second = rigRepo.createRig("order");
      const alpha = rigRepo.addNode(second.id, "alpha", { role: "worker", runtime: "claude-code", cwd: WORK_DIR });
      const beta = rigRepo.addNode(second.id, "beta", { role: "worker", runtime: "claude-code", cwd: WORK_DIR });
      const sessionRegistry = new SessionRegistry(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
      const tmuxAdapter = mockTmuxAdapter();
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
        nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter }), tmuxAdapter,
        claudeResume: new ClaudeResumeAdapter(tmuxAdapter), codexResume: new CodexResumeAdapter(tmuxAdapter),
      });
      const orderOf = async () => {
        const snap = snapshotCapture.captureSnapshot(second.id, "manual");
        const restored = await orchestrator.restore(snap.id);
        return { snap, order: restored.ok ? restored.result.nodes.map((n) => n.logicalId) : [] };
      };
      expect((await orderOf()).order).toEqual(["alpha", "beta"]); // control: alphabetical with no edge
      const added = service.add({ rigId: second.id, from: "beta", to: "alpha", kind: "delegates_to" });
      expect(added.ok).toBe(true);
      const { snap, order } = await orderOf();
      expect(snap.data.edges.map((e) => [e.sourceId, e.targetId, e.kind])).toEqual([[beta.id, alpha.id, "delegates_to"]]);
      expect(order).toEqual(["beta", "alpha"]);
    });
  });

  describe("HTTP", () => {
    function app() {
      const a = new Hono<{ Variables: { rigRepo: RigRepository; eventBus: EventBus } }>();
      a.use("*", async (c, next) => { c.set("rigRepo", rigRepo); c.set("eventBus", eventBus); await next(); });
      a.route("/api/rigs", rigsRoutes);
      return a;
    }
    const post = (body: unknown, headers: Record<string, string> = {}, id = rigId) =>
      app().request(`/api/rigs/${id}/edges`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    it("POST creates (201), repeats (200), and GET reads back", async () => {
      const body = { from: "advisor.lead", to: "queue.worker", kind: "delegates_to" };
      expect((await post(body)).status).toBe(201);
      expect((await post(body)).status).toBe(200);
      const got = await app().request(`/api/rigs/${rigId}/edges`);
      expect(got.status).toBe(200);
      expect((await got.json()).edges).toHaveLength(1);
    });

    it("maps refusals to 404 (unknown rig or seat), 409 (cycle), 400 (self, kind)", async () => {
      await post({ from: "advisor.lead", to: "queue.worker", kind: "delegates_to" });
      expect((await post({ from: "a", to: "b", kind: "delegates_to" }, {}, "nope")).status).toBe(404);
      expect((await app().request("/api/rigs/nope/edges")).status).toBe(404);
      expect((await post({ from: "ghost", to: "queue.worker", kind: "delegates_to" })).status).toBe(404);
      expect((await post({ from: "queue.worker", to: "advisor.lead", kind: "delegates_to" })).status).toBe(409);
      expect((await post({ from: "queue.worker", to: "queue.worker", kind: "delegates_to" })).status).toBe(400);
      expect((await post({ from: "advisor.lead", to: "queue.worker", kind: "nope" })).status).toBe(400);
    });

    it("records the actor: the transport identity wins over a body operator, else the body operator", async () => {
      await post({ from: "advisor.lead", to: "queue.worker", kind: "delegates_to", operator: "claimed@kernel" }, { "x-openrig-session": "engineer@kernel" });
      await post({ from: "advisor.lead", to: "operator.agent", kind: "delegates_to", operator: "claimed@kernel" });
      expect(auditEvents().map((e) => e.operator)).toEqual(["engineer@kernel", "claimed@kernel"]);
    });
  });
});
