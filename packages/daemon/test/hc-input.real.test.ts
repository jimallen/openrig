import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcClient, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HcAttach, type HcAttachEnd } from "../src/adapters/hc-attach.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const SECRET = `sv-${process.pid}-needle`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A poll that survives a loaded host: the stub reads its stdin and handles SIGWINCH on its own schedule. */
function poll<T>(fn: () => T | Promise<T>) { return expect.poll(fn, { timeout: 8_000 }); }

/** A stub program on a pty. It logs every chunk of stdin as hex and every SIGWINCH, can switch bracketed paste on,
 *  and can report a status over OSC 7501. Everything below is measured against a private hc core, never a fake. */
const STUB = `
import os, signal, sys, tty
mode, stdin_log, winch_log = sys.argv[1], sys.argv[2], sys.argv[3]
tty.setraw(0)
winch = open(winch_log, "ab", buffering=0)
def on_winch(*_):
    size = os.get_terminal_size(0)
    winch.write(("%dx%d\\n" % (size.columns, size.lines)).encode())
signal.signal(signal.SIGWINCH, on_winch)
if "bp" in mode.split(","):
    os.write(1, b"\\x1b[?2004h")
if "blocked" in mode.split(","):
    os.write(1, b"\\x1b]7501;state=blocked:app=stub:kind=permission\\x1b\\\\")
if "idle" in mode.split(","):
    os.write(1, b"\\x1b]7501;state=idle:app=stub\\x1b\\\\")
os.write(1, b"READY\\r\\n")
log = open(stdin_log, "ab", buffering=0)
while True:
    try:
        b = os.read(0, 65536)
    except InterruptedError:
        continue
    if not b:
        break
    log.write(b.hex().encode() + b"\\n")
`;

