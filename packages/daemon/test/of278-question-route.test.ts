import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import type { SeatQuestionRequest, SeatQuestionService } from "../src/domain/seat-question-policy.js";

// OF-278: POST /api/activity/question-wait is the long-poll the seat's PermissionRequest hook asks, with the same local hook token as /hooks.
const TOKEN = "test-token";
function app(service: Pick<SeatQuestionService, "wait"> | undefined) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (service) c.set("seatQuestions" as never, service as never);
    c.set("activityHookToken" as never, TOKEN as never);
    await next();
  });
  a.route("/api/activity", activityRoutes);
  return a;
}
const post = (a: Hono, body: unknown, token: string | null = TOKEN) => a.request("/api/activity/question-wait", {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const GOOD = { requestId: "req-00000001", sessionName: "dev-impl@qrig", nodeId: "n1", generation: "g1", toolInput: { questions: [] }, askedAtMs: 1_900_000_000_000 };

describe("POST /api/activity/question-wait", () => {
  it("passes the hook's request to the service and returns its reply", async () => {
    const seen: SeatQuestionRequest[] = [];
    const res = await post(app({ wait: async (r) => { seen.push(r); return { action: "wait" }; } }), GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "wait" });
    expect(seen).toEqual([{ requestId: "req-00000001", sessionName: "dev-impl@qrig", nodeId: "n1", generation: "g1", toolInput: { questions: [] }, askedAtMs: 1_900_000_000_000 }]);
  });
  it("returns an answer to the hook whole", async () => {
    const reply = { action: "answer" as const, updatedInput: { questions: [], answers: { Q: "A (Recommended)" } } };
    const res = await post(app({ wait: async () => reply }), GOOD);
    expect(await res.json()).toEqual({ ok: true, ...reply });
  });
  it("refuses a call without the local hook token, before it reads the body", async () => {
    let called = false;
    const a = app({ wait: async () => { called = true; return { action: "wait" }; } });
    expect((await post(a, GOOD, null)).status).toBe(401);
    expect((await post(a, GOOD, "wrong")).status).toBe(401);
    expect(called).toBe(false);
  });
  it.each([[undefined], [""], ["short"], ["has spaces in it"], ["x".repeat(81)], [42]])("refuses a request id of %j", async (requestId) => {
    let called = false;
    const res = await post(app({ wait: async () => { called = true; return { action: "wait" }; } }), { ...GOOD, requestId });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
  it("is unconfigured, not silent, when the daemon has no question handling", async () => {
    const res = await post(app(undefined), GOOD);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "question_policy_unconfigured" });
  });
  it("refuses a body past the dialog ceiling, with the ceiling's own code, and takes one just under it", async () => {
    let called = 0;
    const a = app({ wait: async () => { called += 1; return { action: "wait" }; } });
    const over = await post(a, { ...GOOD, toolInput: { pad: "x".repeat(70 * 1024) } });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ ok: false, code: "hook_body_too_large" });
    expect(called).toBe(0);
    expect((await post(a, { ...GOOD, toolInput: { pad: "x".repeat(60 * 1024) } })).status).toBe(200);
    expect(called).toBe(1);
  });
});
