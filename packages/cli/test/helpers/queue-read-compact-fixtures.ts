// Fixtures shared by queue-read-compact.test.ts and the opt-in P6 measurement (queue-read-compact-measure.opt-in.ts).
import { vi } from "vitest";
import type { QueueDeps } from "../../src/commands/queue.js";

export type Row = Record<string, unknown>;
export const BODY = "Do the thing.\n".repeat(40) + "é";

/** The daemon's write response, shaped as `rowToItem` returns it. */
export function row(over: Row = {}, waiting: Row = {}): Row {
  const id = (over.qitemId as string | undefined) ?? "qitem-20261010180000-aaaa";
  const state = (over.state as string | undefined) ?? "pending";
  return {
    pickup: { state: "unclaimed" },
    waiting: {
      obligation: id, owner: "worker@r", state, actionableSince: "2026-10-10T18:00:00.000Z", blocker: null,
      lastMeaningfulChange: { id: 7, at: "2026-10-10T18:00:00.000Z" },
      liveness: { subject: "worker@r", activity: "idle", needsInput: { count: 0, reason: null }, confidence: "oracle" },
      nextBackstop: { owner: "lead@r", mechanism: "queue-stuck-sweep:unclaimed", dueAt: "2026-10-10T19:00:00.000Z", intervalSeconds: 300 },
      deadlineAt: null,
      ...waiting,
    },
    qitemId: id, tsCreated: "2026-10-10T18:00:00.000Z", tsUpdated: "2026-10-10T18:00:00.000Z",
    sourceSession: "lead@r", destinationSession: "worker@r", state, priority: "routine", tier: null,
    tags: ["mission:m"], blockedOn: null, handedOffTo: null, handedOffFrom: null, expiresAt: null, chainOfRecord: null,
    body: BODY, summary: "Ship the receipt", evidenceRef: null, humanIntent: null, humanDetail: null, replyTo: null,
    humanQuestions: null, humanAnswers: null, closureReason: null, closureTarget: null, closureRequiredAt: null,
    claimedAt: null, lastNudgeAttempt: null, lastNudgeResult: null, lastHeartbeat: null, resolution: null, targetRepo: null,
    ...over,
  };
}

export function makeDeps(routes: Record<string, { status: number; data: unknown } | Array<{ status: number; data: unknown }>>): QueueDeps {
  const pick = (key: string, fallback: { status: number; data: unknown }) => {
    const r = routes[key];
    return (Array.isArray(r) ? r.shift() : r) ?? fallback;
  };
  return {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (p: string) => pick(`GET ${p}`, { status: 200, data: {} })),
      post: vi.fn(async (p: string) => pick(`POST ${p}`, { status: 500, data: { error: "unrouted" } })),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  };
}

export const ID = "qitem-20261010180000-aaaa";

export function transition(n: number, state: string, note: string, over: Row = {}): Row {
  return { transitionId: n, qitemId: ID, ts: `2026-10-10T18:${String(n).padStart(2, "0")}:00.000Z`, state, transitionNote: note,
    actorSession: "worker@r", closureReason: null, closureTarget: null, identityProvenance: "transport:v1", ownerNotificationKind: null,
    ownerNotificationLevel: "RECORD", ...over };
}
/** 12 transitions: created, claimed, parked on CI at #3, then 9 note-only updates while parked. */
export const LOG: Row[] = [
  transition(1, "pending", "created"),
  transition(2, "in-progress", "claimed"),
  transition(3, "blocked", "parked: waiting on CI run 42"),
  ...Array.from({ length: 9 }, (_, i) => transition(4 + i, "blocked", `progress note ${i + 1}`)),
];
