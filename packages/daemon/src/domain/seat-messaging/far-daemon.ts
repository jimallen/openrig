import { createHash } from "node:crypto";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";
import { loadHostRegistry, resolveHost, type HostRegistryLoadResult, type HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { SEAT_MESSAGE_ID_PREFIX } from "../outbox-handler.js";
import type { GateLookup, LastHop, LastHopResult, MessageId, SeatGate, SeatMessage } from "./ports.js";
import type { SeatDirectory, SeatFate, SeatMessagingPorts, SenderReturn, SenderReturnResult } from "./pump-ports.js";

/**
 * Cross-host (S4 design, section 2). The far daemon owns the last hop: gate, marker, FIFO and pauses. The sender's daemon owns one hop, to the
 * far daemon, behind the same two ports as any seat: `RemoteDaemonHop` is its `LastHop`, and `RemoteDaemonGate` its `SeatGate`. Decision 36: the
 * sender's row stays open until the far row is `received`, so `received` here means what it means everywhere: the body reached the agent. A far row
 * that is still open is a named wait (`far_held`), and one that ended ends this row, which tells its sender here. The cost is this daemon's polling,
 * and a row that stays open while the far host is unreachable.
 */

/** The capability's value on `/healthz`. Absent: a build, or a pump setting, that takes no `/api/messages/accept`. A 404 from the route is never
 *  read as this: a proxy, a read-through or a wrong URL answers 404 too. */
export const MESSAGING_CAPABILITY = 1;
/** The far route's answer for a row it does not hold. Only this body means "not seen": an old daemon's 404 has none. */
export const MESSAGE_NOT_FOUND = "message_not_found";

/** The far `/accept`'s two final answers, at the head of its error text, because that text is all a remote failure carries. */
export const SEAT_UNRESOLVED = "seat_unresolved";
export const SEAT_NOT_GATED = "seat_not_gated";

const FAR_REQUEST_TIMEOUT_MS = 10_000;
const CAPABILITY_TTL_MS = 30_000;
const FAR_SEAT = /^far:([^:]+):(.+)$/;
const CROSS_HOST_ID_PREFIX = `${SEAT_MESSAGE_ID_PREFIX}xh-`;

/** The local row's destination. Never a seat's own name, and never `member@rig@host`, since a rig can share a host's name. */
export function farSeatName(hostId: string, seat: string): string {
  return `far:${hostId}:${seat}`;
}

export function parseFarSeat(seat: string): { hostId: string; seat: string } | null {
  const match = FAR_SEAT.exec(seat);
  return match ? { hostId: match[1]!, seat: match[2]! } : null;
}

/** The far row's id: a pure function of (origin host, id), like `deriveCrossHostSuccessorId`, so a repeat lands on one row, two origins never meet,
 *  and a caller's text never becomes an id. It sits under a prefix `/outbox/record` and `rig send --id` already refuse. */
export function crossHostMessageId(originHost: string, id: string): string {
  return `${CROSS_HOST_ID_PREFIX}${createHash("sha256").update(JSON.stringify([originHost, id])).digest("hex").slice(0, 32)}`;
}

export function isCrossHostMessageId(id: string): boolean {
  return id.startsWith(CROSS_HOST_ID_PREFIX);
}

export type FarCapability = "capable" | "legacy" | "unknown";
export type FarSeatAnswer = { readonly kind: "takes"; readonly seat: string } | { readonly kind: "no" } | { readonly kind: "unreachable" };
/** `unreported`: the far row exists, on a build that does not say how it stands. */
export type FarRowState = "received" | "undeliverable" | "open" | "unreported" | "absent" | "unavailable";
export interface FarDelivery { readonly id: MessageId; readonly seat: string; readonly body: string; readonly messageClass: string; readonly sender: string }
export type FarAcceptAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly code?: typeof SEAT_UNRESOLVED | typeof SEAT_NOT_GATED };

export interface FarDaemonsDeps {
  selfHost: () => string | null;
  loadRegistry?: () => HostRegistryLoadResult;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  capabilityTtlMs?: number;
}

/** One client of the far daemons, shared by the route and the pump's two ports. */
export class FarDaemons {
  private readonly clock: () => number;
  private readonly capabilityTtlMs: number;
  private readonly capabilities = new Map<string, { capable: boolean; readAtMs: number }>();

