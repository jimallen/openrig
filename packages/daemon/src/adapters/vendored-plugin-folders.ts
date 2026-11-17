// workspaces-o9o.44 (verify-qa review): the filesystem side of the vendored-plugin duplicate rule. The rule itself
// (selectIgnoredVendoredPlugins) is pure domain logic; this adapter implements its scan port
// (VendoredPluginFolderScan) by reading the plugins folder, and is what the composition root and `rig doctor` use.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkGuardedFile, PLUGIN_JSON_KIND } from "../domain/culture-file-guard.js";
import {
  hookIdentitiesOf,
  selectIgnoredVendoredPlugins,
  type IgnoredVendoredPlugin,
  type VendoredPluginFolder,
} from "../domain/plugin-discovery-service.js";

const MANIFESTS = [["claude", ".claude-plugin/plugin.json"], ["codex", ".codex-plugin/plugin.json"]] as const;

/** Every folder of `pluginsDir` with its manifests' declared names and the hooks it registers. Reads only, through the
 *  culture-file guard; never throws on what it finds (an unreadable folder, manifest or hooks file counts as empty). */
export function scanVendoredPluginFolders(pluginsDir: string): VendoredPluginFolder[] {
  let entries: string[];
  try { entries = readdirSync(pluginsDir); } catch { return []; }
  const folders: VendoredPluginFolder[] = [];
  for (const entry of entries) {
    const pluginPath = join(pluginsDir, entry);
    if (!isDir(pluginPath)) continue;
    const manifestNames: string[] = [];
    const hooks: VendoredPluginFolder["hooks"] = [];
    for (const [runtime, manifestRel] of MANIFESTS) {
      const manifest = readJson(join(pluginPath, manifestRel));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
      const { name, hooks: hooksRef } = manifest as { name?: unknown; hooks?: unknown };
      if (typeof name === "string") manifestNames.push(name);
      if (typeof hooksRef !== "string" || !hooksRef.trim()) continue;
      const hooksPath = join(pluginPath, hooksRef);
      for (const identity of hookIdentitiesOf(readJson(hooksPath), runtime, pluginPath)) hooks.push({ identity, hooksPath });
    }
    folders.push({ entry, pluginPath, manifestNames, hooks });
  }
  return folders;
}

/** The folders of `pluginsDir` the daemon ignores, by the domain's rule over this adapter's scan. */
export function findIgnoredVendoredPlugins(pluginsDir: string): IgnoredVendoredPlugin[] {
  return selectIgnoredVendoredPlugins(scanVendoredPluginFolders(pluginsDir));
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readJson(path: string): unknown {
  try {
    const checked = checkGuardedFile(PLUGIN_JSON_KIND, path, path);
    return checked.ok ? JSON.parse(checked.content) : null;
  } catch {
    return null;
  }
}
