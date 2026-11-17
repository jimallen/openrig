import type { SeatLeaseStore } from "../adapters/seat-lease-store.js";
import { freshSeatLeaseRefusal } from "../domain/relaunch-checks.js";

/**
 * workspaces-o9o.71: the lease judgement a restore makes for each seat it starts fresh, for a restore PLAN to show, from the same lease
 * store the restore and `rig seat lease` use. Undefined when this daemon has no lease store (the plan then judges no lease, as restore).
 */
export function restoreLeaseJudge(c: { get(key: never): unknown }, rigName: string): ((logicalId: string) => ReturnType<typeof freshSeatLeaseRefusal>) | undefined {
  return leaseJudgeOf(c.get("seatLeases" as never) as SeatLeaseStore | undefined, rigName);
}

/** The same judgement from a lease store the caller already holds. */
export function leaseJudgeOf(store: Pick<SeatLeaseStore, "leases"> | undefined, rigName: string): ((logicalId: string) => ReturnType<typeof freshSeatLeaseRefusal>) | undefined {
  return store ? (logicalId: string) => freshSeatLeaseRefusal((seat) => store.leases(seat), rigName, logicalId) : undefined;
}
