// OF-200: a message pasted into a seat can run in the seat's login shell (finding-shell-paste-race-20261102.md).
//
// The core accepts a send and may HOLD it (0.45 s measured on a seat that has just been active, seconds on one that keeps repainting) before it
// writes, and re-checks only that the terminal is live. If the agent dies inside that hold and a login shell is still above it, the shell reads the
// paste and the Enter and runs the message, with the account's rights and outside the agent's sandbox and approval dialogs. The fix is that nothing
// is left above the agent: the launch REPLACES the login shell (`exec /bin/sh <script>`) or, for a sourced classic Claude, ENDS it (`exit`), so the
// terminal ends with the agent and the core refuses the send as `finished`.
//
// The seat is built as production builds it: HcHost.createSession (a login shell), then the agent is started with HcInput.sendShellCommand and the
// option set each runtime's adapter passes (the census in launch-as-terminal-program-census.test.ts pins those sets to the adapters), and a message
// goes in with HcInput.submitText (the pump's `terminal.send`: the paste and the Enter in one call). The canary is a file the message would create
// if a shell ran it. Everything runs against a private hc core (HC on PATH, else the suite skips) with a stub agent: no real agent, no daemon.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcClient, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcInput, type HcShellCommandOptions } from "../src/adapters/hc-input.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const SHELLS = ["/bin/zsh", "/bin/bash"].filter((candidate) => existsSync(candidate));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw mode, bracketed paste on (as Pi and Codex turn it on), writes its pid when ready, logs every byte it reads. With `repaint` it also draws
 *  about 20 times a second, which is what a real agent does and what makes the core hold a send for seconds. */
const STUB = `
import os, sys, tty, select
ready, log = sys.argv[1], sys.argv[2]
repaint = len(sys.argv) > 3 and sys.argv[3] == "repaint"
tty.setraw(0)
os.write(1, b"\\x1b[?2004h")
open(ready, "w").write(str(os.getpid()))
while True:
    r, _, _ = select.select([0], [], [], 0.05)
    if r:
        d = os.read(0, 65536)
        if not d:
            break
        open(log, "ab").write(d)
    elif repaint:
        os.write(1, b".")
`;

/** The option sets the runtimes' adapters pass (census: launch-as-terminal-program-census.test.ts), and the command shape each hands over. */
type Shape = "runner" | "codex" | "managed" | "classic";
const SHAPES: Record<Shape, { options: HcShellCommandOptions; why: string }> = {
  runner: { options: { stageIfLong: true, execInScript: true, asTerminalProgram: true }, why: "Pi, OMP, PDA and the stub: the script execs the runner, which is the terminal's own process" },
  codex: { options: { asTerminalProgram: true }, why: "Codex: the script is the terminal's program and the agent is its child (what the pump's agent check expects)" },
  managed: { options: { asTerminalProgram: true }, why: "managed Claude: `cd <cwd> && env -i claude ...`, a compound command, run by the script as a child" },
  classic: { options: { sourceInPane: true, asTerminalProgram: true }, why: "classic Claude: an rc function, so the launch is sourced in the pane shell, which then ends" },
};

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

