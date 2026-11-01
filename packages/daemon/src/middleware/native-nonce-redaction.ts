import type { Hono, MiddlewareHandler } from "hono";

/**
 * The one place a message's nonce is kept from leaving the daemon.
 *
 * A native nonce is what lets the seat gate tell a real message from a forged one (`adapters/seat-gate-marker.ts`): `[openrig-msg <id>:<nonce>]`
 * confirms nothing for a caller who cannot produce the nonce, and anyone who can read it can write the marker. The row that holds it
 * (`OutboxEntry.nativeNonce`, `native_nonce`, the gate's `gate_nonce`) is the daemon's own state, and every route that answers with a message
 * row would otherwise have to remember to drop it. The security review (delivery guarantees, F3) found two that did not: the plain list had been
 * fixed by hand, and `GET /api/seat/held-messages/:seat` and `POST /api/seat/retire-held-message/:seat/:id` still sent it. A rule that lives in
 * each caller is lost at the next route; this lives on the response, so a route that does not exist yet is covered.
 *
 * Every JSON answer is read and any key that names a nonce is removed, at any depth. The CLI prints what the daemon sends, so it has no other
 * output to guard. A body with no such key is passed on untouched (same status, same headers, same bytes). Anything that is not JSON is not
 * a message row and is left alone.
 */
const NONCE_KEY = /nonce/i;
const MAY_HOLD_NONCE = /nonce/i;

function withoutNonceKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNonceKeys);
  if (value !== null && typeof value === "object") {
    const kept: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) if (!NONCE_KEY.test(key)) kept[key] = withoutNonceKeys(inner);
    return kept;
  }
  return value;
}

export const redactNativeNonce: MiddlewareHandler = async (c, next) => {
  await next();
  const answered = c.res;
  if (!(answered.headers.get("content-type") ?? "").toLowerCase().includes("json")) return;
  const text = await answered.clone().text();
  if (!MAY_HOLD_NONCE.test(text)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  const headers = new Headers(answered.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(withoutNonceKeys(parsed)), { status: answered.status, statusText: answered.statusText, headers });
};

/** Mounted first on the server's app, before any route, so it sees every answer. */
export function installNativeNonceRedaction(app: Hono): void {
  app.use("*", redactNativeNonce);
}
