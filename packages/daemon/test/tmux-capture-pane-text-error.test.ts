// A batched capture reads many seats, and what a seat's screen SAYS is controlled by an agent. The capture classifies a seat as
// missing only on what the host reported (hc: the terminal is not there), so a screen showing "no server running" or "can't
// find session" can neither hide a dead seat's chunk-mates nor turn a live seat into a missing one. (On tmux this was about the
// stderr of a chained command; the chain, the halving of a failed chain and the fake `tmux` that tested them have no hc form.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient, HcUnavailableError } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const PANE_TEXTS = [
  "no server running on /tmp/tmux-1000/default",
  "error connecting to /tmp/tmux-1000/default (No such file or directory)",
  "can't find session: elsewhere",
];

/** The real client to the private core, except that reading one chosen terminal fails as if the core could not be reached. */
class SelectiveClient extends HcClient {
  unreachableFor: string | null = null;
  override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (method === "terminal.read" && params.terminal === this.unreachableFor) throw new HcUnavailableError("fixture: core not reachable");
    return super.call<T>(method, params, options);
  }
}

describe.skipIf(!findHc())("batched capture error classification, hc", { timeout: 60_000 }, () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  /** Four seat names; the first one's screen shows `text`. Every one is launched but `skip` (a seat the core has no terminal for). */
  const seats = async (adapter: HcAdapter, text: string, skip?: number) => {
    const names = ["a", "b", "c", "d"].map((n) => `${n}-${Math.random().toString(36).slice(2, 8)}`);
    for (const [i, n] of names.entries()) {
      if (i === skip) continue;
      await scratch.client().call("terminal.run", {
        argv: ["sh", "-c", `printf '%s\\n' ${JSON.stringify(n === names[0] ? text : `${n} ok`)}; exec cat`], name: hcTerminalName(n),
        labels: { [SEAT_LABEL]: n }, cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true,
      });
    }
    for (const [i, n] of names.entries()) {
      if (i !== skip) await expect.poll(async () => (await adapter.capturePaneContent(n, 20)) ?? "", { timeout: 10_000 }).toContain(n === names[0] ? text : `${n} ok`);
    }
    return names;
  };

  it.each(PANE_TEXTS)("pane showing %j: a chunk-mate the core has no terminal for is marked missing, the rest are read", async (text) => {
    const adapter = new HcAdapter(scratch.client());
    const names = await seats(adapter, text, 1);
    try {
      expect((await adapter.probeSession(names[1]!)).state).toBe("absent");
      const got = await adapter.capturePanesContent(names, 20);
      expect(got!.get(names[1]!)).toMatchObject({ text: null, missing: true });
      expect(got!.get(names[0]!)?.text).toContain(text);
      expect(got!.get(names[0]!)?.missing).toBeUndefined();
      for (const n of names.slice(2)) expect(got!.get(n)?.text).toContain(`${n} ok`);
    } finally { for (const n of names) await adapter.killSession(n).catch(() => undefined); }
  });

  // Not a regression of the conversion but a difference worth stating: tmux's killed session was gone from the batch; hc keeps a finished
  // terminal readable (hc-capture.real.test.ts), so a killed seat comes back with its last screen and is not marked missing.
  it("a killed seat is read at its last screen, not marked missing (a finished terminal stays readable)", async () => {
    const adapter = new HcAdapter(scratch.client());
    const names = await seats(adapter, "no server running on /tmp/tmux-1000/default");
    try {
      await scratch.client().call("terminal.kill", { terminal: hcTerminalName(names[1]!) });
      await expect.poll(async () => (await adapter.probeSession(names[1]!)).state, { timeout: 10_000 }).toBe("absent");
      const got = await adapter.capturePanesContent(names, 20);
      expect(got!.get(names[1]!)?.text).toContain(`${names[1]} ok`);
      expect(got!.get(names[1]!)?.missing).toBeUndefined();
      expect(got!.get(names[0]!)?.text).toContain("no server running");
    } finally { for (const n of names) await adapter.killSession(n).catch(() => undefined); }
  });

  it("a seat whose read fails for a reason other than absence is left out for the caller to read alone, never marked missing", async () => {
    const client = new SelectiveClient(scratch.socketPath);
    const adapter = new HcAdapter(client);
    const names = await seats(adapter, "no server running on /tmp/tmux-1000/default");
    try {
      client.unreachableFor = hcTerminalName(names[2]!);
      const got = await adapter.capturePanesContent(names, 20);
      expect(got!.has(names[2]!)).toBe(false);
      for (const n of names.filter((x) => x !== names[2])) expect(got!.get(n)?.text, n).toBeTruthy();
      client.unreachableFor = null;
      expect(await adapter.capturePaneContent(names[2]!, 20)).toContain(`${names[2]} ok`);
    } finally { for (const n of names) await adapter.killSession(n).catch(() => undefined); }
  });
});
