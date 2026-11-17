// redaction.ts — applies the transcript redaction policy.
//
// Per M1 contract § 4, extended by workspaces-o9o.28: the named policies:
// - `velocity-v1`: mirrors the Velocity generator's token patterns at
//   field-notes/2026-04-27-velocity-claude-from-codex-restore/tools/
//   codex-jsonl-to-restore-packet.mjs:34-48 (sk-*, gh[pousr]_*,
//   github_pat_*, Bearer *, base64 ≥40 chars).
// - `openrig-v0`: the productized v0 policy, identical patterns to
//   `velocity-v1` but with the canonical name. Packets written before
//   workspaces-o9o.51 carry it, and the validator still accepts it.
// - `openrig-v1`: the v0 patterns plus vendor token shapes (Slack, GitLab,
//   npm, JWT, AWS, Google), URL passwords and secret-named assignments
//   (workspaces-o9o.28/.48). SECRET_PATTERNS below IS this list. The writer
//   emits it since workspaces-o9o.51, which ships only after a release whose
//   validator accepts it (release 5) is live on every host, so no reader
//   in use rejects a new packet.
//
// Redaction is applied to:
// - transcript content in transcript-latest.md and transcript.md.
// - body content in restore-instructions.md if it quotes transcript
//   material.
// - top_paths / touched-files entries are NOT redacted (paths are not
//   credential material).
//
// The validator does NOT scan content for residual credential patterns
// (per § 4 + § 8: enforcement is generator-side at write time).

/** Secret names in UPPER_SNAKE: an env-var assignment (DB_PASSWORD=, MY_API_KEY=, SESSION_TOKEN=). */
const UPPER_SECRET_NAME = String.raw`(?:(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY))`;
/** The other secret names: a lower snake/kebab compound (client_secret, db-password), camelCase (accessToken), or bare password. */
const OTHER_SECRET_NAME = String.raw`(?:[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:password|passwd|secret|token|api_?key|access_?key|private_?key)|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:Password|Passwd|Secret|Token|ApiKey|AccessKey|PrivateKey)|password|passwd)`;

/** The value of a `name` assignment, `minLength` characters or more and not a reference ($VAR, ${VAR}, <placeholder>,
 *  %VAR%), as three rules in order: a "double-quoted" and a 'single-quoted' value whole, up to the closing quote, spaces
 *  and all; then an unquoted value up to whitespace or punctuation. The name and the quotes are kept. */
function assignmentRules(name: string, minLength: number): RegExp[] {
  const at = String.raw`(?<=(?<![A-Za-z0-9_])${name}["']?\s*[=:]\s*`;
  return [
    new RegExp(String.raw`${at}")(?![$<{%])[^"\n]{${minLength},}(?=")`, "g"),
    new RegExp(String.raw`${at}')(?![$<{%])[^'\n]{${minLength},}(?=')`, "g"),
    new RegExp(String.raw`${at}["']?)(?![$<{%])[^\s"',;}]{${minLength},}`, "g"),
  ];
}

/**
 * The transcript secret-pattern list: credential SHAPES, whatever text carries
 * them (workspaces-o9o.28). Identical, pattern for pattern, to the daemon twin
 * packages/daemon/src/domain/transcript-redaction.ts TRANSCRIPT_SECRET_PATTERNS;
 * packages/daemon/test/transcript-redaction.test.ts fails on any drift. The
 * first four and the last are the v0 / Velocity patterns (`:34-48`); the
 * pattern comments are in the daemon twin. Every pattern carries the `g` flag
 * and nothing else, because hasSecretPattern rebuilds each from `source`.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // v0 (Velocity prior art).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // The auth scheme name is case-insensitive (RFC 9110 11.1): bearer, BEARER and bEaReR are the same credential
  // (workspaces-o9o.28 review). Spelled with letter classes, since every pattern carries the g flag and nothing else.
  /\b[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  // Vendor token shapes.
  /\bxox[abeposr]-[A-Za-z0-9-]{10,}/g, // Slack bot/user/app/refresh/config tokens
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level token
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access token
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm access token
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT (header.payload.signature)
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  // The password in scheme://user:password@host; the user and host are kept.
  /(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
  // The value of a secret-named assignment (NAME=value, name: value, "name": "value"); the name is kept.
  // Names: an UPPER_SNAKE name ending in a secret word; a lower snake/kebab compound ending in one
  // (client_secret, db-password); a camelCase one (accessToken, apiKey); or bare password/passwd.
  // Bare "key", "token" or "secret" in lower case is prose or code ("the key: ...", "{ key: value }"),
  // and SORT_KEY / primary_key are not secret names, so none of those match. The value must not be a reference
  // ($VAR, ${VAR}, <placeholder>, %VAR%); its length floor depends on the name's casing (below).
  // A quoted value is redacted whole, up to its closing quote, spaces and all (workspaces-o9o.28 review): a phrase
  // password otherwise leaked whole when its first word was under the floor, or kept every word after the first.
  // These two run before the unquoted rule below.
  // An UPPER_SNAKE name redacts any value, however short: that is where real secrets sit (workspaces-o9o.48, CoS
  // decision A, 2026-11-17). The other names keep an 8-character floor, so prose and code ("password: none") stay.
  ...assignmentRules(UPPER_SECRET_NAME, 1),
  ...assignmentRules(OTHER_SECRET_NAME, 8),
  // v0: any unbroken base64-shaped run of 40+ (last: the generic catch-all), EXCEPT a pure-hex run of
  // exactly 40 or 64 characters (a git sha, a sha256), which stays visible. Jim, 2026-11-16 (o9o.49):
  // "Keep shas, exempt hex 40/64". A 41-hex run, or any 40+ run with a non-hex character, is still redacted.
  // Only a STANDALONE hash is exempt (workspaces-o9o.28 review): a hex run joined to a prefix or a suffix by - or _
  // (token-<40hex>, key_<64hex>, <40hex>-prod) is a token's tail, and a run may start right after an _.
  /(?:\b|(?<=_))(?!(?<![-_])(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})(?![A-Za-z0-9+/=_-]))[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * Apply the transcript redaction policy (SECRET_PATTERNS) to a string. Returns the input
 * with each match of the secret patterns replaced by the literal
 * string `[REDACTED]`. Pure function; no side effects.
 *
 * The redaction is non-destructive at the structural level — only the
 * matched substrings are replaced. Surrounding characters are kept.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Returns true if at least one secret pattern matches the input.
 * Used by the omitted-records counter to track how many records had
 * their content redacted (for the `redacted_secrets` omitted-class
 * count in summary).
 *
 * Note: a SINGLE record may match multiple patterns; this returns true
 * after the first match for efficiency.
 */
export function hasSecretPattern(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // Non-global test: cannot reuse the global `g` regex without resetting
    // lastIndex, so build a fresh non-global RegExp from source.
    const probe = new RegExp(pattern.source);
    if (probe.test(text)) return true;
  }
  return false;
}
