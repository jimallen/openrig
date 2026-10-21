/**
 * Closed class normalisers for free-text failure messages. Only the class leaves the daemon
 * (design 3.1, content rules): the raw error text is read here and never carried into a
 * finding. Matching is case-insensitive and first-match-wins, in the order below. A message
 * that matches no rule is `other`, which is a finding in its own right: it forces a review
 * of the normaliser rather than hiding in a total.
 */
export const OTHER_CLASS = "other" as const;

type Rule = readonly [cls: string, needles: readonly string[]];

const STARTUP_FAILURE_RULES: readonly Rule[] = [
  ["codex-hook-trust", ["hook trust"]],
  // A Codex resume that dropped to a shell is a different code path from a readiness-probe
  // timeout whose pane did: it must precede `pane-returned-to-shell`, or an anchor on the
  // readiness fix would hide Codex resume failures.
  ["codex-resume-returned-to-shell", ["codex resume failed"]],
  ["pane-returned-to-shell", ["returned to a shell", "returned to shell"]],
  ["claude-resume-timeout", ["claude resume failed"]],
  ["no-input-target", ["managed input target"]],
  ["claude-not-active", ["not yet the active pa"]],
  ["codex-profile-getcwd", ["getcwd"]],
  ["codex-resume-not-interactive", ["codex resume has not yet reached an interactive conversation"]],
];

const BOOTSTRAP_FAILURE_RULES: readonly Rule[] = [
  ["rig-name-collision", ["already running", "already has a stopped rig", "belongs to another folder"]],
  ["agent-ref-unresolved", ["agent_ref resolution failed"]],
  ["all-nodes-failed", ["all node launches/startups failed"]],
  ["culture-file", ["culture file"]],
  ["mcp-server-command", ["mcp_servers"]],
  ["project-rig-needs-cwd", ["project rig"]],
];

function classify(rules: readonly Rule[], error: string | null): string {
  if (error === null) return OTHER_CLASS;
  const text = error.toLowerCase();
  for (const [cls, needles] of rules) if (needles.some((needle) => text.includes(needle))) return cls;
  return OTHER_CLASS;
}

export const classifyStartupFailure = (error: string | null): string => classify(STARTUP_FAILURE_RULES, error);
export const classifyBootstrapFailure = (error: string | null): string => classify(BOOTSTRAP_FAILURE_RULES, error);

/** The `error` string of an event payload, or null when the payload is not JSON or has none. */
export function eventErrorText(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}
