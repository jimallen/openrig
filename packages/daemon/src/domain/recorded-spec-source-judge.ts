// OF-103: ONE judgement of a rig's spec source, applied wherever it is recorded or read.
//
// What a rig records as its spec source decides which startup files, culture and `local:` personas a later fresh
// launch or restore delivers into a live seat, and which MCP servers `rig seat set-mcp` trusts. So the file must be one
// a seat could not have written. `rig spec-source set` judges it when it records it (OF-102), and every reader judges
// it again when it reads it (a fresh launch, a `--fresh` restore and its restore-check, the MCP recorded-spec read,
// `spec-source show`): a value recorded by `rig up` before OF-102, or a file edited or a link retargeted after `set`,
// is held to the same rules. The rules, all applied to the path that is actually read:
//  1. it must resolve (a missing file is the reader's own "unavailable");
//  2. its real location must lie under a trusted spec root (the released copies, the spec library, the running
//     install's bundled specs) or be exactly <shared-docs rigs>/<name>/rig.yaml, with the usual ownership, regular-file,
//     one-link, temp-folder, git-tree and seat-folder rules (`specFileTrustProblem`);
//  3. the path as written, with no link followed, must itself lie under a trusted root or be exactly
//     <shared-docs rigs>/<name>/rig.yaml (a link kept in a folder a seat can write could be retargeted later);
//  4. a file admitted only by the shared-docs rigs folder must sit in a folder named for this rig or for its spec.
// Recording adds a fifth: the typed path must be what a launch reads (OF-104).
import fs from "node:fs";
import nodePath from "node:path";
import { reanchorShippedSpecPath } from "./builtin-startup-files.js";
import { DEFAULT_PATH_JUDGE_IO, specFileTrustProblem, type PathJudgeIo } from "./codex-mcp-servers.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import { getOpenRigHome } from "../openrig-compat.js";

export interface SpecSourceTrust {
  /** Where a spec may live: released copies, the spec library, the running install's bundled specs. */
  roots: () => string[];
  /** A root that takes EXACTLY <root>/<name>/rig.yaml by real location and nothing deeper: the shared-docs rigs folder,
   *  whose <rig>/state/<pod> subfolders are writable roots of sandboxed Codex seats (OF-102 review R6). */
  exactDepthRoot?: () => string;
  io?: PathJudgeIo;
}

/** The trust the daemon applies to a recorded spec source, built from the MCP trust it already carries. The shared-docs
 *  rigs folder is the daemon's own and never comes from a caller. */
export function specSourceTrustOf(mcp: { specRoots?: () => string[]; io?: PathJudgeIo } | undefined, exactDepthRoot?: () => string): SpecSourceTrust {
  return {
    roots: () => [...(mcp?.specRoots?.() ?? [])],
    exactDepthRoot: exactDepthRoot ?? (() => nodePath.join(getOpenRigHome(), "shared-docs", "rigs")),
    ...(mcp?.io ? { io: mcp.io } : {}),
  };
}

export type SpecSourceJudgement =
  | { ok: true; /** The path the reader reads (re-anchored for a read; exactly the typed path for a record). */ readPath: string }
  | { ok: false; code: "spec_unreadable" | "spec_untrusted" | "spec_packaged_elsewhere"; message: string };

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

