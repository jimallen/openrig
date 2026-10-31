import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalBrokerRegistry, TerminalSessionBroker, screenSnapshotEscape,
  type BrokerStreamHost, type TerminalSubscriber,
} from "../src/terminal/TerminalSessionBroker.js";
import type { HcLiveView, TerminalModes, ViewEnd, ViewHandlers, ViewOpen, ViewSize } from "../src/adapters/hc-viewer.js";

// ---- doubles -----------------------------------------------------------------------------------------------------------

interface FakeSub extends TerminalSubscriber {
  events: string[];
  received: string[];
  sizes: ViewSize[];
  closed: { code: number; reason: string }[];
}

function makeSub(options: { withSize?: boolean; throwOnSend?: boolean } = {}): FakeSub {
  const sub: FakeSub = {
    events: [], received: [], sizes: [], closed: [],
    send(data) {
      if (options.throwOnSend) throw new Error("socket closed");
      sub.received.push(data);
      sub.events.push(`data ${data}`);
    },
    close(code, reason) { sub.closed.push({ code, reason }); },
  };
  if (options.withSize !== false) {
    sub.size = (cols, rows) => { sub.sizes.push({ cols, rows }); sub.events.push(`size ${cols}x${rows}`); };
  }
  return sub;
}

class FakeView implements HcLiveView {
  modesNow: TerminalModes = { altScreen: false, mouse: false };
  sizeNow: ViewSize = { cols: 100, rows: 5 };
  repaints = 0;
  closes = 0;
  repaintResult = true;
  onRepaint: (() => void) | null = null;
  constructor(readonly handlers: ViewHandlers) {}
  size() { return this.sizeNow; }
  modes() { return this.modesNow; }
  async repaint() { this.repaints++; this.onRepaint?.(); return this.repaintResult; }
  async close() { this.closes++; }
  /** What the core does on attach: announce the paint, the size, then the bytes. */
  paint(text: string | Buffer, size: ViewSize = this.sizeNow) {
    this.handlers.onPaint();
    this.handlers.onSize(size);
    this.handlers.onData(typeof text === "string" ? Buffer.from(text) : text);
  }
  data(text: string | Buffer) { this.handlers.onData(typeof text === "string" ? Buffer.from(text) : text); }
  end(end: ViewEnd) { this.handlers.onEnd(end); }
}

class FakeHost implements BrokerStreamHost {
  views: FakeView[] = [];
  opened: string[] = [];
  /** Results for the next opens; an empty queue opens a view that paints "PAINT". */
  results: ViewOpen[] = [];
  gate: Promise<void> | null = null;
  keys: [string, string[]][] = [];
  pastes: [string, string][] = [];
  histories: [string, number][] = [];
  history: string | null | (() => Promise<string | null>) = null;
  humanInputs = 0;
  inputOrder: string[] = [];
  withHumanInput = false;

  async view(target: string, handlers: ViewHandlers): Promise<ViewOpen> {
    this.opened.push(target);
    if (this.gate) await this.gate;
    const queued = this.results.shift();
    if (queued) return queued;
    const view = new FakeView(handlers);
    this.views.push(view);
    view.paint("PAINT");
    return { ok: true, view };
  }
  async readHistory(target: string, lines: number) {
    this.histories.push([target, lines]);
    return typeof this.history === "function" ? this.history() : this.history;
  }
  async pressKeys(name: string, keys: string[]) { this.keys.push([name, keys]); this.inputOrder.push(`keys:${keys.join(",")}`); return { ok: true as const }; }
  async pasteText(name: string, text: string) {
    await new Promise((resolve) => setTimeout(resolve, text === "slow" ? 25 : 0));
    this.pastes.push([name, text]);
    this.inputOrder.push(`paste:${text}`);
    return { ok: true as const };
  }
}

function hostWithHumanInput(): FakeHost {
  const host = new FakeHost();
  (host as { humanInput?: BrokerStreamHost["humanInput"] }).humanInput = async (_name, fn) => { host.humanInputs++; return fn(); };
  return host;
}

const brokers: TerminalSessionBroker[] = [];
function broker(host: BrokerStreamHost, onEmpty?: (name: string) => void): TerminalSessionBroker {
  const b = new TerminalSessionBroker("dev@rig", host, { onEmpty });
  brokers.push(b);
  return b;
}
afterEach(() => { for (const b of brokers.splice(0)) b.dispose(); });

