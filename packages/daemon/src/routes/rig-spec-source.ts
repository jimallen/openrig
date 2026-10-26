// OF-102: read and record a rig's spec source (rigs.spec_source_path). Mounted at /api/rigs/:rigId/spec-source.
import { Hono } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { RigSpecSourceService, type SpecSourceRefusalCode } from "../domain/rig-spec-source-service.js";
import { transportSenderSession } from "./require-sender-identity.js";

export const rigSpecSourceRoutes = new Hono();

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

rigSpecSourceRoutes.get("/", (c) => {
  const result = service(c).show(c.req.param("rigId")!);
  return c.json(result, result.ok ? 200 : 404);
});

rigSpecSourceRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const operator = transportSenderSession(c) ?? (typeof body["operator"] === "string" ? body["operator"].trim() : "");
  const result = service(c).set({
    rigId: c.req.param("rigId")!,
    path: typeof body["path"] === "string" ? body["path"] : "",
    operator,
  });
  return c.json(result, result.ok ? 200 : statusOf(result.code));
});
