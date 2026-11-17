import { Hono } from "hono";
import { RUNTIME_BINARIES, type HostReadinessService } from "../domain/host-readiness.js";
import { terminalAuthGuard } from "../middleware/terminal-auth-guard.js";

/** workspaces-o9o.11: `POST /api/doctor/host` — the host rows of `rig doctor`. Reads and reports; it changes nothing,
 *  except that with `seatShell` it starts (and always removes) one probe terminal, a login shell shaped like a seat's.
 *  Because it runs a login shell, it sits behind terminalAuthGuard like every route that acts on a terminal (verify-qa). */
export function hostReadinessRoutes(): Hono {
  const app = new Hono();
  app.post("/", terminalAuthGuard(), async (c) => {
    const service = c.get("hostReadiness" as never) as HostReadinessService | undefined;
    if (!service) return c.json({ error: "host_readiness_unavailable" }, 503);
    let body: { seatShell?: unknown; runtimes?: unknown } = {};
    try {
      const raw = await c.req.text();
      if (raw.trim() !== "") body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: "invalid_body", message: "The body must be JSON: { seatShell?: boolean, runtimes?: string[] }." }, 400);
    }
    if (body.seatShell !== undefined && typeof body.seatShell !== "boolean") {
      return c.json({ error: "invalid_body", message: "seatShell must be a boolean." }, 400);
    }
    let runtimes: string[] | null = null;
    if (body.runtimes !== undefined) {
      if (!Array.isArray(body.runtimes) || body.runtimes.some((r) => typeof r !== "string")) {
        return c.json({ error: "invalid_body", message: "runtimes must be a list of runtime names." }, 400);
      }
      // A spec's terminal or stub seats launch no program of their own, so only the runtimes that do are checked.
      runtimes = (body.runtimes as string[]).filter((r) => Object.hasOwn(RUNTIME_BINARIES, r));
    }
    return c.json(await service.report({ seatShell: body.seatShell !== false, runtimes }));
  });
  return app;
}
