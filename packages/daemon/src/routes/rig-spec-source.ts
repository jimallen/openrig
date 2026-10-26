// OF-102: read and record a rig's spec source (rigs.spec_source_path). Mounted at /api/rigs/:rigId/spec-source.
//
// Authority: reading is open. WRITING needs the daemon's operator bearer (OPENRIG_AUTH_BEARER_TOKEN, the same one the
// rig-mode and mission-control writes use). What is recorded here decides which startup files, culture and `local:`
// personas a later plain `--fresh` launch or `--fresh` restore delivers into a live seat, so a seat must not be able
// to point its rig at a spec it wrote itself. Unlike rig-mode, a daemon with NO bearer configured refuses the write
// instead of passing it through: pass-through would leave this open to every local caller. A seat's own session
// header proves nothing here (a caller can simply omit it); the token is the boundary.
import { Hono, type MiddlewareHandler } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { EventBus } from "../domain/event-bus.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { RigSpecSourceService, type SpecSourceRefusalCode } from "../domain/rig-spec-source-service.js";
import { transportSenderSession } from "./require-sender-identity.js";

export interface RigSpecSourceRoutesOpts {
  /** The operator bearer token the daemon was started with; null when none is configured (writes are then refused). */
  bearerToken?: string | null;
}

function service(c: { get: (key: string) => unknown }): RigSpecSourceService {
  return new RigSpecSourceService({
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
  });
}

function statusOf(code: SpecSourceRefusalCode): 400 | 404 | 409 {
  if (code === "rig_not_found") return 404;
  if (code === "missing_operator" || code === "missing_path" || code === "path_not_absolute") return 400;
  return 409;
}

export function rigSpecSourceRoutes(opts?: RigSpecSourceRoutesOpts): Hono {
  const router = new Hono();
  const bearer = opts?.bearerToken ?? null;
  const checkToken = authBearerTokenMiddleware({ expectedToken: bearer });
  const requireOperator: MiddlewareHandler = async (c, next) => {
    if (bearer === null) {
      return c.json({
        ok: false, code: "operator_token_not_configured",
        message: "This daemon has no operator bearer token, so it will not record a rig's spec source.",
        what_to_do: "Start the daemon with OPENRIG_AUTH_BEARER_TOKEN set, then run the command with that token (--bearer or the same env var).",
      }, 403);
    }
    return checkToken(c, next);
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
    });
    return c.json(result, result.ok ? 200 : statusOf(result.code));
  });

  return router;
}
