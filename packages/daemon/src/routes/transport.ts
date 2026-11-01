import { Hono } from "hono";
import type { SessionTransport, TargetSpec } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity, transportSenderSession } from "./require-sender-identity.js";
import { DAEMON_OUTBOX_ID_PREFIXES, OutboxHandlerError, type OutboxHandler } from "../domain/outbox-handler.js";
import { mintMessageId } from "../domain/seat-messaging/message-ledger.js";
import { MessageStore } from "../domain/seat-messaging/message-store.js";
import { messageId } from "../domain/seat-messaging/ports.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";

// S2 (OPR.0.5.4.3) — the sender-side half of two-ended honesty: appended to any
// unattributed delivery's success payload and surfaced by the CLI renderers.
// Held to the S1 truthfulness bar for a success payload: what happened, what the
// recipient cannot know, and the concrete fix (sign).
const UNKNOWN_SENDER_NOTICE =
  "Delivered without sender identity: this request carried no X-OpenRig-Session header, so your recipient has no way of knowing who sent it. Follow up and sign it — send from a seat shell (the header stamps automatically) or state your identity in the message body.";

// The unknown-sender From: marker, DERIVED from the canonical envelope wrapper
// (pane-envelope.ts SENDER_FALLBACK is unexported and its literal is
// canonicity-guarded to exactly two twin sites) — deriving at module load keeps
// one source of truth with no third definition. wrapPaneEnvelope with an absent
// sender renders "From: <marker>" as its first line.
const UNKNOWN_SENDER_MARKER = wrapPaneEnvelope(undefined, "", "").split("\n")[0]!.replace(/^From: /, "");

/** A caller's message id reaches a native marker (`[openrig-msg <id>:<nonce>]`), so it is held to that marker's alphabet. */
const CALLER_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True when `id` is outside the marker alphabet. */
export function requireSeatMessageId(id: string): boolean {
  return !CALLER_MESSAGE_ID.test(id);
}

/** Why a caller may not name this id, or null. A daemon prefix is refused because the row now commits before the send: a caller's
 *  `wake-intent-x` left pending would be executed by the boot drain. */
