// OPR.0.4.6.MH2 FR-2 + FR-7 — the general single-host READ-THROUGH.
//
// The read twin of the shipped forward-then-strip write pattern
// (routes/mission-control.ts remote-forward leg): the browser stays
// same-origin against the LOCAL daemon; a `?host=<id>` query param is the
// out-of-band host envelope (MH-1 BR-1 rail — host never rides in a path or
// session identity). The daemon edge consumes the envelope: resolve the
// registry, forward the SAME path (envelope stripped) to the origin daemon
// over the shared bearer transport, and return the origin's response
// VERBATIM — status + content-type + body untouched (arch P3). Origin
// shapes stay the law: no AggregatedPayload wrapping on single-host reads.
//
// READ-ONLY IS ENFORCED HERE, AT THE EDGE (FR-7, arch R2): a non-GET
// request carrying a remote host envelope, or a GET outside the named
// allowlist below, is REFUSED with a structured error naming the MH-3
// boundary and is NEVER forwarded. The UI hiding mutation affordances is
// necessary but not the enforcement.
//
// local / absent host param short-circuits to the existing handler before
// any of this logic runs — the local path is unchanged by construction
// (FR-2 zero-regression negative).
//
// workspaces-o9o.183: this module is the read-through's DOMAIN half and knows no HTTP framework: the edge rule (which requests
// cross, which are refused and how) and the forward use case, over plain values. The middleware that reads a request into these
// values and writes the answer back is src/middleware/host-read-through.ts (the driving side, beside browser-boundary.ts).

import type { CredentialFileReader } from "../credential-file.js";
import { resolvesToLocalHost } from "./fanout-contract.js";
import { loadHostRegistry, resolveHost } from "./hosts-registry-reader.js";
import type { RemoteDaemonClient } from "./remote-daemon-client.js";

// The 5s single-host READ deadline class (matches the shipped aggregate
// read class in attention-aggregator.ts; deadline is a REQUIRED arg on the
// transport by arch ruling — named here, passed explicitly at the call).
export const READ_THROUGH_TIMEOUT_MS = 5_000;

// THE NAMED CLOSED ALLOWLIST (arch P1). One exported constant; additions
// are deliberate cross-review extensions, never drive-by edits — flag arch.
// Grammar: `:seg` matches exactly one non-empty path segment; a trailing
// `/*` matches one-or-more tail segments. v1 = the MVP read screens
// (topology / project / library / dashboard-ps) exactly.
//
// DELIBERATE EXCLUSIONS (recorded, not oversights): /api/queue/* (queue is
// the MH-3 lane — MH-1's queue-negative boundary, read included for now);
// /api/files/* (local FS discovery; the twin derives remote missions from
// the host-keyed slice list instead); /api/slices/:name/proof-asset/*
// (binary — the raw transport is text-only by design);
// /api/specs/library/active-lens (a local operator preference with write
// verbs — its literal segment cannot match `:id/review`'s shape).
// NUANCE (pinned by test): the slices REFRESH write is excluded by the
// METHOD tooth, not by path shape — `:name` matches the literal "refresh",
// so a GET there forwards and the origin resolves it as a slice named
// "refresh" (its own 404, verbatim); the POST can never cross the edge.
export const READ_THROUGH_ALLOWLIST = [
  "/api/rigs/summary",
  "/api/rigs/:rigId/graph",
  "/api/rigs/:rigId/nodes",
  // OPR.0.4.6.MH2 rev1-r2 B2 + arch ruling (qitem-…c5402960): seat detail
  // is the LEAF of the FR-2 hierarchy — same read class as its /nodes
  // sibling. STRICT SEGMENT-SHAPE match only (the arch tooth): the deeper
  // ACTION routes under this prefix (…/:logicalId/<action>)
  // must stay REFUSED — pinned by named negatives.
  "/api/rigs/:rigId/nodes/:logicalId",
  "/api/ps",
  "/api/slices",
  "/api/slices/:name",
  "/api/slices/:name/doc/*",
  "/api/missions/:missionId",
  "/api/specs/library",
  "/api/specs/library/:id/review",
] as const;

export function isReadThroughPath(path: string): boolean {
  const parts = path.split("/").filter((s) => s !== "");
  return READ_THROUGH_ALLOWLIST.some((pattern) => {
    const pat = pattern.split("/").filter((s) => s !== "");
    const tailWild = pat[pat.length - 1] === "*";
    const fixed = tailWild ? pat.slice(0, -1) : pat;
    if (tailWild ? parts.length <= fixed.length : parts.length !== fixed.length) return false;
    return fixed.every((seg, i) => (seg.startsWith(":") ? parts[i] !== "" : seg === parts[i]));
  });
}

const MH3_BOUNDARY_MESSAGE =
  "acting on a remote host is the MH-3 routing lane; the MH-2 read-through forwards allowlisted GET reads only";