  constructor(private readonly deps: FarDaemonsDeps) {
    this.clock = deps.clock ?? Date.now;
    this.capabilityTtlMs = deps.capabilityTtlMs ?? CAPABILITY_TTL_MS;
  }

  get selfHost(): string | null { return this.deps.selfHost(); }

  private httpHost(hostId: string): HttpHostEntry | null {
    const registry = (this.deps.loadRegistry ?? loadHostRegistry)();
    if (!registry.ok) return null;
    const resolved = resolveHost(registry.registry, hostId);
    return resolved.ok && resolved.host.transport === "http" ? resolved.host : null;
  }

  private request(host: HttpHostEntry, path: string, method: "GET" | "POST", body?: unknown) {
    return remoteJsonRequest(host, path, { method, body, timeoutMs: FAR_REQUEST_TIMEOUT_MS, fetchImpl: this.deps.fetchImpl });
  }

  /** Read at most once per TTL. A far daemon that does not answer keeps its last known value: it is down, which says nothing of its build. */
  async capability(hostId: string): Promise<FarCapability> {
    const host = this.httpHost(hostId);
    if (!host) return "legacy";
    const known = this.capabilities.get(hostId);
    if (known && this.clock() - known.readAtMs < this.capabilityTtlMs) return known.capable ? "capable" : "legacy";
    const res = await this.request(host, "/healthz", "GET");
    if (!res.ok) return known ? (known.capable ? "capable" : "legacy") : "unknown";
    const capable = (res.payload as { messaging?: unknown } | null | undefined)?.messaging === MESSAGING_CAPABILITY;
    this.capabilities.set(hostId, { capable, readAtMs: this.clock() });
    return capable ? "capable" : "legacy";
  }

  async seatAnswer(hostId: string, seat: string): Promise<FarSeatAnswer> {
    const host = this.httpHost(hostId);
    if (!host) return { kind: "no" };
    const res = await this.request(host, `/api/messages/takes?seat=${encodeURIComponent(seat)}`, "GET");
    if (!res.ok) return { kind: "unreachable" };
    const answer = res.payload as { takes?: unknown; seat?: unknown } | null | undefined;
    return answer?.takes === true && typeof answer.seat === "string" ? { kind: "takes", seat: answer.seat } : { kind: "no" };
  }

  async rowState(hostId: string, farId: string): Promise<FarRowState> {
    const host = this.httpHost(hostId);
    if (!host) return "unavailable";
    const res = await this.request(host, `/api/messages/${encodeURIComponent(farId)}`, "GET");
    if (res.ok) {
      const state = (res.payload as { state?: unknown } | null | undefined)?.state;
      return state === "received" || state === "undeliverable" || state === "open" ? state : "unreported";
    }
    return res.kind === "http" && res.status === 404 && res.detail === MESSAGE_NOT_FOUND ? "absent" : "unavailable";
  }

  async accept(hostId: string, delivery: FarDelivery): Promise<FarAcceptAnswer> {
    const host = this.httpHost(hostId);
    const self = this.selfHost;
    if (!host || !self) return { ok: false, reason: `no http route to ${hostId}, or this host has no id yet` };
    const res = await this.request(host, "/api/messages/accept", "POST", {
      id: delivery.id, seat: delivery.seat, body: delivery.body, class: delivery.messageClass, origin: { host: self, sender: originSender(delivery.sender, self) },
    });
    if (res.ok) return { ok: true };
    const reason = `${res.kind}${res.status === undefined ? "" : ` ${res.status}`}: ${res.detail}`;
    const code = res.kind !== "http" ? undefined : res.status === 404 && res.detail.startsWith(`${SEAT_UNRESOLVED}:`) ? SEAT_UNRESOLVED : res.status === 409 && res.detail.startsWith(`${SEAT_NOT_GATED}:`) ? SEAT_NOT_GATED : undefined;
    return { ok: false, reason, ...(code ? { code } : {}) };
  }
}

/** The sender as the far daemon stores it: a seat's address plus its host, so the far end can find the way back. */
function originSender(sender: string, selfHost: string): string {
  return sender.split("@").length === 2 ? `${sender}@${selfHost}` : sender;
}

