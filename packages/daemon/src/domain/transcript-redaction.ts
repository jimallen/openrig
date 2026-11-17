// transcript-redaction.ts — daemon-side twin of the transcript redaction policy.
//
// Twin of packages/cli/src/restore-packet/redaction.ts SECRET_PATTERNS
// (M1 contract § 4). Patterns duplicated rather than imported because
// @openrig/cli is not a daemon dependency (and adding it would invert the
// package graph). The two arrays must stay identical, pattern for pattern:
// test/transcript-redaction.test.ts imports both and fails on any drift.
//
// One list of credential SHAPES, whatever text carries them (workspaces-o9o.28).
// It deliberately leaves out shapes that eat ordinary text: a generic 32-hex run
// (md5 sums, ids) and `sk-` keys under 16 characters. Every pattern carries the
// `g` flag and nothing else, so a caller may rebuild it from `source` alone.

/** The secret-named assignment names (see the assignment patterns in the list). One string, so the three rules agree. */
const SECRET_NAME = String.raw`(?:(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY)|[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:password|passwd|secret|token|api_?key|access_?key|private_?key)|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:Password|Passwd|Secret|Token|ApiKey|AccessKey|PrivateKey)|password|passwd)`;

/** The transcript secret-pattern list. Identical to packages/cli/src/restore-packet/redaction.ts SECRET_PATTERNS. */
export const TRANSCRIPT_SECRET_PATTERNS: readonly RegExp[] = [
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
  // and SORT_KEY / primary_key are not secret names, so none of those match. The value must be 8+
  // characters and not a reference ($VAR, ${VAR}, <placeholder>, %VAR%).
  // A quoted value is redacted whole, up to its closing quote, spaces and all (workspaces-o9o.28 review): a phrase
  // password otherwise leaked whole when its first word was under the floor, or kept every word after the first.
  // These two run before the unquoted rule below.
  new RegExp(String.raw`(?<=(?<![A-Za-z0-9_])${SECRET_NAME}["']?\s*[=:]\s*")(?![$<{%])[^"\n]{8,}(?=")`, "g"),
  new RegExp(String.raw`(?<=(?<![A-Za-z0-9_])${SECRET_NAME}["']?\s*[=:]\s*')(?![$<{%])[^'\n]{8,}(?=')`, "g"),
  new RegExp(String.raw`(?<=(?<![A-Za-z0-9_])${SECRET_NAME}["']?\s*[=:]\s*["']?)(?![$<{%])[^\s"',;}]{8,}`, "g"),
  // v0: any unbroken base64-shaped run of 40+ (last: the generic catch-all), EXCEPT a pure-hex run of
  // exactly 40 or 64 characters (a git sha, a sha256), which stays visible. Jim, 2026-11-16 (o9o.49):
  // "Keep shas, exempt hex 40/64". A 41-hex run, or any 40+ run with a non-hex character, is still redacted.
  // Only a STANDALONE hash is exempt (workspaces-o9o.28 review): a hex run joined to a prefix or a suffix by - or _
  // (token-<40hex>, key_<64hex>, <40hex>-prod) is a token's tail, and a run may start right after an _.
  /(?:\b|(?<=_))(?!(?<![-_])(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})(?![A-Za-z0-9+/=_-]))[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * Apply the transcript redaction policy to transcript content. Returns
 * the input with each match of the secret patterns replaced by the
 * literal string `[REDACTED]`. Pure function; no side effects.
 *
 * Used by GET /api/transcripts/:session/full to redact the wire payload
 * BEFORE serialization, so credential patterns never reach the response
 * body even when a transcript file contains them.
 */
export function redactTranscriptContent(text: string): string {
  let out = text;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
