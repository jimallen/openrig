import nodePath from "node:path";

/**
 * The agent_ref grammar: the one place that says which schemes an agent reference may use and what shape each
 * one takes. A rig member's `agent_ref` (rigspec-schema.ts) and an AgentSpec's `imports[].ref` (agent-manifest.ts)
 * are both checked here, so a scheme cannot be legal in one and refused by the other. Pure: no filesystem.
 * Where a ref POINTS is decided later by agent-ref-guard.ts (resolveAgentRefDir), which also confines it.
 *
 * - `local:<relative>`  relative to the folder that carries the ref (the rig root, or the importing persona).
 * - `path:<absolute>`   an absolute folder on this host.
 * - `shipped:<relative>` relative to the RUNNING OpenRig install's own specs folder (`<install>/daemon/specs`, or
 *   `packages/daemon/specs` in a checkout), so one spec works on every install prefix (Homebrew, ~/.local, a
 *   checkout). It may not leave that folder: no absolute path and no `..` that climbs out of it.
 * - `agents-release:<relative>` (workspaces-o9o.53) relative to the DEPLOYED AGENTS RELEASE in the user's home,
 *   `<home>/.agents-release/current`, so a spec names a reviewed persona of that release on every host (a Mac home and a
 *   Linux home alike). The same shape rule as `shipped:`; where it points and whether that folder may be trusted is
 *   decided by agent-ref-guard.ts.
 *
 * `builtin:terminal` is not a scheme: it is the terminal-node sentinel, handled by the rig spec validator.
 */
export const AGENT_REF_SCHEMES = ["local:", "path:", "shipped:", "agents-release:"] as const;

export type ParsedAgentRef =
  | { ok: true; scheme: "local" | "shipped" | "agents-release"; relative: string }
  | { ok: true; scheme: "path"; absolute: string }
  | { ok: false; reason: string };

/** Whether `ref` starts with one of the agent_ref schemes (its shape is not checked). */
export function hasAgentRefScheme(ref: string): boolean {
  return AGENT_REF_SCHEMES.some((scheme) => ref.startsWith(scheme));
}

/**
 * Check one agent_ref's scheme and shape. On failure `reason` is the message without a field name, for the caller
 * to prefix (`imports[0].ref: ...`, `pods[0].members[0].agent_ref: ...`).
 */
export function parseAgentRef(ref: string): ParsedAgentRef {
  if (ref.startsWith("local:")) {
    const relative = ref.slice("local:".length);
    if (!relative) return { ok: false, reason: "local: ref must have a path" };
    if (relative.startsWith("/")) return { ok: false, reason: `local: ref must be a relative path (got "${ref}")` };
    return { ok: true, scheme: "local", relative };
  }
  if (ref.startsWith("path:")) {
    const absolute = ref.slice("path:".length);
    if (!absolute) return { ok: false, reason: "path: ref must have a path" };
    if (!absolute.startsWith("/")) return { ok: false, reason: `path: ref must be an absolute path (got "${ref}")` };
    return { ok: true, scheme: "path", absolute };
  }
  if (ref.startsWith("shipped:")) {
    const relative = ref.slice("shipped:".length);
    if (!relative) return { ok: false, reason: "shipped: ref must have a path" };
    if (relative.startsWith("/")) {
      return { ok: false, reason: `shipped: ref must be a path relative to the installed OpenRig's specs folder (got "${ref}")` };
    }
    if (climbsOut(relative)) {
      return { ok: false, reason: `shipped: ref must stay inside the installed OpenRig's specs folder (got "${ref}")` };
    }
    return { ok: true, scheme: "shipped", relative };
  }
  if (ref.startsWith("agents-release:")) {
    const relative = ref.slice("agents-release:".length);
    if (!relative) return { ok: false, reason: "agents-release: ref must have a path" };
    if (relative.startsWith("/")) {
      return { ok: false, reason: `agents-release: ref must be a path relative to the deployed agents release, ~/.agents-release/current (got "${ref}")` };
    }
    if (climbsOut(relative)) {
      return { ok: false, reason: `agents-release: ref must stay inside the deployed agents release, ~/.agents-release/current (got "${ref}")` };
    }
    return { ok: true, scheme: "agents-release", relative };
  }
  return { ok: false, reason: `must start with "local:", "path:", "shipped:" or "agents-release:" (got "${ref}")` };
}

/** A relative path whose normal form leaves the folder it is relative to (`..`, `../x`, `a/../../x`). */
function climbsOut(relative: string): boolean {
  const normal = nodePath.posix.normalize(relative);
  return normal === ".." || normal.startsWith("../");
}
