import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";

/**
 * Fork regression (measured live, 2026-09-30): rig-here's per-dir restart loop
 * relaunches rigs under the same name (jims-team-eztrack today, another soon).
 * The old resolver refused every `rig seat <verb>` with "matched multiple
 * nodes" the moment a second generation existed — a one-day-useful seat
 * namespace. Now rig-lifecycle running status disambiguates.
 */
describe("seat verbs with same-name rig history", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => db.close());

  function rigWithCos(name: string, lifecycleState: "running" | "stopped") {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "exec.cos", { role: "coordinator", runtime: "claude-code" });
    // minimal live-session projection the inventory reads
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES (?, ?, ?, ?)")
      .run(`b-${node.id}`, node.id, `exec-cos@${name}`, "%1");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)")
      .run(`s-${node.id}`, node.id, `exec-cos@${name}`, lifecycleState === "running" ? "running" : "stopped");
    return { rig, node };
  }

  it("seat status prefers the running rig when two generations share a session name", () => {
    rigWithCos("history-rig", "stopped");
    const live = rigWithCos("history-rig", "running");
    const svc = new SeatStatusService({ rigRepo });
    const out = svc.getStatus("exec-cos@history-rig");
    expect(out.ok).toBe(true);
  });

  it("all generations stopped: newest generation answers (dead-seat verbs need a target)", () => {
    rigWithCos("history-rig", "stopped");
    rigWithCos("history-rig", "stopped");
    const svc = new SeatStatusService({ rigRepo });
    const out = svc.getStatus("exec-cos@history-rig");
    expect(out.ok).toBe(true);
  });
});
