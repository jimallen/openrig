// pda runtime L2a (design J-3, J-5): the usage sink the pda-runner installs when it runs with `--usage-facts`
// (usage.pda_cost_facts on). It turns the assistant entries the runner's own stream saw into L0 `PdaUsageFact`s and
// posts them to the daemon's `POST /api/activity/pda-usage` (L2c) with the activity-hook token, once per `run_end`.
//
// Attribution (settled in the design): a run is `own` when at least one of its `run_start.inputs` is a submission of
// this seat (mixed runs count as own), `other` when every input is another client's, and `unknown` when no run_start
// was seen for it (the runner attached mid-run) or the run had no inputs. An entry the runner recovered by a gap fill
// (after a reconnect or an overflow snapshot) is `unknown` (design T33); if the same entry is then seen live inside a
// run whose attribution is known, the pending fact is upgraded, never queued twice. Once posted as unknown, the live
// fact is posted again and the store settles unknown -> own/other (L2c: idempotent on (conversation, entry); a settled
// origin is never demoted).
//
// Delivery: facts are kept until the daemon stores them. A 503 (the setting is off, or the store is unconfigured), a
// timeout or a connection failure keeps them for the next run_end; the route is idempotent on (conversation, entry),
// so a resend after a lost reply stores nothing twice. A definitive refusal (4xx) drops the posted facts: a resend
// could never succeed. One post is in flight at a time; facts queued behind it are posted as soon as it settles stored
// or refused (not only at the next run_end). The pending list is bounded; past the bound the OLDEST facts are dropped
// and counted.
// Numbers and ids only: never text, tool output or the token (T32).

import { derivePdaCost, parsePdaUsageFact, type PdaUsageFact, type PdaUsageOrigin, type PdaUsagePayload } from "./pda-runner-protocol.js";
import { idText } from "./pda-render.js";
import type { PdaUsageSink } from "./pda-runner.js";

export const PDA_USAGE_PENDING_MAX = 2000;

/** What a post did: `stored` (2xx), `keep` (503, timeout, unreachable: retry at the next run_end), `refused` (4xx). */
export type PdaUsagePostOutcome = "stored" | "keep" | "refused";

export interface PdaUsageSinkOptions {
  sessionName: string;
  nodeId: string | null;
  generation: string | null;
  agent: string;
  /** Whether pda's submission id (as text) is one this seat made (the runner's own-submissions list). */
  isOwnSubmission: (submissionId: string) => boolean;
  post: (payload: PdaUsagePayload) => Promise<PdaUsagePostOutcome>;
  maxPending?: number;
}

