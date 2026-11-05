// OF-221: who is a rig's Chief of Staff. The rule (Jim, 2026-11-04): one declared `role: chief-of-staff`, else the one `delegates_to` root, else none with the reason.
// The graph shapes are the two live ones measured read-only on 2026-11-04: eztrack (one root, exec.cos, 7 edges) and kernel (two roots: advisor.lead, improve.steward).
// Production entrypoint: startup.ts builds the notifier (simulator-erased-notice.ts) that calls rigChiefOfStaff for the rig of an erased simulator.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { agentRefSegment, rigChiefOfStaff } from "../src/domain/rig-chief-of-staff.js";

describe("rigChiefOfStaff", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let sessions: SessionRegistry;
  beforeEach(() => { db = createFullTestDb(); rigs = new RigRepository(db); sessions = new SessionRegistry(db); });
  afterEach(() => db.close());

  /** A rig with these seats (each with a session named `<member>@<rig>`) and these delegates_to edges. */
  function rig(name: string, seats: Array<string | { id: string; role?: string; agentRef?: string; session?: false }>, edges: Array<[string, string]> = []) {
    const r = rigs.createRig(name);
    const nodes = new Map<string, string>();
    for (const seat of seats) {
      const { id, role, agentRef, session } = typeof seat === "string" ? { id: seat, role: undefined, agentRef: undefined, session: undefined } : seat;
      const node = rigs.addNode(r.id, id, { runtime: "claude-code", ...(role ? { role } : {}), ...(agentRef ? { agentRef } : {}) });
      nodes.set(id, node.id);
      if (session !== false) sessions.registerSession(node.id, `${id.replace(".", "-")}@${name}`);
    }
    for (const [from, to] of edges) rigs.addEdge(r.id, nodes.get(from)!, nodes.get(to)!, "delegates_to");
    return r;
  }

  it("eztrack's shape: the one delegates_to root is the Chief of Staff, by its current session", () => {
    const r = rig("eztrack", ["exec.cos", "build.arch", "build.impl", "verify.qa"], [["exec.cos", "build.arch"], ["exec.cos", "build.impl"], ["exec.cos", "verify.qa"]]);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", session: "exec-cos@eztrack", basis: "delegates_to_root" });
  });

  it("a root that delegates through a chain is still the one root (a seat that is delegated to is never a root)", () => {
    const r = rig("chain", ["a.top", "b.mid", "c.leaf"], [["a.top", "b.mid"], ["b.mid", "c.leaf"]]);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "a.top" });
  });

  it("kernel's shape: two roots is none, naming both (nothing is guessed)", () => {
    const r = rig("kernel", ["advisor.lead", "operator.agent", "improve.steward", "improve.engineer"], [["advisor.lead", "operator.agent"], ["improve.steward", "improve.engineer"]]);
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "several_roots: advisor.lead, improve.steward" });
  });

  it("a declared chief-of-staff role wins over the structure, even where the structure has several roots", () => {
    const r = rig("declared", ["advisor.lead", { id: "ops.chief", role: "chief-of-staff" }, "improve.steward", "improve.engineer"], [["advisor.lead", "ops.chief"], ["improve.steward", "improve.engineer"]]);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "ops.chief", basis: "declared_role" });
  });

  it("a declared role wins over a different single root", () => {
    const r = rig("both", ["exec.cos", { id: "build.arch", role: "chief-of-staff" }], [["exec.cos", "build.arch"]]);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "build.arch", basis: "declared_role" });
  });

  it("another role declared on a seat is not the chief-of-staff role", () => {
    const r = rig("other-role", [{ id: "exec.cos", role: "coordinator" }, "build.impl"], [["exec.cos", "build.impl"]]);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", basis: "delegates_to_root" });
  });

  it("two declared chiefs is none, naming both", () => {
    const r = rig("two", [{ id: "a.one", role: "chief-of-staff" }, { id: "b.two", role: "chief-of-staff" }]);
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "several_declared: a.one, b.two" });
  });

  it("a rig with no delegates_to edge and no declared role has none", () => {
    const r = rig("flat", ["a.one", "b.two"]);
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "no_delegates_to_root" });
  });

  it("only delegates_to makes a root: a can_observe edge does not", () => {
    const r = rigs.createRig("observe");
    const a = rigs.addNode(r.id, "a.one", { runtime: "claude-code" }), b = rigs.addNode(r.id, "b.two", { runtime: "claude-code" });
    sessions.registerSession(a.id, "a-one@observe");
    rigs.addEdge(r.id, a.id, b.id, "can_observe");
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "no_delegates_to_root" });
  });

  // OF-236 a (review of221 N2): the two shapes a wrong query would get past the rows above.
  it("a root keeps being a root when something else points at it with another kind of edge", () => {
    const r = rigs.createRig("watched");
    const cos = rigs.addNode(r.id, "exec.cos", { runtime: "claude-code" }), impl = rigs.addNode(r.id, "build.impl", { runtime: "claude-code" });
    sessions.registerSession(cos.id, "exec-cos@watched"); sessions.registerSession(impl.id, "build-impl@watched");
    rigs.addEdge(r.id, cos.id, impl.id, "delegates_to");
    rigs.addEdge(r.id, impl.id, cos.id, "can_observe"); // an incoming edge, but not a delegation: exec.cos is still delegated to by nobody
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", basis: "delegates_to_root" });
  });

  it("another live rig's declared chief-of-staff is not this rig's (the declared-role query is scoped to the rig)", () => {
    const mine = rig("mine", ["exec.cos", "build.impl"], [["exec.cos", "build.impl"]]);
    rig("twin", [{ id: "ops.chief", role: "chief-of-staff" }]);
    const answer = rigChiefOfStaff(db, mine.id);
    expect(answer).toMatchObject({ ok: true, logicalId: "exec.cos", session: "exec-cos@mine", basis: "delegates_to_root" });
    const bare = rig("bare", ["a.one", "b.two"]);
    expect(rigChiefOfStaff(db, bare.id), "a rig with no chief of its own has none, whatever a twin declares").toEqual({ ok: false, reason: "no_delegates_to_root" });
  });

  it("a Chief of Staff with no session row yet has none (nothing to address)", () => {
    const r = rig("nosession", [{ id: "exec.cos", session: false }, "build.impl"], [["exec.cos", "build.impl"]]);
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "no_session: exec.cos" });
  });

  it("answers by the newest session row of the node", () => {
    const r = rig("renamed", ["exec.cos", "build.impl"], [["exec.cos", "build.impl"]]);
    const cos = db.prepare("SELECT id FROM nodes WHERE logical_id = 'exec.cos'").get() as { id: string };
    db.prepare("UPDATE sessions SET created_at = '2026-11-01 10:00:00' WHERE node_id = ?").run(cos.id);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('zz-newest', ?, 'exec-cos2@renamed', 'running', '2026-11-04 10:00:00')").run(cos.id);
    expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, session: "exec-cos2@renamed" });
  });

  it("an archived rig and an unknown rig have none", () => {
    const r = rig("old", ["exec.cos", "build.impl"], [["exec.cos", "build.impl"]]);
    db.prepare("UPDATE rigs SET archived_at = '2026-11-01 10:00:00' WHERE id = ?").run(r.id);
    expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "rig_archived" });
    expect(rigChiefOfStaff(db, "no-such-rig")).toEqual({ ok: false, reason: "no_rig" });
  });

  it("a same-named archived twin's seats are another rig's: the live rig's answer is its own", () => {
    const old = rig("eztrack", ["exec.cos", "build.impl"], [["exec.cos", "build.impl"]]);
    db.prepare("UPDATE rigs SET archived_at = '2026-11-01 10:00:00' WHERE id = ?").run(old.id);
    const live = rig("eztrack", ["exec.cos", "build.impl"], [["exec.cos", "build.impl"]]);
    const answer = rigChiefOfStaff(db, live.id);
    expect(answer).toMatchObject({ ok: true, logicalId: "exec.cos" });
    if (answer.ok) expect(db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(answer.nodeId)).toEqual({ rig_id: live.id });
  });

  // OF-238: rigs built the way Jim builds them declare no role; exec.cos is known by the agent it is made from. Live shapes (read-only, 2026-11-05): eztrack's
  // exec.cos has agent_ref `local:../../agents/chief-of-staff`, its other seats `local:../../agents/<name>` or `path:/.../agents/<name>`.
  describe("a seat made from the chief-of-staff agent (agent_ref)", () => {
    const COS = "local:../../agents/chief-of-staff";

    it.each([
      ["local: relative", "local:../../agents/chief-of-staff"],
      ["path: absolute", "path:/Users/x/.agents-release/current/agents/chief-of-staff"],
      ["trailing slash", "path:/x/agents/chief-of-staff/"],
      ["several trailing slashes", "local:../../agents/chief-of-staff//"],
      ["no directory, only a scheme", "local:chief-of-staff"],
      ["surrounding whitespace", "  local:../../agents/chief-of-staff  "],
    ])("%s names it", (_name, ref) => {
      const r = rig("agent", [{ id: "exec.boss", agentRef: ref }, "build.impl", "verify.qa"]);
      expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.boss", basis: "agent_ref" });
    });

    it.each([
      ["a longer last segment", "local:../../agents/chief-of-staff-2"],
      ["a prefixed last segment", "local:../../agents/not-chief-of-staff"],
      ["a suffixed file", "path:/x/agents/chief-of-staff.md"],
      ["the name only as a directory above", "path:/x/agents/chief-of-staff/lead"],
      ["another case", "local:../../agents/Chief-Of-Staff"],
      ["the name inside a segment", "local:../../agents/the-chief-of-staff-agent"],
    ])("%s does not", (_name, ref) => {
      const r = rig("lookalike", [{ id: "exec.boss", agentRef: ref }, "build.impl"], [["exec.boss", "build.impl"]]);
      expect(rigChiefOfStaff(db, r.id), "the single delegates_to root answers instead, not the agent_ref").toMatchObject({ ok: true, logicalId: "exec.boss", basis: "delegates_to_root" });
      const flat = rig("lookalike-flat", [{ id: "exec.boss", agentRef: ref }, "build.impl"]);
      expect(rigChiefOfStaff(db, flat.id)).toEqual({ ok: false, reason: "no_delegates_to_root" });
    });

    it("eztrack's live shape: exec.cos by its agent_ref, not by the fallback", () => {
      const r = rig("eztrack", [{ id: "exec.cos", agentRef: COS }, { id: "build.arch", agentRef: "local:../../agents/architect" }, { id: "verify.ops", agentRef: "path:/x/agents/devops" }],
        [["exec.cos", "build.arch"], ["exec.cos", "verify.ops"]]);
      expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", session: "exec-cos@eztrack", basis: "agent_ref" });
    });

    it("beats the delegates_to root: the agent's seat is the Chief of Staff even where another seat is the one root", () => {
      const r = rig("beats-root", ["lead.top", { id: "exec.cos", agentRef: COS }], [["lead.top", "exec.cos"]]);
      expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", basis: "agent_ref" });
    });

    it("answers where the structure has several roots (the kernel's shape with one seat made from the agent)", () => {
      const r = rig("two-roots", ["advisor.lead", { id: "exec.cos", agentRef: COS }, "improve.steward", "improve.engineer"], [["advisor.lead", "exec.cos"], ["improve.steward", "improve.engineer"]]);
      expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "exec.cos", basis: "agent_ref" });
    });

    it("a declared role still comes first", () => {
      const r = rig("role-first", [{ id: "ops.chief", role: "chief-of-staff" }, { id: "exec.cos", agentRef: COS }]);
      expect(rigChiefOfStaff(db, r.id)).toMatchObject({ ok: true, logicalId: "ops.chief", basis: "declared_role" });
    });

    it("two seats made from the agent is none, naming both, even where one delegates_to root exists (fail closed)", () => {
      const r = rig("twice", [{ id: "exec.cos", agentRef: COS }, { id: "backup.cos", agentRef: "path:/x/agents/chief-of-staff" }, "build.impl"], [["exec.cos", "build.impl"]]);
      expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "several_by_agent_ref: backup.cos, exec.cos" });
    });

    it("a seat with no session row yet is none (nothing to address); the root rule is not tried instead", () => {
      const r = rig("nosession", [{ id: "exec.cos", agentRef: COS, session: false }, "build.impl"], [["build.impl", "exec.cos"]]);
      expect(rigChiefOfStaff(db, r.id)).toEqual({ ok: false, reason: "no_session: exec.cos" });
    });

    it("is scoped to the rig: an archived twin's chief-of-staff seat is not the live rig's", () => {
      const old = rig("eztrack", [{ id: "exec.cos", agentRef: COS }, "build.impl"]);
      db.prepare("UPDATE rigs SET archived_at = '2026-11-01 10:00:00' WHERE id = ?").run(old.id);
      const live = rig("eztrack", ["exec.cos", { id: "build.impl", agentRef: "local:../../agents/engineer" }]);
      expect(rigChiefOfStaff(db, live.id)).toEqual({ ok: false, reason: "no_delegates_to_root" });
      expect(rigChiefOfStaff(db, old.id)).toEqual({ ok: false, reason: "rig_archived" });
    });

    it("agentRefSegment is the last segment, exactly", () => {
      expect(agentRefSegment("local:../../agents/chief-of-staff")).toBe("chief-of-staff");
      expect(agentRefSegment("path:/a/b/chief-of-staff///")).toBe("chief-of-staff");
      expect(agentRefSegment("local:chief-of-staff")).toBe("chief-of-staff");
      expect(agentRefSegment("builtin:terminal")).toBe("terminal");
    });
  });
});
