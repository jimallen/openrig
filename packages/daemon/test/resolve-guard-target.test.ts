import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

/**
 * Regression harness for the 0.6.x launch-time failure observed in production:
 * relaunching a rig name that has EVER existed leaves stale node/binding rows
 * behind; resolveGuardTarget returned null on the ambiguity and every seat's
 * harness launch failed with "Cannot establish managed input target …".
 *
 * Proven pathologies (all on one machine, same day):
 *  A. a STOPPED rig kept a bound row for exec-cos@jims-team; the afternoon
 *     relaunch bound the same name again → two live-bound rows, resolver null.
 *  B. stale UNbound nodes (clause-5 derived-name fallback) from earlier same-name
 *     rigs outnumbered the fresh binding 6:1 → resolver null.
 *  C. archived rigs answered lookups at all.
 */
describe("resolveGuardTarget — stale-generation disambiguation", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
  });
  afterEach(() => db.close());

  function seedRigWithBoundCos(name: string, opts: { sessionStatus: string; pane: string; archive?: boolean }) {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "exec.cos", { role: "coordinator", runtime: "claude-code" });
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES (?, ?, ?, ?)")
      .run(`b-${node.id}`, node.id, "exec-cos@jims-team", opts.pane);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)")
      .run(`s-${node.id}`, node.id, "exec-cos@jims-team", opts.sessionStatus);
    if (opts.archive) db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(rig.id);
    return { rig, node };
  }

  function seedUnboundCos(name: string) {
    const rig = rigRepo.createRig(name);
    rigRepo.addNode(rig.id, "exec.cos", { role: "coordinator", runtime: "claude-code" });
    return rig;
  }

  it("prefers the binding whose session is RUNNING over a stopped rig's stale bound row (pathology A)", () => {
    const old_ = seedRigWithBoundCos("jims-team", { sessionStatus: "stopped", pane: "%1" });
    const cur = seedRigWithBoundCos("jims-team", { sessionStatus: "running", pane: "%9" });
    void old_;

    const target = resolveGuardTarget(db, "exec-cos@jims-team");
    expect(target).not.toBeNull();
    expect(target!.nodeId).toBe(cur.node.id);
    expect(target!.pane).toBe("%9");
  });

  it("stale unbound same-name nodes cannot starve the fresh binding (pathology B)", () => {
    seedUnboundCos("jims-team");
    seedUnboundCos("jims-team");
    const cur = seedRigWithBoundCos("jims-team", { sessionStatus: "running", pane: "%9" });

    const target = resolveGuardTarget(db, "exec-cos@jims-team");
    expect(target).not.toBeNull();
    expect(target!.nodeId).toBe(cur.node.id);
  });

  it("archived rigs never resolve (pathology C)", () => {
    const old = seedRigWithBoundCos("jims-team", { sessionStatus: "running", pane: "%1", archive: true });
    expect(resolveGuardTarget(db, "exec-cos@jims-team")).toBeNull();
    void old;
  });

  it("unknown names still resolve to null", () => {
    seedUnboundCos("jims-team");
    expect(resolveGuardTarget(db, "nobody@elsewhere")).toBeNull();
  });
});