export interface PdaUsageReporter extends PdaUsageSink {
  /** Facts not yet stored by the daemon. */
  pending(): readonly PdaUsageFact[];
  /** Facts dropped: refused by the daemon, unbuildable from the entry, or pushed out past the bound. */
  dropped(): number;
  /** Resolves when the post in flight (if any) has finished. */
  settled(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** One assistant entry's fact, or null when the entry is not an assistant message with usage. */
export function pdaUsageFactFromEntry(entry: unknown, origin: PdaUsageOrigin): PdaUsageFact | null {
  if (!isObj(entry)) return null;
  const entryId = idText(entry.id);
  const conversationId = idText(entry.conversationId);
  const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
  if (entryId === null || conversationId === null || !isObj(message) || message.role !== "assistant" || !isObj(message.usage)) return null;
  const u = message.usage;
  const tokens = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const n = tokens[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  }
  const ts = message.timestamp;
  const entryTimestamp = typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : typeof ts === "string" && ts.length > 0 ? ts : null;
  if (entryTimestamp === null) return null;
  const counts = tokens as unknown as { input: number; output: number; cacheRead: number; cacheWrite: number };
  const { costTotal, costBasis } = derivePdaCost(u.cost, counts);
  const fact: PdaUsageFact = {
    conversationId, entryId, entryTimestamp, kind: "assistant",
    provider: strOrNull(message.provider), model: strOrNull(message.model), api: strOrNull(message.api),
    responseId: strOrNull(message.responseId), stopReason: strOrNull(message.stopReason),
    ...counts, costTotal, costBasis, origin,
  };
  // The receiving side's own check (L0), applied before anything is queued: a fact the route would refuse is never sent.
  return parsePdaUsageFact(fact) ? fact : null;
}

export function createPdaUsageSink(options: PdaUsageSinkOptions): PdaUsageReporter {
  const max = options.maxPending ?? PDA_USAGE_PENDING_MAX;
  let pending: PdaUsageFact[] = [];
  let dropped = 0;
  let runOrigin: PdaUsageOrigin | null = null;
  let inFlight: Promise<void> | null = null;

  const key = (f: PdaUsageFact): string => `${f.conversationId}\u0000${f.entryId}`;

  const queue = (fact: PdaUsageFact): void => {
    const at = pending.findIndex((f) => key(f) === key(fact));
    if (at >= 0) {
      // An unknown origin settles to a known one; a known one is never changed. The upgrade is a NEW object (review U1):
      // a batch in flight holds the old one, and its reply removes exactly the objects it sent, so the upgraded fact
      // stays pending and is posted next, where the store settles unknown -> own/other.
      const existing = pending[at]!;
      if (existing.origin === "unknown" && fact.origin !== "unknown") pending[at] = { ...existing, origin: fact.origin };
      return;
    }
    pending.push(fact);
    if (pending.length > max) { dropped += pending.length - max; pending = pending.slice(pending.length - max); }
  };

  const flush = (): void => {
    if (inFlight || pending.length === 0) return;
    const batch = pending.slice();
    const payload: PdaUsagePayload = {
      sessionName: options.sessionName, nodeId: options.nodeId, generation: options.generation, agent: options.agent, facts: batch,
    };
    let settledDefinitively = false;
    inFlight = (async () => {
      let outcome: PdaUsagePostOutcome;
      try { outcome = await options.post(payload); } catch { outcome = "keep"; }
      if (outcome !== "keep") {
        // By identity, not by key: a fact upgraded while this post was in flight is a different object and stays (U1).
        const sent = new Set(batch);
        const before = pending.length;
        pending = pending.filter((f) => !sent.has(f));
        if (outcome === "refused") dropped += before - pending.length;
        settledDefinitively = true;
      }
    })().finally(() => {
      inFlight = null;
      // What is still pending after a stored or refused post was queued (or upgraded) while it was in flight: send it
      // now rather than at the next run_end, which may never come before the runner exits (L3 finding). After `keep`
      // the daemon just said it cannot take facts, so nothing is re-posted until the next run_end (no spin on a 503).
      if (settledDefinitively) flush();
    });
  };

  return {
    onRunStart(event) {
      const inputs = Array.isArray(event.inputs) ? event.inputs.map(idText).filter((id): id is string => id !== null) : [];
      runOrigin = inputs.length === 0 ? "unknown" : inputs.some((id) => options.isOwnSubmission(id)) ? "own" : "other";
    },
    onAssistantEntry(entry) {
      const fact = pdaUsageFactFromEntry(entry, runOrigin ?? "unknown");
      if (!fact) { if (isObj(entry)) dropped += 1; return; }
      queue(fact);
    },
    onGapEntry(entry) {
      const fact = pdaUsageFactFromEntry(entry, "unknown");
      if (!fact) { if (isObj(entry)) dropped += 1; return; }
      queue(fact);
    },
    flush,
    onRunEnd() {
      runOrigin = null;
      flush();
    },
    pending: () => pending,
    dropped: () => dropped,
    settled: async () => { while (inFlight) await inFlight; },
  };
}

/** The real poster: `POST /api/activity/pda-usage` with the activity-hook token, a 3 s budget. */
export function createPdaUsagePoster(
  endpoint: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): (payload: PdaUsagePayload) => Promise<PdaUsagePostOutcome> {
  return async (payload) => {
    if (!endpoint || typeof fetchImpl !== "function") return "keep";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetchImpl(new URL("/api/activity/pda-usage", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return "stored";
      return res.status === 503 || res.status >= 500 ? "keep" : "refused";
    } catch {
      return "keep";
    } finally {
      clearTimeout(timer);
    }
  };
}