const ENDED: ViewEnd = { reason: "program_ended", exitCode: 3, signal: null, endReason: "exited", finishedMs: 1 };

// ---- the seed -----------------------------------------------------------------------------------------------------------

describe("a stream host: what a subscriber sees first", () => {
  it("gives each subscriber a view of its own, and the first paint of that view as its seed", async () => {
    const host = new FakeHost();
    const b = broker(host);
    const a = makeSub();
    const c = makeSub();
    await b.attach(a);
    await b.attach(c);
    expect(host.opened).toEqual(["dev@rig", "dev@rig"]);
    expect(host.views).toHaveLength(2);
    expect(a.received).toEqual(["PAINT"]);
    expect(c.received).toEqual(["PAINT"]);
    host.views[0]!.data("live-a");
    expect(a.received).toEqual(["PAINT", "live-a"]);
    expect(c.received).toEqual(["PAINT"]);  // the other view's bytes are the other subscriber's
    expect(b.subscriberCount).toBe(2);
  });

  it("tells the size before the first byte, and again when the terminal's size changes", async () => {
    const host = new FakeHost();
    const sub = makeSub();
    await broker(host).attach(sub);
    host.views[0]!.handlers.onSize({ cols: 64, rows: 16 });
    expect(sub.events).toEqual(["size 100x5", "data PAINT", "size 64x16"]);
  });

  it("has no fixed geometry: it never asks for a size and a subscriber without size() still works", async () => {
    const host = new FakeHost();
    const sub = makeSub({ withSize: false });
    await broker(host).attach(sub);
    host.views[0]!.handlers.onSize({ cols: 64, rows: 16 });
    expect(sub.received).toEqual(["PAINT"]);
    expect(sub.closed).toEqual([]);
  });

  it("keeps no history ring and no pipe: a late subscriber is seeded by its own paint only", async () => {
    const host = new FakeHost();
    const b = broker(host);
    const first = makeSub();
    await b.attach(first);
    host.views[0]!.data("scrolled-off line\r\n".repeat(100));
    const late = makeSub();
    await b.attach(late);
    expect(late.received).toEqual(["PAINT"]);
    expect(b.historyByteLength).toBe(0);
    expect(b.pipeOutputPath).toBeNull();
  });

  it("decodes a multibyte character split across frames, and drops a half one when a fresh paint starts", async () => {
    const host = new FakeHost();
    const sub = makeSub();
    await broker(host).attach(sub);
    const view = host.views[0]!;
    const e = Buffer.from("é");
    view.data(e.subarray(0, 1));
    view.data(e.subarray(1));
    expect(sub.received.slice(1)).toEqual(["é"]);
    view.data(Buffer.from("中").subarray(0, 2));
    view.paint("NEW");  // a repaint or reconnect: the half character belongs to the old stream and must not prefix the new paint
    expect(sub.received.slice(2)).toEqual(["NEW"]);
  });

  it("detaches a subscriber whose send throws, and keeps delivering to the others", async () => {
    const host = new FakeHost();
    const b = broker(host);
    const dead = makeSub();
    const live = makeSub();
    await b.attach(dead);
    await b.attach(live);
    dead.send = () => { throw new Error("socket closed"); };
    host.views[0]!.data("x");
    host.views[1]!.data("y");
    expect(live.received).toEqual(["PAINT", "y"]);
    expect(host.views[0]!.closes).toBe(1);
    expect(b.subscriberCount).toBe(1);
  });
});

// ---- honest closes -----------------------------------------------------------------------------------------------------

