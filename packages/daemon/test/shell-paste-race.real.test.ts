// OF-200: a message pasted into a seat can run in the seat's login shell (finding-shell-paste-race-20261102.md).
//
// The seat is built the way production builds it: HcHost.createSession (the terminal's own program is the login shell), then the agent is
// typed into that shell with HcInput.sendShellCommand (`execInScript`, the Pi / stub shape), and a message goes in with HcInput.submitText
// (the pump's `terminal.send`: the paste and the Enter in one call). The core accepts a send and may hold it (0.45 s measured on a seat
// that has just been active) before it writes. If the agent dies inside that hold, nothing is left to read the bytes but the login shell
// above it, and the shell runs the message, with the account's rights and outside the agent's sandbox and approval dialogs.
//
// Everything is measured against a private hc core (HC on PATH, else the suite skips), with a stub agent. No real agent, no daemon.
// The canary is a file the message would create if a shell ran it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcClient, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const SHELL = ["/bin/zsh", "/bin/bash"].find((candidate) => existsSync(candidate)) ?? "/bin/sh";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw mode, bracketed paste on (as Pi and Codex turn it on), writes its pid when ready, logs every byte it reads. */
const STUB = `
import os, sys, tty, select
ready, log = sys.argv[1], sys.argv[2]
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
`;

describe.skipIf(!HC)("a message in flight when the agent dies (OF-200), on a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "spr-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `x${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;
  let host: HcHost;
  let input: HcInput;
  let stubPath: string;
  let n = 0;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    const socket = resolveHcSocket(env, env.HOME);
    client = new HcClient(socket);
    input = new HcInput(client, new HcAttach(socket), { deliveryTimeoutMs: 8_000 });
    host = new HcHost(client, { daemonEnv: { PATH: process.env.PATH, HOME: env.HOME, SHELL } });
    stubPath = join(root, "stub.py");
    writeFileSync(stubPath, STUB);
  }, 30_000);

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  interface Trial { seat: string; address: string; pid: number; canary: string; log: string; body: string }

  /** A seat as production makes it, with the stub agent running in it for 0.3 s: the age at which the finding measured the core's hold. */
  async function seat(): Promise<Trial> {
    const id = ++n;
    const seatName = `sp${id}@race`;
    const address = hcTerminalName(seatName);
    const ready = join(root, `r${id}.ready`);
    const log = join(root, `r${id}.log`);
    const canary = join(root, `r${id}.canary`);
    expect(await host.createSession(seatName, root)).toMatchObject({ ok: true });
    const launched = await input.sendShellCommand(seatName, `python3 -I ${stubPath} ${ready} ${log}`, undefined, { execInScript: true });
    expect(launched).toMatchObject({ ok: true });
    const until = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < until) await wait(50);
    expect(existsSync(ready), "the stub agent started").toBe(true);
    await wait(300);
    return { seat: seatName, address, pid: Number(readFileSync(ready, "utf8")), canary, log, body: `touch ${canary}; echo TOK${id}` };
  }

  const teardown = async (t: Trial) => { try { await client.call("terminal.kill", { terminal: t.address }); } catch { /* already finished */ } };
  const agentRead = (t: Trial) => existsSync(t.log) && readFileSync(t.log, "utf8").includes(`TOK`);

  /** Send the message and kill the agent `killAfterMs` after the call began (null: leave it alive). Returns what ran. */
  async function race(killAfterMs: number | null): Promise<{ canary: boolean; agentRead: boolean; sent: string }> {
    const t = await seat();
    try {
      const sending = input.submitText(t.seat, t.body).then((r) => (r.ok ? "accepted" : r.code), (e) => `threw ${(e as Error).message}`);
      if (killAfterMs !== null) {
        await wait(killAfterMs);
        try { process.kill(t.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      const sent = await sending;
      await wait(2_500);
      return { canary: existsSync(t.canary), agentRead: agentRead(t), sent };
    } finally {
      await teardown(t);
    }
  }

  it("control: with the agent alive the message is read by the agent once and no shell runs it", async () => {
    const outcome = await race(null);
    expect(outcome).toMatchObject({ sent: "accepted", agentRead: true, canary: false });
  }, 40_000);

  // These offsets are inside the core's hold on a seat 0.3 s after its agent started (measured 0.45 s here, finding section 1b). Today
  // every one of them is a canary: the shell above the dead agent ran the message. The fix is for nothing to be left above the agent
  // (the agent as the terminal's own program), so the core refuses the send (`finished`) and types nothing. `fails` flips to `it` with it.
  it.fails("OF-200 sweep: killing the agent while its message is in flight must not run the message in a shell", async () => {
    const hits: number[] = [];
    for (const offset of [0, 100, 200, 300]) {
      const outcome = await race(offset);
      if (outcome.canary) hits.push(offset);
    }
    expect(hits, "kill offsets (ms) at which the login shell ran the message").toEqual([]);
  }, 120_000);

  // What a seat crash does now. The agent exiting on its own leaves the login shell: the terminal is still live, so a seat that crashed
  // reads present, not lost, and the foreground is the shell. Under the fix (no shell above the agent) the terminal ends with the agent
  // and probeSession reads absent, which reconcile, restore and health then see as a lost seat. This row is what moves.
  it("recovery today: an agent that exits on its own leaves a live login shell, and the seat still reads present", async () => {
    const t = await seat();
    try {
      process.kill(t.pid, "SIGKILL");
      await wait(1_000);
      const terminal = await client.call<HcTerminal>("terminal.get", { terminal: t.address });
      expect(terminal.state).toBe("live");
      expect(terminal.foreground?.name ?? "").toMatch(/zsh|bash|sh$/);
      expect(await host.probeSession(t.seat)).toEqual({ state: "present" });
    } finally {
      await teardown(t);
    }
  }, 40_000);
});
