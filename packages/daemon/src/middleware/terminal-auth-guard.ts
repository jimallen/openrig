import type { MiddlewareHandler } from "hono";
import { authBearerTokenMiddleware } from "./auth-bearer-token.js";

/** Requires the daemon's terminal bearer token on a route when one is configured (the context's `terminalBearerToken`);
 *  with none configured the route is open, as on a loopback bind. Shared by every route that acts on a seat or the app. */
export function terminalAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    const token = (c.get("terminalBearerToken" as never) as string | null | undefined) ?? null;
    const mw = authBearerTokenMiddleware({ expectedToken: token });
    return mw(c, next);
  };
}
