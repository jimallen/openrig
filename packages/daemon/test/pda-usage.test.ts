// pda runtime, L2c (J-3): the sibling usage table (migration 116), the ingest route a pda-runner posts to, the
// read route, and the seat cost line. Hermetic: an in-memory database migrated with ALL_MIGRATIONS, a fake
// activity registry, and the real activity routes. The daemon never calls pda; every fact here is what a runner
// would post. Production entrypoint: startup.ts mounts `activityRoutes` at /api/activity (server.ts) and passes
// the settings store the gate reads; the runner (L1b, not in this change) is the only caller.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { PdaUsageEntriesStore, hasPdaUsageEntriesTable } from "../src/domain/pda-usage-store.js";
import { computeCostView, PDA_COST_COVERAGE } from "../src/domain/usage-series.js";
import { PDA_SEAT, PDA_NODE, PDA_OTHER_NODE, PDA_OTHER_SEAT, pdaFact, pdaPayload, pdaUsageApp } from "./helpers/pda-usage-route.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function app(opts: Parameters<typeof pdaUsageApp>[0] = {}) {
  const a = pdaUsageApp(opts);
  dbs.push(a.db);
  return a;
}
const NOW = "2026-10-23T12:00:00.000Z";

describe("migration 116: pda_usage_entries", () => {
  it("is registered under its reserved name and creates the sibling table, not columns on Pi's", () => {
    const names = ALL_MIGRATIONS.map((m) => m.name);
    expect(names).toContain("116_pda_usage_entries.sql");
    // 115 (L2b) then 116 (L2c), adjacent and in number order, however the lanes were rebased.
    expect(names.indexOf("116_pda_usage_entries.sql")).toBe(names.indexOf("115_node_pda_binding.sql") + 1);
    const d = createDb(); dbs.push(d);
    migrate(d, ALL_MIGRATIONS);
    expect(hasPdaUsageEntriesTable(d)).toBe(true);
    const cols = (d.prepare("PRAGMA table_info(pda_usage_entries)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["id", "conversation_id", "entry_id", "agent", "entry_timestamp", "kind", "provider", "model", "api", "response_id",
      "stop_reason", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_total", "cost_basis", "origin",
      "seat_session", "node_id", "occupant_generation", "recorded_at"]);
    const piCols = (d.prepare("PRAGMA table_info(pi_usage_entries)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(piCols).not.toContain("cost_basis");
  });

  it("the table itself refuses what the receiving side must never store: another kind, origin or cost basis, a repeated entry", () => {
    const a = app();
    const insert = (over: Record<string, unknown>) => {
      const row = { conversation_id: "c", entry_id: "e", agent: "a", entry_timestamp: NOW, kind: "assistant", input_tokens: 1, output_tokens: 1,
        cache_read_tokens: 0, cache_write_tokens: 0, cost_total: null, cost_basis: "absent", origin: "own", seat_session: "s", recorded_at: NOW, ...over };
      return () => a.db.prepare(`INSERT INTO pda_usage_entries (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    };
    expect(insert({})).not.toThrow();
    expect(insert({ entry_id: "k", kind: "usage" })).toThrow(/CHECK/);
    expect(insert({ entry_id: "o", origin: "inherited" })).toThrow(/CHECK/);
    expect(insert({ entry_id: "b", cost_basis: "free" })).toThrow(/CHECK/);
    expect(insert({})).toThrow(/UNIQUE/);
    expect(insert({ conversation_id: "other-conversation" })).not.toThrow(); // keyed on the pair, not on entry_id alone
  });
});

describe("PdaUsageEntriesStore", () => {
  const rec = (a: ReturnType<typeof app>, facts: ReturnType<typeof pdaFact>[], seat = PDA_SEAT) =>
    new PdaUsageEntriesStore(a.db).record({ seatSession: seat, nodeId: PDA_NODE, generation: "gen-1", agent: "research", facts }, NOW);

  it("stores each (conversation, entry) once; a replay stores nothing and counts a duplicate", () => {
    const a = app();
    expect(rec(a, [pdaFact("e1"), pdaFact("e2")])).toEqual({ stored: 2, duplicates: 0 });
    expect(rec(a, [pdaFact("e1"), pdaFact("e2"), pdaFact("e3")])).toEqual({ stored: 1, duplicates: 2 });
    expect(a.rows().map((r) => r.entry_id)).toEqual(["e1", "e2", "e3"]);
  });

  it("keys on the conversation too: the same entry id in another conversation is a different entry", () => {
    const a = app();
    expect(rec(a, [pdaFact("e1"), pdaFact("e1", { conversationId: "conv-2" })])).toEqual({ stored: 2, duplicates: 0 });
  });

  it("an unknown origin settles to own or other once, by the seat that stored it; nothing else ever changes", () => {
    const a = app();
    rec(a, [pdaFact("e1", { origin: "unknown" }), pdaFact("e2", { origin: "unknown" }), pdaFact("e3", { origin: "own" }), pdaFact("e4", { origin: "other" })]);
    expect(rec(a, [pdaFact("e1", { origin: "own" }), pdaFact("e2", { origin: "other" })])).toEqual({ stored: 2, duplicates: 0 });
    // settled origins are final, and an unknown replay never demotes them
    expect(rec(a, [pdaFact("e1", { origin: "other" }), pdaFact("e3", { origin: "unknown" }), pdaFact("e4", { origin: "own" })])).toEqual({ stored: 0, duplicates: 3 });
    expect(Object.fromEntries(a.rows().map((r) => [r.entry_id, r.origin]))).toEqual({ e1: "own", e2: "other", e3: "own", e4: "other" });
  });

  it("another seat posting an entry this seat stored changes nothing, not even an unknown origin", () => {
    const a = app();
    rec(a, [pdaFact("e1", { origin: "unknown" })]);
    expect(rec(a, [pdaFact("e1", { origin: "own" })], "intruder@rig")).toEqual({ stored: 0, duplicates: 1 });
    expect(a.rows()).toMatchObject([{ seat_session: PDA_SEAT, origin: "unknown" }]);
  });
});

describe("POST /api/activity/pda-usage", () => {
  it("stores a runner's facts under the resolved seat, with its generation and agent; the reply counts them", async () => {
    const a = app();
    const res = await a.postPdaUsage(pdaPayload([pdaFact("e1", { priced: 0.0123 })]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1, duplicates: 0, rejected: 0 });
    expect(a.rows()).toMatchObject([{
      conversation_id: "conv-1", entry_id: "e1", agent: "research", kind: "assistant", provider: "ollama-cloud", model: "gpt-oss:120b",
      api: "openai-completions", response_id: "resp-e1", stop_reason: "stop", input_tokens: 100, output_tokens: 20, cache_read_tokens: 5,
      cache_write_tokens: 1, cost_total: 0.0123, cost_basis: "model_priced", origin: "own", seat_session: PDA_SEAT, node_id: PDA_NODE,
      occupant_generation: "gen-1",
    }]);
  });

  it("a replay (the runner re-sends unacknowledged facts) stores nothing new", async () => {
    const a = app();
    const payload = pdaPayload([pdaFact("e1"), pdaFact("e2")]);
    expect(await (await a.postPdaUsage(payload)).json()).toMatchObject({ stored: 2, duplicates: 0 });
    expect(await (await a.postPdaUsage(payload)).json()).toMatchObject({ stored: 0, duplicates: 2 });
    expect(a.rows()).toHaveLength(2);
  });

  it("J-5: a declared zero price is stored as NULL with its basis, never as 0; 0 tokens is a real 0; no cost is absent", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([
      pdaFact("e1", { priced: 0 }), // tokens > 0, cost.total 0: the provider declares a zero price table
      pdaFact("e2", { priced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      pdaFact("e3", { costTotal: null, costBasis: "absent" }),
      pdaFact("e4", { priced: 0.5 }),
    ]));
    expect(a.rows().map((r) => [r.entry_id, r.cost_total, r.cost_basis])).toEqual([
      ["e1", null, "declared_zero_price"], ["e2", 0, "model_priced"], ["e3", null, "absent"], ["e4", 0.5, "model_priced"],
    ]);
  });

  it("refuses a fact whose cost and basis disagree, or that is not an assistant entry with a known origin; counts it rejected", async () => {
    const a = app();
    const bad = [
      pdaFact("e1", { costTotal: 0, costBasis: "model_priced" }), // a zero that would let reports sum real spend to $0
      pdaFact("e2", { costTotal: 0.5, costBasis: "declared_zero_price" }),
      pdaFact("e3", { costTotal: null, costBasis: "model_priced" }),
      pdaFact("e4", { origin: "inherited" as never }),
      pdaFact("e5", { kind: "tool_result" as never }),
      { entryId: "e6" } as never,
    ];
    expect(await (await a.postPdaUsage(pdaPayload([...bad, pdaFact("e7", { priced: 0.1 })]))).json()).toEqual({ ok: true, stored: 1, duplicates: 0, rejected: 6 });
    expect(a.rows().map((r) => r.entry_id)).toEqual(["e7"]);
  });

  it("OF-129: a fact with an over-long label (an older runner has no bound) is stored with the label NULL and its tokens and cost; an over-long id is still rejected", async () => {
    const a = app();
    const long = "x".repeat(513);
    const res = await a.postPdaUsage(pdaPayload([
      pdaFact("e1", { priced: 0.5, model: long, responseId: long, provider: long, api: long, stopReason: long }),
      pdaFact(long, { priced: 0.5 }),
      pdaFact("e3", { priced: 0.5, model: "x".repeat(512) }),
    ]));
    expect(await res.json()).toEqual({ ok: true, stored: 2, duplicates: 0, rejected: 1 });
    expect(a.rows().map((r) => [r.entry_id, r.provider, r.model, r.api, r.response_id, r.stop_reason, r.input_tokens, r.cost_total, r.cost_basis])).toEqual([
      ["e1", null, null, null, null, null, 100, 0.5, "model_priced"],
      ["e3", "ollama-cloud", "x".repeat(512), "openai-completions", "resp-e3", "stop", 100, 0.5, "model_priced"],
    ]);
  });

  it("stores the origin the runner attributed: own, other, unknown", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([pdaFact("e1", { origin: "own" }), pdaFact("e2", { origin: "other" }), pdaFact("e3", { origin: "unknown" })]));
    expect(a.rows().map((r) => r.origin)).toEqual(["own", "other", "unknown"]);
  });

  it("honours nodeId: the node's own seat is the one stored under, not the session name the body also carries", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([pdaFact("e1")], { nodeId: PDA_OTHER_NODE }));
    expect(a.rows()).toMatchObject([{ seat_session: PDA_OTHER_SEAT, node_id: PDA_OTHER_NODE }]);
    await a.postPdaUsage(pdaPayload([pdaFact("e2")]));
    expect(a.rows().map((r) => [r.entry_id, r.seat_session, r.node_id])).toEqual([["e1", PDA_OTHER_SEAT, PDA_OTHER_NODE], ["e2", PDA_SEAT, PDA_NODE]]);
  });

  it("refuses a missing or wrong hook token, storing nothing", async () => {
    const a = app();
    expect((await a.postPdaUsage(pdaPayload([pdaFact("e1")]), "nope")).status).toBe(401);
    expect((await a.postPdaUsage(pdaPayload([pdaFact("e1")]), null)).status).toBe(401);
    expect(a.rows()).toHaveLength(0);
  });

  it.each(["pi", "omp", "claude-code", "codex", "terminal", null])("refuses a seat that is not a managed pda seat (%s): 404, never stored under another name", async (runtime) => {
    const a = app({ runtime });
    const res = await a.postPdaUsage(pdaPayload([pdaFact("e1")]));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "session_not_found" });
    expect(a.rows()).toHaveLength(0);
  });

  it("the setting gate: with usage.pda_cost_facts off, unreadable or unavailable, nothing is stored (503, so the runner keeps its facts)", async () => {
    for (const setting of [false, "throws", "absent"] as const) {
      const a = app({ setting });
      const res = await a.postPdaUsage(pdaPayload([pdaFact("e1")]));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, code: "pda_usage_disabled" });
      expect(a.rows()).toHaveLength(0);
    }
  });

  it("the gate is read at each request: turning it on stores, turning it off stops again; the same facts are then new", async () => {
    const a = app({ setting: false });
    expect((await a.postPdaUsage(pdaPayload([pdaFact("e1")]))).status).toBe(503);
    a.setSetting(true);
    expect(await (await a.postPdaUsage(pdaPayload([pdaFact("e1")]))).json()).toMatchObject({ stored: 1 });
    a.setSetting(false);
    expect((await a.postPdaUsage(pdaPayload([pdaFact("e2")]))).status).toBe(503);
    expect(a.rows().map((r) => r.entry_id)).toEqual(["e1"]);
  });

  it("an unauthenticated caller learns nothing about the setting: the token is checked first", async () => {
    expect((await app({ setting: false }).postPdaUsage(pdaPayload([pdaFact("e1")]), "nope")).status).toBe(401);
  });

  it("refuses a malformed body (400) and a daemon without the table (503)", async () => {
    const a = app();
    const raw = (body: string) => a.hono.request("/api/activity/pda-usage", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hook-token" }, body });
    expect((await raw("{not json")).status).toBe(400);
    expect((await raw("[]")).status).toBe(400);
    expect((await a.postPdaUsage({ ...pdaPayload([]), agent: undefined })).status).toBe(400);
    expect((await a.postPdaUsage({ ...pdaPayload([]), sessionName: undefined, nodeId: undefined })).status).toBe(400);
    expect((await a.postPdaUsage({ ...pdaPayload([]), facts: "x" })).status).toBe(400);
    const old = createDb(); dbs.push(old);
    migrate(old, ALL_MIGRATIONS.filter((m) => m.name !== "116_pda_usage_entries.sql"));
    expect((await pdaUsageApp({ db: old }).postPdaUsage(pdaPayload([pdaFact("e1")]))).status).toBe(503);
  });
});

describe("GET /api/activity/pda-usage and the cost view", () => {
  async function seeded(setting: boolean = true) {
    const a = app({ setting });
    await a.postPdaUsage(pdaPayload([
      pdaFact("e1", { priced: 0.25 }), pdaFact("e2", { priced: 0.5, stopReason: "error" }),
      pdaFact("e3", { priced: 4, origin: "other" }), pdaFact("e4", { priced: 8, origin: "unknown" }),
      pdaFact("e5", { priced: 0 }), pdaFact("e6", { costTotal: null, costBasis: "absent" }),
    ]));
    return a;
  }

  it("serves the seat's own spend; other-client and unknown-origin entries are shown apart and never added in", async () => {
    const a = await seeded();
    const body = await (await a.getPdaUsage()).json() as { ok: boolean; sessionName: string; cost: Record<string, any> };
    expect(body.sessionName).toBe(PDA_SEAT);
    expect(body.cost).toMatchObject({
      runtime: "pda", status: "reported", kind: "model-priced estimate", costUsd: 0.75, coverage: PDA_COST_COVERAGE,
      window: { conversationId: "conv-1", agent: "research" },
      entries: { own: 4, ownWithoutCost: { declaredZeroPrice: 1, absent: 1 }, errorOrAborted: 1, other: { count: 1, costUsd: 4 }, unknownOrigin: { count: 1, costUsd: 8 } },
      tokens: { input: 400, output: 80, cacheRead: 20, cacheWrite: 4 },
    });
  });

  it("other-client and unknown-origin entries nobody priced have a NULL cost, never 0 (counts still shown)", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([
      pdaFact("e1", { priced: 0.25 }),
      pdaFact("e2", { priced: 0, origin: "other" }), // declared zero price
      pdaFact("e3", { costTotal: null, costBasis: "absent", origin: "unknown" }),
    ]));
    const cost = ((await (await a.getPdaUsage()).json()) as { cost: Record<string, any> }).cost;
    expect(cost.entries.other).toEqual({ count: 1, costUsd: null });
    expect(cost.entries.unknownOrigin).toEqual({ count: 1, costUsd: null });
    expect(cost.costUsd).toBe(0.25);
  });

  it("GET honours nodeId the same way", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([pdaFact("e1", { priced: 1 })], { nodeId: PDA_OTHER_NODE }));
    const body = await (await a.getPdaUsage(`?sessionName=${encodeURIComponent(PDA_SEAT)}&nodeId=${PDA_OTHER_NODE}`)).json() as { sessionName: string; cost: { costUsd: number } };
    expect(body).toMatchObject({ sessionName: PDA_OTHER_SEAT, cost: { costUsd: 1 } });
    expect(((await (await a.getPdaUsage()).json()) as { cost: unknown }).cost).toBeNull(); // PDA_SEAT itself has none
  });

  it("the coverage says what the figure leaves out", () => {
    expect(PDA_COST_COVERAGE).toContain("assistant entries only; excludes compaction and tool usage");
    expect(PDA_COST_COVERAGE).toContain("spend in runs this seat took part in");
  });

  it("still reads with the setting off: what was recorded while it was on stays visible", async () => {
    const a = await seeded();
    a.setSetting(false);
    expect(((await (await a.getPdaUsage()).json()) as { cost: { costUsd: number } }).cost.costUsd).toBe(0.75);
  });

  it("refuses a seat that is not a managed pda seat, and answers null for a pda seat with no facts yet", async () => {
    for (const runtime of ["pi", "claude-code", null]) {
      const res = await app({ runtime }).getPdaUsage();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "session_not_found" });
    }
    expect((await app().getPdaUsage("")).status).toBe(400);
    expect(await (await app().getPdaUsage()).json()).toEqual({ ok: true, sessionName: PDA_SEAT, cost: null });
  });

  it("a seat whose only entries sit at a declared zero price reads as no cost with the reason, never as $0", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([pdaFact("e1", { priced: 0 }), pdaFact("e2", { priced: 0 })]));
    const cost = ((await (await a.getPdaUsage()).json()) as { cost: Record<string, any> }).cost;
    expect(cost.status).toBe("absent");
    expect(cost).not.toHaveProperty("costUsd");
    expect(cost.reason).toContain("zero price table");
    expect(cost.tokens.input).toBe(200);
  });

  it("the latest conversation is the seat's line; an older conversation stays stored as history", async () => {
    const a = app();
    await a.postPdaUsage(pdaPayload([pdaFact("e1", { priced: 1 })]));
    await a.postPdaUsage(pdaPayload([pdaFact("e2", { priced: 2, conversationId: "conv-2" })]));
    const cost = ((await (await a.getPdaUsage()).json()) as { cost: Record<string, any> }).cost;
    expect(cost).toMatchObject({ costUsd: 2, window: { conversationId: "conv-2" } });
    expect(a.rows()).toHaveLength(2);
  });

  it("computeCostView unions the pda seat into the same seat list `rig usage cost` prints; a daemon without the table adds nothing", async () => {
    const a = await seeded();
    const view = computeCostView(a.db, { nowIso: NOW });
    expect(view.seats).toMatchObject([{ seatSession: PDA_SEAT, runtime: "pda", status: "reported", costUsd: 0.75 }]);
    expect(computeCostView(a.db, { nowIso: NOW, seatSession: "someone-else@rig" }).seats).toEqual([]);
    const old = createDb(); dbs.push(old);
    migrate(old, ALL_MIGRATIONS.filter((m) => m.name !== "116_pda_usage_entries.sql"));
    expect(computeCostView(old, { nowIso: NOW }).seats).toEqual([]);
  });
});
