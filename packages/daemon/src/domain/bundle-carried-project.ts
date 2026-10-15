import fs from "node:fs";
import nodePath from "node:path";
import { parse as parseYaml } from "yaml";
import { assertShippableSubstance } from "./agent-resolver.js";
import { collectVendoredTree, productionVendoredReadDeps, readContainedVendoredFile, VendoredTreeBudget, VENDORED_PROJECT_TREE_MAX_BYTES } from "./vendored-file-guard.js";
import type { BundleProjectReference } from "./bundle-types.js";

/** The folder a carried project occupies inside a bundle. */
export const BUNDLE_PROJECT_DIR = "project";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id a project.yaml declares, read the way `rig context work-install` reads it. */
export function projectManifestId(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const m = manifest as Record<string, unknown>;
  if (typeof m["id"] === "string") return m["id"];
  const metadata = m["metadata"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const id = (metadata as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * Vendor a project folder (project.yaml plus the files beside it, such as its
 * SPEC.md) into a bundle being built, for `rig bundle create --project-dir`.
 * Every file must resolve inside the folder. Returns the manifest's `project`
 * reference.
 */
export function vendorProjectDir(projectDir: string, staging: string): BundleProjectReference {
  let projectReal: string;
  try {
    projectReal = fs.realpathSync(projectDir);
  } catch {
    throw new Error(`project directory '${projectDir}' does not exist`);
  }
  const manifestPath = nodePath.join(projectReal, "project.yaml");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`project directory '${projectDir}' has no project.yaml`);
  }
  // project.yaml is read through the guarded reader (one descriptor, regular file, one link, capped): the
  // isFile() check above is stat-then-read, so a file swapped for a FIFO in between would stall the daemon.
  const id = projectManifestId(parseYaml(Buffer.from(readContainedVendoredFile(productionVendoredReadDeps, projectReal, "project.yaml", manifestPath)).toString("utf-8")));
  if (!id) throw new Error(`project.yaml in '${projectDir}' declares no id; add 'id: <name>'`);
  if (!PROJECT_ID.test(id)) throw new Error(`project id '${id}' must be a simple name (letters, digits, '.', '_', '-')`);

  // The shared guarded collector (also behind the author skill/plugin trees): per-file and per-tree caps, an
  // entry cap, hard links, pipes/devices/sockets and links out of the folder refused, cycles refused. A
  // refusal is a caller-correctable VendoredFileRefused (route: 400). The bytes written are the bytes read.
  const files = collectVendoredTree({
    rootReal: projectReal,
    startReal: projectReal,
    label: `project '${id}'`,
    display: (relativePath) => relativePath,
    budget: new VendoredTreeBudget(`project '${id}'`, VENDORED_PROJECT_TREE_MAX_BYTES),
  });
  const sources = files.map((file) => ({ ...file, path: `${BUNDLE_PROJECT_DIR}/${file.relativePath}` }));
  assertShippableSubstance(sources);

  for (const source of sources) {
    const target = nodePath.join(staging, BUNDLE_PROJECT_DIR, source.relativePath);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.bytes);
    fs.chmodSync(target, source.mode | 0o600);
  }
  return { id, path: BUNDLE_PROJECT_DIR };
}
