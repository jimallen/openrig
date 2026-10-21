import nodePath from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

const ENV_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Expands a leading `~` and `$VAR` / `${VAR}` references. A reference to an unset variable is
 *  left as written so preflight reports the path instead of launching in a silently shortened one. */
export function expandCwd(
  authored: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const tilded = authored === "~" || authored.startsWith("~/") ? home + authored.slice(1) : authored;
  return tilded.replace(ENV_REF, (ref, braced?: string, bare?: string) => env[braced ?? bare!] ?? ref);
}

/** Picks the directory an authored cwd means. The literal path wins when it exists, so a directory
 *  named with `~` or `$NAME` keeps its destination; otherwise the expanded path is used. A relative
 *  path resolves under `specRoot`; with no `specRoot` it stays relative, as the caller selected before. */
export function resolveAuthoredCwd(
  authored: string,
  specRoot: string | null,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const place = (p: string) => (specRoot === null || nodePath.isAbsolute(p) ? p : nodePath.resolve(specRoot, p));
  const literal = place(authored);
  return exists(literal) ? literal : place(expandCwd(authored, env, home));
}

export function resolveLaunchCwd(
  authoredCwd: string | null | undefined,
  specRoot: string,
  cwdOverride?: string | null,
): string {
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return nodePath.resolve(cwdOverride);
  }
  if (!authoredCwd || authoredCwd.trim().length === 0) {
    return nodePath.resolve(specRoot);
  }
  return resolveAuthoredCwd(authoredCwd, specRoot);
}

export function getOpenRigInstallRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../..");
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(rootPath), nodePath.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

export function isFilesystemRoot(cwd: string): boolean {
  const resolved = nodePath.resolve(cwd);
  return resolved === nodePath.parse(resolved).root;
}

export function getOpenRigInstallCwdError(
  resolvedCwd: string,
  cwdOverride?: string | null,
  installRoot: string = getOpenRigInstallRoot(),
): string | null {
  // The filesystem root is not refused (#226): an explicit --cwd / or `cwd: /` is the person's
  // choice, and `rig up` warns when it defaulted to '/' itself.
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return null;
  }
  if (!isPathInsideRoot(resolvedCwd, installRoot)) {
    return null;
  }
  return `Resolved cwd '${resolvedCwd}' is inside the OpenRig installation '${installRoot}', which is not a valid project workspace. Pass --cwd <path> to launch into your project directory.`;
}

/** The reason a seat's resolved cwd cannot be a launch directory, or null when it is a directory. tmux does not
 *  refuse a missing `-c` directory: it starts the session in $HOME, so the seat would run in the wrong place
 *  with no error. Preflight refuses instead. Nothing here creates the directory. */
export function getSeatCwdPresenceError(
  resolvedCwd: string,
  stat: (path: string) => { isDirectory(): boolean } = statSync,
): string | null {
  const fault = getSeatCwdFault(resolvedCwd, stat);
  if (!fault) return null;
  return fault.kind === "missing"
    ? `cwd '${resolvedCwd}' does not exist; a seat launched there would silently start in $HOME. Create the directory or change the seat's cwd (preflight does not create it)`
    : `cwd '${resolvedCwd}' ${fault.what}`;
}

/** What is wrong with a seat's resolved cwd, as a kind a caller can branch on. `what` completes "cwd '<path>' ...". */
export type SeatCwdFault = { kind: "missing" } | { kind: "not_directory" | "not_accessible"; what: string };

export function getSeatCwdFault(
  resolvedCwd: string,
  stat: (path: string) => { isDirectory(): boolean } = statSync,
): SeatCwdFault | null {
  let found: { isDirectory(): boolean };
  try {
    found = stat(resolvedCwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "not_accessible", what: `is not accessible (${code ?? (err as Error).message})` };
  }
  return found.isDirectory() ? null : { kind: "not_directory", what: "is not a directory" };
}

/** What the person does about a fault in a seat's recorded folder: create it only when it is absent, otherwise fix what is wrong. */
export function seatCwdFixAdvice(path: string, fault: SeatCwdFault): string {
  return fault.kind === "missing" ? `Create the folder ${path}` : `Fix ${path}: it ${fault.what}`;
}
