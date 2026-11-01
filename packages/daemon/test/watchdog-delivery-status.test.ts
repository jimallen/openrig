import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { watchdogDeliveryOutcome } from "../src/domain/watchdog-delivery-status.js";

// The wake's status decides whether the engine sends it again next scan (a failed wake's receipt stays unbanked).
describe("watchdogDeliveryOutcome", () => {
  it.each(["waiting_on_person", "delivery_outcome_unknown"])("%s is unconfirmed, not failed: the core may still type it", (reason) => {
    expect(watchdogDeliveryOutcome({ ok: false, reason, error: "Not failed: queued" }, false)).toEqual({ status: "unconfirmed", error: "Not failed: queued", continuityActionCompleted: false });
  });

  it("keeps the other three as they were", () => {
    expect(watchdogDeliveryOutcome({ ok: true }, true)).toEqual({ status: "ok", continuityActionCompleted: true });
    expect(watchdogDeliveryOutcome({ ok: true, outcome: "retained", outboxIds: ["a"] }, false)).toEqual({ status: "retained", outboxIds: ["a"], continuityActionCompleted: false });
    expect(watchdogDeliveryOutcome({ ok: false, reason: "session_missing", error: "gone" }, false)).toEqual({ status: "failed", error: "gone", continuityActionCompleted: false });
  });

  it("a failure that merely mentions the words is still a failure: only the transport's reason is read", () => {
    expect(watchdogDeliveryOutcome({ ok: false, reason: "send_failed", error: "waiting_on_person" }, false).status).toBe("failed");
  });
});

// The mapper is only worth anything if the daemon's watchdog deliver goes through it (watchdog-target-gen-wiring.test.ts pins its
// neighbour the same way: a drop of this line silently turns every unconfirmed hc wake back into a "failed" one that is sent again).
describe("the daemon's watchdog deliver uses it", () => {
  const startup = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
  const start = startup.indexOf('const deliveryId = `guard-watchdog-');
  const closure = startup.slice(start, startup.indexOf("resolveTargetGeneration", start));

  it("returns the mapper's outcome for the transport result, and builds no status of its own", () => {
    expect(start).toBeGreaterThan(0);
    expect(closure).toContain("return watchdogDeliveryOutcome(result, continuityActionCompleted);");
    expect(closure).not.toMatch(/status: "(ok|failed)"[^\n]*result\.(ok|error)/);
  });
});
