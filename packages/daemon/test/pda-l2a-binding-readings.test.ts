// pda runtime L2a: L2b's leftovers. N-1: the exporter never silently drops a damaged binding. D-1: '' has one reading.
// (Every reader: the node, the holder check, the launch re-check, the retry gate and the exporter.)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { UnreadableNodeRowError } from "../src/domain/errors.js";
import { retainedPdaBindingAgrees } from "../src/domain/rigspec-instantiator.js";

const research = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
let db: Database.Database;
let repo: RigRepository;
beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); });
afterEach(() => db.close());
const damage = (nodeId: string, text = "{damaged") => db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run(text, nodeId);

describe("D-1: a pda_binding of '' is read one way by every reader: damaged", () => {
  it("the node, the holder check, the retry gate and the exporter all treat '' as damaged, never as absence", () => {
    const a = repo.createRig("rig-a");
    const pod = new PodRepository(db).createPod(a.id, "dev", "Dev", {});
    const node = repo.addNode(a.id, "dev.research", { runtime: "pda", podId: pod.id, agentRef: "local:agents/pda-seat", profile: "default", cwd: "/w", pda: research });
    damage(node.id, "");
    const read = repo.getRig(a.id)!.nodes[0]!;
    expect(read.pda).toBeUndefined();
    expect(read.pdaBindingUnreadable).toBe("pda_binding is empty");
    expect(repo.findPdaBindingHolders(research)).toEqual([expect.objectContaining({ nodeId: node.id, unreadable: "pda_binding is empty" })]);
    expect(retainedPdaBindingAgrees(research, read)).toBe(false);
    const b = repo.createRig("rig-b");
    const other = repo.addNode(b.id, "dev.other", { runtime: "pda", pda: { agent: "zeta", baseUrl: research.baseUrl } });
    expect(repo.findPdaLaunchConflicts({ agent: "zeta", baseUrl: research.baseUrl }, other.id)).toHaveLength(1);
    expect(() => new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(a.id)).toThrow(UnreadableNodeRowError);
  });

  it("control: NULL is the real absence everywhere (a non-pda seat)", () => {
    const a = repo.createRig("rig-a");
    const node = repo.addNode(a.id, "dev.plain", { runtime: "codex" });
    const read = repo.getRig(a.id)!.nodes.find((n) => n.id === node.id)!;
    expect(read.pda).toBeUndefined();
    expect(read.pdaBindingUnreadable).toBeUndefined();
    expect(repo.findPdaBindingHolders(research)).toEqual([]);
  });
});

describe("N-1: the exporter refuses a damaged binding, naming the seat, instead of dropping the block", () => {
  it("throws UnreadableNodeRowError naming the seat and the reason; a healthy binding still exports", () => {
    const rig = repo.createRig("r");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev", {});
    const node = repo.addNode(rig.id, "dev.research", { runtime: "pda", podId: pod.id, agentRef: "local:agents/pda-seat", profile: "default", cwd: "/w", pda: research });
    const exporter = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) });
    expect(() => exporter.exportRig(rig.id)).not.toThrow();
    damage(node.id);
    expect(() => exporter.exportRig(rig.id)).toThrow(/Cannot export node 'dev\.research': its saved row is damaged \(pda_binding is not JSON\)/);
  });
});
