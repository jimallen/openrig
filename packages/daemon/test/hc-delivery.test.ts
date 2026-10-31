import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import type { HcSubmitOptions, HcSubmitResult } from "../src/adapters/hc-input.js";
import {
  CORE_RESTART_MARGIN_MS, HcDelivery, defaultBlockedPolicy, hcPanePid, isBlindRetrySafe, type HcDeliveryOutcome, type HcPendingSend, type HcSubmitter,
} from "../src/adapters/hc-delivery.js";

const SEAT = "qa@rig";
const ADDRESS = "t4";
/** A clock far from the wall clock, so a delivery that reads Date.now() instead of the injected clock cannot pass. */
const T0 = 4_100_000_000_000;

/** The core as the delivery sees it: a terminal, a screen, a start time, and a queue of sends it holds for a person who is
 *  typing. `landed` is what the program received; the point of every scenario is that it holds each text exactly once. */
class FakeCore {
  clock = T0;
  coreStartedAt = T0 - 600_000;
  address = ADDRESS;
  state = "live";
  reason: string | null = null;
  turn = 0;
  status: string | null = "idle";
  reported = true;
  screen = "READY\n";
  unreachable = false;
  missing = false;
  /** Sends accepted by the core and not yet typed: a person is at the keyboard. */
  queue: string[] = [];
  landed: string[] = [];
  readonly calls: string[] = [];

  terminal(): HcTerminal {
    return {
      address: this.address, name: hcTerminalName(SEAT), labels: {}, argv: [], cwd: "/", state: this.state, created_ms: 0, screen: "exact", cols: 120, rows: 40,
      turn: this.turn, reported: this.reported, reason: this.reason, status: this.status === null ? null : { state: this.status },
    };
  }

  /** The person stops typing: the core types every held send, in order. */
  personStops(): void {
    for (const text of this.queue.splice(0)) this.type(text);
  }

  type(text: string): void {
    this.landed.push(text);
    this.screen += `${text}\n`;
    if (this.reported) { this.turn += 1; this.status = "idle"; }
  }

  restartCore(): void {
    this.queue.length = 0;  // a queued send does not survive a core restart (spike 1+2)
    this.coreStartedAt = this.clock;
  }

  answer(method: string): unknown {
    this.calls.push(method);
    if (this.unreachable) throw new HcUnavailableError("hc core not reachable");
    if (this.missing && method === "terminal.get") throw new HcError("no such terminal", "not_found", -32000);
    switch (method) {
      case "terminal.get": return this.terminal();
      case "terminal.read": return { text: this.screen, complete: true, how: "screen" };
      case "server.status": return { uptime_ms: this.clock - this.coreStartedAt, pid: 1 };
      default: throw new Error(`unexpected method ${method}`);
    }
  }
}

class FakeClient extends HcClient {
  constructor(private readonly core: FakeCore) { super("/nonexistent"); }
  override async call<T>(method: string): Promise<T> {
    return this.core.answer(method) as T;
  }
}

type Script = "reply" | "silent" | HcSubmitResult;

/** The submitter's behaviour per call: it hands the text to the core and answers as scripted. */
function submitter(core: FakeCore, ...scripts: Script[]): HcSubmitter & { sent: Array<{ text: string; options: HcSubmitOptions | undefined }> } {
  const sent: Array<{ text: string; options: HcSubmitOptions | undefined }> = [];
  return {
    sent,
    async submitText(_target, text, options) {
      sent.push({ text, options });
      const script = scripts[Math.min(sent.length - 1, scripts.length - 1)] ?? "reply";
      if (typeof script === "object") return script;
      core.queue.push(text);
      if (script === "silent") return { ok: false, code: "delivery_outcome_unknown", message: "no reply from the core" };
      core.personStops();
      return { ok: true, started: true, status: "idle", turn: core.turn };
    },
  };
}

function build(core: FakeCore, ...scripts: Script[]) {
  const send = submitter(core, ...scripts);
  const delivery = new HcDelivery(new FakeClient(core), send, { now: () => core.clock });
  return { delivery, send };
}

function pendingOf(outcome: HcDeliveryOutcome): HcPendingSend {
  if (outcome.state !== "waiting" && outcome.state !== "unknown") throw new Error(`expected a pending outcome, got ${outcome.state}`);
  return outcome.pending;
}

