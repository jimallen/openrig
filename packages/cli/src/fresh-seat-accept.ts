import { DaemonConnectionError, DaemonResponseError } from "./client.js";

/** What an operator's "y" to "start a fresh session instead?" does: one per-seat fresh launch for each accepted seat.
 *  It is NOT a second whole-rig `/api/up` with `freshLogicalIds`: that restore is refused (`rig_not_stopped`, HTTP 409)
 *  while any sibling is live, and a restore that stops a seat for a decision has usually just started its siblings.
 *  `POST /api/seat/launch/<seat>@<rig>` is the route behind `rig seat launch --fresh` and touches only that seat.
 *  Every non-2xx answer (or `ok: false`) is returned as a failure for the caller to print; none is dropped. */
export interface FreshSeatOutcome {
  logicalId: string;
  ok: boolean;
  /** HTTP status, or null when the daemon did not answer in time. */
  httpStatus: number | null;
  /** The daemon's refusal text (or the timeout note) when `ok` is false. */
  message: string | null;
}

export async function launchAcceptedFreshSeats(
  client: { post<T = unknown>(path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<{ status: number; data: T }> },
  logicalIds: string[],
  rigName: string,
  reason: string,
  timeoutMs: number,
): Promise<FreshSeatOutcome[]> {
  const outcomes: FreshSeatOutcome[] = [];
  for (const logicalId of logicalIds) {
    try {
      const res = await client.post<Record<string, unknown>>(
        `/api/seat/launch/${encodeURIComponent(`${logicalId}@${rigName}`)}`,
        { fresh: true, reason },
        { timeoutMs },
      );
      const data = (res.data ?? {}) as Record<string, unknown>;
      const ok = res.status >= 200 && res.status < 300 && data["ok"] !== false;
      const code = typeof data["code"] === "string" ? `${data["code"]}: ` : "";
      const text = typeof data["message"] === "string" ? data["message"] : typeof data["error"] === "string" ? data["error"] : "fresh launch refused";
      outcomes.push({ logicalId, ok, httpStatus: res.status, message: ok ? null : `${code}${text}` });
    } catch (err) {
      // Each seat is independent: whatever happened to this one, the next is still tried and every result is returned.
      if (err instanceof DaemonResponseError) {
        outcomes.push({ logicalId, ok: false, httpStatus: err.status, message: `unreadable response from the daemon${err.bodySnippet ? ` (${err.bodySnippet.trim()})` : ""}; the launch may or may not have happened. Verify with: rig ps` });
      } else if (err instanceof DaemonConnectionError) {
        outcomes.push({ logicalId, ok: false, httpStatus: null, message: `no answer from the daemon (${err.message}); it may still be launching. Verify with: rig ps` });
      } else {
        outcomes.push({ logicalId, ok: false, httpStatus: null, message: `${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  return outcomes;
}
