import type { SeatTerminalStatus, SeatTerminalStatusReader } from "../domain/seat-posture.js";
import type { HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-seat.js";

// OF-267 (B): the daemon's read of a seat's herdr-core terminal status for the busy report. One `terminal.get` per call, bounded by a
// timeout of its own (HcClient's timeout does not cover reaching the core or its hello), cached for a few seconds so a polled
// `rig ps` or graph does not become a call per poll per seat. Every failure (no core, no terminal, a timeout, a refused core) is
// null: the report then keeps what the hooks said.

export interface SeatTerminalStatusOptions {
  /** The whole read, connect included. */
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

export const SEAT_TERMINAL_STATUS_TIMEOUT_MS = 1_500;
export const SEAT_TERMINAL_STATUS_CACHE_MS = 5_000;

export function createSeatTerminalStatusReader(
  client: { call<T>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T> },
  options: SeatTerminalStatusOptions = {},
): SeatTerminalStatusReader {
  const timeoutMs = options.timeoutMs ?? SEAT_TERMINAL_STATUS_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? SEAT_TERMINAL_STATUS_CACHE_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: SeatTerminalStatus | null }>();

  const read = async (seat: string): Promise<SeatTerminalStatus | null> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
      const call = client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) }, { timeoutMs });
      // Promise.race subscribes to `call`, so a read that loses the race and fails later is handled there, not unhandled.
      const terminal = await Promise.race([call, timeout]);
      return {
        live: terminal.state === "live",
        status: terminal.status?.state ?? null,
        sinceMs: typeof terminal.status_ms === "number" && Number.isFinite(terminal.status_ms) ? terminal.status_ms : null,
      };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return async (seat) => {
    const hit = cache.get(seat);
    const at = now();
    if (hit && at - hit.at < cacheMs) return hit.value;
    const value = await read(seat);
    cache.set(seat, { at, value });
    return value;
  };
}
