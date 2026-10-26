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
import { DEFAULT_PATH_JUDGE_IO, specFileTrustProblem, type PathJudgeIo } from "./codex-mcp-servers.js";

export type SpecSourceRefusalCode =
  | "rig_not_found" | "missing_operator" | "missing_path" | "path_not_absolute"
  | "spec_untrusted" | "spec_unreadable" | "spec_invalid" | "spec_mismatch";

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

/** The <name> when the REAL location of `file` is exactly <root>/<name>/rig.yaml (one path component, nothing deeper), else null. */
function exactDepthFolder(file: string, root: string, io: PathJudgeIo): string | null {
  let real: string;
  let rootReal: string;
  try { real = io.realpath(file); rootReal = io.realpath(root); } catch { return null; }
  const parts = nodePath.relative(rootReal, real).split(nodePath.sep);
  return parts.length === 2 && parts[1] === "rig.yaml" && parts[0] !== "" && parts[0] !== ".." ? parts[0]! : null;
}

export class RigSpecSourceService {
  constructor(private readonly deps: {
    rigRepo: RigRepository;
    eventBus: EventBus;
    /** Where a recorded spec may live. A spec outside these roots is refused whoever asks (Jim, 2026-10-26). */
    trust: {
      roots: () => string[];
      /** A root that takes EXACTLY <root>/<name>/rig.yaml by real location and nothing deeper: the shared-docs rigs folder,
       *  whose <rig>/state/<pod> subfolders are writable roots of sandboxed Codex seats (review R6). */
      exactDepthRoot?: () => string;
      io?: PathJudgeIo;
    };
  }) {
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

  set(input: { rigId: string; path: string; operator: string; operatorIdentity: OperatorIdentity; authorizedBy: "operator_bearer" | "trusted_spec_root" }): SpecSourceSetResult {
    const operator = input.operator.trim();
    if (!operator) return { ok: false, code: "missing_operator", message: "An operator is required so the change can be audited." };
    const typed = input.path.trim();
    if (!typed) return { ok: false, code: "missing_path", message: "A spec path is required." };
    if (!nodePath.isAbsolute(typed)) return { ok: false, code: "path_not_absolute", message: `${typed} is not an absolute path; a relative one would depend on the daemon's working directory.` };
    const rig = this.deps.rigRepo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${input.rigId} not found.` };

    // Lexical clean-up only: a link spelling stays a link (OF-32/OF-99).
    const specSource = nodePath.resolve(typed);

    // What is recorded decides which startup files, culture and local: personas a later plain --fresh launch or restore
    // delivers into a live seat, so the file must be one a seat could not have written: under a trusted spec root by its
    // REAL location, a regular file with one link, not in a temp folder, git tree or seat folder, and owned and
    // protected along its whole chain (the check `rig seat set-mcp --spec` applies). The exact-depth root admits only
    // <root>/<name>/rig.yaml, judged by real location, because deeper folders (<rig>/state/<pod>) are seat-writable.
    // The file judged is the one the read below uses (re-anchored), so the check and the read agree. A path that does
    // not resolve falls through to the read, which reports it.
    const readPath = reanchorShippedSpecPath(specSource);
    const io = this.deps.trust.io ?? DEFAULT_PATH_JUDGE_IO;
    const seatFolders = [...new Set(rig.nodes.map((n) => n.cwd).filter((c): c is string => !!c))];
    const judge = (roots: string[]): string | null => {
      for (const seatCwd of seatFolders.length > 0 ? seatFolders : [null]) {
        const problem = specFileTrustProblem(readPath, roots, seatCwd, io);
        if (problem) return problem;
      }
      return null;
    };
    let problem = judge(this.deps.trust.roots());
    let exactFolder: string | null = null;
    const exactRoot = this.deps.trust.exactDepthRoot?.();
    if (problem && exactRoot) {
      exactFolder = exactDepthFolder(readPath, exactRoot, io);
      if (exactFolder !== null) problem = judge([exactRoot]);
    }
    if (problem) {
      return { ok: false, code: "spec_untrusted", message: `${problem}. Record a reviewed spec from a trusted spec root instead (in the shared-docs rigs folder only <rig name>/rig.yaml qualifies).` };
    }
    const loaded = loadSpec(specSource);
        if (loaded.ok) resolvedPath = loaded.resolvedPath; else unavailable = loaded.message;
      }
    }
    return { ok: true, rigId, rigName: rig.rig.name, specSource, resolvedPath, unavailable };
  }

  set(input: { rigId: string; path: string; operator: string; operatorIdentity: OperatorIdentity; authorizedBy: "operator_bearer" | "trusted_spec_root" }): SpecSourceSetResult {
    const operator = input.operator.trim();
    if (!operator) return { ok: false, code: "missing_operator", message: "An operator is required so the change can be audited." };
    const typed = input.path.trim();
    if (!typed) return { ok: false, code: "missing_path", message: "A spec path is required." };
    if (!nodePath.isAbsolute(typed)) return { ok: false, code: "path_not_absolute", message: `${typed} is not an absolute path; a relative one would depend on the daemon's working directory.` };
    const rig = this.deps.rigRepo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${input.rigId} not found.` };

    // Lexical clean-up only: a link spelling stays a link (OF-32/OF-99).
    const specSource = nodePath.resolve(typed);

    // What is recorded decides which startup files, culture and local: personas a later plain --fresh launch or restore
    // delivers into a live seat, so the file must be one a seat could not have written: under a trusted spec root by its
    // REAL location, a regular file with one link, not in a temp folder, git tree or seat folder, and owned and
    // protected along its whole chain (the check `rig seat set-mcp --spec` applies). Unreadable paths fall through
    // to the read below, which reports them.
    const seatFolders = [...new Set(rig.nodes.map((n) => n.cwd).filter((c): c is string => !!c))];
    for (const seatCwd of seatFolders.length > 0 ? seatFolders : [null]) {
      const problem = specFileTrustProblem(specSource, this.deps.trust.roots(), seatCwd, this.deps.trust.io);
      if (problem) return { ok: false, code: "spec_untrusted", message: `${problem}. Record a reviewed spec from a trusted spec root instead.` };
    }
    const loaded = loadSpec(specSource);
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
    // One rig's folder cannot serve another rig: a spec admitted only by the shared-docs rigs folder must sit in a
    // folder named for this rig or for the spec's own name (a project rig is named after its project, its spec is not).
    if (exactFolder !== null && exactFolder !== rig.rig.name && exactFolder !== loaded.specName) {
      return { ok: false, code: "spec_untrusted", message: `${readPath} lies in the shared-docs folder '${exactFolder}', which is neither this rig's name ('${rig.rig.name}') nor its spec's name ('${loaded.specName}'). Record a reviewed spec from a trusted spec root instead.` };
    }

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
      return eventBus.persistWithinTransaction({ type: "rig.spec_source_changed", rigId: input.rigId, from, to: specSource, operator, operatorIdentity: input.operatorIdentity, authorizedBy: input.authorizedBy });
    })();
    eventBus.notifySubscribers(persisted);
    return { ok: true, rigId: input.rigId, rigName: rig.rig.name, from, to: specSource, changed: true, resolvedPath: loaded.resolvedPath, effect: EFFECT, warnings };
  }
}
