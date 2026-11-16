// What the UI reads out of a member's agent_ref string. The daemon owns the grammar and resolves refs
// (packages/daemon/src/domain/agent-ref-grammar.ts, agent-ref-guard.ts); these helpers only name and find the persona a
// ref points at, for display and for opening its spec library entry.
//
// `shipped:<rel>` (workspaces-o9o.1) names a persona folder inside the RUNNING OpenRig install's specs folder. The spec
// library indexes that same folder as its builtin root, so the builtin agent entry whose relativePath is `<rel>/agent.yaml`
// is exactly the persona the ref names. It is matched by that path, never by name: an agent's `name` need not be its folder
// (the kernel's `rigs/launch/kernel/agents/operator/agent` is named `operator.agent`), and a user spec may share a name.

export type AgentRefSource = "builtin" | "user_file" | "fork";

/**
 * The spec name and source the rig spec display shows for a member's agent_ref. The name is the part after `agents/`
 * (for `shipped:`, after the LAST `agents/` segment, so a persona nested in a shipped rig is named by its own folder);
 * everything before it is the source qualifier. `shipped:` and `builtin:` refs ship with OpenRig; `fork:` is a fork;
 * anything else is the user's own file.
 */
export function describeAgentRef(agentRef: string): { specName: string; source: AgentRefSource } {
  if (agentRef.startsWith("shipped:")) {
    const rel = agentRef.slice("shipped:".length).replace(/\/+$/, "");
    const segments = rel.split("/");
    const agents = segments.lastIndexOf("agents");
    const name = agents >= 0 && agents < segments.length - 1 ? segments.slice(agents + 1).join("/") : rel;
    return { specName: name, source: "builtin" };
  }
  const trimmed = agentRef.startsWith("local:") ? agentRef.slice("local:".length) : agentRef;
  const stripQual = trimmed.replace(/^(builtin|user|fork):/, "");
  const after = stripQual.startsWith("agents/") ? stripQual.slice("agents/".length) : stripQual;
  const specName = after.split("@")[0] ?? after;
  const source: AgentRefSource = agentRef.startsWith("fork:")
    ? "fork"
    : agentRef.startsWith("builtin:")
      ? "builtin"
      : "user_file";
  return { specName, source };
}

/**
 * The spec library relativePath (`<rel>/agent.yaml`, normalised) of the persona a `shipped:` ref names. Null for any other
 * ref, and for a `shipped:` ref the daemon refuses (empty, absolute, or climbing out of the specs folder).
 */
export function shippedAgentManifestPath(agentRef: string | null | undefined): string | null {
  if (!agentRef?.startsWith("shipped:")) return null;
  const rel = agentRef.slice("shipped:".length);
  if (!rel || rel.startsWith("/")) return null;
  const parts: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? `${parts.join("/")}/agent.yaml` : null;
}

/** The builtin spec library agent entry a `shipped:` ref names, matched by path (see the file header); null when none. */
export function findShippedAgentEntry<E extends { kind?: string; sourceType: string; relativePath: string }>(
  agentRef: string | null | undefined,
  entries: readonly E[],
): E | null {
  const manifest = shippedAgentManifestPath(agentRef);
  if (!manifest) return null;
  return entries.find((entry) =>
    entry.sourceType === "builtin"
    && (entry.kind === undefined || entry.kind === "agent")
    && entry.relativePath.replaceAll("\\", "/") === manifest) ?? null;
}
