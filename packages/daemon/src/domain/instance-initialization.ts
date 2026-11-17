import { join } from "node:path";
import {
  ensureDefaultWorkspace,
  nodeInitializationFs,
  type InitializationConflict,
  type InitializationFsOps,
} from "./workspace/default-workspace-scaffold.js";
import {
  DEFAULT_SYSTEM_WORLD_MANIFEST,
  DEFAULT_SYSTEM_WORLD_RELATIVE_PATH,
} from "./system-world.js";
import {
  openPrivateRoot,
  privateRootRefusal,
  securePrivateRoot,
  type InstancePrivacyPort,
  type InstancePrivacyResult,
} from "./instance-privacy.js";

export interface OpenRigInstanceInitializationOptions {
  home: string;
  workspaceRoot?: string;
  contextRoot?: string;
  skillsRoot?: string;
  topologyRoot?: string;
  dryRun?: boolean;
  fs?: InitializationFsOps;
  /** When given, a home that is the user's home or above it is refused before anything is written, and the
   * instance is kept private to its owner (workspaces-o9o.36). */
  privacy?: InstancePrivacyPort;
}

export interface OpenRigInstanceInitializationResult {
  ok: boolean;
  home: string;
  createdPaths: string[];
  conflicts: InitializationConflict[];
  dryRun: boolean;
  /** Present when a privacy port was given and the layout was written. */
  privacy?: InstancePrivacyResult;
}

export function openRigContextLibraryRoots(contextRoot: string): [string, string] {
  return [contextRoot, join(contextRoot, "system")];
}

/** The conflict for an OpenRig home that is the user's home directory or an ancestor of it (compared on real paths
 * too), or null. Every path that writes an instance layout checks it before writing (workspaces-o9o.36). */
/**
 * What a launcher does to an OpenRig home before it writes anything into it, its own start lock included (o9o.36, verify-sec round 3):
 * refuse a home that is the user's home or above it (read-only, on real paths), else open an existing root its owner cannot enter
 * (0600) to exactly 0700. Returns the refusal, or null when the home may be written.
 */
export function prepareInstanceHome(home: string, privacy: InstancePrivacyPort): InitializationConflict | null {
  const conflict = instanceHomeConflict(home, privacy);
  if (conflict) return conflict;
  openPrivateRoot(home, privacy);
  return null;
}

export function instanceHomeConflict(home: string, privacy: InstancePrivacyPort): InitializationConflict | null {
  return privateRootRefusal(home, privacy) ? { path: home, expected: "instance-home", actual: "user-home" } : null;
}

/** Reconcile one canonical OpenRig instance layout. This is the shared owner
 * for CLI setup and daemon first-start. It owns empty roots and config.json;
 * S01 owns workspace contents, S04 owns skill contents, and topology owns its
 * contents. */
export function ensureOpenRigInstance(
  options: OpenRigInstanceInitializationOptions,
): OpenRigInstanceInitializationResult {
  const fs = options.fs ?? nodeInitializationFs();
  const dryRun = options.dryRun ?? false;
  // workspaces-o9o.36: the refusal comes first, so a refused home is never written to.
  const homeConflict = options.privacy ? instanceHomeConflict(options.home, options.privacy) : null;
  if (homeConflict) return { ok: false, home: options.home, createdPaths: [], conflicts: [homeConflict], dryRun };
  const workspaceRoot = options.workspaceRoot ?? join(options.home, "workspace");
  const contextRoot = options.contextRoot ?? join(options.home, "context");
  const skillsRoot = options.skillsRoot ?? join(options.home, "skills");
  const topologyRoot = options.topologyRoot ?? join(options.home, "topology");
  const [contextLibraryRoot, systemContextRoot] = openRigContextLibraryRoots(contextRoot);
  const directories = [...new Set([
    options.home,
    join(options.home, "state"),
    contextLibraryRoot,
    systemContextRoot,
    skillsRoot,
    join(options.home, "specs"),
    topologyRoot,
    join(options.home, "plugins"),
    join(options.home, "run"),
    join(options.home, "logs"),
    join(options.home, "transcripts"),
    join(options.home, "backups"),
    join(options.home, "secrets"),
  ])];
  const configPath = join(options.home, "config.json");
  const systemWorldPath = join(contextRoot, DEFAULT_SYSTEM_WORLD_RELATIVE_PATH);
  const conflicts: InitializationConflict[] = [];

  for (const path of directories) {
    const actual = fs.pathKind(path);
    if (actual !== "missing" && actual !== "directory") {
      conflicts.push({ path, expected: "directory", actual });
    }
  }
  const configKind = fs.pathKind(configPath);
  if (configKind !== "missing" && configKind !== "file") {
    conflicts.push({ path: configPath, expected: "file", actual: configKind });
  }
  const systemWorldKind = fs.pathKind(systemWorldPath);
  if (systemWorldKind !== "missing" && systemWorldKind !== "file") {
    conflicts.push({ path: systemWorldPath, expected: "file", actual: systemWorldKind });
  }

  const workspacePlan = ensureDefaultWorkspace({ root: workspaceRoot, dryRun: true, fs });
  conflicts.push(...workspacePlan.conflicts);
  if (conflicts.length > 0) {
    return { ok: false, home: options.home, createdPaths: [], conflicts, dryRun };
  }

  const missingDirectories = directories.filter((path) => fs.pathKind(path) === "missing");
  const createdPaths = [
    ...missingDirectories,
    ...(configKind === "missing" ? [configPath] : []),
    ...(systemWorldKind === "missing" ? [systemWorldPath] : []),
    ...(workspacePlan.rootCreated ? [workspaceRoot] : []),
    ...workspacePlan.subdirs.filter((entry) => entry.created).map((entry) => entry.path),
    ...workspacePlan.files.filter((entry) => entry.created).map((entry) => entry.absPath),
  ];

  if (!dryRun) {
    // A home its owner cannot enter (0600) could not be written into: open it to 0700 first.
    if (options.privacy) openPrivateRoot(options.home, options.privacy);
    for (const path of missingDirectories) fs.mkdirp(path);
    if (configKind === "missing") fs.writeFile(configPath, "{}\n");
    if (systemWorldKind === "missing") fs.writeFile(systemWorldPath, DEFAULT_SYSTEM_WORLD_MANIFEST);
    ensureDefaultWorkspace({ root: workspaceRoot, fs });
  }
  const privacy = !dryRun && options.privacy ? securePrivateRoot(options.home, options.privacy) : undefined;

  return { ok: true, home: options.home, createdPaths, conflicts: [], dryRun, ...(privacy ? { privacy } : {}) };
}

export function formatInstanceInitializationConflicts(
  result: Pick<OpenRigInstanceInitializationResult, "conflicts">,
): string {
  return result.conflicts
    .map((conflict) => `${conflict.path}: expected ${conflict.expected}, found ${conflict.actual}`)
    .join("; ");
}
