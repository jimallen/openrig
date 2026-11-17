// workspaces-o9o.46 — where the shared-docs tree is: the ONE rule, for the daemon and (through `@openrig/daemon/shared-docs-root`)
// the CLI. Eight places used to build it, two ways: five from the account's home (`~/.openrig/shared-docs`) and two from
// OPENRIG_HOME. So an instance with its own OPENRIG_HOME (a scratch or test daemon) still wrote the operator's
// `~/.openrig/shared-docs` and handed it to a Codex seat as a writable --add-dir, while it trusted rig specs only under its own
// home. Now the tree follows OPENRIG_HOME, and OPENRIG_SHARED_DOCS_ROOT names another on purpose. Where OPENRIG_HOME is the
// default (`~/.openrig`, every live host measured 2026-11-16) the path is the same as before.
//
// No env or filesystem reads here: callers pass what they know (openrig-compat's `resolveSharedDocsRoot` is the usual one).
import path from "node:path";

export interface SharedDocsSources {
  /** The env OPENRIG_SHARED_DOCS_ROOT is read from. */
  env: Record<string, string | undefined>;
  /** This instance's OpenRig home, as openrig-compat's getOpenRigHome() resolves it. */
  openrigHome: string;
}

/** The variables that name the tree, in order: RIGX_SHARED_DOCS_ROOT is the older name, used only when the first is unset. */
const ROOT_VARIABLES = ["OPENRIG_SHARED_DOCS_ROOT", "RIGX_SHARED_DOCS_ROOT"] as const;

/** The shared-docs root and what to tell the operator about it. The first of ROOT_VARIABLES that is set (blank is unset) names
 *  the root, if it is an absolute path. A value that is not absolute is not used (review of f4aeb5705: the daemon and each seat
 *  resolved a relative one against different cwds, so the trust root and the seats' write root differed); it is never resolved
 *  against a cwd. It is reported, and the default `<OpenRig home>/shared-docs` is used. */
export function resolveSharedDocs(sources: SharedDocsSources): { root: string; notices: string[] } {
  const fallback = path.join(sources.openrigHome, "shared-docs");
  for (const name of ROOT_VARIABLES) {
    const value = sources.env[name]?.trim();
    if (!value) continue;
    if (path.isAbsolute(value)) return { root: value, notices: [] };
    return { root: fallback, notices: [`Warning: ${name}=${value} is not an absolute path, so it is not used (it would name a different folder from each seat's working folder); the shared-docs tree is ${fallback}.`] };
  }
  return { root: fallback, notices: [] };
}

/** The shared-docs root (resolveSharedDocs without its notices). */
export function sharedDocsRoot(sources: SharedDocsSources): string {
  return resolveSharedDocs(sources).root;
}

/** Before workspaces-o9o.46 the tree was `<account home>/.openrig/shared-docs` whatever OPENRIG_HOME said. On a box with a
 *  non-default home that still has its tree there and none in the new place, say how to keep it. Nothing is moved or copied.
 *  Null when a variable names the tree, the home is the default, the new tree exists, or there is no old one. */
export function legacySharedDocsNotice(
  sources: SharedDocsSources & { accountHome: string }, exists: (p: string) => boolean,
): string | null {
  const current = sharedDocsRoot(sources);
  if (current !== path.join(sources.openrigHome, "shared-docs")) return null; // a variable names the tree on purpose
  const legacy = path.join(sources.accountHome, ".openrig", "shared-docs");
  // With the default home `current` IS `legacy`, so it exists exactly when the old one does: no separate check is needed.
  if (exists(current) || !exists(legacy)) return null;
  return `Warning: the shared-docs tree now follows OPENRIG_HOME (${current}), which does not exist; one exists at ${legacy}. `
    + `Nothing was moved. To keep using it, set OPENRIG_SHARED_DOCS_ROOT=${legacy}.`;
}