describe("HcDelivery: what is read before the send", () => {
  it("sends once and reports the core's own acknowledgement", async () => {
    const core = new FakeCore();
    const { delivery, send } = build(core, "reply");
    const outcome = await delivery.deliver(SEAT, "hello");
    expect(outcome).toEqual({ state: "delivered", evidence: "reply", verified: true, started: true, status: "idle", turn: 1 });
    expect(send.sent).toHaveLength(1);
    expect(core.landed).toEqual(["hello"]);
  });

  it.each([
    ["a finished seat", (c: FakeCore) => { c.state = "finished"; c.reason = "exited"; }, "finished"],
    ["a seat the core never heard of", (c: FakeCore) => { c.missing = true; }, "not_found"],
  ] as const)("refuses %s before anything is typed", async (_name, arrange, reason) => {
    const core = new FakeCore();
    arrange(core);
    const { delivery, send } = build(core, "reply");
    const outcome = await delivery.deliver(SEAT, "hello");
    expect(outcome).toMatchObject({ state: "not_delivered", reason, code: "session_not_found" });
    expect(send.sent).toHaveLength(0);
    expect(isBlindRetrySafe(outcome)).toBe(true);
  });

  it("refuses a blocked seat before typing, and types into it only when the caller answers dialogs", async () => {
    const core = new FakeCore();
    core.status = "blocked";
    const { delivery, send } = build(core, "reply");
    expect(await delivery.deliver(SEAT, "no")).toMatchObject({ state: "not_delivered", reason: "blocked", code: "seat_blocked" });
    expect(send.sent).toHaveLength(0);
    await expect(delivery.deliver(SEAT, "yes", { blocked: "allow" })).resolves.toMatchObject({ state: "delivered" });
    expect(send.sent).toEqual([{ text: "yes", options: { force: true } }]);
  });

  it("does not ask the submitter to force a send the caller did not allow", async () => {
    const core = new FakeCore();
    const { delivery, send } = build(core, "reply");
    await delivery.deliver(SEAT, "plain", { ifStatus: "idle" });
    expect(send.sent[0]!.options).toEqual({ ifStatus: "idle" });
  });

  it("refuses a status other than the one required, with nothing typed", async () => {
    const core = new FakeCore();
    core.status = "working";
    const { delivery, send } = build(core, "reply");
    expect(await delivery.deliver(SEAT, "x", { ifStatus: "idle" })).toMatchObject({ state: "not_delivered", reason: "status_mismatch" });
    expect(send.sent).toHaveLength(0);
  });

  it("says the core is unreachable, not that the seat is gone, when it cannot be asked", async () => {
    const core = new FakeCore();
    core.unreachable = true;
    const { delivery, send } = build(core, "reply");
    expect(await delivery.deliver(SEAT, "x")).toMatchObject({ state: "not_delivered", reason: "core_unreachable", code: "transport_unavailable" });
    expect(send.sent).toHaveLength(0);
  });
});

describe("HcDelivery: a refusal from the send is not delivered; silence is verified", () => {
  it.each([
    ["session_not_found", "not_found"], ["seat_blocked", "blocked"], ["status_mismatch", "status_mismatch"], ["transport_unavailable", "core_unreachable"],
    ["guard_target_changed", "guard_refused"], ["typing_guard_enabled", "guard_refused"],
  ] as const)("reads %s as nothing typed", async (code, reason) => {
    const core = new FakeCore();
    const { delivery } = build(core, { ok: false, code, message: "refused" });
    expect(await delivery.deliver(SEAT, "x")).toMatchObject({ state: "not_delivered", reason, code });
  });

  it("reads a kind hc refused with as nothing typed, and any other unclassified failure as silence", async () => {
    const refused = new FakeCore();
    expect(await build(refused, { ok: false, code: "unknown", message: "hc refused: config" }).delivery.deliver(SEAT, "x")).toMatchObject({ state: "not_delivered", reason: "refused" });
    const odd = new FakeCore();
    expect(await build(odd, { ok: false, code: "unknown", message: "socket exploded" }).delivery.deliver(SEAT, "x")).toMatchObject({ state: "waiting" });
  });
});

