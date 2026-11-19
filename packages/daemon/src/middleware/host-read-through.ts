// OPR.0.4.6.MH2 FR-2 + FR-7: the single-host READ-THROUGH, its HTTP edge. workspaces-o9o.183 moved this middleware out of
// src/domain/hosts/read-through.ts, which keeps the rule (decideReadThrough) and the forward (forwardReadThrough) over plain
// values; this file only reads a hono request into them and writes the answer back. Mounted on /api/* ahead of the route
// table (server.ts), after the browser boundary.
import type { Context, Next } from "hono";
import type { CredentialFileReader } from "../domain/credential-file.js";
import { getSelfHostId } from "../domain/hosts/fanout-contract.js";
import type { RemoteDaemonClient } from "../domain/hosts/remote-daemon-client.js";
import type { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import { decideReadThrough, forwardReadThrough } from "../domain/hosts/read-through.js";

/** The param-intercept middleware (arch E2 ruling): consumes the `?host=` envelope for remote reads and passes everything
 *  else through untouched. `credentialFiles` (workspaces-o9o.151) reads hosts.yaml under the credential rule. `remoteDaemonsFor`
 *  (workspaces-o9o.161) gives the port to the origin daemon for one request (the adapter side decides its transport). */
export function hostReadThrough(credentialFiles: CredentialFileReader, remoteDaemonsFor: (c: Context) => RemoteDaemonClient) {
  return async (c: Context, next: Next) => {
    const decision = decideReadThrough({ method: c.req.method, path: c.req.path, hostParam: c.req.query("host"), selfHostId: getSelfHostId() });
    if (decision.kind === "local") return next();
    if (decision.kind === "refuse") return c.json(decision.body, decision.status);
    // Same injected-loader seam as the write twin: tests swap the registry loader; production reads the registry.
    const registryLoader = c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined;
    const result = await forwardReadThrough(decision.hostId, { path: c.req.path, url: c.req.url }, { credentialFiles, registryLoader, remoteDaemon: remoteDaemonsFor(c) });
    if (result.kind === "failed") return c.json(result.body, result.status);
    return c.body(result.bodyText, result.status as never, { "Content-Type": result.contentType });
  };
}
