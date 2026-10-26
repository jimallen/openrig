import { SEAT_PUBLIC_ENV_KEYS } from "../domain/seat-launch-environment.js";

// Which launch environment may ride a tmux command line (`-e KEY=VAL`), and how
// everything else reaches the seat without ever appearing in a process argv.
//
// A tmux argv is readable by every local user through `ps`, and a server that
// new-session starts keeps the client's argv as its own. Hook tokens and
// provider keys therefore never go there: they are written to a 0600 file that
// the tmux server itself reads (`source-file`), as `set-environment` lines.
//
// The argv-safe set is an explicit allowlist, not a denylist over credential
// names: a key this module has never heard of takes the file channel.

/** Seat metadata and process-location variables that carry no credential. */
export const ARGV_SAFE_LAUNCH_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  ...SEAT_PUBLIC_ENV_KEYS,
  "PATH", "HOME", "USER", "LOGNAME", "CODEX_HOME",
]);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isArgvSafe(key: string, value: string): boolean {
  if (!ARGV_SAFE_LAUNCH_ENV_KEYS.has(key)) return false;
  if (key === "OPENRIG_URL") {
    // A URL with userinfo, query or fragment may carry a credential.
    try {
      const url = new URL(value);
      return !(url.username || url.password || url.search || url.hash);
    } catch { return false; }
  }
  return true;
}

export interface PartitionedLaunchEnv {
  /** May be passed as `-e KEY=VAL`. */
  argv: Record<string, string>;
  /** Must be delivered through the 0600 file channel. */
  file: Record<string, string>;
}

export function partitionLaunchEnv(env: Readonly<Record<string, string>>): PartitionedLaunchEnv {
  const argv: Record<string, string> = {};
  const file: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) (isArgvSafe(key, value) ? argv : file)[key] = value;
  return { argv, file };
}

/** One tmux-config word. Single quotes are literal in tmux's parser (no `$VAR`,
 * `#`, `~` or backslash handling); an apostrophe is spliced in as `"'"`. A
 * newline would end the command and NUL cannot be represented, so both refuse.
 * Errors name the key, never the value. */
function configWord(value: string, what: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error(`${what} cannot be delivered through tmux: it contains a line break or NUL.`);
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The `source-file` script that sets `file` in one session's environment. */
export function renderSecretEnvScript(target: string, file: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(file)) {
    if (!ENV_KEY.test(key)) throw new Error("Launch environment name is not a valid variable name.");
    lines.push(`set-environment -t ${configWord(target, "Session target")} ${key} ${configWord(value, `Launch environment ${key}`)}`);
  }
  return lines.join("\n") + "\n";
}
