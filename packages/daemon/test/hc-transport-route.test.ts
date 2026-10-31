import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUnconfirmedHcSend } from "../src/domain/outbox-handler.js";

const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes", "transport.ts"), "utf8");

describe("an hc send with no confirmation", () => {
  it("reads as unconfirmed for the two reasons, and only when not ok", () => {
    expect(isUnconfirmedHcSend({ ok: false, reason: "waiting_on_person" })).toBe(true);
    expect(isUnconfirmedHcSend({ ok: false, reason: "delivery_outcome_unknown" })).toBe(true);
    expect(isUnconfirmedHcSend({ ok: false, reason: "session_missing" })).toBe(false);
    expect(isUnconfirmedHcSend({ ok: true, reason: "waiting_on_person" })).toBe(false);
  });
  it("answers 202 on the route, so a client never resends it", () => {
    expect(route).toContain("waiting_on_person: 202,");
    expect(route).toContain("delivery_outcome_unknown: 202,");
  });
  it("is recorded as indeterminate in a broadcast, never failed", () => {
    expect(route.indexOf("isUnconfirmedHcSend(r)")).toBeLessThan(route.indexOf("else outbox.markFailed(entry.outboxId, labelForTmuxSend(r))"));
    expect(route).toContain("outbox.markIndeterminate(entry.outboxId, labelForTmuxSend(r))");
  });
});