/** Reads the far row each time and remembers nothing here, so a crash between the far commit and the local one costs one read. */
export class RemoteDaemonGate implements SeatGate {
  readonly version = 1;
  constructor(private readonly far: FarDaemons, private readonly clock: () => number = Date.now) {}

  async lookup(seat: string, id: MessageId): Promise<GateLookup> {
    const parsed = parseFarSeat(seat);
    const self = this.far.selfHost;
    if (!parsed || !self) return { kind: "unavailable", cause: "no far seat, or this host has no id yet" };
    const capability = await this.far.capability(parsed.hostId);
    if (capability !== "capable") return { kind: "unavailable", cause: `${parsed.hostId} is ${capability === "legacy" ? "on a build that takes no accept" : "not answering"}` };
    const state = await this.far.rowState(parsed.hostId, crossHostMessageId(self, id));
    if (state === "absent") return { kind: "not_seen" };
    if (state === "unavailable") return { kind: "unavailable", cause: `${parsed.hostId} did not say` };
    if (state === "undeliverable") return { kind: "ended", reason: `${parsed.hostId} could not deliver it to ${parsed.seat}` };
    if (state === "open") return { kind: "waiting", reason: "far_held" };
    if (state === "unreported") return { kind: "waiting", reason: "far_no_state" };
    return { kind: "seen", record: { id, recordedAt: new Date(this.clock()).toISOString(), nonce: null, evidence: "far_received" } };
  }
}

/** One hop, to the far daemon. Safe to repeat: the far accept is idempotent on (origin host, id). */
export class RemoteDaemonHop implements LastHop {
  constructor(private readonly far: FarDaemons, private readonly senderOf: (id: MessageId) => string | null) {}

  async attempt(message: SeatMessage): Promise<LastHopResult> {
    const parsed = parseFarSeat(message.seat);
    if (!parsed) return { kind: "refused", reason: `${message.seat} is not a far seat` };
    const id = message.ids[0];
    const answer = await this.far.accept(parsed.hostId, { id, seat: parsed.seat, body: message.body, messageClass: message.messageClass, sender: this.senderOf(id) ?? "unknown" });
    if (answer.ok) return { kind: "sent" };
    if (answer.code === SEAT_UNRESOLVED) return { kind: "gone", reason: `${parsed.seat} is not a seat on ${parsed.hostId}: ${answer.reason}` };  // decision 37
    if (answer.code === SEAT_NOT_GATED) return { kind: "paused", reason: "far_not_gated" };
    return { kind: "refused", reason: answer.reason };
  }
}

/** A far seat has its two ports; every other seat is as it was. */
export function withFarSeats(ports: SeatMessagingPorts, far: FarDaemons, senderOf: (id: MessageId) => string | null): SeatMessagingPorts {
  const gate = new RemoteDaemonGate(far);
  const hop = new RemoteDaemonHop(far, senderOf);
  return {
    gateFor: (seat) => (parseFarSeat(seat) ? gate : ports.gateFor(seat)),
    hopFor: (seat) => (parseFarSeat(seat) ? hop : ports.hopFor(seat)),
  };
}

/** What became of a far seat is the far daemon's to know, and its row ends there: no record here can call one gone. */
export class FarSeatDirectory implements SeatDirectory {
  constructor(private readonly inner: SeatDirectory) {}

  fate(seat: string): SeatFate {
    return parseFarSeat(seat) ? { kind: "live", occupantGeneration: null } : this.inner.fate(seat);
  }
}

/** A message from another host that can never arrive here. Its origin's daemon polls this row and tells its sender (decision 36), so this daemon
 *  posts nothing to anyone: a sender's claimed host is never a place it sends text. The row counts as returned, because its origin will know. */
export class OriginPollsSenderReturn implements SenderReturn {
  constructor(private readonly inner: SenderReturn, private readonly selfHost: () => string | null) {}

  async returnToSender(message: { readonly id: MessageId; readonly seat: string; readonly sender: string; readonly body: string }, reason: string): Promise<SenderReturnResult> {
    const host = message.sender.split("@")[2];
    if (host === undefined || host === this.selfHost()) return this.inner.returnToSender(message, reason);
    return { kind: "returned", qitemId: `origin-polls:${host}` };
  }
}
