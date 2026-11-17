import { Hono } from "hono";
import { terminalAuthGuard } from "../middleware/terminal-auth-guard.js";
import type { AskService } from "../domain/ask-service.js";

export const askRoutes = new Hono();
// workspaces-o9o.78: the answer carries transcript excerpts (a seat's screen history), so it takes the terminal guard.
askRoutes.use("*", terminalAuthGuard());

askRoutes.post("/", async (c) => {
  const askService = c.get("askService" as never) as AskService;

  const body = await c.req.json<{ rig?: string; question?: string; nodeId?: string; sessionName?: string; seat?: string; session?: string }>();

  if (!body.rig || !body.question) {
    return c.json({ error: "Missing required fields: rig, question" }, 400);
  }

  const result = await askService.ask(body.rig, body.question, {
    nodeId: body.nodeId,
    sessionName: body.sessionName,
    seat: body.seat,
    session: body.session,
  });
  return c.json(result);
});
