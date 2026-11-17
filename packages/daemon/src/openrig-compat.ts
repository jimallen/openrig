import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacySharedDocsNotice, resolveSharedDocs } from "./shared-docs-root.js";

const warnedKeys = new Set<string>();

export function getOpenRigHome(): string {
  const configured = readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME");
  if (configured !== undefined) return configured;
  return join(homedir(), ".openrig");
}

export function getLegacyRiggedHome(): string {
  return join(homedir(), ".rigged");
}

export const OPENRIG_HOME = getOpenRigHome();
export const LEGACY_RIGGED_HOME = getLegacyRiggedHome();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

export function readOpenRigEnv(primary: string, legacy?: string): string | undefined {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined && primaryValue !== "") return primaryValue;

  if (legacy) {
    const legacyValue = process.env[legacy];
    if (legacyValue !== undefined && legacyValue !== "") {
      warnOnce(`env:${legacy}`, `Warning: ${legacy} is deprecated; use ${primary} instead.`);
      return legacyValue;
    }
  }

  return undefined;
}

export function getPreferredOpenRigHome(): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();

  if (existsSync(openrigHome)) return openrigHome;
  if (existsSync(legacyRiggedHome)) {
    warnOnce(
      "path:home",
      `Warning: using legacy state directory ${legacyRiggedHome}; migrate to ${openrigHome}.`,
    );
    return legacyRiggedHome;
  }
  return openrigHome;
}

export function getDefaultOpenRigPath(filename: string): string {
  return join(getOpenRigHome(), filename);
}

export function getCompatibleOpenRigPath(filename: string): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();
  const primaryPath = join(openrigHome, filename);
  if (existsSync(primaryPath)) return primaryPath;

  const legacyPath = join(legacyRiggedHome, filename);
  if (existsSync(legacyPath)) {
    warnOnce(
      `path:${filename}`,
      `Warning: using legacy state path ${legacyPath}; migrate to ${primaryPath}.`,
    );
    return legacyPath;
  }

  return primaryPath;
}

/** workspaces-o9o.46: this instance's shared-docs tree, the one rule in shared-docs-root.ts (an absolute OPENRIG_SHARED_DOCS_ROOT,
 *  else an absolute RIGX_SHARED_DOCS_ROOT, else <OpenRig home>/shared-docs). Says once per process when a variable is not used,
 *  and how to keep a tree left at ~/.openrig/shared-docs by a non-default home. */
export function resolveSharedDocsRoot(env: Record<string, string | undefined> = process.env): string {
  const sources = { env, openrigHome: getOpenRigHome() };
  const { root, notices } = resolveSharedDocs(sources);
  for (const notice of notices) warnOnce(`env:shared-docs:${notice}`, notice);
  const legacy = legacySharedDocsNotice({ ...sources, accountHome: homedir() }, existsSync);
  if (legacy) warnOnce("path:shared-docs", legacy);
  return root;
}

/** The rigs folder of resolveSharedDocsRoot(). */
export function resolveSharedDocsRigsRoot(): string {
  return join(resolveSharedDocsRoot(), "rigs");
}
