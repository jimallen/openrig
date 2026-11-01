// hc-w45 (QA F1): how long a client of the daemon's transport routes (`/api/transport/send`, `/broadcast`) waits for the answer.
//
// The 5 s read default of the CLI client is wrong for these routes. herdr-core holds a send for about 5 s to see whether a
// status-reporting program goes `working` (it does not when the program starts no run: a pda post, a slash command), longer
// while a person types, and the daemon answers `waiting` after its own bound. A client that gives up first calls a delivered
// message UNCONFIRMED, and a person who resends has delivered it twice (a broadcast has a fresh identity each time).
//
// ONE rule, here, for every client: wait longer than the daemon will work. Only node-free constants and arithmetic, so the CLI
// imports it through the `@openrig/daemon/transport-budget` surface and the daemon's hc-input uses the same bound.

/** The longest the daemon works on one delivery before it answers (herdr-core's wait for a person to stop typing is cut here:
 *  after it the send is a `waiting` row). hc-input's `deliveryTimeoutMs` default. */
export const DAEMON_DELIVERY_BOUND_MS = 30_000;

/** What surrounds a delivery: resolving the target, the guard, the audit row, the answer, the network. */
export const TRANSPORT_MARGIN_MS = 15_000;

/** One send: past the daemon's bound with room for the rest. */
export const TRANSPORT_SEND_BUDGET_MS = DAEMON_DELIVERY_BOUND_MS + TRANSPORT_MARGIN_MS;

/** A fan-out the client cannot count (a rig, a pod, everyone: the daemon resolves them). It is budgeted as this many seats. A fleet
 *  past it is a fleet whose every seat also hits the daemon's bound; the client then reports a timeout, the daemon finishes anyway. */
export const TRANSPORT_UNSCOPED_RECIPIENTS = 32;

/** The wait for one `/api/transport/send`: the idle wait the caller asked the daemon for, then a delivery. */
export function transportSendBudgetMs(waitForIdleMs?: number): number {
  return (waitForIdleMs ?? 0) + TRANSPORT_SEND_BUDGET_MS;
}

/** The wait for one `/api/transport/broadcast`. The daemon delivers to its recipients one after another, each up to the idle wait
 *  and the delivery bound, so the total scales with the recipients (3 seats that start no run took 15.6 s). `recipients` is the
 *  count the client knows (an explicit list), else `TRANSPORT_UNSCOPED_RECIPIENTS`. */
export function transportFanoutBudgetMs(recipients?: number, waitForIdleMs?: number): number {
  const count = recipients !== undefined && Number.isSafeInteger(recipients) && recipients > 0 ? recipients : TRANSPORT_UNSCOPED_RECIPIENTS;
  return count * ((waitForIdleMs ?? 0) + DAEMON_DELIVERY_BOUND_MS) + TRANSPORT_MARGIN_MS;
}

/** A daemon route that awaits a wake to a seat inside the request (workflow project/route/resume/abort/instantiate, a mission-control
 *  resolve). Some of them wake two seats in sequence (the failed step's owner and its successor). */
export const TRANSPORT_WAKES_PER_WRITE = 2;

/** The wait for a write whose handler delivers wakes before it answers. */
export function transportWakingWriteBudgetMs(): number {
  return transportFanoutBudgetMs(TRANSPORT_WAKES_PER_WRITE);
}
