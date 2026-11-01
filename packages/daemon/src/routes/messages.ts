import { Hono, type Context } from "hono";
import { DAEMON_OUTBOX_ID_PREFIXES, OutboxHandler, SEAT_MESSAGE_ID_PREFIX } from "../domain/outbox-handler.js";
import { crossHostMessageId, farSeatName, isCrossHostMessageId, MESSAGE_NOT_FOUND, type FarDaemons } from "../domain/seat-messaging/far-daemon.js";
import { mintMessageId } from "../domain/seat-messaging/message-ledger.js";
import { MessageStore } from "../domain/seat-messaging/message-store.js";
import { messageId } from "../domain/seat-messaging/ports.js";
import { HANDED_TO_PUMP, isPumpableText, MESSAGE_MAX_BYTES, type SessionTransport } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSeatMessageId, refusedMessageId } from "./transport.js";
import { transportSenderSession } from "./require-sender-identity.js";

/** How long `send-far` waits for the far accept before it says `accepted`. Over the pump's tick, so a far daemon that answers is `held` at once. */
const FAR_WAIT_MS = 8_000;
const ORIGIN_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORIGIN_SENDER = /^[^@\s]+@[^@\s]+@([^@\s]+)$/;
/** The executable namespaces. A sender's own minted `seat-msg-` id is what this route carries, and it is hashed into the row id. */
const REMOTE_REFUSED_PREFIXES = DAEMON_OUTBOX_ID_PREFIXES.filter((prefix) => prefix !== SEAT_MESSAGE_ID_PREFIX);

function transportOf(c: Context): SessionTransport {
  return c.get("sessionTransport" as never) as SessionTransport;
}

interface AcceptBody {
  id?: unknown;
  seat?: unknown;
  body?: unknown;
  class?: unknown;
  origin?: { host?: unknown; sender?: unknown } | null;
}

/** A refusal of the request as formed, or null. */
function refusedAccept(body: AcceptBody): string | null {
  const id = body.id;
  if (typeof id !== "string" || requireSeatMessageId(id)) return "id must be a message id";
  if (REMOTE_REFUSED_PREFIXES.some((prefix) => id.startsWith(prefix))) return `id may not start with ${REMOTE_REFUSED_PREFIXES.join(" or ")}`;
  if (typeof body.seat !== "string" || !body.seat) return "seat is required";
  if (typeof body.body !== "string" || !body.body) return "body is required";
  if (body.class !== "content" && body.class !== "nudge") return "class must be content or nudge: lifecycle text and commands stay on their own daemon";
  const host = body.origin?.host;
  const sender = body.origin?.sender;
  if (typeof host !== "string" || !ORIGIN_HOST.test(host)) return "origin.host is required";
  if (typeof sender !== "string" || (sender !== "unknown" && ORIGIN_SENDER.exec(sender)?.[1] !== host)) return "origin.sender must be `unknown` or a seat of origin.host";
  if (!isPumpableText(body.body)) return "this text cannot be carried by the pump";
  return null;
}

/**
 * Seat Messaging across hosts (S4 design, section 2). `/accept` is the far daemon's half: it commits a row and leaves it to the far pump. `/send-far`
 * is the sender's half: `rig send --host` posts here, to its own daemon, and the local pump owns the one hop. Gated like `/api/transport`: the same
 * terminal bearer, since this is the same power of putting text in front of a seat.
 */
