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
  | { ok: true; rigId: string; rigName: string; from: string | null; to: string; changed: boolean; resolvedPath: string; effect: string }
  | { ok: false; code: SpecSourceRefusalCode; message: string; mismatches?: string[] };

const EFFECT = "Only the recorded spec source changed. No seat, session or saved startup context was touched; "
  + "the next `rig seat launch --fresh --startup-from spec` reads startup files from this source.";

type Loaded = { ok: true; resolvedPath: string; specName: string; logicalIds: Set<string> }
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
  const logicalIds = new Set<string>();
  for (const pod of spec.pods) for (const member of pod.members) logicalIds.add(`${pod.id}.${member.id}`);
  return { ok: true, resolvedPath, specName: spec.name, logicalIds };
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

  set(input: { rigId: string; path: string; operator: string }): SpecSourceSetResult {
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

    const mismatches: string[] = [];
    if (loaded.specName !== rig.rig.name) mismatches.push(`the spec is named '${loaded.specName}', this rig is '${rig.rig.name}'`);
    for (const node of rig.nodes) {
      if (!loaded.logicalIds.has(node.logicalId)) mismatches.push(`seat ${node.logicalId} is not declared in the spec's pods`);
    }
    if (mismatches.length > 0) {
      return { ok: false, code: "spec_mismatch", mismatches,
        message: `${specSource} does not describe rig '${rig.rig.name}': ${mismatches.join("; ")}.` };
    }

    const { rigRepo, eventBus } = this.deps;
    const from = rigRepo.getRigSpecSource(input.rigId);
    if (from === specSource) {
      return { ok: true, rigId: input.rigId, rigName: rig.rig.name, from, to: specSource, changed: false, resolvedPath: loaded.resolvedPath, effect: "Already recorded; nothing changed." };
    }
    const persisted = eventBus.db.transaction(() => {
      rigRepo.setRigSpecSource(input.rigId, specSource);
      return eventBus.persistWithinTransaction({ type: "rig.spec_source_changed", rigId: input.rigId, from, to: specSource, operator });
    })();
    eventBus.notifySubscribers(persisted);
    return { ok: true, rigId: input.rigId, rigName: rig.rig.name, from, to: specSource, changed: true, resolvedPath: loaded.resolvedPath, effect: EFFECT };
  }
}
