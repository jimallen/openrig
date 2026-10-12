import nodePath from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * A project rig is a team spec that runs inside a project folder rather than
 * beside its spec. `project_rig: true` at the top of a pod-aware spec makes
 * `rig up <spec> --cwd <project>`:
 *  - require --cwd (the project), refusing a launch without one;
 *  - name the rig after the project folder;
 *  - give every member its own folder, <project>/.workspaces/<pod>-<member>.
 * The launch then proceeds as an ordinary spec whose members carry absolute
 * cwds, so restore and resume reuse the same per-seat folders.
 */

export const PROJECT_RIG_WORKSPACES = ".workspaces";
const RESERVED_PROJECT_RIG_NAMES = new Set(["kernel"]);

export type ProjectRigResult =
  | { kind: "not_project_rig" }
  | { kind: "error"; error: string }
  | { kind: "project_rig"; rigSpecYaml: string; rigName: string; projectRoot: string; workspaceDirs: string[] };

const PROJECT_RIG_ID = /^[A-Za-z0-9_-]+$/;

/** A spec still carrying `project_rig: true` reached a launch path that does not
 *  project it (`rig up <spec> --cwd` is the one that does); refuse rather than run
 *  every member in one shared folder under the spec's own name. */
export function unprojectedProjectRigError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>)["project_rig"] !== true) return null;
  const name = (raw as Record<string, unknown>)["name"];
  return `${typeof name === "string" ? name : "this rig"} is a project rig: launch it with rig up <spec> --cwd <project folder>.`;
}

export function projectRigSlug(projectRoot: string): string {
  return nodePath.basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function applyProjectRig(rigSpecYaml: string, cwdOverride: string | null | undefined): ProjectRigResult {
  let raw: unknown;
  try {
    raw = parseYaml(rigSpecYaml);
  } catch {
    // The normal validation path reports the parse failure.
    return { kind: "not_project_rig" };
  }
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>)["project_rig"] !== true) {
    return { kind: "not_project_rig" };
  }
  const spec = raw as Record<string, unknown>;
  const specName = typeof spec["name"] === "string" ? spec["name"] : "this rig";
  if (!cwdOverride || cwdOverride.trim().length === 0) {
    return { kind: "error", error: `${specName} is a project rig: launch it into a project with --cwd <project folder>.` };
  }
  const projectRoot = nodePath.resolve(cwdOverride);
  const rigName = projectRigSlug(projectRoot);
  if (!rigName) {
    return { kind: "error", error: `${specName} is a project rig, and the project folder '${projectRoot}' gives no usable rig name; rename the folder.` };
  }
  if (RESERVED_PROJECT_RIG_NAMES.has(rigName)) {
    return { kind: "error", error: `${specName} is a project rig, and '${rigName}' is a reserved rig name; rename the project folder.` };
  }

  const owners = new Map<string, string>();
  const workspaceDirs: string[] = [];
  const pods = Array.isArray(spec["pods"]) ? spec["pods"] : [];
  for (const pod of pods) {
    if (!pod || typeof pod !== "object") continue;
    const podId = (pod as Record<string, unknown>)["id"];
    const members = (pod as Record<string, unknown>)["members"];
    if (typeof podId !== "string" || !Array.isArray(members)) {
      return { kind: "error", error: `${specName} is a project rig, and a pod has no usable id or members.` };
    }
    for (const member of members) {
      if (!member || typeof member !== "object") continue;
      const memberId = (member as Record<string, unknown>)["id"];
      if (typeof memberId !== "string") {
        return { kind: "error", error: `${specName} is a project rig, and a member of pod ${podId} has no id.` };
      }
      if (!PROJECT_RIG_ID.test(podId) || !PROJECT_RIG_ID.test(memberId)) {
        return { kind: "error", error: `${specName} is a project rig, and ${JSON.stringify(podId)}.${JSON.stringify(memberId)} is not a usable workspace folder name; pod and member ids may use only letters, digits, '-' and '_'.` };
      }
      const folder = `${podId}-${memberId}`;
      const owner = `${podId}.${memberId}`;
      const prior = owners.get(folder);
      if (prior) {
        return { kind: "error", error: `${specName} is a project rig, and members ${prior} and ${owner} would share the workspace folder ${PROJECT_RIG_WORKSPACES}/${folder}; rename one of them.` };
      }
      owners.set(folder, owner);
      const dir = nodePath.join(projectRoot, PROJECT_RIG_WORKSPACES, folder);
      if (nodePath.dirname(dir) !== nodePath.join(projectRoot, PROJECT_RIG_WORKSPACES)) {
        return { kind: "error", error: `${specName} is a project rig, and member ${owner} would work outside ${PROJECT_RIG_WORKSPACES}.` };
      }
      (member as Record<string, unknown>)["cwd"] = dir;
      workspaceDirs.push(dir);
    }
  }

  spec["name"] = rigName;
  delete spec["project_rig"];
  return { kind: "project_rig", rigSpecYaml: stringifyYaml(spec), rigName, projectRoot, workspaceDirs };
}

/** Escape gitignore pattern characters so a path matches only itself. */
export function escapeGitignore(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);
}

/**
 * Create the member folders and, when the project is a git work tree, keep
 * them out of `git status` through .git/info/exclude (never the tracked
 * .gitignore). The entry is anchored at the work-tree root.
 */
export function prepareProjectRigWorkspaces(projectRoot: string, workspaceDirs: string[]): void {
  for (const dir of workspaceDirs) fs.mkdirSync(dir, { recursive: true });

  let top: string;
  let excludePath: string;
  try {
    top = execFileSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    excludePath = execFileSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return; // not a git work tree
  }
  if (!top) return;
  if (!nodePath.isAbsolute(excludePath)) excludePath = nodePath.resolve(projectRoot, excludePath);
  const relRoot = nodePath.relative(fs.realpathSync(top), fs.realpathSync(projectRoot));
  const anchored = relRoot ? `/${escapeGitignore(relRoot.split(nodePath.sep).join("/"))}` : "";
  const entry = `${anchored}/${PROJECT_RIG_WORKSPACES}/`;
  let current = "";
  try { current = fs.readFileSync(excludePath, "utf-8"); } catch { /* absent until first write */ }
  if (current.split(/\r?\n/).includes(entry)) return;
  fs.mkdirSync(nodePath.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
