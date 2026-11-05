// Seat Messaging, stage S2: the Codex seat's gate. The store and its reconcile are the hook gate's (hook-seen-store.ts, hook-seat-gate.ts),
// which know no runtime; the relay's UserPromptSubmit records and blocks. What is Codex's is which rollout records hold a prompt.
//
// Measured on a real 0.166.0 rollout (s0-live, 2026-11-01), counting each marker per record kind: a delivered message is one
// `response_item` / `message` / `user` record. A prompt the hook blocked is none (X2, sent twice with one block, has one), and a prompt a
// crashed hook let through is one (X5). `compacted` records repeat old prompts, once per compaction, and `item_completed` echoes them,
// so a substring search of the file would not do: neither is read here.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { MessageId, SeatGate } from "../domain/seat-messaging/ports.js";
import { hookSeatGate } from "./hook-seat-gate.js";
import { reconcileSeen, type HookSeenStore, type SeenReconcile } from "./hook-seen-store.js";
import { promptMarkers, seatMarkerKey, type SeatMarker } from "./seat-gate-marker.js";

/** The markers of a rollout's user prompts: empty when the file does not exist (Codex writes it with the first prompt), null when it
 *  cannot be read, which proves nothing either way. A torn last line does not parse, so it is a prompt not yet durable. */
export function codexRolloutMarkers(rolloutPath: string): Map<string, SeatMarker> | null {
  let text: string;
  try {
    text = fs.readFileSync(rolloutPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : null;
  }
  const found = new Map<string, SeatMarker>();
  for (const line of text.split("\n")) {
    if (!line.includes("[openrig-msg ")) continue;
    let entry: { type?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const { type, payload } = entry;
    if (type !== "response_item" || payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) continue;
    for (const part of payload.content as Array<{ type?: unknown; text?: unknown } | null>) {
      if (part?.type !== "input_text" || typeof part.text !== "string") continue;
      for (const marker of promptMarkers(part.text)) found.set(seatMarkerKey(marker), marker);
    }
  }
  return found;
}

/** The sha256 (hex) of every text Codex was given as a hook's context, in a rollout: a developer `message`, its `input_text` exactly (measured on a real
 *  0.166.0 rollout, OF-229: a hook that exited cleanly lands as one such record, and a hook that was killed or failed lands as none, whatever it had written
 *  to stdout). Empty when the file does not exist, null when it cannot be read. */
export function codexRolloutBodies(rolloutPath: string): Set<string> | null {
  let text: string;
  try {
    text = fs.readFileSync(rolloutPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
  }
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"developer"')) continue;
    let entry: { type?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const { type, payload } = entry;
    if (type !== "response_item" || payload?.type !== "message" || payload.role !== "developer" || !Array.isArray(payload.content)) continue;
    for (const part of payload.content as Array<{ type?: unknown; text?: unknown } | null>) {
      if (part?.type === "input_text" && typeof part.text === "string") found.add(createHash("sha256").update(part.text, "utf8").digest("hex"));
    }
  }
  return found;
}

function rolloutIncludes(path: string, needle: string): boolean | null {
  const markers = codexRolloutMarkers(path);
  if (markers === null) return null;
  const key = /^\[openrig-msg (.+)\]$/.exec(needle)?.[1];
  const marker = key === undefined ? undefined : markers.get(key);
  return marker !== undefined && marker.spooled !== true;
}

export interface CodexSeatGateDeps {
  store: HookSeenStore;
  nonceOf: (id: MessageId) => string | null;
  /** The rollout of the seat's current thread, when known. */
  rolloutPathOf: (seat: string) => string | null;
  /** How long the rollout may lag a long message's record before its text is taken as lost (see hook-seat-gate.ts). */
  bodyGraceMs?: number;
  now?: () => number;
  /** How many resends the gate allows a part whose text never shows on file (see hook-seat-gate.ts). */
  maxResends?: number;
}

export function codexSeatGate(deps: CodexSeatGateDeps): SeatGate {
  return hookSeatGate({
    store: deps.store, nonceOf: deps.nonceOf, fileIncludes: rolloutIncludes,
    bodyOnFile: (path, sha) => { const bodies = codexRolloutBodies(path); return bodies === null ? null : bodies.has(sha); },
    bodyGraceMs: deps.bodyGraceMs, now: deps.now, maxResends: deps.maxResends,
    transcriptsOf: (seat) => { const path = deps.rolloutPathOf(seat); return path === null ? [] : [path]; },
  });
}

/** Run on a seat restart, with the old process gone and before the new one starts. A Codex hook names no agent pid. */
export function reconcileCodexSeatGate(store: HookSeenStore, seat: string, rolloutPath: string | null): SeenReconcile {
  return reconcileSeen({ store, seat, transcripts: [rolloutPath], processAlive: () => false, markers: codexRolloutMarkers, bodies: codexRolloutBodies, agentGone: true });
}