describe.skipIf(!HC)("a message in flight when the agent dies (OF-200), on a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "spr-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `x${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;
  let input: HcInput;
  let stubPath: string;
  let n = 0;
  const hosts = new Map<string, HcHost>();
  /** The host for a pane shell: the login shell a seat's terminal starts with. */
  const hostFor = (shell: string): HcHost => {
    if (!hosts.has(shell)) hosts.set(shell, new HcHost(client, { daemonEnv: { PATH: process.env.PATH, HOME: env.HOME, SHELL: shell } }));
    return hosts.get(shell)!;
  };

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    const socket = resolveHcSocket(env, env.HOME);
    client = new HcClient(socket);
    input = new HcInput(client, new HcAttach(socket), { deliveryTimeoutMs: 8_000 });
    stubPath = join(root, "stub.py");
    writeFileSync(stubPath, STUB);
    // A classic Claude is an rc function. Both shells read it as a login shell they are started as (zsh: .zshrc; bash: .bash_profile).
    const rc = `stubagent() { python3 -I ${stubPath} "$@"; }\n`;
    writeFileSync(join(env.HOME!, ".zshrc"), rc);
    writeFileSync(join(env.HOME!, ".bash_profile"), rc);
  }, 30_000);

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  interface Trial { seat: string; address: string; pid: number; canary: string; log: string; body: string; shape: Shape; shell: string }

  /** A seat as production makes it, with the stub agent running in it for 0.3 s: the age at which the finding measured the core's hold. */
  async function seat(shape: Shape = "runner", shell: string = SHELLS[0]!, repaint = false): Promise<Trial> {
    const id = ++n;
    const seatName = `sp${id}@race`;
    const address = hcTerminalName(seatName);
    const ready = join(root, `r${id}.ready`);
    const log = join(root, `r${id}.log`);
    const canary = join(root, `r${id}.canary`);
    expect(await hostFor(shell).createSession(seatName, root)).toMatchObject({ ok: true });
    const tail = `${ready} ${log}${repaint ? " repaint" : ""}`;
    const command = shape === "classic" ? `stubagent ${tail}` : shape === "managed" ? `cd ${root} && python3 -I ${stubPath} ${tail}` : `python3 -I ${stubPath} ${tail}`;
    // The sourced launch reads the pane shell from the terminal's foreground, which hc reports about 0.4 s after a start (claude-interactive-launch.test.ts).
    if (shape === "classic") for (let i = 0; i < 200 && !(await client.call<HcTerminal>("terminal.get", { terminal: address })).foreground?.name; i++) await wait(25);
    const launched = await input.sendShellCommand(seatName, command, undefined, SHAPES[shape].options);
    expect(launched).toMatchObject({ ok: true });
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline) await wait(50);
    expect(existsSync(ready), "the stub agent started").toBe(true);
    await wait(300);
    return { seat: seatName, address, pid: Number(readFileSync(ready, "utf8")), canary, log, body: `touch ${canary}; echo TOK${id}`, shape, shell };
  }

  const teardown = async (t: Trial) => { try { await client.call("terminal.kill", { terminal: t.address }); } catch { /* already finished */ } };
  const readCount = (t: Trial) => existsSync(t.log) ? (readFileSync(t.log, "utf8").match(/TOK/g) ?? []).length : 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  interface Outcome { canary: boolean; reads: number; sent: string }

  /** Send the message and kill the agent `killAfterMs` after the call began (null: leave it alive). Returns what ran. */
  async function race(killAfterMs: number | null, shape: Shape = "runner", shell: string = SHELLS[0]!, repaint = false): Promise<Outcome> {
    const t = await seat(shape, shell, repaint);
    try {
      const sending = input.submitText(t.seat, t.body).then((r) => (r.ok ? "accepted" : r.code), (e) => `threw ${(e as Error).message}`);
      if (killAfterMs !== null) {
        await wait(killAfterMs);
        try { process.kill(t.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      const sent = await sending;
      await wait(2_500);
      return { canary: existsSync(t.canary), reads: readCount(t), sent };
    } finally {
      await teardown(t);
    }
  }

  /** The offsets (ms after the call began) at which the shell ran the message, with what each send came to, for the log. */
  async function sweep(offsets: number[], shape: Shape, shell: string, repaint = false): Promise<number[]> {
    const hits: number[] = [];
    const table: string[] = [];
    for (const offset of offsets) {
      const outcome = await race(offset, shape, shell, repaint);
      table.push(`${shape}/${shell.split("/").pop()}${repaint ? "/repaint" : ""} kill+${offset}ms: send ${outcome.sent}, canary ${outcome.canary}, agent read ${outcome.reads}x`);
      if (outcome.canary) hits.push(offset);
    }
    console.log(table.join("\n"));
    return hits;
  }

  describe.each(Object.keys(SHAPES) as Shape[])("launch shape %s", (shape) => {
    it("control: with the agent alive the message is read by the agent once and no shell runs it", async () => {
      const outcome = await race(null, shape);
      expect(outcome).toMatchObject({ sent: "accepted", reads: 1, canary: false });
    }, 40_000);

    // These offsets are inside the core's hold on a seat 0.3 s after its agent started (measured 0.45 s here, finding section 1b). Before the fix every
    // one was a canary on the runner shape: the shell above the dead agent ran the message. This row was `it.fails` until the launch stopped leaving
    // a shell above the agent.
    it("OF-200 sweep: killing the agent while its message is in flight must not run the message in a shell", async () => {
      const hits = await sweep(shape === "runner" ? [0, 100, 200, 300] : [0, 150, 300], shape, SHELLS[0]!);
      expect(hits, `kill offsets (ms) at which the login shell ran the message (${SHAPES[shape].why})`).toEqual([]);
    }, 120_000);

    it("dead first: a message sent to a seat whose agent already died is refused as a stopped seat, types nothing, and no shell runs it", async () => {
      const t = await seat(shape);
      try {
        process.kill(t.pid, "SIGKILL");
        await wait(1_000);
        const sent = await input.submitText(t.seat, t.body);
        expect(sent).toMatchObject({ ok: false, code: "session_not_found" });
        await wait(1_500);
        expect({ canary: existsSync(t.canary), reads: readCount(t) }).toEqual({ canary: false, reads: 0 });
      } finally {
        await teardown(t);
      }
    }, 40_000);

    it("killed after the message was read: the agent read it once and no shell runs anything later", async () => {
      const t = await seat(shape);
      try {
        expect(await input.submitText(t.seat, t.body)).toMatchObject({ ok: true });
        await until(() => readCount(t), (c) => c === 1, "the agent's read");
        process.kill(t.pid, "SIGKILL");
        await wait(2_500);
        expect({ canary: existsSync(t.canary), reads: readCount(t) }).toEqual({ canary: false, reads: 1 });
      } finally {
        await teardown(t);
      }
    }, 40_000);
  });

  // Both shells the finding measured (zsh and bash 3.2 on this Mac) run a pasted line when asked; the fix must not depend on which.
  describe.each(SHELLS)("pane shell %s", (shell) => {
    it("the runner shape: no offset in the hold runs the message", async () => {
      const hits = await sweep([0, 100, 200, 300], "runner", shell);
      expect(hits, "kill offsets (ms) at which the login shell ran the message").toEqual([]);
    }, 120_000);
  });

  // A real agent repaints, and then the core's hold is seconds, not 0.45 s (finding 1b: about 4.9 s on a stub that repaints 20 times a second).
  it("an agent that keeps repainting, so the core's hold is seconds: killed at 0.5 s and 2 s into it, no shell runs the message", async () => {
    const hits = await sweep([500, 2_000], "runner", SHELLS[0]!, true);
    expect(hits, "kill offsets (ms) at which the login shell ran the message").toEqual([]);
  }, 120_000);

  // Recovery. An agent that exits now ends the seat's terminal: reconcile, restore and health see a lost seat, where they saw a live login shell.
  // The path back is the one a seat lost any other way takes (a reboot): a fresh terminal under the same name, the launch again, and the messages
  // that were waiting. Nothing is typed meanwhile, and the message arrives once.
  describe("recovery", () => {
    it("an agent that exits on its own ends its terminal: the seat reads absent, its record stays readable, and nothing is left to type into", async () => {
      const t = await seat("runner");
      try {
        process.kill(t.pid, "SIGKILL");
        await wait(1_000);
        const terminal = await client.call<HcTerminal>("terminal.get", { terminal: t.address });
        expect(terminal).toMatchObject({ state: "finished" });
        expect(terminal.foreground ?? null).toBeNull();
        expect(await hostFor(t.shell).probeSession(t.seat)).toEqual({ state: "absent" });
        expect(alive(t.pid)).toBe(false);
      } finally {
        await teardown(t);
      }
    }, 40_000);

    it("the agent dies, a message waits, the seat is made again as a restore makes it, and the message arrives once and runs nowhere else", async () => {
      const first = await seat("runner");
      try {
        process.kill(first.pid, "SIGKILL");
        await wait(1_000);
        // While the seat is lost the message is refused, not held in a shell: this is what the pump pauses on (`seat_stopped`).
        expect(await input.submitText(first.seat, first.body)).toMatchObject({ ok: false, code: "session_not_found" });
        expect(await hostFor(first.shell).probeSession(first.seat)).toEqual({ state: "absent" });
        // The same seat again: a new terminal under the same name (hc keeps the finished one's record), then the launch.
        const ready = join(root, "again.ready");
        expect(await hostFor(first.shell).createSession(first.seat, root)).toMatchObject({ ok: true });
        expect(await input.sendShellCommand(first.seat, `python3 -I ${stubPath} ${ready} ${first.log}`, undefined, SHAPES.runner.options)).toMatchObject({ ok: true });
        await until(() => existsSync(ready), (ok) => ok, "the stub agent again");
        await wait(300);
        expect(await hostFor(first.shell).probeSession(first.seat)).toEqual({ state: "present" });
        expect(await input.submitText(first.seat, first.body)).toMatchObject({ ok: true });
        await until(() => readCount(first), (c) => c === 1, "the agent's read of the waiting message");
        await wait(1_500);
        expect({ reads: readCount(first), canary: existsSync(first.canary) }).toEqual({ reads: 1, canary: false });
        // The record the first terminal left is still there beside the live one (the respawn path prunes older ones; a create does not).
        const records = await client.call<{ terminals: HcTerminal[] }>("terminal.list", { all: true });
        expect(records.terminals.filter((x) => x.name === first.address).map((x) => x.state).sort()).toEqual(["finished", "live"]);
      } finally {
        await teardown(first);
      }
    }, 60_000);
  });
});
