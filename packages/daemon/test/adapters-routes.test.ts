import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Adapter routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/adapters/tmux/sessions -> tmux session list", async () => {
    const tmuxExec: ExecFn = async () => "my-session|2|2026-03-23|1\n";
    const tmux = new TmuxAdapter(tmuxExec);

    const { app } = createTestApp(db, { tmux });
    const res = await app.request("/api/adapters/tmux/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("my-session");
  });

  it("GET /api/adapters/cmux/status -> 404: cmux was removed, the route is gone", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(404);
  });
});
