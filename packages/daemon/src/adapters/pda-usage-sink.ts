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
// Delivery: facts are kept until the daemon stores them. A transient answer keeps them for the next run_end: 408, 429,
// 503 (the setting is off, or the store is unconfigured), any 5xx, a timeout or a connection failure. The route is
// idempotent on (conversation, entry), so a resend after a lost reply stores nothing twice. A permanent refusal (every
// other non-2xx: 400, 401, 403, 404, 413, 422 ...) drops the posted facts: a resend could never succeed. A drop is
// counted ONCE per fact (a replayed entry that is dropped again is not counted again) with a reason (`http_<status>`,
// `pending_overflow`, `unbuildable`), and logged as a code and a number. One post is in flight at a time; facts queued
// behind it are posted as soon as it settles stored or refused (not only at the next run_end). The pending list is
// bounded; past the bound the OLDEST facts are dropped and counted.
//
// Stop (OF-93): `close()` posts what is pending with a bounded wait, then persists whatever is still unsent to the
// seat's `usage-pending.json` (tmp + fsync + rename + fsync of the directory, as the outbox persists). The next runner
// start loads that file into its pending list, and the daemon's (conversation, entry) idempotence makes a resend of a
// fact that was in fact stored harmless. The file carries the ENVELOPE the facts were produced under (agent, baseUrl,
// nodeId, generation), as the outbox scopes its records to a binding (A1): a group whose agent and baseUrl equal the
// current binding is posted under ITS OWN nodeId and generation; any other group is never posted, stays in the file
// (rewritten at close) and is reported as `usage facts held: reason=binding_mismatch`. A hard crash or `proc.exit(70)` skips close(): facts pending at that moment
// are lost, as before.
// Numbers and ids only: never text, tool output or the token (T32).

import fs from "node:fs";
import nodePath from "node:path";
import { derivePdaCost, parsePdaUsageFact, type PdaUsageFact, type PdaUsageOrigin, type PdaUsagePayload } from "./pda-runner-protocol.js";
import { idText } from "./pda-render.js";
import { chunkUsagePost } from "../domain/usage-post-limits.js";
import type { PdaUsageSink } from "./pda-runner.js";

export const PDA_USAGE_PENDING_MAX = 2000;

/** What a post did: `stored` (2xx), `keep` (408, 429, 5xx, timeout, unreachable: retry at the next run_end), `refused`
 *  (any other non-2xx: permanent). A poster may name the status of a refusal with the object form. */
export type PdaUsagePostOutcome = "stored" | "keep" | "refused";
export type PdaUsagePostResult = PdaUsagePostOutcome | { outcome: PdaUsagePostOutcome; status?: number; rejected?: number };

/** The statuses a daemon can answer that a resend might outlive. Everything else non-2xx is permanent. */
export const PDA_USAGE_TRANSIENT_STATUSES: readonly number[] = [408, 429, 503];
export const pdaUsageStatusIsTransient = (status: number): boolean => PDA_USAGE_TRANSIENT_STATUSES.includes(status) || status >= 500;

export const PDA_USAGE_CLOSE_BUDGET_MS = 5000;
const DROPPED_KEYS_MAX = 10_000;

export interface PdaUsageSinkOptions {
  sessionName: string;
  nodeId: string | null;
  generation: string | null;
  agent: string;
  /** Whether pda's submission id (as text) is one this seat made (the runner's own-submissions list). */
  isOwnSubmission: (submissionId: string) => boolean;
  post: (payload: PdaUsagePayload) => Promise<PdaUsagePostResult>;
  maxPending?: number;
  /** The seat's `usage-pending.json`. When set, a start loads it and close() persists what is still unsent. */
  spillPath?: string;
  /** The pda base URL this seat is bound to; with `agent` it scopes the spill file (default ""). */
  baseUrl?: string;
  /** A line for the operator: codes and numbers only. */
  log?: (line: string) => void;
}

export interface PdaUsageReporter extends PdaUsageSink {
  /** Facts not yet stored by the daemon. */
  pending(): readonly PdaUsageFact[];
  /** Facts dropped: refused by the daemon, unbuildable from the entry, or pushed out past the bound. */
  dropped(): number;
  /** Why facts were dropped: reason code -> number of facts, each fact counted once. */
  droppedReasons(): Readonly<Record<string, number>>;
  /** Resolves when the post in flight (if any) has finished. */
  settled(): Promise<void>;
  /** Stop: post what is pending within `budgetMs`, then persist what is still unsent. Safe to call twice. */
  close(budgetMs?: number): Promise<void>;
}

/** The posting envelope facts were produced under. `agent` + `baseUrl` is the binding (A1); the rest rides the post. */
export interface PdaUsageSpillGroup { agent: string; baseUrl: string; nodeId: string | null; generation: string | null; facts: PdaUsageFact[] }