describe("a stream host: honest closes", () => {
  it("closes 1008 for a session that is not there, and evicts the broker", async () => {
    const host = new FakeHost();
    host.results.push({ ok: false, end: { reason: "absent" } });
    const gone: string[] = [];
    const sub = makeSub();
    await broker(host, (name) => gone.push(name)).attach(sub);
    expect(sub.closed).toEqual([{ code: 1008, reason: "session not found: dev@rig" }]);
    expect(gone).toEqual(["dev@rig"]);
  });

  it("closes 1001 with the exit code for a terminal that had already finished", async () => {
    const host = new FakeHost();
    host.results.push({ ok: false, end: ENDED });
    const sub = makeSub();
    await broker(host).attach(sub);
    expect(sub.closed).toEqual([{ code: 1001, reason: "session terminated: exited, exit code 3" }]);
  });

  it("closes 1011 naming the cause for a core that cannot be reached", async () => {
    const host = new FakeHost();
    host.results.push({ ok: false, end: { reason: "unavailable", cause: "no socket" } });
    const sub = makeSub();
    await broker(host).attach(sub);
    expect(sub.closed).toEqual([{ code: 1011, reason: "hc core unavailable: no socket" }]);
  });

  it("closes EVERY subscriber when the program ends, with its exit code or signal, never leaving one looking live", async () => {
    const host = new FakeHost();
    const gone: string[] = [];
    const b = broker(host, (name) => gone.push(name));
    const a = makeSub();
    const c = makeSub();
    await b.attach(a);
    await b.attach(c);
    host.views[0]!.end(ENDED);
    host.views[1]!.end(ENDED);  // the core sends the CLOSE on every attached channel
    expect(a.closed).toEqual([{ code: 1001, reason: "session terminated: exited, exit code 3" }]);
    expect(c.closed).toEqual([{ code: 1001, reason: "session terminated: exited, exit code 3" }]);
    expect(host.views.map((v) => v.closes)).toEqual([1, 1]);
    expect(gone).toEqual(["dev@rig"]);  // once
    expect(b.subscriberCount).toBe(0);
  });

  it("says the signal, not an exit code, for a program that was killed", async () => {
    const host = new FakeHost();
    const sub = makeSub();
    await broker(host).attach(sub);
    host.views[0]!.end({ reason: "program_ended", exitCode: null, signal: 9, endReason: "killed", finishedMs: 1 });
    expect(sub.closed).toEqual([{ code: 1001, reason: "session terminated: killed, signal 9" }]);
  });

  it("closes 1011 for every subscriber when the core did not come back, and 1001 when the terminal is gone after a restart", async () => {
    const lostHost = new FakeHost();
    const a = makeSub();
    await broker(lostHost).attach(a);
    lostHost.views[0]!.end({ reason: "unavailable", cause: "down 3" });
    expect(a.closed).toEqual([{ code: 1011, reason: "hc core unavailable: down 3" }]);

    const goneHost = new FakeHost();
    const c = makeSub();
    await broker(goneHost).attach(c);
    goneHost.views[0]!.end({ reason: "absent" });
    expect(c.closed).toEqual([{ code: 1001, reason: "session terminated: it is gone" }]);
  });

  it("keeps a close reason inside a WebSocket close frame's 123 bytes", async () => {
    const host = new FakeHost();
    const sub = makeSub();
    await broker(host).attach(sub);
    host.views[0]!.end({ reason: "unavailable", cause: "é".repeat(200) });
    expect(Buffer.byteLength(sub.closed[0]!.reason)).toBeLessThanOrEqual(123);
    expect(sub.closed[0]!.reason.startsWith("hc core unavailable: é")).toBe(true);
    expect(sub.closed[0]!.reason).not.toContain("�");
  });

  it("closes a late attach honestly when the program ended, and never adds it", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    host.views[0]!.end(ENDED);
    const late = makeSub();
    await b.attach(late);
    expect(late.closed).toEqual([{ code: 1001, reason: "session terminated: exited, exit code 3" }]);
    expect(host.opened).toHaveLength(1);
    expect(b.subscriberCount).toBe(0);
  });

  it("closes an attach that was still opening when the program ended, and closes its view", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    let release!: () => void;
    host.gate = new Promise((resolve) => { release = resolve; });
    const late = makeSub();
    const pending = b.attach(late);
    host.views[0]!.end(ENDED);
    release();
    await pending;
    expect(late.closed).toEqual([{ code: 1001, reason: "session terminated: exited, exit code 3" }]);
    expect(late.received).toEqual([]);  // not even the paint of a view that is being thrown away
    expect(host.views[1]!.closes).toBe(1);
    expect(b.subscriberCount).toBe(0);
  });

  it("closes only the subscriber whose attach failed while others are watching, and keeps the session", async () => {
    const host = new FakeHost();
    const gone: string[] = [];
    const b = broker(host, (name) => gone.push(name));
    const watching = makeSub();
    await b.attach(watching);
    host.results.push({ ok: false, end: { reason: "unavailable", cause: "blip" } });
    const failed = makeSub();
    await b.attach(failed);
    expect(failed.closed).toEqual([{ code: 1011, reason: "hc core unavailable: blip" }]);
    expect(watching.closed).toEqual([]);
    expect(gone).toEqual([]);
    host.views[0]!.data("still live");
    expect(watching.received).toEqual(["PAINT", "still live"]);
  });

  it("closes every concurrent first attach when the session is not there, none left live", async () => {
    const host = new FakeHost();
    host.results.push({ ok: false, end: { reason: "absent" } }, { ok: false, end: { reason: "absent" } });
    const gone: string[] = [];
    const b = broker(host, (name) => gone.push(name));
    const subs = [makeSub(), makeSub()];
    await Promise.all(subs.map((s) => b.attach(s)));
    for (const s of subs) expect(s.closed).toEqual([{ code: 1008, reason: "session not found: dev@rig" }]);
    expect(b.subscriberCount).toBe(0);
    expect(gone).toEqual(["dev@rig"]);
  });
});

