// OF-102: an operator records (or replaces) the spec source of a rig that already exists, so
// `rig seat launch --fresh --startup-from spec` can re-read that rig's startup policy. Only
// rigs.spec_source_path changes; no node, session or startup context is touched here.
import fs from "node:fs";
import nodePath from "node:path";
import type { EventBus } from "./event-bus.js";
import type { RigRepository } from "./rig-repository.js";
import { reanchorShippedSpecPath } from "./builtin-startup-files.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { declaresRig } from "./seat-mcp-servers.js";

export type SpecSourceRefusalCode =
  | "rig_not_found" | "missing_operator" | "missing_path" | "path_not_absolute"
  | "spec_unreadable" | "spec_invalid" | "spec_mismatch";

export type SpecSourceShow = {
  ok: true; rigId: string; rigName: string;
  /** As recorded, spelling kept (a link stays a link); null when none was recorded. */
  specSource: string | null;
  /** Where the recorded spelling leads now, or null when nothing is recorded or it cannot be read. */
  resolvedPath: string | null;
  /** Why a recorded source cannot be read now; null when it can or none is recorded. */
  unavailable: string | null;
};

export type SpecSourceSetResult =
  | { ok: true; rigId: string; rigName: string; from: string | null; to: string; changed: boolean; resolvedPath: string; effect: string;
      /** Seats whose runtime, agent_ref or profile differ from this spec: a fresh launch of each would be refused. */
      warnings: string[] }
  | { ok: false; code: SpecSourceRefusalCode; message: string; mismatches?: string[] };

const EFFECT = "Only the recorded spec source changed. No seat, session or saved startup context was touched. "
  + "From now on, because `spec` is the default startup source, a plain `rig seat launch --fresh` and every seat listed with --fresh "
  + "in a restore or `rig up --existing` re-read their startup files from this source instead of replaying the saved ones. "
  + "Pass --startup-from stored to replay the saved files.";

export type OperatorIdentity = "transport:v1" | "claimed:v1";

type Declared = { runtime: string | null; agentRef: string | null; profile: string | null };
type Loaded = { ok: true; resolvedPath: string; specName: string; raw: Record<string, unknown>; members: Map<string, Declared> }
  | { ok: false; code: "spec_unreadable" | "spec_invalid"; message: string };

/** Read a spec source the way a fresh launch reads it: re-anchored, links followed, parsed and validated. */
function loadSpec(specSource: string): Loaded {
  let resolvedPath: string;
  let yaml: string;
  try {
    resolvedPath = fs.realpathSync(reanchorShippedSpecPath(specSource));
    yaml = fs.readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, code: "spec_unreadable", message: code === "ENOENT"
      ? `${specSource} does not exist (or a link on its path leads nowhere).` : `${specSource} could not be read (${code ?? (err as Error).message}).` };
  }
  let raw: unknown;
  try { raw = RigSpecCodec.parse(yaml); } catch (err) {
    return { ok: false, code: "spec_invalid", message: `${specSource} does not parse as a rig spec (${(err as Error).message}).` };
  }
  const validation = RigSpecSchema.validate(raw);
  if (!validation.valid) {
    return { ok: false, code: "spec_invalid", message: `${specSource} is not a valid rig spec (${validation.errors.join("; ")}).` };
  }
  const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  const members = new Map<string, Declared>();
  for (const pod of spec.pods) {
    for (const member of pod.members) {
      members.set(`${pod.id}.${member.id}`, { runtime: member.runtime ?? null, agentRef: member.agentRef ?? null, profile: member.profile ?? null });
    }
  }
  return { ok: true, resolvedPath, specName: spec.name, raw: raw as Record<string, unknown>, members };
}

export class RigSpecSourceService {
  constructor(private readonly deps: { rigRepo: RigRepository; eventBus: EventBus }) {
    if (deps.rigRepo.db !== deps.eventBus.db) throw new Error("RigSpecSourceService: eventBus must share the rig repository's db handle");
  }

