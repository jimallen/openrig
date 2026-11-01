import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HcClient, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcAttach, type HcAttachment } from "../src/adapters/hc-attach.js";
import { HcHost } from "../src/adapters/hc-host.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { HcDelivery, hcPanePid, isBlindRetrySafe, type HcDeliveryOutcome, type HcPendingSend, type HcSubmitter } from "../src/adapters/hc-delivery.js";
import { deliveryTokenFor, withDeliveryToken } from "../src/adapters/hc-delivery-token.js";
import { sweepHcUnsettled } from "../src/domain/hc-unsettled-sweep.js";
import type { OutboxEntry } from "../src/domain/outbox-handler.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

/** A program on a pty. It echoes what it is typed (so a token is on the screen), logs every chunk of stdin as hex, and
 *  with `turns` reports idle, then working and done for each Enter, so the core's turn counter moves. Bracketed paste on.
 *  `slash`: a line that starts with `/` is a command the program runs and clears the screen for, with no turn and no echo
 *  (what a TUI does for its own commands); the core's record afterwards is the one of a send that never arrived.
 *  `marker`: the end of a paste writes a file, so a test can restart the core in the 200 ms before the Enter.
 *  `busy`: reports `working` from the start and never leaves it (a seat in the middle of a turn).
 *  `noecho`: the program draws nothing for what it is typed or pasted (a paste leaves the screen byte-identical).
 *  `collapse`: a paste is shown as a placeholder, not its text (a composer that folds a large paste), so the token is not rendered. */
const STUB = `
import os, sys, time, tty
mode, log_path = sys.argv[1], sys.argv[2]
marker = sys.argv[3] if len(sys.argv) > 3 else None
tty.setraw(0)
busy = "busy" in mode.split(",")
turns = "turns" in mode.split(",") or busy
slash = "slash" in mode.split(",")
collapse = "collapse" in mode.split(",")
noecho = "noecho" in mode.split(",")
buf = b""
os.write(1, b"\\x1b[?2004h")
if turns:
    os.write(1, b"\\x1b]7501;state=" + (b"working" if busy else b"idle") + b":app=stub\\x1b\\\\")
os.write(1, b"READY\\r\\n")
log = open(log_path, "ab", buffering=0)
while True:
    try:
        b = os.read(0, 65536)
    except InterruptedError:
        continue
    if not b:
        break
    log.write(b.hex().encode() + b"\\n")
    if marker and b"\\x1b[201~" in b:
        open(marker, "w").write("pasted")
    shown = b.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"").replace(b"\\r", b"\\r\\n")
    if collapse and b"\\x1b[200~" in b:
        shown = b"[Pasted text #1]"
    if noecho:
        shown = b""
    os.write(1, shown)
    buf += b
    if b"\\r" in b:
        line = buf.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"").replace(b"\\r", b"")
        buf = b""
        if slash and line.startswith(b"/"):
            os.write(1, b"\\x1b[2J\\x1b[HREADY\\r\\n")
            continue
    if turns and b"\\r" in b:
        os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\")
        time.sleep(0.3)
        os.write(1, b"\\x1b]7501;state=done:app=stub\\x1b\\\\")
`;

