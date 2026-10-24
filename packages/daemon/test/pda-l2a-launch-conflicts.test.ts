// pda runtime L2a: the one-seat-per-pda-agent rule at launch and restore (review L2b action 3 and its forward note).
// findPdaLaunchConflicts is what the pda adapter asks before any keystroke (startup.ts wires it).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const research = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
let db: Database.Database;
let repo: RigRepository;
beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); });
afterEach(() => db.close());
const damage = (nodeId: string, text = "{damaged") => db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run(text, nodeId);

describe("findPdaLaunchConflicts: who stops THIS seat from launching or restoring onto a binding", () => {
  it("nobody else: no conflict, and the seat itself is never its own holder", () => {
    const rig = repo.createRig("rig-a");
    const seat = repo.addNode(rig.id, "dev.research", { runtime: "pda", pda: research });
    expect(repo.findPdaLaunchConflicts(research, seat.id)).toEqual([]);
  });

  it("a healthy seat in another live rig holding the binding refuses, by name; an archived one does not", () => {
    const a = repo.createRig("rig-a");
    const b = repo.createRig("rig-b");
    const seat = repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
    repo.addNode(b.id, "dev.copy", { runtime: "pda", pda: research });
    expect(repo.findPdaLaunchConflicts(research, seat.id)).toEqual([
      'pda agent "research" at http://127.0.0.1:8150 is already driven by seat "dev.copy" in rig "rig-b"; one pda agent is driven by one seat',
    ]);
    repo.archiveRig(b.id);
    expect(repo.findPdaLaunchConflicts(research, seat.id)).toEqual([]);
  });

  it("the agent is the pair: the same name at another port, or another name, is not a conflict", () => {
    const a = repo.createRig("rig-a");
    const b = repo.createRig("rig-b");
    const seat = repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
    repo.addNode(b.id, "dev.x", { runtime: "pda", pda: { agent: "research", baseUrl: "http://127.0.0.1:8151" } });
    repo.addNode(b.id, "dev.y", { runtime: "pda", pda: { agent: "other", baseUrl: research.baseUrl } });
    expect(repo.findPdaLaunchConflicts(research, seat.id)).toEqual([]);
  });

  it("forward note: a DAMAGED sibling in the seat's OWN rig does not block the healthy seat's restore", () => {
    const rig = repo.createRig("rig-a");
    const healthy = repo.addNode(rig.id, "dev.research", { runtime: "pda", pda: research });
    const sibling = repo.addNode(rig.id, "dev.broken", { runtime: "pda", pda: { agent: "other", baseUrl: research.baseUrl } });
    damage(sibling.id);
    expect(repo.findPdaLaunchConflicts(research, healthy.id)).toEqual([]);
    // ... while the holder check the creating doors use still counts it (growth fails closed, L2b).
    expect(repo.findPdaBindingHolders(research, { excludeNodeId: healthy.id })).toHaveLength(1);
  });

  it("fails closed against a damaged row in ANOTHER live rig, naming it and saying what to repair", () => {
    const a = repo.createRig("rig-a");
    const b = repo.createRig("rig-q");
    const seat = repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
    const broken = repo.addNode(b.id, "dev.q", { runtime: "pda", pda: { agent: "other", baseUrl: research.baseUrl } });
    damage(broken.id);
    const conflicts = repo.findPdaLaunchConflicts(research, seat.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('seat "dev.q" in rig "rig-q" has an unreadable pda binding');
    expect(conflicts[0]).toContain("repair its pda_binding or archive that rig");
  });

  it("the seat's own damaged row (a restore uses the token's binding) does not block it", () => {
    const rig = repo.createRig("rig-a");
    const seat = repo.addNode(rig.id, "dev.research", { runtime: "pda", pda: research });
    damage(seat.id);
    expect(repo.findPdaLaunchConflicts(research, seat.id)).toEqual([]);
  });
});