describe.skipIf(!HC)("HcAttach and HcInput against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "hci-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `i${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;
  let attach: HcAttach;
  let input: HcInput;
  let host: HcHost;
  let stubPath: string;
  let n = 0;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    const socket = resolveHcSocket(env, env.HOME);
    client = new HcClient(socket);
    attach = new HcAttach(socket);
    input = new HcInput(client, attach, { deliveryTimeoutMs: 4_000 });
    host = new HcHost(client, { daemonEnv: { PATH: process.env.PATH, HOME: env.HOME, SHELL: "/bin/sh" } });
    stubPath = join(root, "stub.py");
    writeFileSync(stubPath, STUB);
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  interface Stub { seat: string; address: string; stdin: () => Buffer; winches: () => string[] }

  async function launch(mode: string): Promise<Stub> {
    const seat = `stub${++n}@rig`;
    const address = hcTerminalName(seat);
    const stdinLog = join(root, `${address}.stdin`);
    const winchLog = join(root, `${address}.winch`);
    writeFileSync(stdinLog, "");
    writeFileSync(winchLog, "");
    await client.call("terminal.run", { argv: ["python3", "-I", stubPath, mode, stdinLog, winchLog], name: address, labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true });
    await poll(async () => (await client.call<{ text: string }>("terminal.read", { terminal: address })).text).toContain("READY");
    if (mode.includes("blocked")) await poll(async () => (await client.call<HcTerminal>("terminal.get", { terminal: address })).status?.state).toBe("blocked");
    return {
      seat, address,
      stdin: () => Buffer.concat(readFileSync(stdinLog, "utf8").split("\n").filter(Boolean).map((hex) => Buffer.from(hex, "hex"))),
      winches: () => readFileSync(winchLog, "utf8").split("\n").filter(Boolean),
    };
  }

  const size = async (address: string) => { const t = await client.call<HcTerminal>("terminal.get", { terminal: address }); return `${t.cols}x${t.rows}`; };

  describe("the framed attach channel", () => {
    it("paints first, learns the channel from the reply, and detaches on the core's answer", async () => {
      const stub = await launch("bp");
      const chunks: Buffer[] = [];
      const ends: HcAttachEnd[] = [];
      const a = await attach.open({ terminal: stub.address, cols: 100, rows: 30, observe: true }, { onData: (b) => chunks.push(b), onEnd: (e) => ends.push(e) });
      await poll(() => Buffer.concat(chunks).toString("latin1")).toContain("READY");
      expect(a.terminal.name).toBe(stub.address);
      await expect(a.detach()).resolves.toEqual({ reason: "detached" });
      expect(ends).toEqual([{ reason: "detached" }]);
    });

    it("keeps an observer from typing or resizing, and the core agrees it cannot", async () => {
      const stub = await launch("plain");
      const a = await attach.open({ terminal: stub.address, cols: 50, rows: 10, observe: true }, { onData: () => {}, onEnd: () => {} });
      expect(() => a.write("x")).toThrow(/observer/);
      expect(() => a.resize(10, 10)).toThrow(/observer/);
      await a.detach();
      expect(await size(stub.address)).toBe("200x120");
      expect(stub.stdin().length).toBe(0);
    });

    it("types on a writer, resizes it, and carries more than one frame of bytes whole", async () => {
      const stub = await launch("plain");
      const a = await attach.open({ terminal: stub.address, cols: 100, rows: 30 }, { onData: () => {}, onEnd: () => {} });
      const big = Buffer.alloc(50_000, "x");
      a.write("hi\r");
      a.write(big);
      a.resize(70, 20);
      await poll(() => size(stub.address)).toBe("70x20");
      await expect(a.detach()).resolves.toEqual({ reason: "detached" });
      await poll(() => stub.stdin().toString("latin1").length).toBe(3 + big.length);
      expect(stub.stdin().toString("latin1")).toBe(`hi\r${big.toString("latin1")}`);
      await poll(() => stub.winches()).toContain("70x20");
    });

    it("reports the program's finish with its reason, and an attach to a missing terminal as not_found", async () => {
      const stub = await launch("plain");
      const ends: HcAttachEnd[] = [];
      const a = await attach.open({ terminal: stub.address, cols: 100, rows: 30, observe: true }, { onData: () => {}, onEnd: (e) => ends.push(e) });
      await client.call("terminal.kill", { terminal: stub.address });
      await poll(() => ends.length).toBe(1);
      expect(ends[0]).toMatchObject({ reason: "program_ended", endReason: "killed" });
      await a.detach();
      await expect(attach.open({ terminal: "t9999", cols: 80, rows: 24 }, { onData: () => {}, onEnd: () => {} })).rejects.toMatchObject({ kind: "not_found" });
    });
  });

  describe("sendText stages text with no Enter", () => {
    it("brackets the paste for a program that turned bracketed paste on, and presses no Enter", async () => {
      const stub = await launch("bp");
      await expect(input.sendText(stub.seat, "staged text")).resolves.toEqual({ ok: true });
      await poll(() => stub.stdin().toString("latin1")).toBe("\x1b[200~staged text\x1b[201~");
      await wait(400);
      expect(stub.stdin().toString("latin1")).toBe("\x1b[200~staged text\x1b[201~");
    });

    it("sends the bytes as they are to a program that did not, newlines included", async () => {
      const stub = await launch("plain");
      await input.sendText(stub.seat, "one\ntwo");
      await poll(() => stub.stdin().toString("latin1")).toBe("one\ntwo");
    });

    it("sends key input with no brackets for bracketed: false, even to a bracketed program", async () => {
      const stub = await launch("bp");
      await input.sendText(stub.seat, "3", undefined, { bracketed: false });
      await poll(() => stub.stdin().toString("latin1")).toBe("3");
    });

    it("delivers 100 KB whole, in order", async () => {
      const stub = await launch("bp");
      const text = Array.from({ length: 2_000 }, (_, i) => `line ${String(i).padStart(5, "0")} ${"y".repeat(40)}`).join("\n");
      expect(text.length).toBeGreaterThan(100_000);
      await expect(input.sendText(stub.seat, text)).resolves.toEqual({ ok: true });
      await poll(() => stub.stdin().toString("latin1").length).toBe(text.length + 12);
      expect(stub.stdin().toString("latin1")).toBe(`\x1b[200~${text}\x1b[201~`);
    });

    it("leaves the terminal's size alone while a person is attached at another size", async () => {
      const stub = await launch("bp");
      const person = await attach.open({ terminal: stub.address, cols: 120, rows: 40 }, { onData: () => {}, onEnd: () => {} });
      expect(await size(stub.address)).toBe("120x40");
      await poll(() => stub.winches()).toEqual(["120x40"]);
      await input.sendText(stub.seat, "x");
      await poll(() => stub.stdin().toString("latin1")).toBe("\x1b[200~x\x1b[201~");
      await wait(300);
      expect(await size(stub.address)).toBe("120x40");
      expect(stub.winches()).toEqual(["120x40"]);
      await person.detach();
    });

    it("refuses a bracketed paste whose text would end the paste, writing nothing", async () => {
      const stub = await launch("bp");
      await expect(input.sendText(stub.seat, "a\x1b[201~b")).resolves.toMatchObject({ ok: false, code: "paste_terminator" });
      await wait(200);
      expect(stub.stdin().length).toBe(0);
    });

    it("refuses a blocked program unless allowed, then answers its dialog", async () => {
      const stub = await launch("bp,blocked");
      await expect(input.sendText(stub.seat, "1")).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
      await wait(200);
      expect(stub.stdin().length).toBe(0);
      await expect(input.sendText(stub.seat, "1", undefined, { bracketed: false, blocked: "allow" })).resolves.toEqual({ ok: true });
      await poll(() => stub.stdin().toString("latin1")).toBe("1");
    });

    it("reports a finished or missing seat as session_not_found, nothing written", async () => {
      const stub = await launch("plain");
      await client.call("terminal.kill", { terminal: stub.address });
      await poll(async () => (await client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state).toBe("finished");
      await expect(input.sendText(stub.seat, "x")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
      await expect(input.sendText("never@rig", "x")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    });
  });

  describe("sendKeys", () => {
    const table: Array<[string, string]> = [
      ["Enter", "0d"], ["Escape", "1b"], ["Tab", "09"], ["BTab", "1b5b5a"], ["BSpace", "7f"], ["Space", "20"],
      ["Up", "1b5b41"], ["Down", "1b5b42"], ["Right", "1b5b43"], ["Left", "1b5b44"], ["Home", "1b5b48"], ["End", "1b5b46"],
      ["PgUp", "1b5b357e"], ["PgDn", "1b5b367e"], ["DC", "1b5b337e"], ["IC", "1b5b327e"],
      ["C-c", "03"], ["C-d", "04"], ["C-Space", "00"], ["C-/", "1f"], ["M-x", "1b78"], ["S-Up", "1b5b313b3241"],
      ["F1", "1b4f50"], ["F12", "1b5b32347e"], ["a", "61"], ["3", "33"], ["A", "41"], ["Z", "5a"],
    ];

    it.each(table)("presses tmux's %s as bytes %s", async (key, hex) => {
      const stub = await launch("plain");
      await expect(input.sendKeys(stub.seat, [key])).resolves.toEqual({ ok: true });
      await poll(() => stub.stdin().toString("hex")).toBe(hex);
    });

    it("presses several keys in order, and nothing for the empty strings of the redraw nudge", async () => {
      const stub = await launch("plain");
      await input.sendKeys(stub.seat, ["", "", "a", "Enter"]);
      await poll(() => stub.stdin().toString("hex")).toBe("610d");
      await expect(input.sendKeys(stub.seat, ["", ""])).resolves.toEqual({ ok: true });
    });

    it("refuses a name hc has no key for, before pressing any", async () => {
      const stub = await launch("plain");
      await expect(input.sendKeys(stub.seat, ["a", "hello"])).resolves.toMatchObject({ ok: false, code: "unsupported_key" });
      await expect(input.sendKeys(stub.seat, ["a", ":"])).resolves.toMatchObject({ ok: false, code: "unsupported_key" });
      await wait(200);
      expect(stub.stdin().length).toBe(0);
    });

    it("refuses to answer a blocked program's dialog by default, and answers it when allowed", async () => {
      const stub = await launch("blocked");
      await expect(input.sendKeys(stub.seat, ["Enter"])).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
      await wait(200);
      expect(stub.stdin().length).toBe(0);
      await expect(input.sendKeys(stub.seat, ["Enter"], undefined, { blocked: "allow" })).resolves.toEqual({ ok: true });
      await poll(() => stub.stdin().toString("hex")).toBe("0d");
    });

    it("reports a finished seat as session_not_found", async () => {
      const stub = await launch("plain");
      await client.call("terminal.kill", { terminal: stub.address });
      await poll(async () => (await client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state).toBe("finished");
      await expect(input.sendKeys(stub.seat, ["Enter"], undefined, { blocked: "allow" })).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    });
  });

  describe("submitText", () => {
    // A program that reports status makes hc watch ~5 s for the turn to start, so a delivered send can take that long.
    const slow = () => new HcInput(client, attach, { deliveryTimeoutMs: 20_000 });

    it("pastes and presses Enter as one send, and returns the turn", async () => {
      const stub = await launch("bp,idle");
      const sent = await slow().submitText(stub.seat, "hello agent");
      expect(sent).toMatchObject({ ok: true, status: "idle", turn: 0 });
      await poll(() => stub.stdin().toString("latin1")).toBe("\x1b[200~hello agent\x1b[201~\r");
    });

    it("lets hc refuse a blocked program, types nothing, and types when forced", async () => {
      const stub = await launch("bp,blocked");
      await expect(input.submitText(stub.seat, "no")).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
      await wait(300);
      expect(stub.stdin().length).toBe(0);
      await expect(slow().submitText(stub.seat, "yes", { force: true })).resolves.toMatchObject({ ok: true });
      await poll(() => stub.stdin().toString("latin1")).toBe("\x1b[200~yes\x1b[201~\r");
    });

    it("refuses on a status mismatch with nothing typed", async () => {
      const stub = await launch("bp,idle");
      await expect(input.submitText(stub.seat, "x", { ifStatus: "working" })).resolves.toMatchObject({ ok: false, code: "status_mismatch" });
      await wait(300);
      expect(stub.stdin().length).toBe(0);
    });

    it("reads a timeout while a person types as an unknown outcome, and the send still lands afterwards", async () => {
      const stub = await launch("bp");
      const person = await attach.open({ terminal: stub.address, cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
      person.write("p");
      const quick = new HcInput(client, attach, { deliveryTimeoutMs: 700 });
      const sent = await quick.submitText(stub.seat, "late");
      expect(sent).toMatchObject({ ok: false, code: "delivery_outcome_unknown" });
      // The queued send survived its client (spike 1+2): a blind retry here would deliver twice.
      await expect.poll(() => stub.stdin().toString("latin1"), { timeout: 8_000 }).toContain("\x1b[200~late\x1b[201~");
      await person.detach();
    });
  });

  describe("sendShellCommand", () => {
    it("runs the command from a staged script that removes itself, and keeps a secret off the pane and the argv", async () => {
      await host.createSession("shell@rig", root);
      const out = join(root, "shell-out.txt");
      const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("openrig-tmux-send-")));
      await expect(input.sendShellCommand("shell@rig", `API_KEY=${SECRET}; echo "$API_KEY" > ${out}`)).resolves.toEqual({ ok: true });
      await poll(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }).toContain(SECRET);
      const pane = (await client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName("shell@rig"), lines: 50 })).text;
      expect(pane).not.toContain(SECRET);
      expect(spawnSync("ps", ["-axww", "-o", "args"], { encoding: "utf8" }).stdout).not.toContain(SECRET);
      await poll(() => readdirSync(tmpdir()).filter((f) => f.startsWith("openrig-tmux-send-") && !before.has(f))).toEqual([]);
    });

    it("sources the script in a POSIX pane shell for sourceInPane, so a shell function stays, and not otherwise", async () => {
      await host.createSession("src@rig", root);
      const address = hcTerminalName("src@rig");
      await client.call("terminal.send", { terminal: address, text: "myfn() { echo fn-ran > " + join(root, "fn-out.txt") + "; }" });
      await wait(500);
      await input.sendShellCommand("src@rig", "myfn", undefined, { sourceInPane: true });
      await poll(() => existsSync(join(root, "fn-out.txt"))).toBe(true);
      rmSync(join(root, "fn-out.txt"));
      await input.sendShellCommand("src@rig", "myfn || echo nofn > " + join(root, "nofn-out.txt"));
      await poll(() => existsSync(join(root, "nofn-out.txt"))).toBe(true);
      expect(existsSync(join(root, "fn-out.txt"))).toBe(false);
    });
  });

  describe("a core restart", () => {
    it("ends a stream as core_lost, with no CLOSE, while the program lives on", async () => {
      const stub = await launch("plain");
      const ends: HcAttachEnd[] = [];
      await attach.open({ terminal: stub.address, cols: 100, rows: 30, observe: true }, { onData: () => {}, onEnd: (e) => ends.push(e) });
      execFileSync(HC, ["server", "restart"], { env, stdio: "ignore" });
      await expect.poll(() => ends, { timeout: 10_000 }).toEqual([{ reason: "core_lost" }]);
      await expect.poll(async () => (await client.call<HcTerminal>("terminal.get", { terminal: stub.address })).state, { timeout: 10_000 }).toBe("live");
    });
  });
});
