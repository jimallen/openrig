// activity-endpoint-file.ts — the files behind the self-provisioned activity-hook endpoint (OPR.0.4.3.28 B2/B3), moved out of
// domain/activity-endpoint.ts and put under the credential rule (workspaces-o9o.151):
//
// - <state>/activity-hook-token : the durable token, STABLE across daemon restarts so already-launched seats (whose env froze the
//   token at launch) still authenticate. Made with O_EXCL|O_NOFOLLOW at 0600. As for the terminal token (o9o.78), a link, a
//   non-file or another user's file stops the start, naming the file and the fix; a file of ours others can read is narrowed.
// - <state>/activity-endpoint.json : the {baseUrl, token} snapshot the relay's file-discovery fallback reads (B3). Its baseUrl
//   decides where a seat sends its token, so it is written to a fresh O_EXCL temp file and renamed into place (a rename replaces
//   a planted link, it never writes through it) and read only as a plain file of ours with no group/other bits.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { ACTIVITY_ENDPOINT_POLICY, ACTIVITY_HOOK_TOKEN_POLICY } from "../domain/credential-file.js";
import { ACTIVITY_ENDPOINT_FILE, ACTIVITY_HOOK_TOKEN_FILE } from "../domain/activity-endpoint.js";
import { narrowOwnSecretFile, readCredentialFile } from "./node-credential-file-reader.js";

const NEW_SECRET_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Write `data` to `path`, which must not exist yet (O_EXCL, no link followed), at 0600. Throws EEXIST when it does. */
function createSecretFile(path: string, data: string): void {
  const fd = fs.openSync(path, NEW_SECRET_FLAGS, 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

/** Replace `path` with a plain 0600 file holding `data`: a fresh temp file beside it, then rename over the name. */
function replaceSecretFile(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  createSecretFile(tmp, data);
  try {
    fs.renameSync(tmp, path);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The durable activity-hook token, made when absent. Throws (the daemon does not start) when the token path is a link, not a plain
 * file, or another user's; the message names the file and the fix. When the token cannot be persisted at all (an unwritable state
 * dir), an in-memory token still works for this run, as before.
 */
export function ensureActivityHookToken(stateDir: string): string {
  const tokenPath = nodePath.join(stateDir, ACTIVITY_HOOK_TOKEN_FILE);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const token = newToken();
    createSecretFile(tokenPath, token);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return newToken(); // could not persist: best effort, as before
  }
  const refused = narrowOwnSecretFile(tokenPath, ACTIVITY_HOOK_TOKEN_POLICY);
  if (refused) throw new Error(refused.message);
  const read = readCredentialFile(tokenPath, ACTIVITY_HOOK_TOKEN_POLICY);
  if (!read.ok) throw new Error(read.message);
  const existing = read.content.trim();
  if (existing.length > 0) return existing;
  // An empty file of ours: regenerate, as before, by replacing it (never writing through the name).
  const token = newToken();
  try { replaceSecretFile(tokenPath, token); } catch { /* best effort: the in-memory token works for this run */ }
  return token;
}

/** Snapshot {baseUrl, token} to activity-endpoint.json for the relay's file-discovery fallback (B3). Best-effort. */
export function writeActivityEndpointFile(stateDir: string, endpoint: { baseUrl: string; token: string }): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    replaceSecretFile(nodePath.join(stateDir, ACTIVITY_ENDPOINT_FILE), JSON.stringify({ baseUrl: endpoint.baseUrl, token: endpoint.token }));
  } catch {
    // best-effort — reconcile/restored seats simply won't get file-discovery.
  }
}

/** The {baseUrl, token} snapshot, or null when absent, malformed, or refused by the rule. */
export function readActivityEndpointFile(stateDir: string): { baseUrl: string; token: string } | null {
  return parseActivityEndpoint(readCredentialFile(nodePath.join(stateDir, ACTIVITY_ENDPOINT_FILE), ACTIVITY_ENDPOINT_POLICY));
}

/**
 * The fallback the Pi and stub runners use: <home>/activity-endpoint.json under the rule, as {baseUrl?, token?} (either may be
 * absent). A refused or malformed file gives nothing, so only the environment is used.
 */
export function readActivityEndpointFallback(home: string): { baseUrl?: string; token?: string } {
  const read = readCredentialFile(nodePath.join(home, ACTIVITY_ENDPOINT_FILE), ACTIVITY_ENDPOINT_POLICY);
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.content) as { baseUrl?: unknown; token?: unknown };
    return {
      ...(typeof parsed.baseUrl === "string" ? { baseUrl: parsed.baseUrl } : {}),
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    };
  } catch {
    return {};
  }
}

function parseActivityEndpoint(read: ReturnType<typeof readCredentialFile>): { baseUrl: string; token: string } | null {
  if (!read.ok) return null;
  try {
    const parsed = JSON.parse(read.content) as { baseUrl?: unknown; token?: unknown };
    if (typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0 && typeof parsed.token === "string" && parsed.token.length > 0) {
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    }
  } catch {
    // malformed
  }
  return null;
}
