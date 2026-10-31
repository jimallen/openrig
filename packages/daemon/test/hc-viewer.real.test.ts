import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { resolveHcSocket, type HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { HcViewer, cursorOfPaint, type ViewEnd, type ViewHandlers, type ViewSize } from "../src/adapters/hc-viewer.js";
import { TerminalBrokerRegistry, TerminalSessionBroker, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

/** The live view against a private hc core (own HOME, XDG paths and HC_SESSION; the host's core and the app are never contacted).
 *  Programs are node scripts, so the suite needs nothing but node and hc. */
describe.skipIf(!HC)("HcViewer and the stream broker against a private hc core", () => {
  const core = new PrivateCore();
  let socket: string;
  let viewer: HcViewer;
  const input = () => new HcInput(core.client, new HcAttach(socket));
  const logOf = (name: string): string[] => {
    const path = join(core.root, `${name}.log`);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  };
  const get = (seat: string) => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });

  async function run(seat: string, code: string, ...args: string[]): Promise<void> {
    await core.client.call("terminal.run", {
      argv: [process.execPath, "-e", code, ...args], name: hcTerminalName(seat), labels: { [SEAT_LABEL]: seat }, cwd: core.root,
      no_parent: true, no_notify: true, outlive_parent: true,
    });
  }

  /** Raw mode, the modes `mode` says, and every byte it is typed logged as hex to <root>/<log>.log; and every resize. */
  const LOGGER = [
    "const fs=require('fs');const log=process.argv[1]+'.log';const mode=process.argv[2];",
    "process.stdin.setRawMode(true);process.stdin.resume();",
    "if(mode!=='plain')process.stdout.write('\\x1b[?1049h');",
    "if(mode==='mouse')process.stdout.write('\\x1b[?1000h\\x1b[?1006h');",
    "fs.appendFileSync(log,'START '+process.stdout.columns+'x'+process.stdout.rows+'\\n');",
    "process.stdout.on('resize',()=>fs.appendFileSync(log,'WINCH '+process.stdout.columns+'x'+process.stdout.rows+'\\n'));",
    "process.stdout.write('READY '+mode+'\\r\\n');",
    "process.stdin.on('data',d=>fs.appendFileSync(log,'KEY '+d.toString('hex')+'\\n'));",
    "setInterval(()=>{},1e6);",
  ].join("");
  const runLogger = (seat: string, mode: "mouse" | "alt" | "plain") => run(seat, LOGGER, join(core.root, seat.split("@")[0]!), mode);
  const readyLogger = (seat: string) => waitUntil(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(seat), lines: 0 })).text, (text) => text.includes("READY"), `${seat} ready`);

  function recorder() {
    const log = { events: [] as string[], sizes: [] as ViewSize[], bytes: [] as Buffer[], ends: [] as ViewEnd[], paints: 0 };
    const handlers: ViewHandlers = {
      onPaint: () => { log.paints++; log.events.push("paint"); },
      onSize: (size) => { log.sizes.push(size); log.events.push(`size ${size.cols}x${size.rows}`); },
      onData: (bytes) => { log.bytes.push(bytes); },
      onEnd: (end) => { log.ends.push(end); },
    };
    return { log, handlers, text: () => Buffer.concat(log.bytes).toString("utf8") };
  }

  function subscriber(): TerminalSubscriber & { sent: string[]; sizes: ViewSize[]; closed: { code: number; reason: string }[]; text(): string } {
    const sub = {
      sent: [] as string[], sizes: [] as ViewSize[], closed: [] as { code: number; reason: string }[],
      send(data: string) { sub.sent.push(data); },
      close(code: number, reason: string) { sub.closed.push({ code, reason }); },
      size(cols: number, rows: number) { sub.sizes.push({ cols, rows }); },
      text: () => sub.sent.join(""),
    };
    return sub;
  }

  beforeAll(async () => {
    core.start();
    socket = resolveHcSocket(core.env, core.env.HOME);
    viewer = new HcViewer({
      socketPath: socket,
      input: {
        keys: (name, keys) => input().sendKeys(name, keys, undefined, { blocked: "allow" }),
        paste: (name, text) => input().sendText(name, text, undefined, { blocked: "allow" }),
      },
    });
  }, 30_000);

  afterAll(() => core.stop());

  it("watches as an observer: the program is never resized, whatever the viewer asks", async () => {
    await run("calm@rig", LOGGER, join(core.root, "calm"), "plain");
    await readyLogger("calm@rig");
    const { log, handlers } = recorder();
    const opened = await viewer.view("calm@rig", handlers);
    if (!opened.ok) throw new Error(`not open: ${JSON.stringify(opened.end)}`);
    try {
      await waitUntil(async () => log.bytes.length, (n) => n > 0, "the first paint");
      expect(log.sizes).toEqual([{ cols: 200, rows: 120 }]);  // the terminal's own, not the 80x24 the attach asked for
      const terminal = await get("calm@rig");
      expect([terminal.cols, terminal.rows]).toEqual([200, 120]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(logOf("calm").filter((line) => line.startsWith("WINCH"))).toEqual([]);
    } finally {
      await opened.view.close();
    }
  });

  it("follows the terminal's size through the size event, and back when the last writer leaves", async () => {
    await run("sized@rig", LOGGER, join(core.root, "sized"), "plain");
    await readyLogger("sized@rig");
    const { log, handlers } = recorder();
    const opened = await viewer.view("sized@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    const attacher = new HcAttach(socket);
    try {
      const writer = await attacher.open({ terminal: hcTerminalName("sized@rig"), cols: 100, rows: 30 }, { onData: () => {}, onEnd: () => {} });
      await waitUntil(async () => log.sizes.length, (n) => n >= 2, "the writer's size");
      writer.resize(64, 16);
      await waitUntil(async () => log.sizes.length, (n) => n >= 3, "the writer's resize");
      await writer.detach();
      await waitUntil(async () => log.sizes.length, (n) => n >= 4, "the size after the writer left");
      expect(log.sizes).toEqual([{ cols: 200, rows: 120 }, { cols: 100, rows: 30 }, { cols: 64, rows: 16 }, { cols: 200, rows: 120 }]);
      expect(opened.view.size()).toEqual({ cols: 200, rows: 120 });
    } finally {
      await opened.view.close();
    }
  });

  it("paints the escapes, the program's modes and the cursor, which terminal.read never gives", async () => {
    await run("paint@rig", "process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[2J\\x1b[31mRED\\x1b[0m plain\\x1b[12;20H');setInterval(()=>{},1e6)");
    await waitUntil(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName("paint@rig"), lines: 0 })).text, (t) => t.includes("RED"), "paint@rig");
    const { log, handlers, text } = recorder();
    const opened = await viewer.view("paint@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    try {
      await waitUntil(async () => text(), (t) => t.includes("plain"), "the paint");
      expect(text()).toContain("\x1b[");  // escapes
      expect(text()).toMatch(/\x1b\[(?:[0-9;]*;)?(?:31|38;5;1)m/);  // the colour of RED
      expect(cursorOfPaint(text())).toEqual({ x: 19, y: 11 });
      expect(opened.view.modes()).toEqual({ altScreen: true, mouse: true });
      expect(log.paints).toBe(1);
      expect(await viewer.getPaneCursorPosition("paint@rig")).toEqual({ x: 19, y: 11, width: 200, height: 120 });
    } finally {
      await opened.view.close();
    }
  });

  it("reports a program's exit with its code and reason, and a finished terminal as ended, a missing one as absent", async () => {
    await run("short@rig", "process.stdout.write('bye\\r\\n');setTimeout(()=>process.exit(3),1200)");
    const { log, handlers } = recorder();
    const opened = await viewer.view("short@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    await waitUntil(async () => log.ends.length, (n) => n === 1, "the end");
    expect(log.ends[0]).toMatchObject({ reason: "program_ended", exitCode: 3, endReason: "exited" });
    expect(log.ends).toHaveLength(1);

    const after = await viewer.view("short@rig", recorder().handlers);
    expect(after).toMatchObject({ ok: false, end: { reason: "program_ended", exitCode: 3, endReason: "exited" } });
    expect(await viewer.view("nobody@rig", recorder().handlers)).toEqual({ ok: false, end: { reason: "absent" } });
  });

  it("attaches again after the core restarts and the program lives: a fresh paint, announced", async () => {
    await run("ticker@rig", "let n=0;setInterval(()=>process.stdout.write('tick '+(++n)+'\\r\\n'),100)");
    const { log, handlers, text } = recorder();
    const opened = await viewer.view("ticker@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    try {
      await waitUntil(async () => text(), (t) => /tick \d/.test(t), "first ticks");
      const pid = (await get("ticker@rig")).pid;
      const before = log.bytes.length;
      execFileSync(HC, ["server", "restart"], { env: core.env, stdio: "ignore" });
      await waitUntil(async () => log.paints, (n) => n >= 2, "the second paint", 30_000);
      await waitUntil(async () => log.bytes.length, (n) => n > before + 1, "bytes after the restart", 30_000);
      expect(log.ends).toEqual([]);
      expect((await get("ticker@rig")).pid).toBe(pid);  // the program lived through it
      expect(log.events.filter((e) => e === "paint")).toHaveLength(2);
    } finally {
      await opened.view.close();
    }
  }, 60_000);

  describe("through the stream broker", () => {
    it("never reads the history of a full-screen app that reports the mouse, and a read that does is the injection", async () => {
      await runLogger("wheel@rig", "mouse");
      await readyLogger("wheel@rig");
      const registry = new TerminalBrokerRegistry(viewer);
      const sub = subscriber();
      const broker = await registry.attach("wheel@rig", sub);
      try {
        await waitUntil(async () => sub.text(), (t) => t.includes("READY"), "the paint");
        for (const offset of [5, 50, 5, 0, 7]) await broker.scroll(sub, offset);
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(logOf("wheel").filter((line) => line.startsWith("KEY"))).toEqual([]);
        // The instrument can see them: a read that asks for history does inject wheel events (SGR mouse reports, 1b5b3c).
        await viewer.readHistory("wheel@rig", 100);
        await waitUntil(async () => logOf("wheel").filter((line) => line.startsWith("KEY")), (keys) => keys.length > 0, "the injected wheel events");
        expect(logOf("wheel").filter((line) => line.startsWith("KEY"))[0]).toMatch(/^KEY 1b5b3c3(?:6|7)/);
      } finally {
        broker.dispose();
      }
    });

    it("scrolls a plain screen from plain text, bottom-anchored, and returns to a true screen", async () => {
      await core.client.call("terminal.run", {
        argv: ["sh", "-c", "i=1; while [ $i -le 300 ]; do printf 'L%04d\\n' $i; i=$((i+1)); done; sleep 600"],
        name: hcTerminalName("lines@rig"), labels: { [SEAT_LABEL]: "lines@rig" }, cwd: core.root, no_parent: true, no_notify: true, outlive_parent: true,
      });
      await waitUntil(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName("lines@rig"), lines: 0 })).text, (t) => t.includes("L0300"), "lines@rig");
      const sub = subscriber();
      const broker = new TerminalSessionBroker("lines@rig", viewer);
      await broker.attach(sub);
      try {
        await waitUntil(async () => sub.text(), (t) => t.includes("L0300"), "the live screen");
        expect(sub.sizes).toEqual([{ cols: 200, rows: 120 }]);
        const before = sub.sent.length;
        await broker.scroll(sub, 10);
        const painted = sub.sent.slice(before).join("");
        expect(painted).toContain("L0290");
        expect(painted).not.toContain("L0291");
        expect(painted).toContain("L0171");
        await broker.scroll(sub, 0);
        await waitUntil(async () => sub.sent.slice(before).join(""), (t) => t.lastIndexOf("L0300") > t.lastIndexOf("L0290"), "the live screen again");
      } finally {
        broker.dispose();
      }
    });

    it("types a person's keys and pasted text into the program through terminal.keys and a writer at its own size", async () => {
      await runLogger("typed@rig", "plain");
      await readyLogger("typed@rig");
      const sub = subscriber();
      const broker = new TerminalSessionBroker("typed@rig", viewer);
      await broker.attach(sub);
      try {
        await waitUntil(async () => sub.text(), (t) => t.includes("READY"), "the paint");
        await broker.input({ type: "keys", keys: ["a", "Enter"] });
        await broker.input({ type: "text", text: "hi" });
        const keys = await waitUntil(async () => logOf("typed").filter((line) => line.startsWith("KEY")).join(" "), (k) => k.includes("6869") && k.includes("0d"), "the typed bytes");
        expect(keys).toContain("KEY 61");
        const terminal = await get("typed@rig");
        expect([terminal.cols, terminal.rows]).toEqual([200, 120]);  // typing did not resize it
        expect(logOf("typed").filter((line) => line.startsWith("WINCH"))).toEqual([]);
      } finally {
        broker.dispose();
      }
    });

    it("gives two subscribers a paint each, and closes both with the exit code when the program ends", async () => {
      await run("pair@rig", "process.stdout.write('PAIR-SCREEN\\r\\n');setTimeout(()=>process.exit(4),1500)");
      const registry = new TerminalBrokerRegistry(viewer);
      const a = subscriber();
      const b = subscriber();
      const broker = await registry.attach("pair@rig", a);
      await registry.attach("pair@rig", b);
      expect(registry.size).toBe(1);
      await waitUntil(async () => [a.text(), b.text()], ([x, y]) => x!.includes("PAIR-SCREEN") && y!.includes("PAIR-SCREEN"), "both paints");
      await waitUntil(async () => [a.closed.length, b.closed.length], ([x, y]) => x === 1 && y === 1, "both closes");
      expect(a.closed[0]).toEqual({ code: 1001, reason: "session terminated: exited, exit code 4" });
      expect(b.closed[0]).toEqual(a.closed[0]);
      expect(broker.subscriberCount).toBe(0);
      expect(registry.size).toBe(0);
    });

    it("closes 1008 for a session that is not there", async () => {
      const registry = new TerminalBrokerRegistry(viewer);
      const sub = subscriber();
      await registry.attach("nobody@rig", sub);
      expect(sub.closed).toEqual([{ code: 1008, reason: "session not found: nobody@rig" }]);
      expect(registry.size).toBe(0);
    });
  });
});
