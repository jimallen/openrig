// OF-102: read and record a rig's spec source (rigs.spec_source_path). Mounted at /api/rigs/:rigId/spec-source.
//
// What is recorded here decides which startup files, culture and `local:` personas a later plain `--fresh` launch or
// `--fresh` restore delivers into a live seat, so a seat must not be able to point its rig at a spec it wrote itself.
// Two gates on the write (reading is open):
//  1. The spec file must be one a seat could not have written: it must lie, by its REAL location, under a trusted
//     spec root and pass the ownership and placement rules `rig seat set-mcp --spec` applies (Jim, 2026-10-26,
//     "Trusted folders instead"). The roots are the MCP ones (released copies, spec library) plus this route's own,
//     <OPENRIG_HOME>/shared-docs/rigs, taken from the daemon's home and never from the caller. No other caller's
//     roots change. Whoever asks, a spec outside the roots is refused.
//  2. When the daemon was started with an operator bearer (OPENRIG_AUTH_BEARER_TOKEN) the call must carry it, as the
//     rig-mode writes do. With none configured the trusted-root rule alone gates the write.
import nodePath from "node:path";
import { Hono } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { EventBus } from "../domain/event-bus.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { RigSpecSourceService, type SpecSourceRefusalCode } from "../domain/rig-spec-source-service.js";
import type { SeatLifecycleDeps } from "../domain/seat-lifecycle-service.js";
import { getOpenRigHome } from "../openrig-compat.js";
import { transportSenderSession } from "./require-sender-identity.js";

export interface RigSpecSourceRoutesOpts {
  /** The operator bearer token the daemon was started with; null/absent when none is configured. */
  bearerToken?: string | null;
  /** This route's own trusted root. Default: <OPENRIG_HOME>/shared-docs/rigs of this daemon. */
  sharedDocsRigsRoot?: string;
}

function statusOf(code: SpecSourceRefusalCode): 400 | 404 | 409 {
  if (code === "rig_not_found") return 404;
  if (code === "missing_operator" || code === "missing_path" || code === "path_not_absolute") return 400;
  return 409;
}

export function rigSpecSourceRoutes(opts?: RigSpecSourceRoutesOpts): Hono {
  const router = new Hono();
  const requireOperator = authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null });
  const sharedDocsRigsRoot = () => opts?.sharedDocsRigsRoot ?? nodePath.join(getOpenRigHome(), "shared-docs", "rigs");

  const service = (c: { get: (key: string) => unknown }) => {
    // The MCP trust roots (released copies, spec library) and their judging io, read here, never widened for them.
    const mcpTrust = c.get("mcpTrust" as never) as SeatLifecycleDeps["mcpTrust"] | undefined;
    return new RigSpecSourceService({
      rigRepo: c.get("rigRepo" as never) as RigRepository,
      eventBus: c.get("eventBus" as never) as EventBus,
      trust: { roots: () => [...(mcpTrust?.specRoots?.() ?? []), sharedDocsRigsRoot()], ...(mcpTrust?.io ? { io: mcpTrust.io } : {}) },
    });
  };

  router.get("/", (c) => {
    const result = service(c).show(c.req.param("rigId")!);
    return c.json(result, result.ok ? 200 : 404);
  });

  router.post("/", requireOperator, async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const transport = transportSenderSession(c);
    const operator = transport ?? (typeof body["operator"] === "string" ? body["operator"].trim() : "");
    const result = service(c).set({
      rigId: c.req.param("rigId")!,
      path: typeof body["path"] === "string" ? body["path"] : "",
      operator,
      operatorIdentity: transport ? "transport:v1" : "claimed:v1",
      authorizedBy: opts?.bearerToken ? "operator_bearer" : "trusted_spec_root",
    });
    return c.json(result, result.ok ? 200 : statusOf(result.code));
  });

  return router;
}
