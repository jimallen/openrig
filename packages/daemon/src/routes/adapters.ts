import { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";

export const adaptersRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
  };
}

// GET /api/adapters/tmux/sessions
adaptersRoutes.get("/tmux/sessions", async (c) => {
  const { tmuxAdapter } = getDeps(c);
  const sessions = await tmuxAdapter.listSessions();
  return c.json(sessions);
});
