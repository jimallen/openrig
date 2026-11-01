// Seat Messaging, stage S2: the Codex seat's gate. The store and its reconcile are the hook gate's (hook-seen-store.ts, hook-seat-gate.ts),
// which know no runtime; the relay's UserPromptSubmit records and blocks. What is Codex's is which rollout records hold a prompt.
//
// Measured on a real 0.166.0 rollout (s0-live, 2026-11-01), counting each marker per record kind: a delivered message is one
// `response_item` / `message` / `user` record. A prompt the hook blocked is none (X2, sent twice with one block, has one), and a prompt a
// crashed hook let through is one (X5). `compacted` records repeat old prompts, once per compaction, and `item_completed` echoes them,
// so a substring search of the file would not do: neither is read here.

import fs from "node:fs";
import { NATIVE_MARKER_RE } from "../domain/claude-native-inbox.js";
import type { MessageId, SeatGate } from "../domain/seat-messaging/ports.js";
import { hookSeatGate } from "./hook-seat-gate.js";
import { reconcileSeen, type HookSeenStore, type SeenReconcile } from "./hook-seen-store.js";
import { seatMarkerKey, type SeatMarker } from "./seat-gate-marker.js";

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
      for (const match of part.text.matchAll(NATIVE_MARKER_RE)) {
        const marker = { id: match[1]!, nonce: match[2]! };
        found.set(seatMarkerKey(marker), marker);
      }
    }
  }
  return found;
}

function rolloutIncludes(path: string, needle: string): boolean | null {
  const markers = codexRolloutMarkers(path);
  if (markers === null) return null;
  const key = /^\[openrig-msg (.+)\]$/.exec(needle)?.[1];
  return key !== undefined && markers.has(key);
}

export interface CodexSeatGateDeps {
  store: HookSeenStore;
  nonceOf: (id: MessageId) => string | null;
  /** The rollout of the seat's current thread, when known. */
  rolloutPathOf: (seat: string) => string | null;
}

export function codexSeatGate(deps: CodexSeatGateDeps): SeatGate {
  return hookSeatGate({
    store: deps.store, nonceOf: deps.nonceOf, fileIncludes: rolloutIncludes,
    transcriptsOf: (seat) => { const path = deps.rolloutPathOf(seat); return path === null ? [] : [path]; },
  });
}

/** Run on a seat restart, with the old process gone and before the new one starts. A Codex hook names no agent pid. */
export function reconcileCodexSeatGate(store: HookSeenStore, seat: string, rolloutPath: string | null): SeenReconcile {
  return reconcileSeen({ store, seat, transcripts: [rolloutPath], processAlive: () => false, markers: codexRolloutMarkers, agentGone: true });
}