  show(rigId: string): SpecSourceShow | { ok: false; code: "rig_not_found"; message: string } {
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${rigId} not found.` };
    const specSource = this.deps.rigRepo.getRigSpecSource(rigId);
    let resolvedPath: string | null = null;
    let unavailable: string | null = null;
    if (specSource) {
      if (!nodePath.isAbsolute(specSource)) unavailable = `${specSource} is not an absolute path, so it cannot be located.`;
      else {
        const loaded = loadSpec(specSource);
        if (loaded.ok) resolvedPath = loaded.resolvedPath; else unavailable = loaded.message;
      }
    }
    return { ok: true, rigId, rigName: rig.rig.name, specSource, resolvedPath, unavailable };
  }

  set(input: { rigId: string; path: string; operator: string; operatorIdentity: OperatorIdentity }): SpecSourceSetResult {
    const operator = input.operator.trim();
    if (!operator) return { ok: false, code: "missing_operator", message: "An operator is required so the change can be audited." };
    const typed = input.path.trim();
    if (!typed) return { ok: false, code: "missing_path", message: "A spec path is required." };
    if (!nodePath.isAbsolute(typed)) return { ok: false, code: "path_not_absolute", message: `${typed} is not an absolute path; a relative one would depend on the daemon's working directory.` };
    const rig = this.deps.rigRepo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${input.rigId} not found.` };

    // Lexical clean-up only: a link spelling stays a link (OF-32/OF-99).
    const specSource = nodePath.resolve(typed);
    const loaded = loadSpec(specSource);
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };

    // The spec's own name, or, for a project rig (named after its project folder at launch), the name the launch path
    // gives it: the same test `rig seat set-mcp --spec` uses.
    const mismatches: string[] = [];
    const namesRig = loaded.specName === rig.rig.name || rig.nodes.some((n) => declaresRig(loaded.raw, rig.rig.name, n.cwd));
    if (!namesRig) mismatches.push(`the spec is named '${loaded.specName}', this rig is '${rig.rig.name}'`);
    for (const node of rig.nodes) {
      if (!loaded.members.has(node.logicalId)) mismatches.push(`seat ${node.logicalId} is not declared in the spec's pods`);
    }
    if (mismatches.length > 0) {
      return { ok: false, code: "spec_mismatch", mismatches,
        message: `${specSource} does not describe rig '${rig.rig.name}': ${mismatches.join("; ")}.` };
    }
    // Not a refusal: a fresh launch refuses a seat whose identity moved, safely, before anything is stopped.
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    const warnings: string[] = [];
    for (const node of rig.nodes) {
      const declared = loaded.members.get(node.logicalId)!;
      const drift = [
        !same(declared.runtime, node.runtime) ? `runtime ${declared.runtime} (seat: ${node.runtime ?? "none"})` : null,
        !same(declared.agentRef, node.agentRef) ? `agent_ref ${declared.agentRef} (seat: ${node.agentRef ?? "none"})` : null,
        !same(declared.profile, node.profile) ? `profile ${declared.profile} (seat: ${node.profile ?? "none"})` : null,
      ].filter((d): d is string => d !== null);
      if (drift.length > 0) warnings.push(`${node.logicalId}: the spec declares ${drift.join(", ")}; a fresh launch of this seat from the spec would be refused.`);
    }

    const { rigRepo, eventBus } = this.deps;
    const from = rigRepo.getRigSpecSource(input.rigId);
    if (from === specSource) {
      return { ok: true, rigId: input.rigId, rigName: rig.rig.name, from, to: specSource, changed: false, resolvedPath: loaded.resolvedPath, effect: "Already recorded; nothing changed.", warnings };
    }
    const persisted = eventBus.db.transaction(() => {
      rigRepo.setRigSpecSource(input.rigId, specSource);
      return eventBus.persistWithinTransaction({ type: "rig.spec_source_changed", rigId: input.rigId, from, to: specSource, operator, operatorIdentity: input.operatorIdentity, authorizedBy: "operator_bearer" });
    })();
    eventBus.notifySubscribers(persisted);
    return { ok: true, rigId: input.rigId, rigName: rig.rig.name, from, to: specSource, changed: true, resolvedPath: loaded.resolvedPath, effect: EFFECT, warnings };
  }
}
