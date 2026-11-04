// OF-217: an error line the Pi runner prints is sanitized, through a PRIVATE hc core (own HOME, HC_SESSION and XDG paths via
// helpers/hc-scratch.ts; the host's core is never contacted).
//
// Production consequence: the pane guard lets cursor-move and erase CSI through (the line editor needs them) and the console frame saves the
// output cursor after every write. An error text carrying `ESC [ 999 ; 1 H ESC [ 1 A ESC [ 2 K` moved the saved cursor onto the rule row and erased
// it, so the rest of the line and every later line landed on the frame's rows and were painted over: the runner's own `EXITED` line disappeared
// and the failure was unreadable. Measured on a private core at base 8e427a66 (hc 0.1.16, Linux): the `ERROR OMP exited during startup` line ended
// at `Its last output: fake omp failed` (the rest cut) and the `[omp-runner] EXITED omp exited (code 1)` line after it was gone.
//
// Reachable sites exercised here, each with a hostile string a real failure can carry: OMP's own stderr tail (the `ERROR OMP exited during
// startup` line), a PATH string (the `omp was not found on PATH` line, printed with the frame open), and a flag (`unknown flag:`, printed before
// the frame opens). The other two `console.error` lines carry `err.message` of a spawn failure and are covered by the census in
// pi-runner-pane-writes-census.test.ts: no test here can put a hostile byte into `spawn`'s message.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { until } from "./helpers/pi-runner-pane.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url));
const ESC = "\u001b";
// Restated: put the cursor on the last row (999 is clamped), up one (the rule row), erase that row.
const ONTO_THE_RULE_ROW = `${ESC}[999;1H${ESC}[1A${ESC}[2K`;

describe.skipIf(!findHc())("a hostile error line does not break the Pi runner's pane, through a private hc core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); });
  afterAll(() => { scratch?.cleanup(); });

  /** Run the runner as terminal `name` until it ends and return what the pane holds (screen and history, trailing blanks dropped). */
  async function runToEnd(name: string, options: { omp?: boolean; path: string; extraArgs?: string[]; flags?: string[] }): Promise<string[]> {
    const temp = fs.mkdtempSync(path.join(scratch.root, `${name}-`));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    if (options.omp) {
      // A fake OMP that fails at startup with hostile bytes on stderr, the way a broken launcher's own error text can.
      fs.writeFileSync(path.join(bin, "omp"), `#!${process.execPath}\nprocess.stderr.write("fake omp failed" + ${JSON.stringify(ONTO_THE_RULE_ROW)} + "after-hostile\\n"); process.exit(1);\n`, { mode: 0o700 });
    }
    const flags = options.flags ?? ["--session-name", "verify-qa@eztrack", "--runtime", "omp", "--approval-mode", "yolo", "--state-root", path.join(temp, "state"), "--cwd", temp, "--launch-id", "of217", "--model", "x/y"];
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", RUNNER, ...flags],
      name, cwd: PACKAGE_DIR, env: { PATH: options.path.replace("<bin>", `${bin}${path.delimiter}${path.dirname(process.execPath)}`), OPENRIG_HOME: path.join(temp, "home") },
      labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await until(() => scratch.client().call<HcTerminal>("terminal.get", { terminal: name }), (t) => t.state !== "live", "the runner to end", 30_000);
    const read = await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 500 });
    return read.text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  }
  const omp = (lines: string[]) => lines.filter((l) => l.startsWith("[omp"));

  it("OMP's own stderr, in the startup-failure line: the whole line, then the runner's EXITED line after it, each once", async () => {
    const lines = await runToEnd("b", { omp: true, path: "<bin>" });
    expect(omp(lines), "the lines the runner printed, in order").toEqual([
      "[omp-runner] starting omp --mode rpc (seat verify-qa@eztrack)",
      "[omp-runner] send text normally; prefixes: \"/followup <text>\" queues after the turn, \"/abort\" cancels",
      "[omp:err] fake omp failedafter-hostile",
      expect.stringMatching(/^\[omp-runner\] ERROR OMP exited during startup, before its RPC transport started \(.*\/bin\/omp, exit code 1\)\. Its last output: fake omp failedafter-hostile$/),
      "[omp-runner] EXITED omp exited (code 1)",
    ]);
  }, 90_000);

  it("a PATH string in the `not found on PATH` line, printed with the frame open: the whole line", async () => {
    const lines = await runToEnd("a", { path: `/nonexistent-dir:${ONTO_THE_RULE_ROW}hostile-path-tail` });
    expect(omp(lines).filter((l) => l.includes("ERROR launch")), "the one error line, whole").toEqual([
      "[omp-runner] ERROR launch: 'omp' was not found on PATH (/nonexistent-dir:hostile-path-tail)",
    ]);
  }, 90_000);

  it("a flag in the `unknown flag` line, printed before the frame opens: the whole line on one row", async () => {
    const lines = await runToEnd("c", { path: "<bin>", flags: [`${ESC}[5;1Hhostile-flag`] });
    expect(lines.filter((l) => l.includes("ERROR")), "the one error line, whole, on one row").toEqual(["[pi-runner] ERROR unknown flag: hostile-flag"]);
  }, 90_000);
});