/** The spec's own `name`, read best-effort for the folder rule; null when it cannot be read or parsed. */
function specNameAt(file: string, io: PathJudgeIo): string | null {
  try {
    const raw = RigSpecCodec.parse(fs.readFileSync(io.realpath(file), "utf-8")) as unknown;
    const name = (raw as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : null;
  } catch { return null; }
}

/** Whether two paths lead to the same file now (so a link spelling of the running install is not "elsewhere"). */
function sameFile(a: string, b: string, io: PathJudgeIo): boolean {
  try { return io.realpath(a) === io.realpath(b); } catch { return false; }
}

export function judgeSpecSource(input: {
  /** As recorded (read) or as typed (record). Must be absolute. */
  specSource: string;
  use: "record" | "read";
  rigName: string;
  /** The working folders of the rig's seats: a spec inside one is refused. */
  seatFolders: readonly string[];
  trust: SpecSourceTrust;
}): SpecSourceJudgement {
  const io = input.trust.io ?? DEFAULT_PATH_JUDGE_IO;
  // Lexical clean-up only: a link spelling stays a link (OF-32/OF-99).
  const written = nodePath.resolve(input.specSource);
  const record = input.use === "record";
  // A launch reads the re-anchored path, so a read judges that one; a record judges exactly what it records.
  const readPath = record ? written : reanchorShippedSpecPath(written);
  try { io.realpath(readPath); } catch {
    return { ok: false, code: "spec_unreadable", message: record
      ? `${written} does not exist as typed (a missing path is not re-anchored when recording; name the real file).`
      : `${readPath} does not exist (or a link on its path leads nowhere).` };
  }
  if (record) {
    // OF-104: a packaged-install-shaped path is always read from the RUNNING install, so a path outside it would be judged
    // here and then read from a different file.
    const anchored = reanchorShippedSpecPath(written);
    if (anchored !== written && !sameFile(anchored, written, io)) {
      return { ok: false, code: "spec_packaged_elsewhere", message: `${written} lies in an OpenRig install other than the running one, and a launch always reads a packaged spec from the running install (${anchored}), a different file from the one judged here. Name the file in the running install, or a released copy under ~/.agents-release.` };
    }
  }
  const seatFolders = [...new Set(input.seatFolders)];
  const judge = (roots: string[]): string | null => {
    for (const seatCwd of seatFolders.length > 0 ? seatFolders : [null]) {
      const problem = specFileTrustProblem(readPath, roots, seatCwd, io);
      if (problem) return problem;
    }
    return null;
  };
  const roots = input.trust.roots();
  const hint = record
    ? "Record a reviewed spec from a trusted spec root instead (in the shared-docs rigs folder only <rig name>/rig.yaml qualifies)."
    : "A recorded spec source is held to the rules `rig spec-source set` applies. Put a reviewed copy in a trusted spec root and record it with `rig spec-source set`, or replay the saved files with --startup-from stored.";
  let problem = judge(roots);
  let exactFolder: string | null = null;
  const exactRoot = input.trust.exactDepthRoot?.();
  if (problem && exactRoot) {
    exactFolder = exactDepthFolder(readPath, exactRoot, io);
    if (exactFolder !== null) problem = judge([exactRoot]);
  }
  if (problem) return { ok: false, code: "spec_untrusted", message: `${problem}. ${hint}` };
  // The spelling is what gets read, so the path AS WRITTEN must qualify too, not only where it leads today: a link kept
  // in a folder a seat can write (the Codex state folders under the shared-docs rigs folder) could be retargeted to the
  // seat's own file later. Its own folders get the ownership and mode checks above, which judge the written chain too.
  const typedGeneral = typedUnderRoots(readPath, roots, io);
  const typedFolder = !typedGeneral && exactRoot ? typedExactFolder(readPath, exactRoot, io) : null;
  if (!typedGeneral && typedFolder === null) {
    return { ok: false, code: "spec_untrusted", message: `${readPath}, as typed, is not itself under a trusted spec root or exactly <shared-docs rigs>/<rig name>/rig.yaml. A link kept anywhere else (a seat's writable folder, say) could be pointed at another file later, so name the path through the trusted folder. ${hint}` };
  }
  // One rig's folder cannot serve another rig: a spec admitted only by the shared-docs rigs folder must sit in a folder
  // named for this rig or for the spec's own name (a project rig is named after its project, its spec is not).
  const folders = [exactFolder, typedFolder].filter((f): f is string => f !== null);
  if (folders.length > 0) {
    const specName = specNameAt(readPath, io);
    const wrong = folders.find((f) => f !== input.rigName && f !== specName);
    if (wrong !== undefined) {
      return { ok: false, code: "spec_untrusted", message: `${readPath} lies in the shared-docs folder '${wrong}', which is neither this rig's name ('${input.rigName}') nor its spec's name ('${specName ?? "unreadable"}'). ${hint}` };
    }
  }
  return { ok: true, readPath };
}
