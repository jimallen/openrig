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

/** Read a spec source: links followed, parsed and validated. `show` reads it the way a fresh launch does (re-anchored to the
 *  running install when it is a shipped spec); `set` reads exactly the file it judges and records (`reanchor: false`). */
function loadSpec(specSource: string, reanchor = true): Loaded {
  let resolvedPath: string;
  let yaml: string;
  try {
    resolvedPath = fs.realpathSync(reanchor ? reanchorShippedSpecPath(specSource) : specSource);
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

/** `child` relative to `root` when it lies strictly inside it (no `..` step), else null. Purely lexical. */
function insideRoot(child: string, root: string): string | null {
  const rel = nodePath.relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + nodePath.sep) && !nodePath.isAbsolute(rel) ? rel : null;
}

/** The ways a root can be spelled: as given, and by its real location. */
function rootSpellings(root: string, io: PathJudgeIo): string[] {
  const out = new Set([nodePath.resolve(root)]);
  try { out.add(io.realpath(root)); } catch { /* absent: only the given spelling */ }
  return [...out];
}

/** The <name> when `rel` is exactly <name>/rig.yaml (one path component, nothing deeper), else null. */
function exactShapeName(rel: string | null): string | null {
  if (rel === null) return null;
  const parts = rel.split(nodePath.sep);
  return parts.length === 2 && parts[1] === "rig.yaml" && parts[0] !== "" ? parts[0]! : null;
}

/** The <name> when the REAL location of `file` is exactly <root>/<name>/rig.yaml, else null. */
function exactDepthFolder(file: string, root: string, io: PathJudgeIo): string | null {
  let real: string;
  let rootReal: string;
  try { real = io.realpath(file); rootReal = io.realpath(root); } catch { return null; }
  return exactShapeName(insideRoot(real, rootReal));
}

/** The <name> when the path AS TYPED (normalised, no link followed) is exactly <root>/<name>/rig.yaml, else null. */
function typedExactFolder(typed: string, root: string, io: PathJudgeIo): string | null {
  for (const spelling of rootSpellings(root, io)) {
    const name = exactShapeName(insideRoot(typed, spelling));
    if (name !== null) return name;
  }
  return null;
}

/** Whether the path AS TYPED lies lexically under one of the roots. */
function typedUnderRoots(typed: string, roots: string[], io: PathJudgeIo): boolean {
  return roots.some((root) => rootSpellings(root, io).some((spelling) => insideRoot(typed, spelling) !== null));
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
    // INVARIANT: the value judged below is the value recorded, never a re-anchored stand-in. Everything here (the
    // ownership and trust judgement, the typed-path check, the read) runs on `specSource`, or on its realpath, which is
    // what the judge resolves it to. A dev-checkout-shaped path that does not exist would otherwise be re-anchored to the
    // installed specs for the judgement and then recorded as typed, and a seat could write that file afterwards.
    const io = this.deps.trust.io ?? DEFAULT_PATH_JUDGE_IO;
    try { io.realpath(specSource); } catch {
      return { ok: false, code: "spec_unreadable", message: `${specSource} does not exist as typed (a missing path is not re-anchored when recording; name the real file).` };
    }
    const readPath = specSource;
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
    const loaded = loadSpec(specSource, false);
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
    // (Read first, so a path that does not resolve is reported as unreadable, not as untrusted.)
    // The spelling is what gets recorded and read again at every launch, restore and MCP read, with no re-check, so the
    // path AS TYPED must qualify too, not only where it leads today: a link kept in a folder a seat can write (the
    // Codex state folders under the shared-docs rigs folder) could be retargeted to the seat's own file later. So the
    // typed path itself must lie lexically under a general trusted root (where the links, like ~/.agents-release/current,
    // sit in a protected place) or be exactly <shared-docs rigs>/<name>/rig.yaml. Its own folders get the ownership and
    // mode checks above, which judge the written chain as well as the real one.
    const typedGeneral = typedUnderRoots(readPath, this.deps.trust.roots(), io);
    const typedFolder = !typedGeneral && exactRoot ? typedExactFolder(readPath, exactRoot, io) : null;
    if (!typedGeneral && typedFolder === null) {
      return { ok: false, code: "spec_untrusted", message: `${readPath}, as typed, is not itself under a trusted spec root or exactly <shared-docs rigs>/<rig name>/rig.yaml. A link kept anywhere else (a seat's writable folder, say) could be pointed at another file later, so type the path through the trusted folder.` };
    }
    // One rig's folder cannot serve another rig: a spec admitted only by the shared-docs rigs folder must sit in a
    // folder named for this rig or for the spec's own name (a project rig is named after its project, its spec is not).
    const wrongFolder = [exactFolder, typedFolder].find((f) => f !== null && f !== rig.rig.name && f !== loaded.specName);
    if (wrongFolder !== undefined && wrongFolder !== null) {
      return { ok: false, code: "spec_untrusted", message: `${readPath} lies in the shared-docs folder '${wrongFolder}', which is neither this rig's name ('${rig.rig.name}') nor its spec's name ('${loaded.specName}'). Record a reviewed spec from a trusted spec root instead.` };
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