describe.skipIf(!HC)("HcDelivery against a private hc core: exactly once", () => {
  const core = new PrivateCore("dlv");
  const attach = new HcAttach(core.socketPath);
  let stubPath: string;
  let n = 0;

  beforeAll(() => {
    // Preflight, before any core starts: the socket, HOME and every XDG path the core and its client use are under this test's own
    // root, and nothing from the caller's HC_* / XDG_* / HOME is in the env the core is started with.
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
    mkdirSync(join(core.root, "w"), { recursive: true });
    stubPath = join(core.root, "w", "stub.py");
    writeFileSync(stubPath, STUB);
  });
  afterAll(() => core.stop());

  interface Seat { seat: string; address: string; marker: string; stdin: () => string }

  async function launch(mode: string): Promise<Seat> {
    const seat = `dlv${++n}@rig`;
    const address = hcTerminalName(seat);
    const log = join(core.root, "w", `${address}.stdin`);
    writeFileSync(log, "");
    const marker = join(core.root, "w", `${address}.marker`);
    await core.client.call("terminal.run", { argv: ["python3", "-I", stubPath, mode, log, marker], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the stub's first paint");
    return { seat, address, marker, stdin: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((hex) => Buffer.from(hex, "hex").toString("latin1")).join("") };
  }

  /** A person at the keyboard: one key every 400 ms, so the core's ~3 s quiet window never opens until `stop`. */
  async function person(address: string): Promise<{ stop: () => Promise<void> }> {
    const viewer: HcAttachment = await attach.open({ terminal: address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    viewer.write("p");
    const timer = setInterval(() => { try { viewer.write("p"); } catch { /* the viewer ended with a core restart */ } }, 400);
    return { stop: async () => { clearInterval(timer); await viewer.detach().catch(() => undefined); } };
  }

  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  /** What a sweep over the one row this verdict leaves would settle (an outbox that records what it is told to). */
  async function sweepOnce(d: HcDelivery, outcome: HcDeliveryOutcome) {
    const settled: Array<{ state: string; detail: string | null | undefined }> = [];
    if (outcome.state !== "waiting" && outcome.state !== "unknown") return settled;
    const row: OutboxEntry = {
      outboxId: "wake-f1", senderSession: "planner@rig", destinationSession: outcome.pending.seat, body: "x", tags: null, urgency: "routine",
      tsDispatched: "2031-03-04 05:00:00", deliveryState: "indeterminate", deliveredAt: null, auditPointer: null, ackDetail: JSON.stringify(outcome.pending),
    };
    await sweepHcUnsettled({
      outbox: { listHcSweepable: () => [row], settleHcUnsettled: (_id, state, label) => { settled.push({ state, detail: label.detail }); return true; }, markHcSendGone: () => { settled.push({ state: "send_gone", detail: null }); return true; } },
      verify: (p) => d.verify(p), recordNudgeAttempt: () => undefined,
    });
    return settled;
  }
  const delivery = (timeoutMs: number) => new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: timeoutMs }));
  const pending = (outcome: HcDeliveryOutcome): HcPendingSend => {
    if (outcome.state !== "waiting" && outcome.state !== "unknown") throw new Error(`expected a pending outcome, got ${JSON.stringify(outcome).slice(0, 200)}`);
    return outcome.pending;
  };

  it("holds a send the core is queueing for a person, sees its token once typed, never calls it delivered without a turn, and never sends twice", async () => {
    const stub = await launch("plain");
    const typing = await person(stub.address);
    const d = delivery(1_500);
    const first = await d.deliver(stub.seat, "hello <tok-a1>", { token: "tok-a1" });
    expect(first).toMatchObject({ state: "waiting", reason: "waiting_on_person" });
    // While the person types, the verdict stays "waiting": the core still holds the text.
    expect(await d.verify(pending(first))).toMatchObject({ state: "waiting" });
    expect(stub.stdin()).not.toContain("hello");
    await typing.stop();
    // Once the person stops, the core types it. The program reports no status, so nothing shows the Enter reached it: the token on
    // the screen is the paste, and the verdict is "waiting" for a person, not "delivered" (a design limit, not a gap in the test).
    const settled = await until(() => d.verify(pending(first)), (o) => o.state === "waiting" && o.cause === "text_present_no_turn", "the text on the screen", 15_000);
    expect(isBlindRetrySafe(settled)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(occurrences(stub.stdin(), "\x1b[200~hello <tok-a1>\x1b[201~")).toBe(1);
    expect(occurrences(stub.stdin(), "\r")).toBe(1);
  }, 40_000);

  it("settles a send by a turn that carries its token, for a program that reports status", async () => {
    const stub = await launch("turns");
    const typing = await person(stub.address);
    const d = delivery(1_500);
    const first = await d.deliver(stub.seat, "work please <tok-w1>", { token: "tok-w1" });
    expect(first).toMatchObject({ state: "waiting" });
    expect(pending(first)).toMatchObject({ preStatus: "idle", preReported: true, preTurn: 0 });
    await typing.stop();
    const settled = await until(() => d.verify(pending(first)), (o) => o.state !== "waiting", "the turn to advance", 20_000);
    expect(settled).toMatchObject({ state: "delivered", evidence: "turn_with_token" });
    expect(occurrences(stub.stdin(), "\x1b[200~work please <tok-w1>\x1b[201~")).toBe(1);
  }, 45_000);

  it("takes the core's own acknowledgement when there is no one at the keyboard", async () => {
    const stub = await launch("turns");
    const outcome = await delivery(20_000).deliver(stub.seat, "straight in");
    expect(outcome).toMatchObject({ state: "delivered", evidence: "reply", verified: true, started: true });
    expect(occurrences(stub.stdin(), "straight in")).toBe(1);
  }, 40_000);

  it("proves a send gone when the core restarts while it waits, for a seat that reports status and whose screen is as it was, and a retry then delivers exactly once", async () => {
    const stub = await launch("turns");
    const addressBefore = (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).address;
    // One key, typed and then left: the core holds a send for 3 s after it, and the key is already on the screen when the send is
    // issued. A person who KEEPS typing changes the screen, and then nothing proves the send gone (see the next test).
    const viewer = await attach.open({ terminal: stub.address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    viewer.write("p");
    await viewer.detach();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const d = delivery(12_000);
    const racing = d.deliver(stub.seat, "survive this", { pasteEchoes: true });  // the stub shows a paste: declared, as a runtime would be
    // The restart must come after the send was issued by more than the margin (2 s) and inside the 3 s hold, or it proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    core.restart();
    const first = await racing;
    const verdict = first.state === "not_delivered" ? first : await until(() => d.verify(pending(first)), (o) => o.state !== "waiting" && o.state !== "unknown", "a verdict after the restart", 15_000);
    expect(verdict).toMatchObject({ state: "not_delivered", reason: "core_restarted_send_gone" });
    // The queued send did not survive the restart: the program never saw it, and the terminal kept its address.
    expect(stub.stdin()).not.toContain("survive this");
    expect((await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).address).toBe(addressBefore);
    const retried = await delivery(20_000).deliver(stub.seat, "survive this");
    expect(retried).toMatchObject({ state: "delivered" });
    await until(() => stub.stdin(), (s) => s.includes("survive this"), "the retried text", 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(occurrences(stub.stdin(), "survive this")).toBe(1);
  }, 60_000);

  it("a person who keeps typing while the core restarts leaves the screen changed: not provably gone, so waiting for a person (QA F3)", async () => {
    const stub = await launch("turns");
    const typing = await person(stub.address);
    const d = delivery(12_000);
    const racing = d.deliver(stub.seat, "survive this", {});
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    core.restart();
    await typing.stop();
    const first = await racing;
    const verdict = first.state === "waiting" || first.state === "unknown" ? await until(() => d.verify(pending(first)), (o) => o.state !== "unknown", "a verdict after the restart", 15_000) : first;
    expect(verdict).toMatchObject({ state: "waiting", cause: "restart_unsettled" });
    expect(isBlindRetrySafe(verdict)).toBe(false);
    expect(stub.stdin()).not.toContain("survive this");
  }, 60_000);

  it("does not call a restart proof for a seat that reports no status: the text may have been delivered first, so it waits and nobody resends", async () => {
    const stub = await launch("plain");
    const typing = await person(stub.address);
    const d = delivery(12_000);
    const racing = d.deliver(stub.seat, "survive this <tok-b1>", { token: "tok-b1" });
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    core.restart();
    await typing.stop();
    const first = await racing;
    expect(first).toMatchObject({ state: "waiting" });
    // The queued send really was lost with the core (nothing reached the program), and still the verdict is not "gone":
    // from a seat that reports nothing, "lost with the restart" and "delivered, then the core restarted" look the same.
    expect(stub.stdin()).not.toContain("survive this");
    for (let i = 0; i < 3; i++) {
      expect(await d.verify(pending(first))).toMatchObject({ state: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(first.state === "waiting" && first.message).toMatch(/lost with it/);
  }, 60_000);

  describe("the double-delivery window: the text was delivered, the reply was lost, the core then restarted", () => {
    /** The real send goes through (text delivered), its reply is dropped, and the core restarts more than the margin after
     *  the send began: exactly the case a restart-means-gone rule resends into. */
    const lossyThenRestart = (): HcSubmitter => {
      const real = new HcInput(core.client, attach, { deliveryTimeoutMs: 20_000 });
      return {
        async submitText(target, text, options) {
          const delivered = await real.submitText(target, text, options);
          if (!delivered.ok) throw new Error(`the real send was refused (${delivered.code}); the scenario needs it delivered`);
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          core.restart();
          return { ok: false, code: "delivery_outcome_unknown", message: "no reply from the core" };
        },
      };
    };

    /** A sweep over the one row the verdict leaves, with an outbox that records what it was told to settle. */
    async function sweepVerdict(d: HcDelivery, outcome: HcDeliveryOutcome) {
      const settled: Array<{ state: string; detail: string | null | undefined }> = [];
      if (outcome.state !== "waiting" && outcome.state !== "unknown") return settled;
      const row: OutboxEntry = {
        outboxId: "wake-1", senderSession: "planner@rig", destinationSession: outcome.pending.seat, body: "x", tags: null, urgency: "routine",
        tsDispatched: "2031-03-04 05:00:00", deliveryState: "indeterminate", deliveredAt: null, auditPointer: null, ackDetail: JSON.stringify(outcome.pending),
      };
      for (let i = 0; i < 3; i++) {
        await sweepHcUnsettled({
          outbox: { listHcSweepable: () => [row], settleHcUnsettled: (_id, state, label) => { settled.push({ state, detail: label.detail }); return true; }, markHcSendGone: () => { settled.push({ state: "send_gone", detail: null }); return true; } },
          verify: (p) => d.verify(p), recordNudgeAttempt: () => undefined,
        });
      }
      return settled;
    }

    it("a seat that carries the token but reports no status: the token is the paste, not the Enter, so waiting; nothing is sent again", async () => {
      const stub = await launch("plain");
      const d = new HcDelivery(core.client, lossyThenRestart());
      const token = deliveryTokenFor("delivery:window-1");
      const outcome = await d.deliver(stub.seat, withDeliveryToken("hello window", token), { token });
      // The token is on the screen and the plain stub reports no status: the paste is certain, the Enter is not shown. Waiting.
      expect(outcome).toMatchObject({ state: "waiting", cause: "text_present_no_turn" });
      expect(occurrences(stub.stdin(), "hello window")).toBe(1);
      // The retry of the same message: the token is already on the screen, so nothing is typed, and nothing is claimed.
      const retry = await new HcDelivery(core.client, { submitText: async () => { throw new Error("a retry typed into the seat"); } }).deliver(stub.seat, withDeliveryToken("hello window", token), { token });
      expect(retry).toMatchObject({ state: "waiting", cause: "text_present_no_turn" });
      expect(occurrences(stub.stdin(), "hello window")).toBe(1);
    }, 60_000);

    it("a seat that reports status and took the text: the turn it started settles it delivered", async () => {
      const stub = await launch("turns");
      const d = new HcDelivery(core.client, lossyThenRestart());
      const token = deliveryTokenFor("delivery:window-2");
      const outcome = await d.deliver(stub.seat, withDeliveryToken("hello window", token), { token });
      expect(outcome).toMatchObject({ state: "delivered", evidence: "turn_with_token" });
      expect(occurrences(stub.stdin(), "hello window")).toBe(1);
    }, 60_000);

    it("a plain terminal (no token, no status): not 'safe to resend'; it waits, and a sweep never settles it failed", async () => {
      const stub = await launch("plain");
      const d = new HcDelivery(core.client, lossyThenRestart());
      const outcome = await d.deliver(stub.seat, "hello window");
      expect(outcome).toMatchObject({ state: "waiting" });
      expect(isBlindRetrySafe(outcome)).toBe(false);
      expect(occurrences(stub.stdin(), "hello window")).toBe(1);  // it WAS delivered, which is why a resend would have doubled it
      expect(await sweepVerdict(d, outcome)).toEqual([]);
      expect(occurrences(stub.stdin(), "hello window")).toBe(1);
    }, 60_000);

    it("a slash command the program ran, reply lost, core restarted: not 'never reached' (it was delivered, and a retry would run it twice)", async () => {
      // A seat with no token (a plain runner) that reports status: before, the restart plus "at rest, same turn" read as proof the
      // send was gone, the sweep settled the row `failed`, and the queue's retry typed the command again.
      const stub = await launch("turns,slash");
      const d = new HcDelivery(core.client, lossyThenRestart());
      const outcome = await d.deliver(stub.seat, "/x arg");
      expect(stub.stdin()).toContain("\x1b[200~/x arg\x1b[201~");  // the program took it, and ran it
      expect((await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).turn).toBe(0);  // with no turn
      expect(outcome).toMatchObject({ state: "waiting", cause: "restart_unsettled" });
      expect(isBlindRetrySafe(outcome)).toBe(false);
      expect(await sweepVerdict(d, outcome)).toEqual([]);  // the sweep never settles it failed, so the queue never retries it
      expect(occurrences(stub.stdin(), "/x arg")).toBe(1);
    }, 60_000);
  });

  describe("the core goes between the paste and the Enter (200 ms apart): measured, the paste lands and the Enter does not", () => {
    /** Restart the core the instant the stub has the paste, which is the 200 ms before hc presses Enter. */
    async function restartBetween(how: "graceful" | "killed", seatMode: string, delayed = false, withToken = true) {
      const stub = await launch(seatMode);
      // `delayed`: a person types for 3.5 s, so the core holds the send for ~6.5 s and the restart that follows the paste comes well
      // past CORE_RESTART_MARGIN_MS after the send was issued, which is when the restart rule is in play at all.
      const typing = delayed ? await person(stub.address) : null;
      const typingStops = delayed ? setTimeout(() => { void typing?.stop(); }, 3_500) : null;
      const token = deliveryTokenFor(`delivery:between-${how}-${n}`);
      const d = new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 }));
      const racing = withToken ? d.deliver(stub.seat, withDeliveryToken("hello between", token), { token }) : d.deliver(stub.seat, "hello between");
      await until(() => existsSync(stub.marker), (seen) => seen, "the paste to reach the program", 10_000);
      if (how === "graceful") core.restart();
      else {
        const pid = await core.corePid();
        if (!core.isMine(pid)) throw new Error("the core pid is not this test's own");
        process.kill(pid, "SIGKILL");
      }
      const first = await racing;
      if (typingStops) clearTimeout(typingStops);
      await typing?.stop();
      if (how === "killed") core.start();
      await until(async () => { try { return (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state; } catch { return "down"; } }, (state) => state === "live", "the terminal after the core came back", 15_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));  // longer than the 200 ms: a late Enter would have shown by now
      return { stub, d, first, token };
    }

    it.each(["graceful", "killed"] as const)("%s: the text sits typed and unsubmitted, and the verdict is waiting, never delivered and never gone", async (how) => {
      const { stub, d, first } = await restartBetween(how, "turns,marker");
      expect(stub.stdin()).toContain("\x1b[200~hello between");
      expect(stub.stdin()).not.toContain("\r");  // the Enter never came
      expect((await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).turn).toBe(0);  // no turn: nothing was submitted
      const verdict = first.state === "waiting" || first.state === "unknown"
        ? await until(() => d.verify(pending(first)), (o) => o.state !== "unknown", "a verdict once the core answered", 15_000)
        : first;
      expect(verdict).toMatchObject({ state: "waiting", cause: "text_present_no_turn" });
      expect(isBlindRetrySafe(verdict)).toBe(false);
      for (let i = 0; i < 3; i++) expect(await d.verify(pending(first.state === "waiting" || first.state === "unknown" ? first : verdict))).toMatchObject({ state: "waiting" });
      expect(occurrences(stub.stdin(), "hello between")).toBe(1);  // nothing was typed again
    }, 60_000);

    it.each(["graceful", "killed"] as const)("%s, then the screen cannot be read: still waiting, never gone, and a retry types nothing (security review F1)", async (how) => {
      // The core, the status and the turn are the real ones: paste landed, Enter lost, core restarted after the send. Only the read
      // is made to fail, on the client the sweep uses; before the fix this read as "no token", then as proof the send was gone.
      class UnreadableScreen extends HcClient {
        override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
          if (method === "terminal.read") throw new HcUnavailableError("the screen could not be read");
          return super.call<T>(method, params, options);
        }
      }
      const { stub, first, token } = await restartBetween(how, "turns,marker", true);
      expect(stub.stdin()).not.toContain("\r");  // the Enter never came
      // The restart really is later than the margin after the send, so the restart rule is what is being tested.
      expect(pending(first).sendStartedAtMs).toBeLessThan(Date.now() - 6_000);
      const blind = new HcDelivery(new UnreadableScreen(core.socketPath), new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 }));
      const verdict = await blind.verify(pending(first));
      expect(verdict).toMatchObject({ state: "waiting", cause: "screen_unreadable" });
      expect(isBlindRetrySafe(verdict)).toBe(false);
      expect(await sweepOnce(blind, verdict)).toEqual([]);  // the sweep settles nothing failed, so the queue never retries
      const retried = await blind.deliver(stub.seat, withDeliveryToken("hello between", token), { token });
      expect(retried).toMatchObject({ state: "not_delivered", code: "transport_unavailable" });
      expect(occurrences(stub.stdin(), "hello between")).toBe(1);  // nothing was typed again
    }, 60_000);

    // QA F1, F2, F3 on the real core: the same staged state (paste landed, Enter lost, core restarted well after the send) for the seat
    // states the earlier rule did not cover. Each reads waiting; none may read delivered or gone, and nothing is typed again.
    const staged = it.each([
      ["a seat that was busy (working) when it was sent", "busy,marker", true],
      ["a seat that reports no status", "marker", true],
    ] as const);
    staged("F1: %s: typed and unsubmitted reads waiting, never delivered", async (_name, mode, withToken) => {
      const { stub, first } = await restartBetween("graceful", mode, true, withToken);
      expect(stub.stdin()).toContain("\x1b[200~hello between");
      expect(stub.stdin()).not.toContain("\r");
      const d = new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 }));
      const verdict = await d.verify(pending(first));
      expect(verdict).toMatchObject({ state: "waiting", cause: "text_present_no_turn" });
      expect(isBlindRetrySafe(verdict)).toBe(false);
    }, 60_000);

    it("F2: a resend of the same token while the text sits unsubmitted types nothing and does not read delivered", async () => {
      const { stub, token } = await restartBetween("graceful", "turns,marker", true);
      const d = new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 }));
      const again = await d.deliver(stub.seat, withDeliveryToken("hello between", token), { token });
      expect(again).toMatchObject({ state: "waiting", cause: "text_present_no_turn" });
      expect(occurrences(stub.stdin(), "hello between")).toBe(1);
      expect(stub.stdin()).not.toContain("\r");
    }, 60_000);

    it("F3a: a seat with no token whose text is in the input is not proved gone", async () => {
      const { stub, first } = await restartBetween("graceful", "turns,marker", true, false);
      expect(stub.stdin()).toContain("\x1b[200~hello between");
      expect(stub.stdin()).not.toContain("\r");
      const verdict = await new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 })).verify(pending(first));
      expect(verdict).toMatchObject({ state: "waiting", cause: "restart_unsettled" });
    }, 60_000);

    it("F3b: a token the composer does not render (a collapsed paste) is not proved gone either", async () => {
      const { stub, first } = await restartBetween("graceful", "turns,marker,collapse", true);
      expect(stub.stdin()).toContain("\x1b[200~hello between");
      expect(stub.stdin()).not.toContain("\r");
      const verdict = await new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 })).verify(pending(first));
      expect(verdict).toMatchObject({ state: "waiting", cause: "restart_unsettled" });
    }, 60_000);

    it("N2: a program that draws nothing on a paste leaves the screen as it was: not gone by default, it waits for a person", async () => {
      const { stub, first } = await restartBetween("graceful", "turns,marker,noecho", true, false);
      expect(stub.stdin()).toContain("\x1b[200~hello between");  // the paste landed ...
      expect(stub.stdin()).not.toContain("\r");                // ... the Enter did not ...
      const verdict = await new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 8_000 })).verify(pending(first));
      expect(verdict).toMatchObject({ state: "waiting", cause: "restart_unsettled" });  // ... and the screen alone could not say so
      expect(isBlindRetrySafe(verdict)).toBe(false);
    }, 60_000);

    it("a retry that typed again would put the text in twice and submit it once (the reason nobody resends)", async () => {
      const { stub } = await restartBetween("graceful", "turns,marker");
      const sent = await core.client.call<{ turn: number }>("terminal.send", { terminal: stub.address, text: "hello between" }, { timeoutMs: 20_000 });
      expect(sent.turn).toBeGreaterThanOrEqual(0);
      await until(() => stub.stdin(), (s) => s.includes("\r"), "the retry's Enter", 10_000);
      expect(occurrences(stub.stdin(), "hello between")).toBe(2);
      expect(occurrences(stub.stdin(), "\r")).toBe(1);
    }, 60_000);
  });

  it("N1: a send lost in a core restart, then a person presses Enter on their own text: a turn, not this send's: waiting, never delivered", async () => {
    const stub = await launch("turns");
    const viewer = await attach.open({ terminal: stub.address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    viewer.write("p");
    await viewer.detach();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const token = deliveryTokenFor("delivery:n1");
    const d = delivery(1_000);
    const first = await d.deliver(stub.seat, withDeliveryToken("hello n1", token), { token });
    expect(first).toMatchObject({ state: "waiting" });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    core.restart();  // inside the 3 s hold, more than the margin after the send: the queued text is lost with the core
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stub.stdin()).not.toContain("hello n1");
    // The person types their own line and presses Enter: the program starts a turn that is not this send's.
    const person2 = await attach.open({ terminal: stub.address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    person2.write("my own line\r");
    await until(async () => (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).turn, (turn) => (turn ?? 0) >= 1, "the person's turn", 10_000);
    await person2.detach();
    const verdict = await d.verify(pending(first));
    expect(verdict).toMatchObject({ state: "waiting", cause: "turn_without_token" });
    expect(isBlindRetrySafe(verdict)).toBe(false);
    expect(stub.stdin()).not.toContain("hello n1");  // the message never arrived, and nothing says it was delivered
  }, 60_000);

  it("the daemon dies between the paste and the Enter: the core still presses the Enter, once, and the turn settles it", async () => {
    // Not a restart of the core: only the client goes (here a 100 ms timeout, the socket is destroyed). Measured: a queued send
    // outlives its client, so the program gets the paste and then the Enter exactly once.
    const stub = await launch("turns,marker");
    const token = deliveryTokenFor("delivery:client-dies");
    const d = new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 100 }));
    const first = await d.deliver(stub.seat, withDeliveryToken("hello client", token), { token });
    await until(() => stub.stdin(), (text) => text.includes("\r"), "the Enter, after the client was gone", 10_000);
    const settled = first.state === "delivered" ? first : await until(() => d.verify(pending(first)), (o) => o.state !== "waiting" && o.state !== "unknown", "the turn", 15_000);
    expect(settled).toMatchObject({ state: "delivered" });
    expect(occurrences(stub.stdin(), "hello client")).toBe(1);
    expect(occurrences(stub.stdin(), "\r")).toBe(1);
  }, 60_000);

  it("refuses a finished seat and an unknown one with nothing typed", async () => {
    const stub = await launch("plain");
    await core.client.call("terminal.kill", { terminal: stub.address });
    await until(async () => (await core.client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state, (s) => s === "finished", "the kill");
    expect(await delivery(2_000).deliver(stub.seat, "x")).toMatchObject({ state: "not_delivered", reason: "finished" });
    expect(await delivery(2_000).deliver("never@rig", "x")).toMatchObject({ state: "not_delivered", reason: "not_found" });
    expect(stub.stdin()).toBe("");
  }, 30_000);

  it("gives the native inbox an ancestor of the agent: the terminal's pid is the login shell the agent is typed into", async () => {
    const host = new HcHost(core.client, { daemonEnv: { PATH: process.env.PATH, HOME: core.env.HOME, SHELL: "/bin/sh" } });
    await host.createSession("native@rig", core.root);
    const input = new HcInput(core.client, attach, { deliveryTimeoutMs: 10_000 });
    // The host is shared: a stand-in named by the run, so no other run's `sleep` can be mistaken for this agent.
    const standIn = `sleep 600.${process.pid}${Date.now() % 100000}`;
    await input.sendShellCommand("native@rig", standIn);
    const pane = await hcPanePid(core.client, "native@rig");
    expect(pane).not.toBeNull();
    const table = () => spawnSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }));
    const child = await until(() => table().find((p) => p.args === standIn && p.pid !== pane), (p) => p !== undefined, "the agent stand-in");
    const byPid = new Map(table().map((p) => [p.pid, p]));
    // The walk the native inbox makes (claude-native-inbox.ts eligibility): from the agent up the ppid chain to the pane pid.
    let cursor = child;
    const chain: number[] = [];
    for (let hops = 0; cursor && hops < 32; hops++) { chain.push(cursor.pid); if (cursor.pid === pane) break; cursor = byPid.get(cursor.ppid); }
    expect(chain).toContain(pane);
    expect(chain[0]).not.toBe(pane);  // the agent is a descendant of the shell, not the terminal's own pid
    await input.sendKeys("native@rig", ["C-c"]);
  }, 40_000);
});
