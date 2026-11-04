// OF-215: a Pi runner killed by SIGKILL cannot reset the scroll region its console set (rows 1..R-2), and a `hc keep` shell left in the pane was
// argued to inherit it: its prompt on the last row outside the region, so it would scroll only the upper area until `reset`. Measured instead,
// through a PRIVATE hc core (own HOME, HC_SESSION and XDG paths via helpers/hc-scratch.ts), hc 0.1.16 on Linux and 0.1.17 on macOS: the kept shell
// is a new shell on a CLEARED screen with no region, and it scrolls the whole pane. Nothing in this repo has to write `ESC [ r` for it; the owner of
// that behaviour is hc's keep. This file pins it, because the repo's console depends on it, with a positive control: the same shell with a region
// set by hand is visibly broken by the same flood, so the instrument can see the leak it reports absent.
//
// Both ways a seat's terminal is kept: `keep` at run, and `terminal.keep` after the runner is up (what the Herdr app's adoption does; the seat host
// turns it off again, hc-placement.ts). Not proven: the Herdr app's own drawing of a kept pane.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { physicalRows } from "./helpers/hc-physical-screen.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { panePi, until } from "./helpers/pi-runner-pane.js";

describe.skipIf(!findHc())("a kept shell after a SIGKILLed Pi runner, through a private hc core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); });
  afterAll(() => { scratch?.cleanup(); });
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A runner as terminal `name`, up and READY, its program SIGKILLed; returns the terminal once a new shell runs in it. */
  async function killedRunner(name: string, keepAtRun: boolean): Promise<HcTerminal> {
    const pi = panePi(scratch, fs.mkdtempSync(path.join(scratch.root, `${name}-`)));
    await pi.start(name, `verify-qa@${name}`, { keep: keepAtRun });
    await until(() => pi.screen(name), (s) => s.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the READY marker");
    if (!keepAtRun) await scratch.client().call("terminal.keep", { terminal: name, keep: true });
    const before = await get(name);
    expect(before.keep, "the terminal is kept").toBe(true);
    // The console is up: the rule is on the second-last row, so the region is set.
    const rows = await physicalRows(scratch.socketPath, name);
    expect(rows[before.rows - 2]!.startsWith("── verify-qa@"), "the runner's rule is on the second-last row before the kill").toBe(true);
    process.kill(before.pid!, "SIGKILL");
    const after = await until(() => get(name), (t) => t.pid != null && t.pid !== before.pid && t.state === "live", "the kept shell", 20_000);
    expect(after.argv[0]!.endsWith("sh"), "the program is now a shell").toBe(true);
    await pause(1500);
    return after;
  }
  /** Print 300 numbered lines in the shell and read the pane. */
  async function flood(name: string, prefix: string) {
    await scratch.client().call("terminal.send", { terminal: name, text: `i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo ${prefix}-$i; done` }, { timeoutMs: 20_000 });
    await pause(2500);
    const rows = await physicalRows(scratch.socketPath, name);
    const history = (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 1000 })).text;
    const seen = (history.match(new RegExp(`^${prefix}-(\\d+)$`, "gm")) ?? []).length;
    return { rows, seen };
  }

  for (const [name, keepAtRun, how] of [["a", true, "kept at run"], ["b", false, "kept after it was up (the app's adoption)"]] as const) {
    it(`${how}: the shell has a clean screen and scrolls the whole pane; the runner's frame is gone`, async () => {
      const shell = await killedRunner(name, keepAtRun);
      const start = await physicalRows(scratch.socketPath, name);
      expect(start.filter((r) => r.trim() !== "").length, "one row: the shell's prompt, nothing of the runner's frame").toBe(1);
      const { rows, seen } = await flood(name, "sk");
      expect(rows[shell.rows - 2], "the last numbered line is on the second-last row: the output scrolled past row R-2").toBe("sk-300");
      expect(rows[shell.rows - 1]!.trimEnd().endsWith("$"), "the prompt is on the last row").toBe(true);
      expect(rows.filter((r) => r.startsWith("──") || r.startsWith("❯")), "no rule or input row left on the screen").toEqual([]);
      expect(seen, "every numbered line is in the history once").toBe(300);
    }, 120_000);
  }

  it("positive control: the same shell with the runner's region set by hand loses its output, so the instrument sees a leaked region", async () => {
    const shell = await killedRunner("c", true);
    await scratch.client().call("terminal.send", { terminal: "c", text: `printf '\\033[1;${shell.rows - 2}r\\033[${shell.rows};1H'` }, { timeoutMs: 20_000 });
    await pause(500);
    const { rows, seen } = await flood("c", "ctl");
    expect(rows[shell.rows - 2], "with the region leaked the numbered lines do not scroll above the last rows").not.toBe("ctl-300");
    expect(seen, "and the history does not hold every line").toBeLessThan(300);
  }, 120_000);
});
