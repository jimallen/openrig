// OF-221: who is a rig's Chief of Staff? No such resolver existed; `defaultResolveOrchestrator` answers a different question (who orchestrates THIS seat).
// Pure: a database in, an answer out. No adapter, infrastructure or queue import.
//
// The rule (Jim, 2026-11-04, from of221-design.md section 2):
//   1. exactly one node of the rig declares `role = 'chief-of-staff'` (the seat-side role a spec may carry; no live spec declares it yet), else
//   2. exactly one node whose `agent_ref` names the chief-of-staff agent (OF-238: rigs built the way Jim builds them declare no role; exec.cos carries
//      `local:../../agents/chief-of-staff`), matched on the FINAL path segment exactly, else
//   3. exactly one node is the root of the rig's `delegates_to` edges (it delegates, and nothing delegates to it), else
//   4. none, with the reason. Nothing is guessed: several roots (the kernel has two) or none is "no Chief of Staff", not a pick.
// The answer is the node's current canonical session: its newest session row.

/** What the resolver reads the topology through: the part of a SQLite handle it uses (the daemon's better-sqlite3 database satisfies it). Declared here so the
 *  domain names no infrastructure module (the hexagonal census). */
export interface TopologyDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export const CHIEF_OF_STAFF_ROLE = "chief-of-staff";
/** The agent a Chief of Staff seat is made from (`agents/chief-of-staff` in the persona tree). */
export const CHIEF_OF_STAFF_AGENT = "chief-of-staff";

/** The last path segment of an agent ref (`local:../../agents/chief-of-staff`, `path:/x/agents/chief-of-staff/`), trailing slashes ignored; a ref with no
 *  slash (`local:chief-of-staff`) is taken after its scheme. Exact: `chief-of-staff-2` and `not-chief-of-staff` are other agents. */
export function agentRefSegment(ref: string): string {
  const trimmed = ref.trim().replace(/\/+$/, "");
  const afterSlash = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return afterSlash.slice(afterSlash.lastIndexOf(":") + 1);
}

export type RigChiefOfStaff =
  | { ok: true; nodeId: string; logicalId: string; session: string; basis: "declared_role" | "agent_ref" | "delegates_to_root" }
  | { ok: false; reason: string };

interface NodeRef { id: string; logical_id: string }

export function rigChiefOfStaff(db: TopologyDb, rigId: string): RigChiefOfStaff {
  const rig = db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null } | undefined;
  if (!rig) return { ok: false, reason: "no_rig" };
  if (rig.archived_at !== null) return { ok: false, reason: "rig_archived" };

  const declared = db.prepare("SELECT id, logical_id FROM nodes WHERE rig_id = ? AND role = ? ORDER BY logical_id").all(rigId, CHIEF_OF_STAFF_ROLE) as NodeRef[];
  if (declared.length > 1) return { ok: false, reason: `several_declared: ${declared.map((n) => n.logical_id).join(", ")}` };

  const byAgent = (db.prepare("SELECT id, logical_id, agent_ref FROM nodes WHERE rig_id = ? AND agent_ref IS NOT NULL ORDER BY logical_id").all(rigId) as Array<NodeRef & { agent_ref: string }>)
    .filter((n) => agentRefSegment(n.agent_ref) === CHIEF_OF_STAFF_AGENT);

  let node: NodeRef;
  let basis: "declared_role" | "agent_ref" | "delegates_to_root";
  if (declared.length === 1) {
    node = declared[0]!;
    basis = "declared_role";
  } else if (byAgent.length > 1) {
    return { ok: false, reason: `several_by_agent_ref: ${byAgent.map((n) => n.logical_id).join(", ")}` };
  } else if (byAgent.length === 1) {
    node = byAgent[0]!;
    basis = "agent_ref";
  } else {
    const roots = db.prepare(`
      SELECT n.id, n.logical_id FROM nodes n
      WHERE n.rig_id = @rig
        AND EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id AND e.kind = 'delegates_to')
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.kind = 'delegates_to')
      ORDER BY n.logical_id
    `).all({ rig: rigId }) as NodeRef[];
    if (roots.length === 0) return { ok: false, reason: "no_delegates_to_root" };
    if (roots.length > 1) return { ok: false, reason: `several_roots: ${roots.map((n) => n.logical_id).join(", ")}` };
    node = roots[0]!;
    basis = "delegates_to_root";
  }

  const session = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(node.id) as { session_name: string } | undefined;
  if (!session) return { ok: false, reason: `no_session: ${node.logical_id}` };
  return { ok: true, nodeId: node.id, logicalId: node.logical_id, session: session.session_name, basis };
}
