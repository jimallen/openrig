import { realpathSync } from "node:fs";
import nodePath from "node:path";
import { checkGuardedFile, type GuardedFileKind } from "./culture-file-guard.js";

/**
 * TRUST BOUNDARY (read this before changing anything here). Same decision as culture-file-guard.ts.
 *
 * The caller of the daemon API (`rig up`, `rig add/grow --agent-ref`, MCP `rig_add`, a rig spec's
 * `agent_ref`) is TRUSTED: whoever can reach the daemon can already start a seat in any folder, so a persona
 * folder allowlist cannot be the security boundary and there is none. `path:/abs/dir` may name any persona
 * folder on the host. These checks guard against ACCIDENTS and SWAPS, not a hostile caller: a `local:` ref that
 * wanders out of the tree it was written in (a stray `..`, a symlink that points elsewhere), an agent.yaml that
 * is a FIFO/device/directory, a runaway file, or a hard link that aliases some other file.
 *
 * `local:` refs. A `local:` ref is resolved against the folder that carries it (the rig root for a member's
 * agent_ref, the importing persona's folder for an import), after realpath. The result must stay inside that
 * folder's SPEC TREE ROOT: the nearest ancestor (the folder itself included) that has both an `agents/` and a
 * `rigs/` child, else the root the ref was reached under (a persona's imports share the rig folder that
 * named the persona; a `path:` persona that is not in a marked tree is confined to its own folder), else the
 * folder itself. That is the layout the shipped specs and the deployed release use
 * (`<root>/rigs/<rig>/rig.yaml` naming `local:../../agents/<persona>`), so they keep working; a ref that
 * leaves the tree (`local:../../etc`, a symlink out) is refused with a message that says to use `path:`.
 * It could not be a literal "stay inside the carrying folder": 44 of the 52 `local:` refs in the repo's specs
 * (every built-in factory/starter rig and every shared-import) and all 9 in the deployed jims-team rig climb
 * out of their own folder to a sibling `agents/` tree (census in the commit message).
 *
 * `path:` refs. Must be absolute; `..` is normalised away and the result is realpath'd. No allowlist.
 *
 * Persona file. The resolver reads exactly one file per persona folder, `agent.yaml`. It must be, after
 * realpath, a regular file with a single link, at most PERSONA_FILE_MAX_BYTES, read through ONE descriptor
 * opened with O_NOFOLLOW|O_NONBLOCK (the shared reader in culture-file-guard.ts), so a FIFO cannot hang the
 * daemon. RESIDUAL: the files a persona names (guidance, skills, startup files) are read later by the
 * adapters, projection and bundle vendoring; they are NOT covered here. A CONTENT swap of a regular,
 * single-link, under-cap agent.yaml between the check and the parse is not detected either.
 *
 * Cap: the largest agent.yaml in real use, measured 2026-10-15, is 2,115 bytes (the built-in `shared`
 * persona; the deployed release's largest is 1,218). 64 KiB is ~31x that, and far below any credential
 * bundle or log.
 */
export const PERSONA_FILE_MAX_BYTES = 64 * 1024;

export const PERSONA_FILE_KIND: GuardedFileKind = {
  label: "persona file",
  maxBytes: PERSONA_FILE_MAX_BYTES,
  notFoundHint: "check the agent_ref",
  notRegularHint: "an agent.yaml must be a plain file",
  article: "an agent.yaml",
};

/** Thrown by {@link readGuardedPersonaFile}; the resolver turns it into a `ref_refused` result. */
export class PersonaFileRefused extends Error {}

/** Read one persona file (agent.yaml) through the guard. Throws {@link PersonaFileRefused} with the refusal message. */
export function readGuardedPersonaFile(path: string): string {
  const checked = checkGuardedFile(PERSONA_FILE_KIND, path, path);
  if (!checked.ok) throw new PersonaFileRefused(checked.message);
  return checked.content;
}

/**
 * The production additions to an `AgentResolverFsOps` (spread them into every filesystem the resolver is
 * given outside tests): realpath for confinement and the guarded agent.yaml reader. Without them the
 * resolver can only check refs lexically, which is all an in-memory test filesystem needs.
 */
export const guardedAgentRefFsOps = {
  realpath: (p: string): string => realpathSync(p),
  readPersonaFile: readGuardedPersonaFile,
};

export interface AgentRefFs {
  exists(path: string): boolean;
  realpath?(path: string): string;
}

export type AgentRefDir =
  | { ok: true; dir: string; /** The root this persona's own `local:` imports are confined to (set for a `local:` ref only). */ importRoot?: string }
  | { ok: false; kind: "malformed" | "refused"; message: string };

function realOrSame(fs: AgentRefFs, p: string): string {
  try { return fs.realpath ? fs.realpath(p) : p; } catch { return p; }
}

function isInside(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${nodePath.sep}`) && rel !== ".." && !nodePath.isAbsolute(rel));
}

/** The spec tree root of a real folder: nearest ancestor (itself included) with `agents/` and `rigs/` children, if any. */
export function specTreeRoot(fs: AgentRefFs, realDir: string): string | undefined {
  for (let dir = realDir; ; ) {
    if (fs.exists(nodePath.join(dir, "agents")) && fs.exists(nodePath.join(dir, "rigs"))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Turn an agent_ref (or an import ref) into the persona folder to load, or a refusal. Pure apart from the
 * injected `exists`/`realpath`; nothing is created. `baseDir` is the folder a `local:` ref is relative to.
 */
export function resolveAgentRefDir(ref: string, baseDir: string, fs: AgentRefFs, inheritedRoot?: string): AgentRefDir {
  if (ref.startsWith("local:")) {
    const rel = ref.slice("local:".length);
    if (!rel) return { ok: false, kind: "malformed", message: `Cannot resolve agent_ref "${ref}"` };
    const realBase = realOrSame(fs, nodePath.resolve(baseDir));
    // No marked tree: the root is the one the carrying persona was reached under (a rig's own folder for a
    // member's agent_ref), else the carrying folder itself.
    const root = specTreeRoot(fs, realBase) ?? inheritedRoot ?? realBase;
    const lexical = nodePath.resolve(realBase, rel);
    const target = realOrSame(fs, lexical);
    // Both the lexical and the real location must be inside: a `..` that escapes is refused even when the
    // target does not exist, and a symlink that resolves outside is refused after realpath.
    if (!isInside(root, lexical) || !isInside(root, target)) {
      return {
        ok: false,
        kind: "refused",
        message: `agent_ref "${ref}" resolves to ${target}, outside ${root} (the tree it is relative to); a local: ref must stay inside that tree, use path:/absolute/dir for a persona outside it`,
      };
    }
    return { ok: true, dir: target, importRoot: root };
  }
  if (ref.startsWith("path:")) {
    const abs = ref.slice("path:".length);
    if (!abs) return { ok: false, kind: "malformed", message: `Cannot resolve agent_ref "${ref}"` };
    if (!nodePath.isAbsolute(abs)) {
      return { ok: false, kind: "refused", message: `agent_ref "${ref}": a path: ref must be an absolute path (use local: for a path relative to the rig)` };
    }
    return { ok: true, dir: realOrSame(fs, nodePath.resolve(abs)) };
  }
  return { ok: false, kind: "malformed", message: `Cannot resolve agent_ref "${ref}"` };
}