describe("HcDelivery: delivery_outcome_unknown means verify, and verify never sends", () => {
  it("settles a lost reply by the turn advancing, and the text is never sent a second time", async () => {
    const core = new FakeCore();
    const { delivery, send } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    expect(first).toMatchObject({ state: "waiting", reason: "waiting_on_person" });
    core.personStops();  // the person stopped typing; the core types the held send
    const settled = await delivery.verify(pendingOf(first));
    expect(settled).toMatchObject({ state: "delivered", evidence: "turn_advanced" });
    expect(send.sent).toHaveLength(1);
    expect(core.landed).toEqual(["hello"]);
  });

  it("holds a send the core still has: not a failure, not delivered, and nothing is sent", async () => {
    const core = new FakeCore();
    const { delivery, send } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    expect(first.state).toBe("waiting");
    expect(isBlindRetrySafe(first)).toBe(false);
    for (let i = 0; i < 3; i++) {
      core.clock += 60_000;
      expect((await delivery.verify(pendingOf(first))).state).toBe("waiting");
    }
    expect(send.sent).toHaveLength(1);
    expect(core.landed).toEqual([]);
  });

  it("proves a send gone only when the core restarted after it was issued, and then a retry delivers exactly once", async () => {
    const core = new FakeCore();
    const { delivery, send } = build(core, "silent", "reply");
    const first = await delivery.deliver(SEAT, "hello");
    expect(first.state).toBe("waiting");
    core.clock += 10_000;
    core.restartCore();
    core.clock += 5_000;
    const verdict = await delivery.verify(pendingOf(first));
    expect(verdict).toMatchObject({ state: "not_delivered", reason: "core_restarted_send_gone" });
    expect(isBlindRetrySafe(verdict)).toBe(true);
    expect(core.landed).toEqual([]);
    await expect(delivery.deliver(SEAT, "hello")).resolves.toMatchObject({ state: "delivered", evidence: "reply" });
    expect(send.sent).toHaveLength(2);
    expect(core.landed).toEqual(["hello"]);
  });

  it("does not call a restart proof when it overlaps the send, or came before it", async () => {
    const overlapping = new FakeCore();
    const a = build(overlapping, "silent");
    const first = await a.delivery.deliver(SEAT, "hello");
    overlapping.clock += CORE_RESTART_MARGIN_MS - 1;
    overlapping.restartCore();
    overlapping.clock += 10_000;
    expect((await a.delivery.verify(pendingOf(first))).state).toBe("waiting");

    const earlier = new FakeCore();
    earlier.coreStartedAt = T0 - 1;  // started just before the send was issued
    const b = build(earlier, "silent");
    const second = await b.delivery.deliver(SEAT, "hello");
    earlier.clock += 60_000;
    expect((await b.delivery.verify(pendingOf(second))).state).toBe("waiting");
  });

  it("proves the restart at the margin exactly, and not a millisecond short", async () => {
    const core = new FakeCore();
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    core.clock += CORE_RESTART_MARGIN_MS;
    core.restartCore();
    expect((await delivery.verify(pendingOf(first))).state).toBe("not_delivered");
    const short = new FakeCore();
    const b = build(short, "silent");
    const second = await b.delivery.deliver(SEAT, "hello");
    short.clock += CORE_RESTART_MARGIN_MS - 1;
    short.restartCore();
    expect((await b.delivery.verify(pendingOf(second))).state).toBe("waiting");
  });

  it("lets evidence win over a restart: a token or turn that is there means the text landed", async () => {
    const core = new FakeCore();
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello <tok-1>", { token: "tok-1" });
    core.clock += 10_000;
    core.restartCore();
    core.screen += "hello <tok-1>\n";  // the paste landed before the restart (the unmeasured gap in spike 1+2)
    expect(await delivery.verify(pendingOf(first))).toMatchObject({ state: "delivered", evidence: "token_on_screen" });
  });

  it("does not take a turn for this send when the seat was already working", async () => {
    const core = new FakeCore();
    core.status = "working";
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    core.turn += 1;  // the turn it was already in ended
    core.status = "idle";
    expect(await delivery.verify(pendingOf(first))).toMatchObject({ state: "waiting" });
  });

  it("does not take a turn from a program that never reported status", async () => {
    const core = new FakeCore();
    core.reported = false;
    core.status = null;
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    core.turn += 5;
    expect(await delivery.verify(pendingOf(first))).toMatchObject({ state: "waiting" });
  });

  it("counts a turn only for a program the core says reports, whatever status word it shows", async () => {
    // An inconsistent answer (a status word, but `reported: false`) is not something the core sends today; the guard is the
    // rule itself, kept apart from the status word, so a change in how the core fills either field cannot start counting turns.
    const core = new FakeCore();
    core.reported = false;
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    core.turn += 1;
    expect(await delivery.verify(pendingOf(first))).toMatchObject({ state: "waiting" });
  });

  it("settles by the token alone for a program that reports no status", async () => {
    const core = new FakeCore();
    core.reported = false;
    core.status = null;
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello <tok-2>", { token: "tok-2" });
    core.personStops();
    expect(await delivery.verify(pendingOf(first))).toMatchObject({ state: "delivered", evidence: "token_on_screen" });
  });

  it("sends nothing when the token is already on the screen: the delivery was already made", async () => {
    const core = new FakeCore();
    core.screen += "earlier <tok-3>\n";
    const { delivery, send } = build(core, "reply");
    expect(await delivery.deliver(SEAT, "again <tok-3>", { token: "tok-3" })).toMatchObject({ state: "delivered", evidence: "already_on_screen" });
    expect(send.sent).toHaveLength(0);
  });

  it("will not settle for a different terminal, a finished one, or an unreachable core", async () => {
    const replaced = new FakeCore();
    const a = build(replaced, "silent");
    const first = await a.delivery.deliver(SEAT, "hello");
    replaced.address = "t9";
    expect(await a.delivery.verify(pendingOf(first))).toMatchObject({ state: "unknown", reason: "terminal_replaced" });

    const ended = new FakeCore();
    const b = build(ended, "silent");
    const second = await b.delivery.deliver(SEAT, "hello");
    ended.state = "finished";
    ended.reason = "killed";
    expect(await b.delivery.verify(pendingOf(second))).toMatchObject({ state: "unknown", reason: "seat_ended" });

    const dark = new FakeCore();
    const c = build(dark, "silent");
    const third = await c.delivery.deliver(SEAT, "hello");
    dark.unreachable = true;
    expect(await c.delivery.verify(pendingOf(third))).toMatchObject({ state: "unknown", reason: "core_unreachable" });
  });

  it("does not read a restart as proof when the core's uptime cannot be read", async () => {
    const core = new FakeCore();
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello");
    core.clock += 30_000;
    core.restartCore();
    const blind = new HcDelivery(new class extends FakeClient {
      override async call<T>(method: string): Promise<T> {
        if (method === "server.status") throw new HcOutcomeUnknownError("no reply", method);
        return super.call<T>(method);
      }
    }(core), submitter(core), { now: () => core.clock });
    expect((await blind.verify(pendingOf(first))).state).toBe("waiting");
  });

  it("carries a pending record that survives JSON, so a daemon restart loses nothing", async () => {
    const core = new FakeCore();
    const { delivery } = build(core, "silent");
    const first = await delivery.deliver(SEAT, "hello <tok-4>", { token: "tok-4" });
    const stored: HcPendingSend = JSON.parse(JSON.stringify(pendingOf(first)));
    expect(stored).toEqual({ version: 1, seat: SEAT, address: ADDRESS, token: "tok-4", sendStartedAtMs: T0, preTurn: 0, preStatus: "idle", preReported: true });
    core.personStops();
    expect(await delivery.verify(stored)).toMatchObject({ state: "delivered" });
  });
});

