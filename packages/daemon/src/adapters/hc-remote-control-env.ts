// A leaf: it imports nothing, because hc-seat.ts needs it and hc-seat.ts is on the small surface the CLI loads (hc-surface.ts).

/** What a launch knows about a seat that its env does not say. The tmux host ignores these: seats there get the daemon's env. */
export interface SeatLaunchHints {
  /** The seat declared `remote_control: true`, so the host keeps the names that switch it off away from the seat. */
  remoteControl?: boolean;
}

// ── Claude Code: Remote Control must survive a new launch path ───────────────────────────────────────────────────
// `--remote-control=<seat name>` is argv built by claude-remote-control.ts, so it does not depend on tmux. What can
// switch Remote Control off is the environment (code.claude.com remote-control, "Requirements"). Under hc a seat's
// env is the core's env plus `terminal.run.env`, and the API cannot unset a core variable, so these names must be
// removed by the launch wrapper (HcHost's `env -u`) when the seat declares Remote Control and its own env lacks them.

/** Unavailable whenever set (non-empty; DISABLE_GROWTHBOOK documents `1` or `true`). */
export const REMOTE_CONTROL_BLOCKING_ENV = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK"] as const;
/** Unavailable only when the organization requires Trusted Devices, which the daemon cannot see. */
export const REMOTE_CONTROL_CONDITIONAL_ENV = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;
/** Unavailable when it points at a host other than api.anthropic.com. */
export const REMOTE_CONTROL_ENDPOINT_ENV = "ANTHROPIC_BASE_URL";

/** Every name the launch wrapper should clear for a Remote Control seat that does not set it itself. */
export const REMOTE_CONTROL_ENV_NAMES: readonly string[] = [
  ...REMOTE_CONTROL_BLOCKING_ENV, ...REMOTE_CONTROL_CONDITIONAL_ENV, REMOTE_CONTROL_ENDPOINT_ENV,
];

export interface RemoteControlEnvFindings {
  /** Names in `env` that make Remote Control unavailable. */
  blocking: string[];
  /** Names in `env` that make it unavailable only under a Trusted Devices policy. */
  conditional: string[];
}

/** What in a seat's own env turns Remote Control off. Values are never returned, only names. */
export function remoteControlEnvFindings(env: Readonly<Record<string, string | undefined>>): RemoteControlEnvFindings {
  const set = (name: string) => (env[name] ?? "") !== "";
  const blocking: string[] = REMOTE_CONTROL_BLOCKING_ENV.filter(set);
  const endpoint = env[REMOTE_CONTROL_ENDPOINT_ENV];
  if (endpoint && !isAnthropicApiEndpoint(endpoint)) blocking.push(REMOTE_CONTROL_ENDPOINT_ENV);
  return { blocking, conditional: REMOTE_CONTROL_CONDITIONAL_ENV.filter(set) };
}

/** One launch warning per kind of finding in a seat's own env. Names only, as the findings are. */
export function remoteControlEnvWarnings(env: Readonly<Record<string, string | undefined>>): string[] {
  const { blocking, conditional } = remoteControlEnvFindings(env);
  return [
    ...(blocking.length > 0 ? [`This seat declares remote_control but sets ${blocking.join(", ")} itself, which makes Claude Remote Control unavailable.`] : []),
    ...(conditional.length > 0 ? [`This seat declares remote_control but sets ${conditional.join(", ")} itself, which makes Claude Remote Control unavailable under a Trusted Devices policy.`] : []),
  ];
}

/** The names `REMOTE_CONTROL_CONDITIONAL_ENV` holds that a seat would have inherited and the launch wrapper removes: set (non-empty)
 *  in the inherited env, and not stated by the seat itself (a name the seat states is kept, and `remoteControlEnvWarnings` speaks). */
export function remoteControlClearedConditional(inherited: Readonly<Record<string, string | undefined>>, seat: Readonly<Record<string, string>>): string[] {
  return REMOTE_CONTROL_CONDITIONAL_ENV.filter((name) => (inherited[name] ?? "") !== "" && !(name in seat));
}

/** One launch warning naming what the wrapper cleared. Jim, 2026-11-01: clearing stays, but a person who set one of these is told by
 *  name that the seat no longer has it. Names only, never a value. */
export function remoteControlClearedWarnings(inherited: Readonly<Record<string, string | undefined>>, seat: Readonly<Record<string, string>>): string[] {
  const cleared = remoteControlClearedConditional(inherited, seat);
  return cleared.length === 0 ? [] : [
    `This seat declares remote_control, so ${cleared.join(", ")} (set in the environment it would have inherited) ${cleared.length === 1 ? "was" : "were"} removed from it: ${cleared.length === 1 ? "it makes" : "they make"} Claude Remote Control unavailable under a Trusted Devices policy. State ${cleared.length === 1 ? "it" : "them"} in the seat's own env to keep ${cleared.length === 1 ? "it" : "them"}.`,
  ];
}

function isAnthropicApiEndpoint(value: string): boolean {
  try { return new URL(value).hostname === "api.anthropic.com"; } catch { return false; }
}