// ---- lifecycle ---------------------------------------------------------------------------------------------------------

describe("a stream host: lifecycle", () => {
  it("survives while subscribers remain, and the last detach closes the views and evicts the broker", async () => {
    const host = new FakeHost();
    const gone: string[] = [];
    const b = broker(host, (name) => gone.push(name));
    const a = makeSub();
    const c = makeSub();
    await b.attach(a);
    await b.attach(c);
    b.detach(a);
    expect(host.views.map((v) => v.closes)).toEqual([1, 0]);
    expect(gone).toEqual([]);
    expect(b.subscriberCount).toBe(1);
    b.detach(a);  // not a member: nothing
    expect(gone).toEqual([]);
    b.detach(c);
    expect(host.views.map((v) => v.closes)).toEqual([1, 1]);
    expect(gone).toEqual(["dev@rig"]);
  });

  it("dispose closes every view and evicts, once", async () => {
    const host = new FakeHost();
    const gone: string[] = [];
    const b = broker(host, (name) => gone.push(name));
    await b.attach(makeSub());
    await b.attach(makeSub());
    b.dispose();
    b.dispose();
    expect(host.views.map((v) => v.closes)).toEqual([1, 1]);
    expect(gone).toEqual(["dev@rig"]);
    const after = makeSub();
    await b.attach(after);
    expect(after.closed).toEqual([{ code: 1011, reason: "terminal broker unavailable" }]);
  });

  it("closes a subscriber that left while its attach was in flight, instead of keeping its view", async () => {
    const host = new FakeHost();
    const b = broker(host);
    let release!: () => void;
    host.gate = new Promise((resolve) => { release = resolve; });
    const sub = makeSub();
    const pending = b.attach(sub);
    b.dispose();
    release();
    await pending;
    expect(host.views[0]!.closes).toBe(1);
    expect(sub.closed).toEqual([{ code: 1011, reason: "terminal broker unavailable" }]);
  });

  it("the registry shares one broker per session, evicts it with the last subscriber, and builds a fresh one after", async () => {
    const host = new FakeHost();
    const registry = new TerminalBrokerRegistry(host);
    const a = makeSub();
    const c = makeSub();
    const first = await registry.attach("dev@rig", a);
    const second = await registry.attach("dev@rig", c);
    const other = await registry.attach("other@rig", makeSub());
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(registry.size).toBe(2);
    first.detach(a);
    first.detach(c);
    expect(registry.size).toBe(1);
    const again = await registry.attach("dev@rig", makeSub());
    expect(again).not.toBe(first);
    expect(host.opened).toEqual(["dev@rig", "dev@rig", "other@rig", "dev@rig"]);
  });

  it("the registry evicts a session that is not there", async () => {
    const host = new FakeHost();
    host.results.push({ ok: false, end: { reason: "absent" } });
    const registry = new TerminalBrokerRegistry(host);
    const sub = makeSub();
    await registry.attach("dev@rig", sub);
    expect(sub.closed[0]).toEqual({ code: 1008, reason: "session not found: dev@rig" });
    expect(registry.size).toBe(0);
  });
});

// ---- input -------------------------------------------------------------------------------------------------------------