export function refusedMessageId(id: unknown): string | null {
  if (id === undefined) return null;
  if (typeof id !== "string" || !CALLER_MESSAGE_ID.test(id)) return "deliveryId must be 1-128 characters of letters, digits, '.', '_', ':' or '-', starting with a letter or digit. No text was sent.";
  if (DAEMON_OUTBOX_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return `deliveryId may not start with a daemon-reserved prefix (${DAEMON_OUTBOX_ID_PREFIXES.join(", ")}). No text was sent.`;
  return null;
}

/** Recorded as `retired_by` when the close came from a shell with no seat identity (no X-OpenRig-Session header). */
export const UNATTRIBUTED_OPERATOR = "operator (no seat identity)";

/** The seat `workspace.operator_seat_name` names, or null when none is set. */
function operatorSeatName(c: { get: (key: never) => unknown }): string | null {
  const value = (c.get("settingsStore" as never) as SettingsStore | undefined)?.resolveOne("workspace.operator_seat_name").value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function transportRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();

  const terminalToken = opts?.bearerToken ?? null;
  router.use("*", authBearerTokenMiddleware({ expectedToken: terminalToken }));

  router.post("/send", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      deliveryId?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      submitOnly?: boolean;
      expectedStagedText?: string;
      expectedStagedLineCount?: number;
    }>();

    // submitOnly (mechanics-gate fix d9b3989a) sends NO text — the Enter-only retry for staged
    // content; every other send still requires text.
    if (!body.session || (!body.text && !body.submitOnly)) {
      return c.json({ error: "Missing required fields: session, text" }, 400);
    }
    const idRefusal = refusedMessageId(body.deliveryId);
    if (idRefusal) return c.json({ ok: false, reason: "invalid_delivery_id", error: idRefusal }, 400);
    // OPR.0.4.1.10 — the danger override and wait mode are contradictory; reject before transport.
    if (body.dangerouslyInteract && body.waitForIdleMs !== undefined) {
      return c.json({
        ok: false,
        reason: "invalid_dangerously_interact",
        error: "--dangerously-interact cannot be combined with --wait-for-idle. No text was sent.",
      }, 400);
    }
    // The override must carry a reason for the audit record.
    if (body.dangerouslyInteract && (!body.reason || body.reason.trim().length === 0)) {
      return c.json({
        ok: false,
        reason: "dangerously_interact_requires_reason",
        error: "--dangerously-interact requires --reason explaining why the prompt is being driven. No text was sent.",
      }, 400);
    }
    if (body.waitForIdleMs !== undefined) {
      if (body.force) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle cannot be combined with force. No text was sent.",
        }, 400);
      }
      if (typeof body.waitForIdleMs !== "number" || !Number.isFinite(body.waitForIdleMs) || body.waitForIdleMs <= 0) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs must be a positive number. No text was sent.",
        }, 400);
      }
    }

    // P21 I4 + S2 (OPR.0.5.4.3): the actor (the --dangerously-interact override AUDIT actor) is
    // DERIVED from the transport header, never body.actorSession. A body claim that DIFFERS is
    // simply SUPERSEDED, never a refusal: the wire decides the actor and the body never does
    // (PM ruling (A), 2026-08-11 — see require-sender-identity.ts:16-22). An ABSENT header no
    // longer refuses (founder descope, S2): a spoofer defeats a refusal by adding a header, so
    // the 401 only ever stopped honest uncounted callers. Instead the send DELIVERS, the
    // already-nullable audit actor records null (projected "unknown"), and the response carries
    // the sign-it notice below.
    const derivedActor = transportSenderSession(c) ?? null;

    // Check for ambiguity first
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    // The row commits inside transport.send, before any write, and every send from here is settled there. The id is the answer's:
    // a repeat under it is the same message.
    const messageId = body.submitOnly ? undefined : body.deliveryId ?? mintMessageId();
    const result = await transport.send(body.session, body.text ?? "", {
      deliveryId: messageId,
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // transport-derived, never the body claim
      // Mechanics-gate fix (d9b3989a): the walk retry's bare-Enter mode, guarded in the
      // transport by the expected-staged-text precheck.
      submitOnly: body.submitOnly,
      expectedStagedText: body.expectedStagedText,
      expectedStagedLineCount: body.expectedStagedLineCount,
    });

    const answer = messageId ? { ...result, messageId } : result;
    if (result.outcome === "retained") return c.json(answer);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        typing_guard_enabled: 409,
        guard_target_unknown: 409,
        guard_target_changed: 409,
        delivery_identity_conflict: 409,
        message_not_recorded: 500,
        empty_message: 400,
        message_too_large: 413,
        message_already_ended: 409,
        retained_quota_full: 409,
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        mid_work: 409,
        invalid_wait_for_idle: 400,
        invalid_dangerously_interact: 400,
        dangerously_interact_requires_reason: 400,
        wait_for_idle_timeout: 409,
        target_needs_input: 409,
        target_activity_unknown: 409,
        prompt_override_audit_unavailable: 500,
        submit_failed: 502,
        send_failed: 502,
        invalid_submit_only: 400,
        paste_terminator_in_text: 400,
        staged_mismatch: 409,
        // OF-160 (z5): a refusal is not a server error. Every mapped refusal follows one rule —
        // request-formation problems are 400, target-STATE refusals are 409 (like their neighbours
        // target_needs_input / target_activity_unknown); the 500 fallback is for the genuinely
        // unmapped and nothing deliberate. These three are target-state refusals:
        runner_input_no_override: 409,
        target_runtime_unverified: 409,
        target_runner_unverified: 409,
        target_runtime_conflict: 409, // OF-160-F2: binding changed before/after the paste
        // hc: accepted, not confirmed. Anything 5xx invites a resend, and a queued send outlives its client.
        waiting_on_person: 202,
        delivery_outcome_unknown: 202,
      };
      const status = (statusMap[result.reason ?? ""] ?? 500) as 202 | 400 | 404 | 409 | 413 | 500 | 502 | 503;
      return c.json(answer, status);
    }

    // S2 (OPR.0.5.4.3) sender-side honesty: an unattributed delivery tells the sender, on the
    // success payload the CLI renderers surface, that the recipient cannot know who sent it.
    // Composes with any existing transport warning; attributed sends see no change and no nag.
    if (!derivedActor) {
      answer.warning = result.warning ? `${result.warning} ${UNKNOWN_SENDER_NOTICE}` : UNKNOWN_SENDER_NOTICE;
    }

    return c.json(answer);
  });

  // The body of a message too long to paste into its seat: the seat's copy names this (rig seat read-message). Reading changes nothing.
  router.get("/read-message/:seat/:id", (c) => {
    const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
    if (!outbox) return c.json({ error: "Outbox unavailable" }, 503);
    const entry = outbox.getById(c.req.param("id"));
    if (entry?.destinationSession !== c.req.param("seat")) return c.json({ error: `No message ${c.req.param("id")} for ${c.req.param("seat")}` }, 404);
    return c.json({ id: entry.outboxId, seat: entry.destinationSession, sender: entry.senderSession, body: entry.body });
  });

  // The operator's end of a message nothing can deliver (rig seat cancel-message): by id, naming its seat, with a reason. No state of the pump
  // needs this to move, but a message that will never pass a gate holds its seat's queue, and this is the way out.
  router.post("/cancel-message/:seat/:id", async (c) => {
    const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
    if (!outbox) return c.json({ error: "Outbox unavailable" }, 503);
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
    if (typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "A reason is required" }, 400);
    const id = messageId(c.req.param("id"));
    if (outbox.getById(id)?.destinationSession !== c.req.param("seat")) return c.json({ error: `No message ${id} for ${c.req.param("seat")}` }, 404);
    // Whose close this is. A plain shell has no seat identity: that is the person at the keyboard, the one this verb exists for, and it is
    // recorded as such (as retire-unsettled does). A named seat must be the message's sender or the configured operator seat: any other
    // seat could otherwise end a message it did not send, with nothing on the row to say who.
    const store = new MessageStore(outbox.db);
    const actor = transportSenderSession(c) ?? UNATTRIBUTED_OPERATOR;
    if (actor !== UNATTRIBUTED_OPERATOR && actor !== store.senderOf(id) && actor !== operatorSeatName(c)) {
      return c.json({ error: `${actor} did not send message ${id} and is not the operator seat; only the sender or the operator may cancel it. Nothing was changed.` }, 403);
    }
    const cancelled = store.cancel(id, body.reason, new Date().toISOString(), actor);
    return cancelled ? c.json({ ok: true, id }) : c.json({ error: `Message ${id} is not open; nothing was changed.` }, 409);
  });

  // The operator's close of an unsettled hc send (rig seat retire-unsettled-send): the person has looked at the seat. Audited with
  // the transport-derived actor and a reason; refuses a row that is settled, another seat's, or not yet escalated.
  router.post("/retire-unsettled/:seat/:id", async (c) => {
    const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
    if (!outbox) return c.json({ error: "Outbox unavailable" }, 503);
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
    // The close is a person's: from a plain shell there is no seat identity, and refusing would leave the one exit of a crash-left row
    // closed to the person `rig health` tells to use it. A missing identity is recorded as such, not refused (as /send does).
    const actor = transportSenderSession(c) ?? UNATTRIBUTED_OPERATOR;
    if (typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "A reason is required" }, 400);
    try {
      const entry = outbox.retireHcUnsettled(c.req.param("id"), c.req.param("seat"), actor, body.reason);
      return c.json({ entry: { outboxId: entry.outboxId, destinationSession: entry.destinationSession, deliveryState: entry.deliveryState, retiredAt: entry.retiredAt, retiredBy: entry.retiredBy, retirementReason: entry.retirementReason },
        effect: "Closed: the row leaves the unsettled list and `rig health`. Nothing was sent and nothing is asserted about delivery; the label and pending record are kept as evidence." });
    } catch (err) {
      if (!(err instanceof OutboxHandlerError)) throw err;
      return c.json({ error: err.message, code: err.code }, err.code === "outbox_not_found" ? 404 : err.code === "retirement_reason_required" ? 400 : 409);
    }
  });

  router.post("/capture", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      rig?: string;
      pod?: string;
      lines?: number;
    }>();

    // Multi-target: rig or pod
    if (body.rig || body.pod) {
      const target: TargetSpec = body.pod
        ? { pod: body.pod, rig: body.rig }
        : { rig: body.rig! };

      const resolved = await transport.resolveSessions(target);
      if (!resolved.ok) {
        return c.json({ ok: false, error: resolved.error }, 404);
      }

      const results = [];
      for (const session of resolved.sessions) {
        const result = await transport.capture(session.sessionName, { lines: body.lines });
        results.push(result);
      }
      return c.json({ results });
    }

    // Single target: session
    if (!body.session) {
      return c.json({ error: "Provide session, rig, or pod to capture" }, 400);
    }

    const result = await transport.capture(body.session, { lines: body.lines });
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        capture_failed: 502,
      };
      const status = (statusMap[result.reason ?? ""] ?? 404) as 404 | 409 | 502 | 503;
      return c.json(result, status);
    }
    return c.json(result);
  });

  router.post("/broadcast", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      rig?: string;
      pod?: string;
      // OPR.0.4.3.30 — explicit multi-recipient list (`rig send --to a,b`).
      sessions?: string[];
      /** The fan-out's id: each recipient's message is `<id>:<seat>`. */
      deliveryId?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
      // OPR.0.4.3.30 — plumbed through so `rig send` fan-out carries the same guard/wait
      // semantics as a single send. Each is applied PER recipient inside broadcast()'s loop
      // (the danger audit fires once per seat, not once per batch).
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      // OPR.0.4.3.30 — when set, the fan-out wraps each recipient in its own From/To envelope.
      // `rig broadcast` never sets it (raw-to-all, unchanged).
      envelopeSender?: string | null;
    }>();

    if (!body.text) {
      return c.json({ error: "Missing required field: text" }, 400);
    }
    const idRefusal = refusedMessageId(body.deliveryId);
    if (idRefusal) return c.json({ ok: false, reason: "invalid_delivery_id", error: idRefusal }, 400);

    // P21 I4 + S2 (OPR.0.5.4.3): the --dangerously-interact override AUDIT actor is DERIVED from the
    // transport header (see /send). An absent header no longer refuses — the send proceeds and the
    // audit's already-nullable actor records null (projected "unknown"); the response carries the
    // sign-it notice below.
    const derivedActor = transportSenderSession(c) ?? null;

    // P21 I4 (orch ruling from specimen 5 — the false "From: pm-lead" the incident acted upon): the
    // From: line rendered into every recipient's terminal MUST DERIVE from the transport identity, never
    // the body value. A present body.envelopeSender signals the ENVELOPED fan-out (rig send); its value
    // is IGNORED and the From: is the derived actor. A cross-host relay re-stamps X-OpenRig-Session from
    // ITS authenticated context (not a caller --from string). S2 (OPR.0.5.4.3): an unattributable
    // enveloped send now DELIVERS with the explicit unknown-sender marker as its From: — the specimen-5
    // rule is preserved unweakened: the body claim is STILL never rendered; the recipient sees honest
    // "unknown", never an unverified name. Raw `rig broadcast` = no envelope.
    let envelopeSender: string | undefined = undefined;
    if (body.envelopeSender !== undefined && body.envelopeSender !== null) {
      envelopeSender = derivedActor ?? UNKNOWN_SENDER_MARKER;
    }

    const target: TargetSpec =
      body.sessions && body.sessions.length > 0
        ? { sessions: body.sessions }
        : body.pod
          ? { pod: body.pod, rig: body.rig }
          : body.rig
            ? { rig: body.rig }
            : { global: true };

    const result = await transport.broadcast(target, body.text, {
      deliveryId: body.deliveryId,
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // transport-derived, never the body claim
      envelopeSender, // the From: is the DERIVED identity (never the body value) — orch ruling (a)
    });

    // A3b (P22): one row per RESOLVED recipient, committed and settled inside transport.send, so a partial fan-out records the truth per
    // recipient.

    // S2 (OPR.0.5.4.3) sender-side honesty: an unattributed fan-out's response carries the
    // sign-it notice for the CLI renderers to surface. Attributed fan-outs are unchanged.
    if (!derivedActor) {
      return c.json({ ...result, warning: UNKNOWN_SENDER_NOTICE });
    }
    return c.json(result);
  });

  return router;
}
