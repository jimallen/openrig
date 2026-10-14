import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("WhoamiService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let transcriptStore: TranscriptStore;
  let svc: WhoamiService;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true });
    svc = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore });
  });

  afterEach(() => { db.close(); });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Development");
    const nodeA = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", label: "Implementer", podId: "pod-dev" });
    const nodeB = rigRepo.addNode(rig.id, "dev.qa", { role: "reviewer", runtime: "codex", label: "QA", podId: "pod-dev" });
    rigRepo.addEdge(rig.id, nodeA.id, nodeB.id, "delegates_to");

    const sessA = sessionRegistry.registerSession(nodeA.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sessA.id, "running");
    sessionRegistry.updateBinding(nodeA.id, { tmuxSession: "dev-impl@my-rig" });

    const sessB = sessionRegistry.registerSession(nodeB.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sessB.id, "running");
    sessionRegistry.updateBinding(nodeB.id, { tmuxSession: "dev-qa@my-rig" });

    return { rig, nodeA, nodeB, sessA, sessB };
  }

  it("resolve by nodeId returns full identity including memberLabel, peers, edges", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("node_id");
    expect(result!.identity.logicalId).toBe("dev.impl");
    expect(result!.identity.memberId).toBe("impl");
    expect(result!.identity.memberLabel).toBe("Implementer");
    expect(result!.identity.podNamespace).toBe("dev");
    expect(result!.identity.sessionName).toBe("dev-impl@my-rig");
    expect(result!.identity.runtime).toBe("claude-code");
    expect(result!.identity.rigName).toBe("my-rig");
  });

  it("resolve by sessionName returns same result", () => {
    seedRig();
    const result = svc.resolve({ sessionName: "dev-impl@my-rig" });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("session_name");
    expect(result!.identity.logicalId).toBe("dev.impl");
  });

  it("edges classified correctly as outgoing/incoming relative to queried node", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    // nodeA delegates_to nodeB → outgoing from A's perspective
    expect(result!.edges.outgoing).toHaveLength(1);
    expect(result!.edges.outgoing[0]!.kind).toBe("delegates_to");
    expect(result!.edges.outgoing[0]!.to.logicalId).toBe("dev.qa");
    expect(result!.edges.incoming).toHaveLength(0);
  });

  it("peers list excludes the queried node itself, uses current sessions", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result!.peers).toHaveLength(1);
    expect(result!.peers[0]!.logicalId).toBe("dev.qa");
    expect(result!.peers[0]!.sessionName).toBe("dev-qa@my-rig");
    expect(result!.peers[0]!.podNamespace).toBe("dev");
    // Should NOT include self
    expect(result!.peers.find((p) => p.logicalId === "dev.impl")).toBeUndefined();
  });

  // OPR.99.0.6.1 — the peers[] roster contract, stated and asserted.
  it("peers[] is the same-rig roster excluding self, independent of directional edges (the contract)", () => {
    const { rig, nodeA } = seedRig();
    // A third node with NO edge to/from the queried node: still a peer.
    rigRepo.addNode(rig.id, "dev.unedged", { role: "worker", runtime: "terminal", podId: "pod-dev" });

    const result = svc.resolve({ nodeId: nodeA.id });

    const peerIds = result!.peers.map((p) => p.logicalId).sort();
    expect(peerIds).toEqual(["dev.qa", "dev.unedged"]);
    // dev.unedged has no directional relationship to dev.impl - membership in
    // peers[] is roster-based, not edge-based.
    expect(result!.edges.outgoing.find((e) => e.to.logicalId === "dev.unedged")).toBeUndefined();
    expect(result!.edges.incoming.find((e) => e.from.logicalId === "dev.unedged")).toBeUndefined();
    // Shape compat: the peer entry keys are unchanged (no rename/removal).
    expect(Object.keys(result!.peers[0]!).sort()).toEqual(
      ["logicalId", "memberId", "podId", "podNamespace", "reachable", "runtime", "sessionName"],
    );
  });

  describe("a peer whose session is not running is not offered as reachable", () => {
    // A peer mid-start (session row registered, never marked running), a peer whose session exited, and a
    // peer whose binding still names an exited session all carry a session NAME. Handing that name to
    // `rig send` / `rig capture` as a ready example points the agent at a seat that cannot answer.
    function seedPeer(logicalId: string, rigId: string, rows: Array<{ name: string; status: string }>, bindTmux?: string) {
      const node = rigRepo.addNode(rigId, logicalId, { role: "worker", runtime: "claude-code", podId: "pod-dev" });
      for (const row of rows) {
        const sess = sessionRegistry.registerSession(node.id, row.name);
        sessionRegistry.updateStatus(sess.id, row.status);
      }
      if (bindTmux) sessionRegistry.updateBinding(node.id, { tmuxSession: bindTmux });
      return node;
    }

    function seedSelfWithRig() {
      const rig = rigRepo.createRig("my-rig");
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Development");
      const self = seedPeer("dev.impl", rig.id, [{ name: "dev-impl@my-rig", status: "running" }], "dev-impl@my-rig");
      return { rig, self };
    }

    it("a peer registered but never started (status unknown) is flagged and kept out of the command examples", () => {
      const { rig, self } = seedSelfWithRig();
      seedPeer("dev.starting", rig.id, [{ name: "dev-starting@my-rig", status: "unknown" }]);

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.commands.sendExamples).toEqual([]);
      expect(result.commands.captureExamples).toEqual([]);
      const peer = result.peers.find((p) => p.logicalId === "dev.starting")!;
      expect(peer.sessionName).toBe("dev-starting@my-rig");
      expect(peer.reachable).toBe(false);
    });

    it("a peer whose newest session exited is flagged and kept out of the command examples", () => {
      const { rig, self } = seedSelfWithRig();
      seedPeer("dev.gone", rig.id, [{ name: "dev-gone@my-rig", status: "exited" }]);

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.commands.sendExamples).toEqual([]);
      expect(result.commands.captureExamples).toEqual([]);
      expect(result.peers.find((p) => p.logicalId === "dev.gone")!.reachable).toBe(false);
    });

    it("a peer whose binding still names a session that has exited is flagged and kept out of the command examples", () => {
      const { rig, self } = seedSelfWithRig();
      seedPeer("dev.stale", rig.id, [{ name: "dev-stale@my-rig", status: "exited" }], "dev-stale@my-rig");

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.commands.sendExamples).toEqual([]);
      expect(result.peers.find((p) => p.logicalId === "dev.stale")!.reachable).toBe(false);
    });

    it("a running peer stays reachable and is the only one offered when others are not running", () => {
      const { rig, self } = seedSelfWithRig();
      seedPeer("dev.starting", rig.id, [{ name: "dev-starting@my-rig", status: "unknown" }]);
      seedPeer("dev.live", rig.id, [{ name: "dev-live@my-rig", status: "running" }], "dev-live@my-rig");

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.peers.find((p) => p.logicalId === "dev.live")!.reachable).toBe(true);
      expect(result.commands.sendExamples).toEqual(["rig send dev-live@my-rig 'message' --verify"]);
      expect(result.commands.captureExamples).toEqual(["rig capture dev-live@my-rig"]);
    });

    it("a peer with no session at all is not reachable", () => {
      const { rig, self } = seedSelfWithRig();
      rigRepo.addNode(rig.id, "dev.unlaunched", { role: "worker", runtime: "claude-code", podId: "pod-dev" });

      const result = svc.resolve({ nodeId: self.id })!;

      const peer = result.peers.find((p) => p.logicalId === "dev.unlaunched")!;
      expect(peer.sessionName).toBeNull();
      expect(peer.reachable).toBe(false);
    });

    it("a bound peer with no session row is not judged unreachable (no evidence it is down)", () => {
      const { rig, self } = seedSelfWithRig();
      const node = rigRepo.addNode(rig.id, "dev.adopted", { role: "worker", runtime: "claude-code", podId: "pod-dev" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-adopted@my-rig" });

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.peers.find((p) => p.logicalId === "dev.adopted")!.reachable).toBe(true);
      expect(result.commands.sendExamples).toEqual(["rig send dev-adopted@my-rig 'message' --verify"]);
    });

    it("a peer is judged by the session its binding names, not by a newer row of another name", () => {
      const { rig, self } = seedSelfWithRig();
      // Bound to a running session; a later row under a different name exited. The advertised name is live.
      seedPeer("dev.renamed", rig.id, [
        { name: "dev-renamed@my-rig", status: "running" },
        { name: "dev-renamed-old@my-rig", status: "exited" },
      ], "dev-renamed@my-rig");

      const result = svc.resolve({ nodeId: self.id })!;

      const peer = result.peers.find((p) => p.logicalId === "dev.renamed")!;
      expect(peer.sessionName).toBe("dev-renamed@my-rig");
      expect(peer.reachable).toBe(true);
    });

    it("a relaunched seat is judged by the session it now names, not by the exited one before it", () => {
      const { rig, self } = seedSelfWithRig();
      seedPeer("dev.back", rig.id, [
        { name: "dev-back@my-rig", status: "exited" },
        { name: "dev-back@my-rig", status: "running" },
      ]);

      const result = svc.resolve({ nodeId: self.id })!;

      expect(result.peers.find((p) => p.logicalId === "dev.back")!.reachable).toBe(true);
    });
  });

  it("result carries the additive peersNote stating the corrected meaning", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result!.peersNote).toContain("roster excluding self");
    expect(result!.peersNote).toContain("edges");
    expect(result!.peersNote).toContain("rig ps --nodes");
  });

  it("emits NO roster/podRoster field (advisor ruling: peers[] already IS the roster)", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id }) as unknown as Record<string, unknown>;

    expect(result["roster"]).toBeUndefined();
    expect(result["podRoster"]).toBeUndefined();
  });

  it("unknown nodeId returns null", () => {
    seedRig();
    const result = svc.resolve({ nodeId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("session name matching multiple rigs returns ambiguous error", () => {
    // Create two rigs with same session name
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    expect(() => svc.resolve({ sessionName: "dev-impl@shared" })).toThrow(/ambiguous/i);
  });

  describe("archived rigs do not compete with a live rig for a session name", () => {
    const NAME = "exec-cos@eztrack";

    function seatIn(rigName: string, archive: boolean) {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "exec.cos", { role: "orchestrator", runtime: "claude-code" });
      sessionRegistry.registerSession(node.id, NAME);
      if (archive) expect(rigRepo.archiveRig(rig.id)).toBe(true);
      return { rig, node };
    }

    it("resolves to the live rig when an older archived rig has the same session name", () => {
      const archived = seatIn("eztrack-old", true);
      const live = seatIn("eztrack", false);

      const result = svc.resolve({ sessionName: NAME });

      expect(result!.identity.nodeId).toBe(live.node.id);
      expect(result!.identity.rigId).toBe(live.rig.id);
      expect(result!.identity.nodeId).not.toBe(archived.node.id);
    });

    it("resolves to the live rig when the archived rig's session row is the newest", () => {
      const live = seatIn("eztrack", false);
      const archived = seatIn("eztrack-old", true);

      const result = svc.resolve({ sessionName: NAME });

      expect(result!.identity.nodeId).toBe(live.node.id);
      expect(result!.identity.nodeId).not.toBe(archived.node.id);
    });

    it("still reports ambiguity when two live rigs share the name alongside an archived one", () => {
      seatIn("eztrack-old", true);
      seatIn("eztrack-a", false);
      seatIn("eztrack-b", false);

      expect(() => svc.resolve({ sessionName: NAME })).toThrow(/ambiguous — found in 2 rigs/);
    });

    it("keeps resolving the archived seat when it is the only match", () => {
      const archived = seatIn("eztrack-old", true);

      const result = svc.resolve({ sessionName: NAME });

      expect(result!.identity.nodeId).toBe(archived.node.id);
    });

    it("keeps reporting ambiguity when the only matches are in two archived rigs", () => {
      seatIn("eztrack-old-1", true);
      seatIn("eztrack-old-2", true);

      expect(() => svc.resolve({ sessionName: NAME })).toThrow(/ambiguous — found in 2 rigs/);
    });

    // A session row whose node or rig row is gone belongs to no rig, so it neither answers for
    // the name nor counts toward ambiguity. Its id sorts newest so ordering cannot hide it.
    it.each(["node", "rig"] as const)("ignores a session whose %s row is gone beside an archived rig", (gone) => {
      const archived = seatIn("eztrack-old", true);
      const ghostRig = rigRepo.createRig("ghost");
      const ghostNode = rigRepo.addNode(ghostRig.id, "exec.ghost", { role: "orchestrator", runtime: "claude-code" });
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run("ZZZZZZZZZZZZZZZZZZZZZZZZZZ", ghostNode.id, NAME);
      if (gone === "node") db.prepare("DELETE FROM nodes WHERE id = ?").run(ghostNode.id);
      else db.prepare("DELETE FROM rigs WHERE id = ?").run(ghostRig.id);
      db.pragma("foreign_keys = ON");

      const result = svc.resolve({ sessionName: NAME });

      expect(result!.identity.nodeId).toBe(archived.node.id);
    });

    // Within one rig two nodes can carry the name (a replaced seat): the newest session row decides.
    // Ids are written explicitly: ulid() is not ordered within a millisecond.
    it.each([
      ["the later-created node holds the newest session row", true],
      ["the earlier-created node holds the newest session row", false],
    ] as const)("resolves the node of the newest session row when %s", (_label, laterIsNewest) => {
      const rig = rigRepo.createRig("eztrack");
      const first = rigRepo.addNode(rig.id, "exec.cos-a", { role: "orchestrator", runtime: "claude-code" });
      const second = rigRepo.addNode(rig.id, "exec.cos-b", { role: "orchestrator", runtime: "claude-code" });
      const [older, newer] = laterIsNewest ? [first, second] : [second, first];
      const insert = db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)");
      insert.run("00000000000000000000000001", older.id, NAME);
      insert.run("00000000000000000000000002", newer.id, NAME);

      const result = svc.resolve({ sessionName: NAME });

      expect(result!.identity.nodeId).toBe(newer.id);
    });
  });

  it("resolve surfaces external_cli attachment type and external session name", () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", { role: "orchestrator", runtime: "claude-code" });
    sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });

    const result = svc.resolve({ nodeId: node.id });

    expect(result).not.toBeNull();
    expect(result!.identity.attachmentType).toBe("external_cli");
    expect(result!.identity.sessionName).toBe("orch1-lead@rigged-buildout");
  });

  it("resolve returns null session and no transcript affordances for an unbound node", () => {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker",
      runtime: "claude-code",
    });

    const result = svc.resolve({ nodeId: node.id });

    expect(result).not.toBeNull();
    expect(result!.identity.sessionName).toBeNull();
    expect(result!.transcript.enabled).toBe(false);
    expect(result!.transcript.path).toBeNull();
    expect(result!.transcript.tailCommand).toBeNull();
    expect(result!.transcript.grepCommand).toBeNull();
    expect(result!.commands.sendExamples).toEqual([]);
    expect(result!.commands.captureExamples).toEqual([]);
  });

  // --- PL-012 Token / Context Usage Surface v0: runtimeContext block ---

  it("PL-012: claude-code seat surfaces runtimeContext with resumeToken from sessions table", () => {
    const { nodeA, sessA } = seedRig();
    db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run("claude-resume-abc", sessA.id);
    const result = svc.resolve({ nodeId: nodeA.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("claude-code");
    if (result!.runtimeContext?.runtime === "claude-code") {
      expect(result!.runtimeContext.resumeToken).toBe("claude-resume-abc");
    }
  });

  it("PL-012: codex seat surfaces runtimeContext with runtime=codex (threadId null at v0)", () => {
    const { nodeB } = seedRig();
    const result = svc.resolve({ nodeId: nodeB.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("codex");
    if (result!.runtimeContext?.runtime === "codex") {
      // v0: threadId resolution requires pid plumbing; surface null
      // honestly rather than fabricated.
      expect(result!.runtimeContext.threadId).toBeNull();
      expect(result!.runtimeContext.conversationId).toBeNull();
    }
  });

  it("PL-012: terminal runtime surfaces null runtimeContext (no conversation)", () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "tools.shell", { role: "worker", runtime: "terminal", label: "Shell" });
    const result = svc.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).toBeNull();
  });

  it("PL-012: unknown runtime surfaces null runtimeContext (honest degradation)", () => {
    const rig = rigRepo.createRig("future-rig");
    const node = rigRepo.addNode(rig.id, "future.experimental", { role: "worker", runtime: "future-runtime-xyz", label: "Future" });
    const result = svc.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).toBeNull();
  });

  // --- OPR.0.4.0.27 AC-4: compact skips the contextUsage/runtimeContext compute ---

  const sampleContextUsage = {
    availability: "known",
    totalInputTokens: 10,
    totalOutputTokens: 5,
    sampledAt: "2026-06-20T00:00:00Z",
  };

  it("AC-4: compact resolve does NOT call the contextUsageStore lookup and omits contextUsage/runtimeContext", () => {
    const getForNode = vi.fn(() => sampleContextUsage as never);
    const svcWithCtx = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore: { getForNode } as never });
    const { nodeA } = seedRig();

    const result = svcWithCtx.resolve({ nodeId: nodeA.id, compact: true });

    expect(result).not.toBeNull();
    // The look-above win: the per-call contextUsageStore lookup is never performed.
    expect(getForNode).not.toHaveBeenCalled();
    expect(result!.contextUsage).toBeUndefined();
    expect(result!.runtimeContext).toBeUndefined();
  });

  it("AC-4 back-compat: full (no compact) performs the contextUsage lookup and builds runtimeContext", () => {
    const getForNode = vi.fn(() => sampleContextUsage as never);
    const svcWithCtx = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore: { getForNode } as never });
    const { nodeA } = seedRig();

    const result = svcWithCtx.resolve({ nodeId: nodeA.id });

    expect(result).not.toBeNull();
    expect(getForNode).toHaveBeenCalledTimes(1);
    expect(result!.contextUsage).toEqual(sampleContextUsage);
    // nodeA is claude-code -> runtimeContext is built (not skipped).
    expect(result!.runtimeContext).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("claude-code");
  });
});
