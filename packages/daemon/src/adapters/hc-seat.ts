import { createHash } from "node:crypto";
import { PARENT_SESSION_ENV_KEYS, removeParentSessionEnv } from "../domain/parent-session-env.js";
import { REMOTE_CONTROL_ENV_NAMES, remoteControlEnvWarnings } from "./hc-remote-control-env.js";
import type { SeatLaunchHints } from "./tmux.js";

/** Label holding a seat's canonical name; hc's own name cannot hold it (`verify-qa@eztrack` is refused). */
export const SEAT_LABEL = "openrig.seat";

/** hc names are 1 to 32 of a-z 0-9 - _ . A digest keeps `name_taken`'s atomic refusal for any seat name. */
export function hcTerminalName(seat: string): string {
  return `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Set by a host the daemon may sit inside; hc sets its own for the seat. */
const HOST_ENV_KEYS = ["TMUX", "TMUX_PANE"];

/** The daemon's own operator credentials, read from its env (census at add4c5e: index.ts and startup.ts read the two
 *  bearer tokens; the Slack gateway reads the two bot tokens through resolveSecret). A seat has no use for them: the
 *  operator bearer is the write gate, the terminal bearer opens the terminal WebSocket. Never inherited from the daemon
 *  and always unset in the launch wrapper, so a core started with them does not pass them on either. A seat that must
 *  hold one states it in its own env. Provider keys are not here: they keep the allowlisted channel. */
export const OPERATOR_SECRET_ENV_NAMES: readonly string[] = [
  "OPENRIG_AUTH_BEARER_TOKEN", "OPENRIG_TERMINAL_BEARER_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
];

export interface SeatEnvironment {
  /** Sent in `terminal.run.env`, which merges over the core's env: values cross the socket, never an argv. */
  env: Record<string, string>;
  /** Names the launch wrapper removes: the API cannot unset a core variable, and the core's env is not the daemon's. */
  unset: string[];
  /** Launch warnings, names only: what the seat's own env keeps that turns Remote Control off. Empty for a plain seat. */
  warnings: string[];
}

/** A seat's env, stated rather than inherited: the core's env is whatever started it (the app, a first CLI call), while
 *  the daemon's is what seats get today, since the daemon starts the tmux server. Throws naming the key, never a value.
 *  A Remote Control seat loses the names that switch Remote Control off, stated and core alike, unless it set them itself. */
export function seatEnvironment(seat: Readonly<Record<string, string>> = {}, daemon: NodeJS.ProcessEnv = process.env, hints: SeatLaunchHints = {}): SeatEnvironment {
  const remoteControlNames = hints.remoteControl === true ? REMOTE_CONTROL_ENV_NAMES : [];
  const inherited: Record<string, string | undefined> = { ...daemon };
  removeParentSessionEnv(inherited);
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("HC_") || HOST_ENV_KEYS.includes(key) || OPERATOR_SECRET_ENV_NAMES.includes(key) || remoteControlNames.includes(key)) delete inherited[key];
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined) env[key] = value;
  // An empty value keeps a stale policy from pinning over config.json, as on tmux. Explicit seat settings win.
  Object.assign(env, { OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "" }, seat);
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new Error(`invalid environment name ${JSON.stringify(key)}`);  // hc accepts "A=B" and ""
    if (value.includes("\0")) throw new Error(`environment value of ${key} holds a NUL`);
  }
  const candidates = [...PARENT_SESSION_ENV_KEYS, "CLAUDE_EFFORT", ...HOST_ENV_KEYS, ...OPERATOR_SECRET_ENV_NAMES, ...remoteControlNames];
  return { env, unset: candidates.filter((key) => !(key in env)), warnings: hints.remoteControl === true ? remoteControlEnvWarnings(env) : [] };
}
