// OPR.0.4.3.28 B2/B3 — self-provisioned activity-hook endpoint (url + token).
//
// The daemon generates a per-install activity-hook token and derives its own
// ingest URL so launched seats can reach /api/activity/hooks WITHOUT the
// operator seeding OPENRIG_URL / OPENRIG_ACTIVITY_HOOK_TOKEN into their shell
// (the confirmed live break — see the slice-28 IMPL-SPEC §1.1).
//
// The token is a LOCALHOST internal-auth HANDLE, not a founder-secret: kept out
// of logs/prints and stored mode-0600, but no redaction machinery is built
// around it (orch-advisor ruling 2026-07-02).
//
// - activity-hook-token : durable token, STABLE across daemon restarts so
//   already-launched seats (whose env froze the token at launch) still
//   authenticate after a restart.
// - activity-endpoint.json : {baseUrl, token} snapshot, re-written each boot,
//   read by the relay's file-discovery fallback for reconcile/restored seats
//   whose frozen process env carries no OpenRig activity vars (B3).

import { formatDaemonHostForUrl } from "./daemon-url.js";

/** The file names under the daemon state dir; the files themselves are read and written by adapters/activity-endpoint-file.ts
 *  under the credential rule (workspaces-o9o.151). */
export const ACTIVITY_HOOK_TOKEN_FILE = "activity-hook-token";
export const ACTIVITY_ENDPOINT_FILE = "activity-endpoint.json";
const DEFAULT_DAEMON_PORT = "7433";

/** OPR.0.4.3.28 B2 — derive the activity ingest URL the daemon injects into seats
 *  from its OWN bound host+port, so the seat's relay posts to an address the
 *  daemon is actually listening on. When OPENRIG_HOST is an explicit host
 *  (loopback, localhost, a tailnet IP, a hostname) the daemon binds ONLY that
 *  host, so the URL MUST use it — a hardcoded 127.0.0.1 would be unreachable.
 *  Wildcard/bind-all hosts (0.0.0.0 / ::) are not connectable addresses and the
 *  daemon also binds loopback there, so they map to 127.0.0.1. An absent host
 *  (the default loopback+tailscale multi-bind) also uses loopback. */
export function deriveActivityUrl(host: string | undefined, port: string | undefined): string {
  const p = port && port.trim().length > 0 ? port.trim() : DEFAULT_DAEMON_PORT;
  const h = host?.trim();
  const wildcard = !h || h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*";
  const resolvedHost = wildcard ? "127.0.0.1" : formatDaemonHostForUrl(h);
  return `http://${resolvedHost}:${p}`;
}