export function messageRoutes(opts?: { bearerToken?: string | null; far?: FarDaemons }): Hono {
  const router = new Hono();
  router.use("*", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }));

  /** Whether this daemon's pump would carry a message to `seat`, under the name it knows it by. */
  router.get("/takes", async (c) => {
    const transport = transportOf(c);
    const seat = c.req.query("seat");
    if (!seat) return c.json({ error: "seat is required" }, 400);
    const resolved = await transport.resolveSessions({ session: seat });
    const name = resolved.ok ? resolved.sessions[0]?.sessionName : undefined;
    return c.json(name && transport.messageHandOff?.takes(name) ? { takes: true, seat: name } : { takes: false });
  });

  /** Idempotent on (origin host, id): a repeat answers the same and changes nothing, even after the message arrived. */
  router.post("/accept", async (c) => {
    const transport = transportOf(c);
    const handOff = transport.messageHandOff;
    if (!handOff) return c.json({ error: "This daemon's message pump is off.", code: "messaging_off" }, 503);
    const body = await c.req.json<AcceptBody>().catch(() => ({} as AcceptBody));
    const refusal = refusedAccept(body);
    if (refusal) return c.json({ error: refusal, code: "invalid_accept" }, 400);
    const accept = body as { id: string; seat: string; body: string; class: "content" | "nudge"; origin: { host: string; sender: string } };
    const resolved = await transport.resolveSessions({ session: accept.seat });
    if (!resolved.ok) return c.json({ error: resolved.error, code: "seat_unresolved" }, resolved.code === "ambiguous" ? 409 : 404);
    const seat = resolved.sessions[0]!.sessionName;
    if (!handOff.takes(seat)) return c.json({ error: `seat_not_gated: ${seat} has no gate, so nothing could confirm a message to it.`, code: "seat_not_gated" }, 409);
    const id = crossHostMessageId(accept.origin.host, accept.id);
    const result = await transport.send(seat, accept.body, {
      deliveryId: id, actorSession: accept.origin.sender, messageClass: accept.class, lane: 2, auditPointer: `cross-host:${accept.origin.host}:${accept.id}`,
    });
    if (result.reason === HANDED_TO_PUMP || result.reason === "message_already_ended") return c.json({ ok: true, id });
    if (result.reason === "delivery_identity_conflict") return c.json({ error: result.error, code: result.reason }, 409);
    return c.json({ error: result.error ?? "The message was not accepted.", code: result.reason ?? "not_accepted" }, result.reason === "message_too_large" ? 413 : 400);
  });

  /** The sender's daemon asks for the row whose id it derived. State only: the text stays on the row. */
  router.get("/:id", (c) => {
    const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
    if (!outbox) return c.json({ error: "Outbox unavailable" }, 503);
    const id = c.req.param("id");
    const state = isCrossHostMessageId(id) ? new MessageStore(outbox.db).outcomeOf(messageId(id)) : "unknown";
    return state === "unknown" ? c.json({ error: MESSAGE_NOT_FOUND }, 404) : c.json({ id, state });
  });

  /** `far_legacy` commits nothing and sends nothing: the caller runs today's path, and tells its sender that path is at most once. */
  router.post("/send-far", async (c) => {
    const transport = transportOf(c);
    const handOff = transport.messageHandOff;
    const body = await c.req.json<{ host?: unknown; session?: unknown; text?: unknown; deliveryId?: unknown; waitMs?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const { host, session, text } = body;
    if (typeof host !== "string" || typeof session !== "string" || typeof text !== "string" || !host || !session || !text) return c.json({ error: "Missing required fields: host, session, text" }, 400);
    const idRefusal = refusedMessageId(body.deliveryId);
    if (idRefusal) return c.json({ ok: false, reason: "invalid_delivery_id", error: idRefusal }, 400);
    const legacy = (reason: string) => c.json({ outcome: "far_legacy", reason });
    const far = opts?.far;
    if (!handOff || !far || !far.selfHost) return legacy("this daemon's message pump is off");
    if (!isPumpableText(text) || Buffer.byteLength(text) > MESSAGE_MAX_BYTES) return legacy("this text cannot be carried by the pump");
    const capability = await far.capability(host);
    if (capability !== "capable") return legacy(`${host} ${capability === "legacy" ? "has no accept route" : "is not answering"}`);
    const answer = await far.seatAnswer(host, session);
    if (answer.kind === "no") return legacy(`${session} on ${host} has no gate`);
    // Down now, known capable: the row is held and the pump goes on.
    const seat = farSeatName(host, answer.kind === "takes" ? answer.seat : session);
    const id = typeof body.deliveryId === "string" ? body.deliveryId : mintMessageId();
    const sender = transportSenderSession(c);
    const accepted = handOff.accept({
      id: messageId(id), seat, body: text, sender: sender ?? "unknown", identityProvenance: sender ? "transport:v1" : "origin-unknown:v1", messageClass: "content", lane: 2,
    });
    if (accepted.kind === "conflict") return c.json({ ok: false, reason: "delivery_identity_conflict", error: "Delivery ID names different content/identity." }, 409);
    const waitMs = typeof body.waitMs === "number" ? Math.min(Math.max(body.waitMs, 0), FAR_WAIT_MS) : FAR_WAIT_MS;
    const outcome = accepted.kind === "ended" ? (accepted.received ? "received" : "undeliverable") : await handOff.awaitReceived(messageId(id), waitMs);
    if (outcome === "undeliverable") return c.json({ ok: false, reason: "message_already_ended", messageId: id, host }, 409);
    return c.json({ outcome: outcome === "received" ? "held" : "accepted", messageId: id, host });
  });

  return router;
}
