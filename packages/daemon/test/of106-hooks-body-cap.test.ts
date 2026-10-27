// OF-106: POST /api/activity/hooks read its whole body (`c.req.json()`) with no byte ceiling, so a holder of the local
// hook token could make the daemon buffer and parse a body of any size (the usage routes already cap theirs: OF-90).
// It now answers 413 `hook_body_too_large` once the body passes 64 KiB, after the token check and before anything
// is parsed or recorded.
//
// Deployed entrypoint: startup.ts mounts activityRoutes at /api/activity. Posters: activity-relay.cjs (Claude hooks),
// stub-runner.ts, pi-runner.ts, pda-runner.ts and `rig` startup proof (startup-proof.ts). Each sends a flat object of
// a few hundred bytes. The cap is written out literally here; nothing in this file imports it.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";

const MAX_HOOK_BODY_BYTES = 64 * 1024;
const TOKEN = "hook-token";

function app() {
  const recordHookEvent = vi.fn(() => ({
    ok: true as const,
    activity: { state: "running" },
    event: undefined,
  }));
  const store = { recordHookEvent, db: {} };
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, TOKEN as never);
    await next();
  });
  hono.route("/api/activity", activityRoutes);
  const post = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}, token = TOKEN) => {
    // A stream body needs `duplex: "half"`; it is not in the DOM RequestInit type.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body,
      duplex: "half",
    };
    return hono.request("/api/activity/hooks", init);
  };
  return { post, recordHookEvent };
}

/** A hook body of exactly `bytes` UTF-8 bytes (a `pad` field fills the difference). */
function hookBodyOfBytes(bytes: number, filler = "x"): string {
  const base = { runtime: "claude-code", sessionName: "s@r", hookEvent: "Stop", pad: "" };
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  const unit = Buffer.byteLength(filler, "utf8");
  const text = JSON.stringify({ ...base, pad: filler.repeat((bytes - overhead) / unit) });
  expect(Buffer.byteLength(text, "utf8")).toBe(bytes);
  return text;
}

const streamOf = (text: string, pieceBytes: number) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, at + pieceBytes));
      at += pieceBytes;
    },
  });
};

describe("OF-106: /api/activity/hooks body ceiling", () => {
  it("a normal hook body is recorded", async () => {
    const a = app();
    const res = await a.post(JSON.stringify({ runtime: "claude-code", sessionName: "s@r", hookEvent: "Stop" }));
    expect(res.status).toBe(200);
    expect(a.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("a body of exactly 64 KiB is still read", async () => {
    const a = app();
    const res = await a.post(hookBodyOfBytes(MAX_HOOK_BODY_BYTES));
    expect(res.status).toBe(200);
    expect(a.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("a body one byte over 64 KiB is refused with 413 hook_body_too_large and records nothing", async () => {
    const a = app();
    const res = await a.post(hookBodyOfBytes(MAX_HOOK_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "hook_body_too_large" });
    expect(a.recordHookEvent).not.toHaveBeenCalled();
  });

  it("counts BYTES, not characters: a multi-byte body under the cap in characters is refused", async () => {
    const a = app();
    // "é" is 2 bytes. 40,000 of them is 40,000 characters (under 65,536) and 80,000 bytes (over it).
    const res = await a.post(JSON.stringify({ runtime: "claude-code", sessionName: "s@r", hookEvent: "Stop", pad: "é".repeat(40_000) }));
    expect(res.status).toBe(413);
    expect(a.recordHookEvent).not.toHaveBeenCalled();
  });

  it("a chunked body with no declared length is cut off at the ceiling", async () => {
    const a = app();
    const text = hookBodyOfBytes(MAX_HOOK_BODY_BYTES + 5_000);
    const res = await a.post(streamOf(text, 8 * 1024));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "hook_body_too_large" });
    expect(a.recordHookEvent).not.toHaveBeenCalled();
  });

  it("a chunked body under the ceiling is read whole", async () => {
    const a = app();
    const res = await a.post(streamOf(hookBodyOfBytes(MAX_HOOK_BODY_BYTES - 100), 8 * 1024));
    expect(res.status).toBe(200);
    expect(a.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("a declared Content-Length over the ceiling is refused without reading the body", async () => {
    const a = app();
    const res = await a.post(JSON.stringify({ hookEvent: "Stop" }), { "content-length": String(MAX_HOOK_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(a.recordHookEvent).not.toHaveBeenCalled();
  });

  it("a declared Content-Length of exactly 64 KiB is not refused up front", async () => {
    const a = app();
    const res = await a.post(JSON.stringify({ hookEvent: "Stop" }), { "content-length": String(MAX_HOOK_BODY_BYTES) });
    expect(res.status).toBe(200);
    expect(a.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("the token is checked first: an oversize body without the token is 401, not 413", async () => {
    const a = app();
    const res = await a.post(hookBodyOfBytes(MAX_HOOK_BODY_BYTES + 1), {}, "wrong-token");
    expect(res.status).toBe(401);
    expect(a.recordHookEvent).not.toHaveBeenCalled();
  });

  it("a small body that is not JSON is still 400 invalid_json", async () => {
    const a = app();
    const res = await a.post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid_json" });
  });
});
