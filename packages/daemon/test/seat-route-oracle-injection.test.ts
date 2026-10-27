import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// WAVE O FIX R1 — B1 (R2 verdict 508e383d): the PRODUCTION handover construction must
// receive the daemon's ONE SeatActivityService. The service-level swap contract is
// already pinned (seat-handover-service.test.ts); THIS pin holds the actual route seam
// R2's effect probe caught: routes/seat.ts constructed the service without the oracle,
// so a real managed handover committed without declareOccupantSwap and the successor
// could inherit the retiree's evidence and promoted rung authority.

const constructed: Array<Record<string, unknown>> = [];
const handover = vi.fn(async () => ({ ok: true, seat: "x" }));

vi.mock("../src/domain/seat-handover-service.js", () => ({
  SeatHandoverService: class {
    constructor(deps: Record<string, unknown>) {
      constructed.push(deps);
    }
    handover = handover;
  },
}));

import { seatRoutes } from "../src/routes/seat.js";

function makeApp(sentinelOracle: object) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, { db: {} } as never);
    c.set("sessionRegistry" as never, {} as never);
    c.set("discoveryRepo" as never, {} as never);
    c.set("eventBus" as never, {} as never);
    c.set("tmuxAdapter" as never, {} as never);
    c.set("seatActivityService" as never, sentinelOracle as never);
    await next();
  });
  app.route("/api/seat", seatRoutes);
  return app;
}

describe("Wave-O B1 — production handover construction injects the one activity oracle", () => {
  beforeEach(() => {
    constructed.length = 0;
    handover.mockClear();
  });

  it("POST /api/seat/handover/:seatRef constructs the service WITH the context's seatActivityService as activityOracle", async () => {
    const sentinel = { declareOccupantSwap: vi.fn() };
    const app = makeApp(sentinel);
    const res = await app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "context-wall", source: "fresh" }),
    });
    expect(res.status).toBe(200);
    expect(constructed).toHaveLength(1);
    // The R2 discriminator, preserved: candidate captured `undefined` here.
    expect(constructed[0]!.activityOracle).toBe(sentinel);
  });

  // OF-124 N3: a seat folder the person can fix is a conflict they can act on, not a server error.
  it("a handover refused for the seat's folder answers 409 with its own code; any other create failure stays 500", async () => {
    const post = (app: ReturnType<typeof makeApp>) => app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "context-wall", source: "fresh" }),
    });
    const app = makeApp({ declareOccupantSwap: vi.fn() });
    handover.mockResolvedValueOnce({ ok: false, code: "seat_cwd_unusable", message: "m", guidance: "g" } as never);
    const folder = await post(app);
    expect(folder.status).toBe(409);
    expect(await folder.json()).toMatchObject({ code: "seat_cwd_unusable" });
    handover.mockResolvedValueOnce({ ok: false, code: "successor_create_failed", message: "m", guidance: "g" } as never);
    expect((await post(app)).status).toBe(500);
  });
});