/** Read a seat's persisted unsent facts, grouped by envelope. Anything unreadable or failing L0's check is skipped; never throws. */
export function readPdaUsageSpill(path: string): PdaUsageSpillGroup[] {
  try {
    const doc = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!isObj(doc) || doc.v !== 2 || !Array.isArray(doc.groups)) return [];
    const groups: PdaUsageSpillGroup[] = [];
    for (const g of doc.groups as unknown[]) {
      if (!isObj(g) || typeof g.agent !== "string" || typeof g.baseUrl !== "string" || !Array.isArray(g.facts)) continue;
      const facts = g.facts.map(parsePdaUsageFact).filter((f): f is PdaUsageFact => f !== null);
      if (facts.length === 0) continue;
      groups.push({ agent: g.agent, baseUrl: g.baseUrl, nodeId: strOrNull(g.nodeId), generation: strOrNull(g.generation), facts });
    }
    return groups;
  } catch { return []; }
}

/** Persist unsent facts: tmp + fsync + rename + fsync of the directory. No facts removes the file. */
export function writePdaUsageSpill(path: string, groups: readonly PdaUsageSpillGroup[]): void {
  const live = groups.filter((g) => g.facts.length > 0);
  if (live.length === 0) { try { fs.unlinkSync(path); } catch { /* already gone */ } return; }
  const dir = nodePath.dirname(path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`; // per process: an overlapping old runner and its successor never share one
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, JSON.stringify({ v: 2, groups: live })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
  const dfd = fs.openSync(dir, "r");
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
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
  // OF-129: the checked fact, with an over-long label read as null (its tokens and cost are kept).
  return parsePdaUsageFact(fact);
}

export function createPdaUsageSink(options: PdaUsageSinkOptions): PdaUsageReporter {
  const max = options.maxPending ?? PDA_USAGE_PENDING_MAX;
  let pending: PdaUsageFact[] = [];
  let dropped = 0;
  const reasons: Record<string, number> = {};
  const droppedKeys = new Set<string>();
  let closing: Promise<void> | null = null;
  let runOrigin: PdaUsageOrigin | null = null;
  let inFlight: Promise<void> | null = null;

  const key = (f: PdaUsageFact): string => `${f.conversationId}\u0000${f.entryId}`;

  /** Count a drop once per fact. `id` is null for an entry whose identity cannot be read (counted each time). */
  const countDrop = (id: string | null, reason: string): boolean => {
    if (id !== null) {
      if (droppedKeys.has(id)) return false;
      droppedKeys.add(id);
      if (droppedKeys.size > DROPPED_KEYS_MAX) droppedKeys.delete(droppedKeys.values().next().value as string);
    }
    dropped += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    return true;
  };
  const entryKey = (entry: unknown): string | null => {
    if (!isObj(entry)) return null;
    const e = idText(entry.id); const c = idText(entry.conversationId);
    return e !== null && c !== null ? `${c}\u0000${e}` : null;
  };
  const dropUnbuildable = (entry: unknown): void => {
    if (!isObj(entry)) return;
    if (countDrop(entryKey(entry), "unbuildable")) options.log?.("[pda-runner] usage fact dropped: reason=unbuildable count=1");
  };
  // Spilled facts keep the envelope they were produced under (F1). Facts without an entry here use this launch's.
  const baseUrl = options.baseUrl ?? "";
  type Env = { nodeId: string | null; generation: string | null };
  const carried = new WeakMap<PdaUsageFact, Env>();
  const envOf = (f: PdaUsageFact): Env => carried.get(f) ?? { nodeId: options.nodeId, generation: options.generation };
  const sameEnv = (a: Env, b: Env): boolean => a.nodeId === b.nodeId && a.generation === b.generation;
  let held: PdaUsageSpillGroup[] = [];
  if (options.spillPath) {
    let heldCount = 0;
    for (const g of readPdaUsageSpill(options.spillPath)) {
      if (g.agent === options.agent && g.baseUrl === baseUrl) {
        for (const f of g.facts) { carried.set(f, { nodeId: g.nodeId, generation: g.generation }); pending.push(f); }
      } else { held.push(g); heldCount += g.facts.length; }
    }
    if (heldCount > 0) options.log?.(`[pda-runner] usage facts held: reason=binding_mismatch count=${heldCount}`);
  }

  const queue = (fact: PdaUsageFact): void => {
    const at = pending.findIndex((f) => key(f) === key(fact));
    if (at >= 0) {
      // An unknown origin settles to a known one; a known one is never changed. The upgrade is a NEW object (review U1):
      // a batch in flight holds the old one, and its reply removes exactly the objects it sent, so the upgraded fact
      // stays pending and is posted next, where the store settles unknown -> own/other.
      const existing = pending[at]!;
      if (existing.origin === "unknown" && fact.origin !== "unknown") {
        const upgraded = { ...existing, origin: fact.origin };
        const env = carried.get(existing);
        if (env) carried.set(upgraded, env);
        pending[at] = upgraded;
      }
      return;
    }
    pending.push(fact);
    if (pending.length > max) {
      const out = pending.slice(0, pending.length - max);
      pending = pending.slice(pending.length - max);
      let counted = 0;
      for (const f of out) if (countDrop(key(f), "pending_overflow")) counted += 1;
      if (counted > 0) options.log?.(`[pda-runner] usage facts dropped: reason=pending_overflow count=${counted}`);
    }
  };

  const flush = (): void => {
    if (inFlight || pending.length === 0) return;
    // One post carries one envelope: the oldest pending fact's, and every pending fact that shares it.
    const env = envOf(pending[0]!);
    // OF-105: and only as many as fit one post under the daemon's byte cap (a 413 would drop the whole batch). What is
    // left is posted next: a stored or refused post flushes again at once (below), a kept one waits for the next run_end.
    const batch = chunkUsagePost(pending.filter((f) => sameEnv(envOf(f), env)))[0]!;
    const payload: PdaUsagePayload = {
      sessionName: options.sessionName, nodeId: env.nodeId, generation: env.generation, agent: options.agent, facts: batch,
    };
    let settledDefinitively = false;
    inFlight = (async () => {
      let outcome: PdaUsagePostOutcome;
      let status: number | undefined;
      let rejected = 0;
      try {
        const r = await options.post(payload);
        outcome = typeof r === "string" ? r : r.outcome;
        status = typeof r === "string" ? undefined : r.status;
        rejected = typeof r === "string" ? 0 : r.rejected ?? 0;
      } catch { outcome = "keep"; }
      if (outcome !== "keep") {
        // By identity, not by key: a fact upgraded while this post was in flight is a different object and stays (U1).
        const sent = new Set(batch);
        pending = pending.filter((f) => !sent.has(f));
        if (outcome === "refused") {
          const reason = status === undefined ? "refused" : `http_${status}`;
          let counted = 0;
          for (const f of batch) if (!pending.includes(f) && countDrop(key(f), reason)) counted += 1;
          if (counted > 0) options.log?.(`[pda-runner] usage facts dropped: reason=${reason} count=${counted}`);
        }
        // OF-129: a 2xx that says it did not take some facts (`rejected`) did not store them. Which ones is not named, so the
        // count is recorded and logged as one; they were not kept, because the daemon will not take them on a resend either.
        if (outcome === "stored" && rejected > 0) {
          dropped += rejected;
          reasons.daemon_rejected = (reasons.daemon_rejected ?? 0) + rejected;
          options.log?.(`[pda-runner] usage facts dropped: reason=daemon_rejected count=${rejected}`);
        }
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
      if (!fact) { dropUnbuildable(entry); return; }
      queue(fact);
    },
    onGapEntry(entry) {
      const fact = pdaUsageFactFromEntry(entry, "unknown");
      if (!fact) { dropUnbuildable(entry); return; }
      queue(fact);
    },
    flush,
    onRunEnd() {
      runOrigin = null;
      flush();
    },
    pending: () => pending,
    dropped: () => dropped,
    droppedReasons: () => ({ ...reasons }),
    settled: async () => { while (inFlight) await inFlight; },
    close(budgetMs = PDA_USAGE_CLOSE_BUDGET_MS) {
      closing ??= (async () => {
        flush();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); });
        const drained = (async () => { while (inFlight) await inFlight; })();
        try { await Promise.race([drained, deadline]); } finally { clearTimeout(timer); }
        if (options.spillPath) {
          try {
            const groups: PdaUsageSpillGroup[] = [...held];
            for (const f of pending) {
              const env = envOf(f);
              const g = groups.find((x) => x.agent === options.agent && x.baseUrl === baseUrl && x.nodeId === env.nodeId && x.generation === env.generation);
              if (g) g.facts.push(f);
              else groups.push({ agent: options.agent, baseUrl, nodeId: env.nodeId, generation: env.generation, facts: [f] });
            }
            writePdaUsageSpill(options.spillPath, groups);
          }
          catch { options.log?.(`[pda-runner] usage facts could not be persisted: count=${pending.length}`); }
        }
      })();
      return closing;
    },
  };
}

const REPLY_MAX_BYTES = 65_536;
/** The `rejected` count of a 2xx reply; 0 when the body is absent, larger than REPLY_MAX_BYTES (never read past it), not JSON or
 *  has no such count. The reply is advice about this post, not authority over it, so every doubt reads as 0. */
async function readRejectedCount(res: Response): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return 0;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REPLY_MAX_BYTES) { await reader.cancel().catch(() => undefined); return 0; }
      chunks.push(value);
    }
    const n = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rejected?: unknown } | null)?.rejected;
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/** The real poster: `POST /api/activity/pda-usage` with the activity-hook token, a 3 s budget. */
export function createPdaUsagePoster(
  endpoint: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): (payload: PdaUsagePayload) => Promise<PdaUsagePostResult> {
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
      if (res.ok) {
        // OF-129: a 2xx can still say `rejected: n` (a fact the daemon would not take). Read the count, never the rest.
        const rejected = await readRejectedCount(res);
        return rejected > 0 ? { outcome: "stored", rejected } : "stored";
      }
      await res.body?.cancel().catch(() => undefined);
      return pdaUsageStatusIsTransient(res.status) ? "keep" : { outcome: "refused", status: res.status };
    } catch {
      return "keep";
    } finally {
      clearTimeout(timer);
    }
  };
}
