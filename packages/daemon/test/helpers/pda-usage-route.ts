// pda runtime (L2c): the daemon's pda usage route in a hermetic app, and the helper that posts what a
// pda-runner posts. L1b's runner tests reuse `postPdaUsage` to send a real `PdaUsagePayload` to the real route,
// so the payload the runner builds and the payload the route accepts cannot drift apart unseen.
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";
import { activityRoutes } from "../../src/routes/activity.js";
import { derivePdaCost, type PdaUsageFact, type PdaUsagePayload } from "../../src/adapters/pda-runner-protocol.js";

export const PDA_USAGE_TOKEN = "hook-token";
export const PDA_SEAT = "research@rig";
export const PDA_NODE = "node-pda-1";
/** A second managed pda seat, reachable only by its node id. */
export const PDA_OTHER_NODE = "node-pda-2";
export const PDA_OTHER_SEAT = "other-pda@rig";

/** One assistant entry's fact, built the way the runner builds it: the cost and basis come from `derivePdaCost`
 *  (J-5), never typed by hand, unless a test overrides them to build a fact the receiving side must refuse. */
export function pdaFact(entryId: string, over: Partial<PdaUsageFact> & { priced?: number } = {}): PdaUsageFact {
  const tokens = { input: over.input ?? 100, output: over.output ?? 20, cacheRead: over.cacheRead ?? 5, cacheWrite: over.cacheWrite ?? 1 };
  const { priced, ...rest } = over;
  const cost = derivePdaCost({ total: priced ?? 0 }, tokens);
  return {
    conversationId: "conv-1", entryId, entryTimestamp: new Date(Date.UTC(2026, 9, 23, 9, 0, Number(entryId.replace(/\D/g, "") || 0))).toISOString(),
    kind: "assistant", provider: "ollama-cloud", model: "gpt-oss:120b", api: "openai-completions", responseId: `resp-${entryId}`, stopReason: "stop",
    ...tokens, costTotal: cost.costTotal, costBasis: cost.costBasis, origin: "own", ...rest,
  };
}

export function pdaPayload(facts: PdaUsageFact[], over: Partial<PdaUsagePayload> = {}): PdaUsagePayload {
  return { sessionName: PDA_SEAT, nodeId: PDA_NODE, generation: "gen-1", agent: "research", facts, ...over };
}

export interface PdaUsageApp {
  db: Database.Database;
  hono: Hono;
  /** Change what usage.pda_cost_facts resolves to, between requests. */
  setSetting(value: boolean | "throws" | "absent"): void;
  /** POST /api/activity/pda-usage with the hook token (or another). Returns the raw Response. */
  postPdaUsage(payload: unknown, token?: string | null): Promise<Response>;
  getPdaUsage(query?: string): Promise<Response>;
  rows(): Array<Record<string, unknown>>;
}

/** `runtime`: the runtime of the seat the fake registry resolves (null: no such seat). `setting`: what
 *  `usage.pda_cost_facts` resolves to, "throws" for a settings store that fails, "absent" for no store. */
export function pdaUsageApp(opts: { runtime?: string | null; setting?: boolean | "throws" | "absent"; db?: Database.Database } = {}): PdaUsageApp {
  const db = opts.db ?? createDb();
  if (!opts.db) migrate(db, ALL_MIGRATIONS);
  const runtime = opts.runtime === undefined ? "pda" : opts.runtime;
  let setting: boolean | "throws" | "absent" = opts.setting === undefined ? true : opts.setting;
  // Like the real registry: an explicit nodeId answers with that node's own session (so the same session name on
  // two nodes never mixes them); otherwise the session name decides.
  const store = { resolveSession: (q: { sessionName?: string | null; nodeId?: string | null; runtime?: string | null }) => {
    if (!runtime) return null;
    if (q.nodeId === PDA_OTHER_NODE) return { sessionId: "sid2", rigId: "r", nodeId: PDA_OTHER_NODE, sessionName: PDA_OTHER_SEAT, runtime };
    return q.sessionName === PDA_SEAT ? { sessionId: "sid", rigId: "r", nodeId: PDA_NODE, sessionName: PDA_SEAT, runtime } : null;
  } };
  const settingsStore = {
    resolveOne: (key: string) => {
      if (key !== "usage.pda_cost_facts") throw new Error(`unexpected setting ${key}`);
      if (setting === "throws") throw new Error("settings unreadable");
      return { value: setting };
    },
  };
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, PDA_USAGE_TOKEN as never);
    c.set("sessionRegistry" as never, { db } as never);
    c.set("settingsStore" as never, (setting === "absent" ? undefined : settingsStore) as never);
    await next();
  });
  hono.route("/api/activity", activityRoutes);
  return {
    db, hono,
    setSetting: (value) => { setting = value; },
    postPdaUsage: (payload, token = PDA_USAGE_TOKEN) => Promise.resolve(hono.request("/api/activity/pda-usage", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(payload),
    })),
    getPdaUsage: (query = `?sessionName=${encodeURIComponent(PDA_SEAT)}`) => Promise.resolve(hono.request(`/api/activity/pda-usage${query}`)),
    rows: () => db.prepare("SELECT * FROM pda_usage_entries ORDER BY id").all() as Array<Record<string, unknown>>,
  };
}