describe("a stream host: a person's input", () => {
  it("sends keys by key and text by paste, to the seat by its canonical name", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    await b.input({ type: "keys", keys: ["Up", "Enter"] });
    await b.input({ type: "text", text: "echo hi" });
    expect(host.keys).toEqual([["dev@rig", ["Up", "Enter"]]]);
    expect(host.pastes).toEqual([["dev@rig", "echo hi"]]);
  });

  it("removes a paste-end sequence from pasted text, and leaves keys as sent", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    await b.input({ type: "text", text: "a\x1b[201~rm -rf /\r" });
    await b.input({ type: "keys", keys: ["\x1b[201~"] });
    expect(host.pastes[0]![1]).not.toContain("\x1b[201~");
    expect(host.pastes[0]![1]).toContain("rm -rf /");
    expect(host.keys[0]![1]).toEqual(["\x1b[201~"]);
  });

  it("keeps rapid input in order", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    void b.input({ type: "text", text: "slow" });
    void b.input({ type: "keys", keys: ["x"] });
    await b.input({ type: "text", text: "last" });
    expect(host.inputOrder).toEqual(["paste:slow", "keys:x", "paste:last"]);
  });

  it("marks the input as a person's when the host has a delivery guard", async () => {
    const host = hostWithHumanInput();
    const b = broker(host);
    await b.attach(makeSub());
    await b.input({ type: "keys", keys: ["a"] });
    await b.input({ type: "text", text: "b" });
    expect(host.humanInputs).toBe(2);
    expect(host.inputOrder).toEqual(["keys:a", "paste:b"]);
  });

  it("types nothing after the session was torn down", async () => {
    const host = new FakeHost();
    const b = broker(host);
    await b.attach(makeSub());
    host.views[0]!.end(ENDED);
    await b.input({ type: "keys", keys: ["a"] });
    await b.input({ type: "text", text: "b" });
    expect(host.inputOrder).toEqual([]);
  });
});

// ---- scroll ------------------------------------------------------------------------------------------------------------

