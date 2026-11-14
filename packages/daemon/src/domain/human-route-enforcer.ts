import { setOff } from "./active-occupant.js";

/**
 * Human-route enforcement (OPR.0.4.4.19 FR-4 + FR-5; conventions C6 + C3).
 *
 * Sibling of hot-potato-enforcer.ts: a pure domain validator wired at the
 * QueueRepository write paths (create / handoff / handoff-and-complete, and
 * the FR-6 park transition) so every surface — CLI, HTTP, future UI —
 * inherits the same guarantee. NOT enforced at the route, NOT at the CLI.
 *
 * THE scoping predicate (PRD §5 — the complete trigger list, BR-1):
 *
 *   tier = 'human-gate'
 *   OR is_human_seat_session(destination_session)
 *   OR (state = 'blocked' AND is_human_seat_session(blocked_on))   [FR-6]
 *
 * When the predicate is FALSE, this module validates NOTHING: ordinary
 * agent-to-agent queue traffic gains zero new required fields, zero new
 * rejection paths, zero new warns (BR-1 zero-friction boundary). Do not
 * broaden the trigger by destination tag, body text, or state alone.
 */

/**
 * The EXACT human-seat regex. Single TS source of truth — the same pattern
 * QueueRepository registers as the SQLite `is_human_seat_session` function
 * (queue-repository.ts constructor) so SQL-side and TS-side checks cannot
 * drift. Mirrors the UI's feed-classifier isHumanSeat.
 */
export const HUMAN_SEAT_SESSION_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;

export function isHumanSeatSession(value: unknown): boolean {
  return typeof value === "string" && HUMAN_SEAT_SESSION_PATTERN.test(value);
}

export interface HumanRouteRequest {
  tier: string | null | undefined;
  destinationSession: string;
  summary: string | null | undefined;
  evidenceRef: string | null | undefined;
}

export interface HumanRouteValidationOk {
  ok: true;
  /** True when the §5 predicate matched (the item is human-routed). */
  humanRouted: boolean;
}

export interface HumanRouteValidationErr {
  ok: false;
  code: "human_route_fields_required";
  message: string;
  missingFields: string[];
}

export type HumanRouteValidation = HumanRouteValidationOk | HumanRouteValidationErr;

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/**
 * Validate the C6/C3 structure of a NEW qitem (create / the created half of a
 * handoff). Fires ONLY when the item is human-routed via legs 1–2 of the §5
 * predicate (human-gate tier, human-seat destination). The park leg
 * (blocked_on a human seat) is validated by {@link validateHumanPark} at the
 * blocked-transition write path.
 */
export function validateHumanRoute(req: HumanRouteRequest): HumanRouteValidation {
  return validateRequiredFields(
    req.tier === "human-gate" || isHumanSeatSession(req.destinationSession),
    req.summary,
    req.evidenceRef,
    "human-routed queue items",
    "Provide --summary / --evidence-ref (ordinary agent-to-agent items are unaffected).",
  );
}

export interface HumanParkRequest {
  /** The blocker the item is being parked on (qitem id OR human-seat session). */
  blockedOn: string | null | undefined;
  /** Effective values at park time: the value provided on the park call,
   *  falling back to what the item already carries. */
  summary: string | null | undefined;
  evidenceRef: string | null | undefined;
}

/**
 * OPR.0.4.4.19 FR-6 — leg-1 park enforcement (§5 predicate leg 3). Fires
 * ONLY when the blocker is a human seat; blocking on another qitem (today's
 * shipped usage) requires nothing new. The parked qitem itself — id, slice
 * tag, summary — IS the what-it-unblocks (arch-ruled: no decision_descriptor
 * field). Enforcement symmetry: park requires summary + evidence_ref like
 * FR-7's resolve requires non-empty decision text.
 */
export function validateHumanPark(req: HumanParkRequest): HumanRouteValidation {
  return validateRequiredFields(
    isHumanSeatSession(req.blockedOn),
    req.summary,
    req.evidenceRef,
    "parking a qitem on a human seat",
    `Provide them at park time (${setOff("rig queue block --summary --evidence-ref")}) or on the item beforehand; blocking on another qitem requires nothing new.`,
  );
}

function validateRequiredFields(
  predicateFired: boolean,
  summary: string | null | undefined,
  evidenceRef: string | null | undefined,
  subject: string,
  remedy: string,
): HumanRouteValidation {
  if (!predicateFired) {
    return { ok: true, humanRouted: false };
  }
  const missing: string[] = [];
  if (isBlank(summary)) missing.push("summary");
  if (isBlank(evidenceRef)) missing.push("evidence_ref");
  if (missing.length === 0) {
    return { ok: true, humanRouted: true };
  }
  const why: string[] = [];
  if (missing.includes("summary")) {
    why.push("summary: a decision the human reads must be in plain language (convention C6)");
  }
  if (missing.includes("evidence_ref")) {
    why.push("evidence_ref: the human must have a durable artifact to judge (convention C3)");
  }
  return {
    ok: false,
    code: "human_route_fields_required",
    message: `${subject} require${subject.endsWith("s") ? "" : "s"} ${missing.join(" + ")} — ${why.join("; ")}. ${remedy}`,
    missingFields: missing,
  };
}
