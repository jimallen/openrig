// OF-90: the usage routes of /api/activity (pi-usage, pi-usage-charges, pda-usage) accepted any number of facts
// and any body size from a holder of the local hook token. Measured in review-pda-l2c: 100k facts block the daemon's
// event loop for ~0.55s and the rows grow without bound. They now answer 413 BEFORE a fact is parsed or stored.
// Also: a Pi usage fact's token counts are safe integers (a 2**53 count would store a rounded, wrong total).
//
// Deployed entrypoint: startup.ts mounts activityRoutes at /api/activity (server.ts). Posters: pi-runner.ts
// (/pi-usage, /pi-usage-charges) and pda-usage-sink.ts (/pda-usage). The caps are written out literally here;
// nothing in this file imports them. Legit load: the pda sink holds at most 2000 pending facts (one post), and a
// Pi runner posts one session's unposted facts per refresh.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { activityRoutes } from "../src/routes/activity.js";
import { validPiUsageFact } from "../src/domain/pi-usage-entries-store.js";
import { pdaFact, pdaPayload, pdaUsageApp } from "./helpers/pda-usage-route.js";

const MAX_FACTS = 5000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SEAT = "pi-seat@rig";
const TOKEN = "hook-token";

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

function piApp() {
  const d = createDb(); migrate(d, ALL_MIGRATIONS); dbs.push(d);
  const store = { resolveSession: (q: { sessionName?: string | null }) => (q.sessionName === SEAT
    ? { sessionId: "sid", rigId: "r", nodeId: "node-1", sessionName: SEAT, runtime: "pi" } : null) };
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("sessionRegistry" as never, { db: d } as never);
    await next();
  });
  hono.route("/api/activity", activityRoutes);
  const post = (path: string, body: unknown, token = TOKEN) => hono.request(`/api/activity/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body) });
  const count = (table: string) => (d.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { post, count };
}
const piFact = (i: number, over: Record<string, unknown> = {}) => ({
  entryId: `e${i}`, entryTimestamp: "2026-10-26T10:00:00.000Z", kind: "assistant", origin: "own", input: 10, output: 5, ...over });
const piBody = (facts: unknown[]) => ({ sessionName: SEAT, nodeId: "node-1", generation: "g", piSessionId: "s1", facts });
const chargeBody = (charges: unknown[]) => ({ sessionName: SEAT, nodeId: "node-1", piSessionId: "s1", charges });
const pad = (bytes: number) => "x".repeat(bytes);

describe("OF-90: /api/activity/pi-usage", () => {
  it("accepts exactly 5000 facts and stores them", async () => {
    const a = piApp();
    const res = await a.post("pi-usage", piBody(Array.from({ length: MAX_FACTS }, (_, i) => piFact(i))));
    expect(res.status).toBe(200);
    expect(a.count("pi_usage_entries")).toBe(MAX_FACTS);
  });
  it("refuses 5001 facts with 413 and stores nothing", async () => {
    const a = piApp();
    const res = await a.post("pi-usage", piBody(Array.from({ length: MAX_FACTS + 1 }, (_, i) => piFact(i))));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "usage_facts_too_many" });
    expect(a.count("pi_usage_entries")).toBe(0);
  });
  it("refuses a body over 4 MiB with 413 even with one fact, and stores nothing", async () => {
    const a = piApp();
    const res = await a.post("pi-usage", piBody([piFact(1, { model: pad(MAX_BODY_BYTES) })]));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "usage_body_too_large" });
    expect(a.count("pi_usage_entries")).toBe(0);
  });
  it("counts BYTES, not characters: a multi-byte body just over 4 MiB is refused", async () => {
    const a = piApp();
    const res = await a.post("pi-usage", piBody([piFact(1, { model: "é".repeat(MAX_BODY_BYTES / 2 + 200) })]));
    expect(res.status).toBe(413); // 2,097,352 characters (under the cap as a character count), 4,194,704+ bytes (over it)
  });
  it("a body under the cap with a large model string is still read", async () => {
    const a = piApp();
    expect((await a.post("pi-usage", piBody([piFact(1, { model: pad(1024 * 1024) })]))).status).toBe(200);
  });
  it("authenticates before it measures: a wrong token with an oversize body is 401", async () => {
    const a = piApp();
    expect((await a.post("pi-usage", piBody(Array.from({ length: MAX_FACTS + 1 }, (_, i) => piFact(i))), "nope")).status).toBe(401);
  });
  it("a count of 2**53 (not a safe integer) or 1.5 is a rejected fact, not a stored one", async () => {
    const a = piApp();
    const res = await a.post("pi-usage", piBody([piFact(1, { input: 2 ** 53 }), piFact(2, { output: 1.5 }), piFact(3, { cacheRead: 2 ** 60 }), piFact(4)]));
    expect(await res.json()).toMatchObject({ ok: true, stored: 1, rejected: 3 });
  });
});

describe("OF-90: validPiUsageFact counts are safe integers", () => {
  it.each(["input", "output", "cacheRead", "cacheWrite"])("%s: 2**53 is refused, 2**53 - 1 is kept", (k) => {
    expect(validPiUsageFact(piFact(1, { [k]: 2 ** 53 }))).toBeNull();
    expect(validPiUsageFact(piFact(1, { [k]: 2 ** 53 - 1 }))).toMatchObject({ [k]: 2 ** 53 - 1 });
  });
  it("a fractional or infinite count is refused; a fractional COST is still kept", () => {
    expect(validPiUsageFact(piFact(1, { input: 0.5 }))).toBeNull();
    expect(validPiUsageFact(piFact(1, { cacheWrite: Infinity }))).toBeNull();
    expect(validPiUsageFact(piFact(1, { costTotal: 0.0123 }))).toMatchObject({ costTotal: 0.0123 });
  });
});

describe("OF-90: /api/activity/pi-usage-charges", () => {
  const charge = (i: number) => ({ entryId: `e${i}`, generationId: `g${i}`, credentialSource: "env", status: "unavailable", reason: "no" });
  it("accepts 5000 charges (they reach the validator) and refuses 5001 with 413", async () => {
    const a = piApp();
    expect((await a.post("pi-usage-charges", chargeBody(Array.from({ length: MAX_FACTS }, (_, i) => charge(i))))).status).toBe(200);
    const res = await a.post("pi-usage-charges", chargeBody(Array.from({ length: MAX_FACTS + 1 }, (_, i) => charge(i))));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "usage_facts_too_many" });
  });
  it("refuses a body over 4 MiB with 413", async () => {
    const res = await piApp().post("pi-usage-charges", chargeBody([{ ...charge(1), reason: pad(MAX_BODY_BYTES) }]));
    expect(res.status).toBe(413);
  });
});

describe("OF-90: /api/activity/pda-usage", () => {
  const rowsCount = (a: ReturnType<typeof pdaUsageApp>) => a.rows().length;
  it("accepts exactly 5000 facts and stores them", async () => {
    const a = pdaUsageApp(); dbs.push(a.db);
    const res = await a.postPdaUsage(pdaPayload(Array.from({ length: MAX_FACTS }, (_, i) => pdaFact(`e${i}`))));
    expect(res.status).toBe(200);
    expect(rowsCount(a)).toBe(MAX_FACTS);
  });
  it("refuses 5001 facts with 413 and stores nothing", async () => {
    const a = pdaUsageApp(); dbs.push(a.db);
    const res = await a.postPdaUsage(pdaPayload(Array.from({ length: MAX_FACTS + 1 }, (_, i) => pdaFact(`e${i}`))));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "usage_facts_too_many" });
    expect(rowsCount(a)).toBe(0);
  });
  it("refuses a body over 4 MiB with 413 and stores nothing", async () => {
    const a = pdaUsageApp(); dbs.push(a.db);
    const res = await a.postPdaUsage(pdaPayload([pdaFact("e1", { model: pad(MAX_BODY_BYTES) })]));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "usage_body_too_large" });
    expect(rowsCount(a)).toBe(0);
  });
  it("authenticates, and honours the setting gate, before it measures", async () => {
    const big = pdaPayload(Array.from({ length: MAX_FACTS + 1 }, (_, i) => pdaFact(`e${i}`)));
    const a = pdaUsageApp(); dbs.push(a.db);
    expect((await a.postPdaUsage(big, "nope")).status).toBe(401);
    const off = pdaUsageApp({ setting: false }); dbs.push(off.db);
    expect((await off.postPdaUsage(big)).status).toBe(503);
  });
});
