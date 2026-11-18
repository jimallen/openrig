// Slice-11 slack-connector — secret resolution (item 7 + 10).
//
// Secrets (Slack bot token / app-level token / incoming-webhook URL) resolve
// from EITHER an OPENRIG_SLACK_* environment variable OR a 0600 env file, at
// call time — NEVER stored in the connector config file, NEVER in the repo,
// NEVER logged. Mirrors the daemon's bearer_file/activity-hook-token posture.
// The env file lives on the TRUSTED host (item 10 secret-host axis); it may be
// a different host from the queue/alert host.
//
// workspaces-o9o.151: the env file is read through the CredentialFileReader port under the secret rule (a plain file of ours, no
// group/other bits, no link, capped). A refused file is never read: its secrets stay unresolved, which leaves the Slack wire inert
// (the daemon still starts), and checkEnvFilePermissions names the refusal and the fix for `rig slack status` and `rig doctor`.
import { SLACK_SECRETS_POLICY, type CredentialFileReader } from "../../credential-file.js";

/** Parse KEY=VALUE lines (quotes trimmed). Blank lines / #comments ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const value = t.slice(i + 1).trim();
    const quote = value[0];
    out[t.slice(0, i).trim()] = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)
      ? value.slice(1, -1)
      : value;
  }
  return out;
}

export interface SecretLookupOpts {
  envFile?: string; // path to the 0600 env file (optional)
  env?: NodeJS.ProcessEnv; // process env (default process.env)
  /** How the env file is read (required: the composition root passes the production reader). */
  credentialFiles: CredentialFileReader;
}

/** Why the env file is refused (a link, not ours, others can access it, too large), naming the file and the fix; null when it is
 *  fit to read or absent (absent is a separate "unconfigured" concern). */
export function checkEnvFilePermissions(envFile: string, credentialFiles: CredentialFileReader): string | null {
  const read = credentialFiles.read(envFile, SLACK_SECRETS_POLICY);
  if (read.ok || read.problem === "missing") return null;
  return read.message;
}

/**
 * Resolve a secret by logical name. Precedence: explicit env var (OPENRIG_SLACK_<NAME>
 * or the raw name) → env-file key. Returns null when unresolved (honest: callers
 * report "unconfigured", they do NOT fabricate). Never logs the value.
 */
export function resolveSecret(name: string, opts: SecretLookupOpts): string | null {
  const env = opts.env ?? process.env;
  // Aliases: the raw name (e.g. SLACK_WEBHOOK_URL) and the OPENRIG_-prefixed
  // form (OPENRIG_SLACK_WEBHOOK_URL). NOT OPENRIG_SLACK_<name> — that would
  // double the SLACK_ segment (the B4 defect).
  const envKeys = [name, `OPENRIG_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  for (const k of envKeys) {
    if (env[k]) return env[k]!;
  }
  if (opts.envFile) {
    const read = opts.credentialFiles.read(opts.envFile, SLACK_SECRETS_POLICY);
    if (read.ok) {
      const map = parseEnvFile(read.content);
      if (map[name]) return map[name];
    } // absent, unreadable or refused → null
  }
  return null;
}
