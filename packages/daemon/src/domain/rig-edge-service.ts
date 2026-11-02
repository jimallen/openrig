import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";

/** Only these edge kinds constrain launch order (restore plan). */
export const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

/** The seat that must launch first and the one that waits, for an edge that constrains launch order; null for a record-only kind.
 *  delegates_to: the source launches before the target. spawned_by: the target (the parent) launches before the source (the child).
 *  The ONE statement of this rule: the restore plan orders by it and the edge verb's cycle check refuses by it. */
export function launchPrecedence(kind: string, sourceId: string, targetId: string): { first: string; then: string } | null {
  if (!LAUNCH_DEPENDENCY_KINDS.has(kind)) return null;
  return kind === "delegates_to" ? { first: sourceId, then: targetId } : { first: targetId, then: sourceId };
}

export interface RigEdgeView { id: string; from: string; to: string; kind: string }

export type AddRigEdgeResult =
  | { ok: true; created: boolean; edge: RigEdgeView }
  | { ok: false; code: "rig_not_found" | "node_not_found" | "invalid_kind" | "self_edge" | "would_cycle" | "validation_failed"; message: string };

/** Add one edge between two EXISTING seats of a rig. `rig remove` + `rig add` loses a seat's cross-pod edges and `rig add` accepts
 *  only pod-local ones, so this is the one way to put one back. Endpoints are node logical ids (or node ids). Re-adding an existing
 *  edge is an honest no-op (created:false, no event). The check, the insert and the audit event are one transaction. */
export class RigEdgeService {
  constructor(private readonly deps: { db: Database.Database; rigRepo: RigRepository; eventBus: EventBus }) {}

  list(rigId: string): { ok: true; edges: RigEdgeView[] } | { ok: false; code: "rig_not_found"; message: string } {
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig '${rigId}' not found.` };
    const logical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
    return { ok: true, edges: rig.edges.map((e) => ({ id: e.id, from: logical.get(e.sourceId) ?? e.sourceId, to: logical.get(e.targetId) ?? e.targetId, kind: e.kind })) };
  }

  add(input: { rigId: string; from: unknown; to: unknown; kind: unknown; reason?: string | null; operator?: string | null }): AddRigEdgeResult {
    const { from, to, kind } = input;
    if (typeof from !== "string" || typeof to !== "string" || typeof kind !== "string" || !from.trim() || !to.trim() || !kind.trim()) {
      return { ok: false, code: "validation_failed", message: "from, to and kind are required non-empty strings." };
    }
    if (!VALID_EDGE_KINDS.has(kind)) {
      return { ok: false, code: "invalid_kind", message: `kind must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${kind}").` };
    }
    const rig = this.deps.rigRepo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig '${input.rigId}' not found.` };
    const find = (ref: string) => rig.nodes.find((n) => n.logicalId === ref || n.id === ref);
    const source = find(from);
    const target = find(to);
    const missing = !source ? from : !target ? to : null;
    if (!source || !target) {
      return { ok: false, code: "node_not_found", message: `'${missing}' is not a seat of rig '${rig.rig.name}'. Seats: ${rig.nodes.map((n) => n.logicalId).join(", ")}.` };
    }
    if (source.id === target.id) {
      return { ok: false, code: "self_edge", message: `An edge from a seat to itself ('${source.logicalId}') is not allowed.` };
    }
    const view = (id: string): RigEdgeView => ({ id, from: source.logicalId, to: target.logicalId, kind });
    const existing = rig.edges.find((e) => e.sourceId === source.id && e.targetId === target.id && e.kind === kind);
    if (existing) return { ok: true, created: false, edge: view(existing.id) };

    // A launch-order cycle would drop its seats from the restore plan (the topological sort never frees them).
    const added = launchPrecedence(kind, source.id, target.id);
    if (added) {
      const next = new Map<string, string[]>();
      for (const e of rig.edges) {
        const p = launchPrecedence(e.kind, e.sourceId, e.targetId);
        if (p) next.set(p.first, [...(next.get(p.first) ?? []), p.then]);
      }
      const seen = new Set<string>();
      const stack = [added.then];
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (at === added.first) {
          return { ok: false, code: "would_cycle", message: `Adding ${source.logicalId} ${kind} ${target.logicalId} would make the launch order circular, and a restore would leave these seats out of its plan.` };
        }
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(next.get(at) ?? []));
      }
    }

    let persisted: PersistedEvent | null = null;
    let edgeId = "";
    this.deps.db.transaction(() => {
      edgeId = this.deps.rigRepo.addEdge(rig.rig.id, source.id, target.id, kind).id;
      persisted = this.deps.eventBus.persistWithinTransaction({
        type: "rig.edge_added", rigId: rig.rig.id, edgeId, from: source.logicalId, to: target.logicalId, kind,
        reason: input.reason ?? null, operator: input.operator ?? null,
      });
    })();
    if (persisted) this.deps.eventBus.notifySubscribers(persisted);
    return { ok: true, created: true, edge: view(edgeId) };
  }
}