describe("a stream host: per-subscriber scroll-back", () => {
  const SCREEN = (n: number) => Array.from({ length: n }, (_, i) => `L${String(i + 1).padStart(2, "0")}`);
  /** A capture of `n` rows ending at the live bottom, newline-terminated as terminal.read text is made. */
  const capture = (n: number) => `${SCREEN(n).join("\n")}\n`;

  async function scrolling() {
    const host = new FakeHost();
    const b = broker(host);
    const sub = makeSub();
    const other = makeSub();
    await b.attach(sub);
    await b.attach(other);
    return { host, b, sub, other };
  }

  it("paints a bottom-anchored window `offset` lines up, as tall as the terminal is now, to that subscriber only", async () => {
    const { host, b, sub, other } = await scrolling();
    host.history = capture(20);
    await b.scroll(sub, 3);
    // asks for the offset plus the terminal's current rows (5 here, not a fixed 27)
    expect(host.histories).toEqual([["dev@rig", 8]]);
    expect(sub.received.at(-1)).toBe(screenSnapshotEscape(SCREEN(20).slice(12, 17).join("\n"), null));
    expect(sub.received.at(-1)).toContain("\x1b[1;1HL13");
    expect(sub.received.at(-1)).toContain("\x1b[5;1HL17");
    expect(other.received).toEqual(["PAINT"]);
  });

  it("shows the oldest screenful when scrolled to or past the top of what exists", async () => {
    const { host, b, sub } = await scrolling();
    host.history = capture(7);
    await b.scroll(sub, 100);
    expect(sub.received.at(-1)).toBe(screenSnapshotEscape(SCREEN(7).slice(0, 5).join("\n"), null));
  });

  it("follows the terminal's size when it asks for the window", async () => {
    const { host, b, sub } = await scrolling();
    host.views[0]!.sizeNow = { cols: 200, rows: 12 };
    host.history = capture(40);
    await b.scroll(sub, 4);
    expect(host.histories).toEqual([["dev@rig", 16]]);
  });

  it("skips a scrolled subscriber in the live stream, while the others keep streaming", async () => {
    const { host, b, sub, other } = await scrolling();
    host.history = capture(20);
    await b.scroll(sub, 3);
    const before = sub.received.length;
    host.views[0]!.data("live-a");
    host.views[1]!.data("live-b");
    expect(sub.received).toHaveLength(before);
    expect(other.received).toEqual(["PAINT", "live-b"]);
  });

  it("returns to live by attaching again for a true screen, and the subscriber rejoins the stream", async () => {
    const { host, b, sub } = await scrolling();
    host.history = capture(20);
    await b.scroll(sub, 3);
    host.views[0]!.onRepaint = () => host.views[0]!.paint("REPAINT");
    await b.scroll(sub, 0);
    expect(host.views[0]!.repaints).toBe(1);
    expect(sub.received.at(-1)).toBe("REPAINT");
    host.views[0]!.data("live-again");
    expect(sub.received.at(-1)).toBe("live-again");
  });

  it("does not repaint a subscriber that is already live", async () => {
    const { host, b, sub } = await scrolling();
    await b.scroll(sub, 0);
    expect(host.views[0]!.repaints).toBe(0);
  });

  it("never reads the history of a full-screen app: that injects wheel events into it", async () => {
    for (const modes of [{ altScreen: true, mouse: false }, { altScreen: false, mouse: true }, { altScreen: true, mouse: true }]) {
      const { host, b, sub } = await scrolling();
      host.views[0]!.modesNow = modes;
      host.history = capture(20);
      await b.scroll(sub, 3);
      await b.scroll(sub, 50);
      expect(host.histories, JSON.stringify(modes)).toEqual([]);
      host.views[0]!.data("live");
      expect(sub.received.at(-1)).toBe("live");  // and stays live, not frozen at an offset it never painted
      b.dispose();
    }
  });

  it("reads when the app is on a plain screen, and reads again once it leaves the full-screen one", async () => {
    const { host, b, sub } = await scrolling();
    host.history = capture(20);
    host.views[0]!.modesNow = { altScreen: true, mouse: false };
    await b.scroll(sub, 3);
    host.views[0]!.modesNow = { altScreen: false, mouse: false };
    await b.scroll(sub, 3);
    expect(host.histories).toHaveLength(1);
  });

  it("leaves the subscriber live and silent when the read fails or finds nothing", async () => {
    const { host, b, sub } = await scrolling();
    host.history = null;
    await b.scroll(sub, 3);
    host.history = async () => { throw new Error("boom"); };
    await b.scroll(sub, 3);
    expect(sub.received).toEqual(["PAINT"]);
    host.views[0]!.data("live");
    expect(sub.received.at(-1)).toBe("live");
  });

  it("drops a read that a newer scroll request overtook", async () => {
    const { host, b, sub } = await scrolling();
    let release!: (text: string) => void;
    host.history = () => new Promise((resolve) => { release = resolve; });
    const slow = b.scroll(sub, 3);
    host.history = capture(20);
    await b.scroll(sub, 6);
    const painted = sub.received.length;
    release(capture(20));
    await slow;
    expect(sub.received).toHaveLength(painted);
    expect(sub.received.at(-1)).toBe(screenSnapshotEscape(SCREEN(20).slice(9, 14).join("\n"), null));
  });

  it("is a no-op for a subscriber it does not know and after teardown", async () => {
    const { host, b } = await scrolling();
    host.history = capture(20);
    const stranger = makeSub();
    await b.scroll(stranger, 3);
    expect(stranger.received).toEqual([]);
    expect(host.histories).toEqual([]);
    b.dispose();
    await b.scroll(makeSub(), 3);
    expect(host.histories).toEqual([]);
  });

  it("detaches a subscriber whose socket died under the window paint", async () => {
    const host = new FakeHost();
    const b = broker(host);
    const sub = makeSub();
    await b.attach(sub);
    host.history = capture(20);
    sub.send = () => { throw new Error("closed"); };
    await b.scroll(sub, 3);
    expect(b.subscriberCount).toBe(0);
  });
});

describe("a stream host: the tmux half stays out of it", () => {
  it("never touches a method only a tmux host has", async () => {
    const host = new FakeHost();
    const spy = vi.spyOn(host, "view");
    const b = broker(host);
    await b.attach(makeSub());
    expect(spy).toHaveBeenCalledOnce();
    expect(Object.keys(host).filter((key) => /pipe|resize|capture|cursor|hasSession/i.test(key))).toEqual([]);
  });
});
