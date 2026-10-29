import fs from "node:fs";
import nodePath from "node:path";
import type { DaemonClient } from "./client.js";

/**
 * OF-173: which rig a folder belongs to, so `rig down` with no <rig> can act on the rig of the current folder.
 *
 * The daemon records no project folder for a rig; it records each seat's folder (nodes.cwd). A project rig is
 * built by `rig up <spec> --cwd <project>` (daemon domain/project-rig.ts): it is named after the project folder
 * (projectRigSlug) and every seat runs in <project>/.workspaces/<pod>-<member>. So a rig's folder is KNOWN only
 * when both hold: every seat's folder is a direct child of the same <P>/.workspaces, and the rig's name is the
 * slug of <P>. Measured on the laptop daemon (2026-10-29, read-only): eztrack and ezhome have all 8 seats under
 * ~/Code/<project>/.workspaces/; the kernel's 7 seats are under ~/.workspaces/<seat>, whose <P> would be the home
 * folder, but "kernel" is not that folder's slug, so the kernel has no folder here (it never matches a folder).
 * A rig with no seats, or a seat with no folder, has no known folder either.
 *
 * The name is judged on the seat folders AS RECORDED, because the daemon names the rig from the --cwd it was given
 * (path.resolve, symlinks kept) and records the seats under that same path; folders are compared by REAL path, so a
 * project launched through a symlink is found from the link and from the real folder alike, whatever either is called.
 */
export interface FolderRig { id: string; name: string; folder: string }

/** The daemon's projectRigSlug (domain/project-rig.ts), the rule that names a project rig after its folder. */
export function projectRigSlug(projectRoot: string): string {
  return nodePath.basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Real path of the nearest existing ancestor (macOS /var vs /private/var), as the daemon compares seat folders. */
export function realFolder(p: string): string {
  const abs = nodePath.resolve(p);
  try { return fs.realpathSync.native(abs); } catch {
    const parent = nodePath.dirname(abs);
    return parent === abs ? abs : nodePath.join(realFolder(parent), nodePath.basename(abs));
  }
}

/** The project folder of a rig (its real path) from its seats' recorded folders, or null when it is not known (see above). */
export function rigProjectFolder(name: string, seatFolders: ReadonlyArray<string | null>): string | null {
  if (seatFolders.length === 0) return null;
  let root: string | null = null;
  for (const seat of seatFolders) {
    if (!seat) return null;
    const recorded = nodePath.dirname(nodePath.resolve(seat));
    if (nodePath.basename(recorded) !== ".workspaces") return null;
    if (projectRigSlug(nodePath.dirname(recorded)) !== name) return null;
    const project = realFolder(nodePath.dirname(recorded));
    if (root !== null && project !== root) return null;
    root = project;
  }
  return root;
}

export type FolderInference =
  | { kind: "one"; rig: FolderRig }
  | { kind: "none"; folder: string; known: FolderRig[] }
  | { kind: "several"; folder: string; candidates: FolderRig[] }
  | { kind: "unavailable"; error: string };

interface SummaryEntry { id: string; name: string; archivedAt?: string | null }
interface InventoryEntry { cwd?: string | null }

/**
 * The non-archived rig whose project folder contains `folder` (equal to it or below it). Any rig whose seats cannot be read
 * makes the answer unavailable: a rig not looked at could be the one, so the caller must not guess.
 */
export async function inferRigFromFolder(client: Pick<DaemonClient, "get">, folder: string): Promise<FolderInference> {
  const here = realFolder(folder);
  let rigs: SummaryEntry[];
  try {
    const res = await client.get<SummaryEntry[]>("/api/rigs/summary?includeArchived=true");
    if (res.status !== 200 || !Array.isArray(res.data)) return { kind: "unavailable", error: `the rig list could not be read (HTTP ${res.status})` };
    rigs = res.data.filter((r) => r.archivedAt == null);
  } catch (err) {
    return { kind: "unavailable", error: `the rig list could not be read: ${(err as Error).message}` };
  }
  const known: FolderRig[] = [];
  for (const rig of rigs) {
    let nodes: InventoryEntry[];
    try {
      const res = await client.get<InventoryEntry[]>(`/api/rigs/${encodeURIComponent(rig.id)}/nodes`);
      if (res.status !== 200 || !Array.isArray(res.data)) return { kind: "unavailable", error: `the seats of rig ${rig.name} (${rig.id}) could not be read (HTTP ${res.status})` };
      nodes = res.data;
    } catch (err) {
      return { kind: "unavailable", error: `the seats of rig ${rig.name} (${rig.id}) could not be read: ${(err as Error).message}` };
    }
    const projectFolder = rigProjectFolder(rig.name, nodes.map((n) => (typeof n.cwd === "string" ? n.cwd : null)));
    if (projectFolder !== null) known.push({ id: rig.id, name: rig.name, folder: projectFolder });
  }
  const candidates = known.filter((r) => here === r.folder || here.startsWith(r.folder + nodePath.sep));
  if (candidates.length === 1) return { kind: "one", rig: candidates[0]! };
  if (candidates.length === 0) return { kind: "none", folder: here, known };
  return { kind: "several", folder: here, candidates };
}