/** A request at the edge, as the read-through rule sees it. */
export interface ReadThroughRequest {
  method: string;
  /** The path, without the query. */
  path: string;
  /** The full request URL (the forward keeps every query param but `host`). */
  url: string;
  /** The `?host=` envelope, undefined when absent. */
  hostParam: string | undefined;
  /** This daemon's own self-host id (51-09 incr 2), null before it is published. */
  selfHostId: string | null;
}

/** What the edge does with a request: serve it here, refuse it (never forwarded), or forward it to `hostId`. */
export type ReadThroughDecision =
  | { kind: "local" }
  | { kind: "refuse"; status: 403 | 405; body: Record<string, unknown> }
  | { kind: "forward"; hostId: string };

/** The FR-7 edge rule, in order: local or absent host -> local; a non-GET -> 405; a GET outside the allowlist -> 403; else forward. */
export function decideReadThrough(req: Pick<ReadThroughRequest, "method" | "path" | "hostParam" | "selfHostId">): ReadThroughDecision {
  // local / absent host param short-circuits to the existing handler. 51-09
  // incr 2: the daemon's OWN self-host id resolves home too (a distinct
  // spelling from the 'local' sentinel, not an overload) — so a read
  // addressed to this host's own id is served locally, never dialed out.
  if (req.hostParam === undefined || resolvesToLocalHost(req.hostParam, req.selfHostId)) return { kind: "local" };
  const hostId = req.hostParam;
  const path = req.path;
  if (req.method !== "GET") {
    // FR-7 tooth 1: a mutating request never crosses the edge.
    return { kind: "refuse", status: 405, body: { error: "cross_host_write_refused", boundary: "MH-3", hostId, method: req.method, path, message: MH3_BOUNDARY_MESSAGE } };
  }
  if (!isReadThroughPath(path)) {
    // FR-7 tooth 2: reads outside the named closed set never cross either.
    return { kind: "refuse", status: 403, body: { error: "read_through_path_not_allowed", boundary: "MH-3", hostId, path, message: MH3_BOUNDARY_MESSAGE } };
  }
  return { kind: "forward", hostId };
}

/** The forward's outcome: the origin's answer verbatim (arch P3), or the edge's own 502 failure. */
export type ReadThroughResult =
  | { kind: "answer"; status: number; contentType: string; bodyText: string }
  | { kind: "failed"; status: 502; body: Record<string, unknown> };

export interface ReadThroughForwardDeps {
  /** Reads hosts.yaml under the credential rule (workspaces-o9o.151). */
  credentialFiles: CredentialFileReader;
  /** The registry loader (tests swap it; production reads the registry). */
  registryLoader?: () => ReturnType<typeof loadHostRegistry>;
  /** The port to the origin daemon (workspaces-o9o.161); the adapter side decides its transport. */
  remoteDaemon: RemoteDaemonClient;
}

/** Forward one allowlisted GET to `hostId`: registry-validated before any dial, envelope stripped, origin answer verbatim. */
export async function forwardReadThrough(hostId: string, req: Pick<ReadThroughRequest, "path" | "url">, deps: ReadThroughForwardDeps): Promise<ReadThroughResult> {
  const fail = (detail: string, failureClass: string, remoteStatus?: number): ReadThroughResult =>
    ({ kind: "failed", status: 502, body: { error: "remote_read_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail } });

  // Arch P2 leg 1: registry-validated BEFORE any dial — an unknown id is a
  // structured error, never a blind network attempt.
  const reg = (deps.registryLoader ?? (() => loadHostRegistry(deps.credentialFiles)))();
  if (!reg.ok) return fail(reg.error, "registry");
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return fail(resolved.error, "unknown-host");
  if (resolved.host.transport !== "http") {
    return fail(`host '${hostId}' is SSH-declared; the read-through requires an http-transport registry entry (url; bearer optional)`, "unsupported-transport");
  }

  // Arch P2 leg 2: STRIP IS TOTAL — the forwarded request carries no host
  // param in any form, so the origin never sees the envelope and a
  // forwarded request structurally cannot re-forward. Every OTHER query
  // param rides through untouched (e.g. the slices filter).
  const url = new URL(req.url);
  url.searchParams.delete("host");
  const forwardPath = `${req.path}${url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ""}`;

  const res = await deps.remoteDaemon.requestRaw(resolved.host, forwardPath, { timeoutMs: READ_THROUGH_TIMEOUT_MS });
  if (res.ok) {
    // Arch P3: the origin ANSWERED — its status/content-type/body ARE the
    // answer, passed through untouched (its own 404/500 included). Edge
    // taxonomy errors below are only for the forward itself failing.
    return { kind: "answer", status: res.status, contentType: res.contentType, bodyText: res.bodyText };
  }
  switch (res.kind) {
    case "bearer":
      return fail(res.detail, "auth-failed");
    case "timeout":
      return fail(
        res.phase === "body"
          ? `remote read timed out: response headers arrived (HTTP ${res.status}) but the body never completed`
          : `remote read timed out after ${READ_THROUGH_TIMEOUT_MS}ms`,
        "unreachable",
        res.status,
      );
    case "network":
      return fail(res.detail, "unreachable");
  }
}
