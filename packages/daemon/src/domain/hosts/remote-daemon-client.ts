// workspaces-o9o.161: the domain's port to another OpenRig daemon over HTTP, in the domain's own words. The domain asks a
// RemoteDaemonClient for one bounded JSON exchange or one verbatim read; the HTTP mechanics (fetch, the single deadline over
// request and body, bounded reads, status classification) live in its adapter, src/adapters/remote-daemon-http.ts, wired in
// startup.ts. Which bearer token goes out is a domain rule (resolveBearer), read through the CredentialFileReader port.

import type { HttpHostEntry } from "./hosts-registry-reader.js";
import { BEARER_FILE_POLICY, type CredentialFileReader } from "../credential-file.js";

/** Where a host's bearer token comes from: its env var, or its bearer_file read under the credential rule (workspaces-o9o.151). */
export interface BearerSources {
  credentialFiles: CredentialFileReader;
  env?: Record<string, string | undefined>;
}

/** One JSON exchange with another daemon. */
export interface RemoteJsonRequest {
  method: "GET" | "POST";
  body?: unknown;
  /** REQUIRED — the caller names its deadline class explicitly. */
  timeoutMs: number;
  /** P21: extra request headers (e.g. the re-stamped X-OpenRig-Session + X-OpenRig-Relay on a
   *  cross-host forward). Merged AFTER Content-Type/Authorization so a forwarder's identity re-stamp
   *  is what the remote reads — never the inbound body claim. */
  headers?: Record<string, string>;
  /** Stop reading an answer larger than this many bytes (a failure, never parsed). Absent: no bound (today's default). */
  maxBytes?: number;
  /** Absent: fetch's default (follow). "manual": a 3xx comes back as the http failure it is, never followed, and its
   *  body isn't read. */
  redirect?: "follow" | "manual" | "error";
  /** The bearer resolution to send, made by the caller with `resolveBearer` right before this call, so the caller
   *  knows exactly which token went out. Absent: resolved by the client, as before. */
  resolvedBearer?: ReturnType<typeof resolveBearer>;
}

/** One verbatim GET from another daemon. */
export interface RemoteRawRequest {
  /** REQUIRED — the caller names its deadline class explicitly. */
  timeoutMs: number;
}

export type RemoteJsonFailureKind = "bearer" | "timeout" | "network" | "http";

export interface RemoteJsonFailure {
  ok: false;
  kind: RemoteJsonFailureKind;
  /** Response interruption after request delivery cannot settle the operation outcome. */
  outcome?: "indeterminate";
  /** For kind=timeout: whether the deadline fired before headers
   *  ("request") or while reading the body ("body"). */
  phase?: "request" | "body";
  /** HTTP status when headers arrived (including body timeout or network failure). */
  status?: number;
  /** Bearer message / network error message / remote error text (may be ""). */
  detail: string;
  /** The answer exceeded the caller's `maxBytes` and wasn't read further (kind "network"). */
  tooLarge?: true;
}

export type RemoteJsonResult = { ok: true; status: number; payload: unknown } | RemoteJsonFailure;

// OPR.0.4.6.MH2 FR-2/FR-7 — the read-through's transport leg. Verbatim
// passthrough means STATUS + CONTENT-TYPE + BODY (arch P3): the origin's own
// 404/500 IS the answer, so unlike remoteJsonRequest this variant returns the
// full body TEXT for EVERY origin status and never collapses error bodies to
// a detail string. Failure kinds stay transport-only (bearer/timeout/network)
// — an origin that ANSWERED is always ok:true here. Text-only by design: the
// v1 read allowlist carries JSON endpoints; binary surfaces (proof-asset)
// are deliberately not allowlisted.
export type RemoteRawResult =
  | { ok: true; status: number; contentType: string; bodyText: string }
  | { ok: false; kind: Exclude<RemoteJsonFailureKind, "http">; phase?: "request" | "body"; status?: number; detail: string };

/** The port: another OpenRig daemon, reached over HTTP. Neither method hangs or throws; every outcome is structured. */
export interface RemoteDaemonClient {
  /** One bounded JSON exchange; the single deadline covers request and body. */
  requestJson(host: HttpHostEntry, path: string, request: RemoteJsonRequest): Promise<RemoteJsonResult>;
  /** One bounded GET whose body comes back as text for any origin status (the read-through's verbatim rule). */
  requestRaw(host: HttpHostEntry, path: string, request: RemoteRawRequest): Promise<RemoteRawResult>;
}

/** Mirrors the CLI's resolveRemoteBearer (host-registry.ts): at-most-one of
 *  bearer_env / bearer_file, resolved at call time. Neither configured is an
 *  anonymous (URL-only) host — a tokenless daemon; ok with no token, so no
 *  Authorization header is sent. A configured-but-unresolvable pointer still
 *  fails (fail-closed). */
export function resolveBearer(host: HttpHostEntry, deps: BearerSources): { ok: true; token?: string } | { ok: false; detail: string } {
  const env = deps.env ?? process.env;
  if (host.bearer_env) {
    const token = env[host.bearer_env]?.trim();
    if (token) return { ok: true, token };
    return { ok: false, detail: `bearer env var ${host.bearer_env} is not set or empty for host ${host.id}` };
  }
  if (host.bearer_file) {
    // workspaces-o9o.151: under the credential rule (a plain file of ours, no group/other bits, capped). Missing keeps its old
    // wording; a refusal names the file and the fix, never the content.
    const read = deps.credentialFiles.read(host.bearer_file, BEARER_FILE_POLICY);
    if (!read.ok) {
      return read.problem === "missing"
        ? { ok: false, detail: `bearer file ${host.bearer_file} not readable for host ${host.id}` }
        : { ok: false, detail: `bearer file refused for host ${host.id}: ${read.message}` };
    }
    const token = read.content.trim();
    if (token) return { ok: true, token };
    return { ok: false, detail: `bearer file ${host.bearer_file} is empty for host ${host.id}` };
  }
  return { ok: true };
}
