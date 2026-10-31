import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// Each row drives a real hc terminal and polls it for output that arrives on its own; the polls resolve the
// moment the text is there. The ceilings only bound a genuine hang (10 s / 30 s were overrun on a heavily
// loaded host).
const POLL_CEILING_MS = 60_000;
const TEST_CEILING_MS = 150_000;
// Controlled provider-shaped output, not an authenticated Codex invocation.
// The actual terminal process receives the real production resume command.
let scratch: HcScratch;
async function finalObservation(output: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-final-"));
  const gate = path.join(home, "final-output.txt");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n` +
    `const fs = require("node:fs");\n` +
    `if (process.argv.slice(2).join(" ") !== "-s workspace-write -c check_for_update_on_startup=false resume fixture-id") process.exit(2);\n` +
    `process.stdout.write("\\n".repeat(36) + "fixture waiting for final observation\\n");\n` +
    `const tick = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) {\n` +
    `process.stdout.write(fs.readFileSync(${JSON.stringify(gate)}, "utf8") + "\\n"); clearInterval(tick);\n` +
    `setInterval(() => {}, 1000); } }, 5);\n`, { mode: 0o755 });
  const adapter = new HcAdapter(scratch.client());
  try {
    // The pane's interactive bash saves history into HOME as it exits, racing the teardown's rmSync (ENOTEMPTY); keep that file out of home.
    await scratch.client().call("terminal.run", {
      argv: ["/bin/bash", "--noprofile", "--norc", "-i"], env: { HOME: home, HISTFILE: "/dev/null" }, name: hcTerminalName("fixture"),
      labels: { [SEAT_LABEL]: "fixture" }, cwd: home, no_parent: true, no_notify: true, outlive_parent: true,
    });
    const nativeCapture = adapter.capturePaneContent.bind(adapter);
    let captures = 0;
    const capture = vi.spyOn(adapter, "capturePaneContent").mockImplementation(async (target, lines) => {
      captures++;
      if (captures === 1) {
        await expect.poll(() => nativeCapture(target, lines), { timeout: POLL_CEILING_MS }).toContain("fixture waiting for final observation");
      }
      if (captures === 27) {
        // The default budget has 26 loop observations plus one final read.
        // Release output only at that final boundary, avoiding timer races.
        // Atomic: the fixture polls for this file every 5 ms and, once it exists, prints its content once and stops
        // polling. A plain write is create-empty-then-fill; a fixture tick between the two printed nothing, and the
        // poll below then waited out its whole ceiling for output that would never come.
        fs.writeFileSync(`${gate}.tmp`, output);
        fs.renameSync(`${gate}.tmp`, gate);
        await expect.poll(() => nativeCapture(target, lines), { timeout: POLL_CEILING_MS }).toContain(output);
      }
      return nativeCapture(target, lines);
    });
    const resume = new CodexResumeAdapter(adapter, {
      launchPath: `${bin}:/usr/bin:/bin`, codexHome: path.join(home, "private-codex"),
      // Preserve the default observation count; this tests classification at
      // the final read, not the wall-clock duration of the production timeout.
      sleep: async () => {},
    });
    const result = await resume.resume("fixture", "codex_id", "fixture-id", home);
    // A resume the poll accepts takes one more read after the settle window (OF-167); a refused one does not.
    expect(capture).toHaveBeenCalledTimes(result.ok ? 28 : 27);
    return result;
  } finally {
    await adapter.killSession("fixture");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!findHc())("hc terminal final Codex resume observation", () => {
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("retains a late access-token refusal as recoverable attention with evidence", async () => {
    const output = "Your access token could not be refreshed. Please sign in again.";
    expect(await finalObservation(output)).toMatchObject({ ok: false, code: "attention_required", evidence: expect.stringContaining(output) });
  }, TEST_CEILING_MS);

  it("retains a late incompatible-client notice as recoverable attention", async () => {
    const output = "This model requires a newer version of Codex.";
    expect(await finalObservation(output)).toMatchObject({ ok: false, code: "attention_required", evidence: expect.stringContaining(output) });
  }, TEST_CEILING_MS);

  it("retains a late missing saved session as a fresh-retry outcome", async () => {
    expect(await finalObservation("Error: No saved session found for that token.")).toMatchObject({
      ok: false, code: "retry_fresh", message: "Codex resume failed: no saved session found for the requested token",
    });
  }, TEST_CEILING_MS);

  it("still accepts a ready interactive prompt arriving at the final read", async () => {
    expect(await finalObservation("OpenAI Codex (v0.0.0)\n› Ask Codex to do anything")).toMatchObject({ ok: true });
  }, TEST_CEILING_MS);

  it("preserves the shell fallback without claiming readiness or attention from unrelated output", async () => {
    // The production launch stages this fixture via /bin/sh. hc reports that
    // foreground wrapper (sh) as the terminal's foreground, as tmux did, so the existing shell fallback outcome stands.
    expect(await finalObservation("fixture output remains inconclusive")).toMatchObject({
      ok: false, code: "retry_fresh", message: "Codex resume failed: pane returned to shell instead of entering Codex",
    });
  }, TEST_CEILING_MS);
});