describe("hcPanePid and defaultBlockedPolicy", () => {
  it("gives the terminal's pid, and null when it is gone or reports none", async () => {
    const core = new FakeCore();
    const client = new class extends FakeClient {
      override async call<T>(method: string): Promise<T> {
        const terminal = { ...core.terminal(), pid: 4242 };
        return method === "terminal.get" ? (terminal as T) : super.call<T>(method);
      }
    }(core);
    expect(await hcPanePid(client, SEAT)).toBe(4242);
    core.state = "finished";
    expect(await hcPanePid(client, SEAT)).toBeNull();
    core.missing = true;
    expect(await hcPanePid(new FakeClient(core), SEAT)).toBeNull();
  });

  it("lets only a person's lease answer a dialog", () => {
    const lease = (origin: "human" | "automatic" | null) => ({ leaseOrigin: () => origin });
    expect(defaultBlockedPolicy(lease("human"), SEAT)).toBe("allow");
    expect(defaultBlockedPolicy(lease("automatic"), SEAT)).toBe("refuse");
    expect(defaultBlockedPolicy(lease(null), SEAT)).toBe("refuse");
    expect(defaultBlockedPolicy(undefined, SEAT)).toBe("refuse");
    expect(defaultBlockedPolicy({ leaseOrigin: () => { throw new Error("unresolved"); } }, SEAT)).toBe("refuse");
  });
});
