// hc-w45 (QA F1): the one rule every transport client waits by. See src/transport-budget.ts.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAEMON_DELIVERY_BOUND_MS, TRANSPORT_BROADCAST_CONCURRENCY, TRANSPORT_MARGIN_MS, TRANSPORT_SEND_BUDGET_MS, TRANSPORT_UNSCOPED_RECIPIENTS,
  transportFanoutBudgetMs, transportSendBudgetMs, transportWakingWriteBudgetMs,
} from "../src/transport-budget.js";

describe("transport budget", () => {
  it("a send waits past the daemon's own bound, by the margin", () => {
    expect(DAEMON_DELIVERY_BOUND_MS).toBe(30_000);
    expect(TRANSPORT_SEND_BUDGET_MS).toBe(DAEMON_DELIVERY_BOUND_MS + TRANSPORT_MARGIN_MS);
    expect(transportSendBudgetMs()).toBeGreaterThan(DAEMON_DELIVERY_BOUND_MS);
    expect(transportSendBudgetMs()).toBeGreaterThan(5_000);
  });
  it("an idle wait the caller asked the daemon for is added before the delivery", () => {
    expect(transportSendBudgetMs(30_000)).toBe(30_000 + TRANSPORT_SEND_BUDGET_MS);
  });
  it("a fan-out waits in waves of eight: each wave takes as long as its slowest seat", () => {
    expect(TRANSPORT_BROADCAST_CONCURRENCY).toBe(8);
    // 1 to 8 seats are one wave, 9 to 16 two, and so on
    for (const n of [1, 3, 8]) expect(transportFanoutBudgetMs(n), `${n} seats`).toBe(30_000 + 15_000);
    for (const n of [9, 16]) expect(transportFanoutBudgetMs(n), `${n} seats`).toBe(2 * 30_000 + 15_000);
    expect(transportFanoutBudgetMs(17)).toBe(3 * 30_000 + 15_000);
    // QA measured 3 seats that start no run at 15.6 s serially; one wave now, and the budget covers it
    expect(transportFanoutBudgetMs(3)).toBeGreaterThan(15_600);
    expect(transportFanoutBudgetMs(3, 10_000)).toBe(40_000 + 15_000);
    expect(transportFanoutBudgetMs(20, 10_000)).toBe(3 * 40_000 + 15_000);
  });
  it("a fan-out the client cannot count is budgeted as 32 seats (four waves, 135 s); nonsense counts are not counts", () => {
    const unscoped = transportFanoutBudgetMs(undefined);
    expect(TRANSPORT_UNSCOPED_RECIPIENTS).toBe(32);
    expect(unscoped).toBe(4 * 30_000 + 15_000);
    expect(unscoped).toBe(135_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(transportFanoutBudgetMs(bad)).toBe(unscoped);
  });
  it("a write whose handler wakes seats before it answers covers two wakes one after the other (they are awaited in sequence)", () => {
    expect(transportWakingWriteBudgetMs()).toBe(2 * 30_000 + 15_000);
    expect(transportWakingWriteBudgetMs()).toBeGreaterThan(2 * DAEMON_DELIVERY_BOUND_MS);
  });
  it("the daemon's own delivery bound IS this constant (hc-input's default), so the two cannot drift apart", () => {
    const src = fs.readFileSync(new URL("../src/adapters/hc-input.ts", import.meta.url), "utf8");
    expect(src).toContain("deliveryTimeoutMs: options.deliveryTimeoutMs ?? DAEMON_DELIVERY_BOUND_MS");
    expect(src).not.toMatch(/deliveryTimeoutMs: options\.deliveryTimeoutMs \?\? \d/);
  });
});
