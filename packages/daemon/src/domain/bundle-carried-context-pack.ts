import fs from "node:fs";
import nodePath from "node:path";
import { parseManifest } from "./context-packs/manifest-parser.js";
import { isSafePackRef } from "./context-packs/ref-safety.js";
import { productionVendoredReadDeps, readContainedVendoredFileWithMode, VendoredFileRefused, VendoredTreeBudget, VENDORED_CONTEXT_PACK_MAX_BYTES } from "./vendored-file-guard.js";
import { assertShippableSubstance } from "./agent-resolver.js";

/**
 * Vendor one context pack, named by its directory, into a bundle being built.
 *
 * Used by `rig bundle create --context-pack <dir>`. The author names the
 * directory on the command line, so it may sit outside the rig folder (for
 * example a world pack whose manifest is at its repository root). Only
 * `manifest.yaml` and the files the manifest declares are carried, the same
 * set `rig context add --git` installs, so a pack at a repository root does
 * not pull in the rest of the repository.
 *
 * The pack lands at `context-packs/<manifest name>/` in the bundle, so
 * install routes it under the pack's own name. Returns the bundle-relative
 * manifest path for the bundle manifest's `context_packs` list.
 */
export function vendorContextPackDir(packDir: string, staging: string): string {
  let packReal: string;
  try {
    packReal = fs.realpathSync(packDir);
  } catch {
    throw new Error(`context pack directory '${packDir}' does not exist`);
  }
  const manifestPath = nodePath.join(packReal, "manifest.yaml");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`context pack directory '${packDir}' has no manifest.yaml`);
  }
  // Every read below is the guarded read (one descriptor, regular file, one link, capped, inside the pack): the
  // existence/isFile checks are stat-then-read, so they only choose the message; they are not the defence.
  const budget = new VendoredTreeBudget(`context pack '${packDir}'`, VENDORED_CONTEXT_PACK_MAX_BYTES);
  const manifestRead = readContainedVendoredFileWithMode(productionVendoredReadDeps, packReal, "manifest.yaml", manifestPath);
  budget.take(manifestRead.bytes.byteLength);
  const manifest = parseManifest(Buffer.from(manifestRead.bytes).toString("utf-8"), manifestPath);
  const name = manifest.name;
  if (!isSafePackRef(name) || name.includes("/")) {
    throw new Error(`context pack '${packDir}' has name '${name}', which cannot be used as a single pack directory name`);
  }

  const bundleDir = `context-packs/${name}`;
  if (fs.existsSync(nodePath.join(staging, bundleDir))) {
    throw new Error(`context pack '${name}' is already in the bundle; each carried pack needs a distinct manifest name`);
  }

  const relativePaths = [...new Set(["manifest.yaml", ...manifest.files.map((f) => f.path)])];
  const sources = relativePaths.map((relativePath) => {
    const absolute = nodePath.resolve(packReal, relativePath);
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      throw new Error(`context pack '${name}' declares '${relativePath}', which does not exist`);
    }
    if (!real.startsWith(packReal + nodePath.sep)) {
      throw new VendoredFileRefused(`context pack '${name}' file '${relativePath}' resolves outside the pack directory; rejected`);
    }
    if (!fs.statSync(real).isFile()) {
      throw new Error(`context pack '${name}' declares '${relativePath}', which is not a file`);
    }
    const read = readContainedVendoredFileWithMode(productionVendoredReadDeps, packReal, relativePath, absolute);
    const bytes = Buffer.from(read.bytes);
    // manifest.yaml was taken from the budget when it was read first.
    if (relativePath !== "manifest.yaml") budget.take(bytes.byteLength);
    return { relativePath, path: `${bundleDir}/${relativePath}`, bytes, mode: read.mode };
  });
  assertShippableSubstance(sources);

  for (const source of sources) {
    const target = nodePath.join(staging, bundleDir, source.relativePath);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.bytes);
    fs.chmodSync(target, source.mode | 0o600);
  }
  return `${bundleDir}/manifest.yaml`;
}
