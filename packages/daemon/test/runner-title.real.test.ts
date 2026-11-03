// OF-213: what herdr-core records as a terminal's title, and the real Pi runner as the pane's program on a PRIVATE core (own HOME,
// HC_SESSION and XDG paths via helpers/hc-scratch.ts; the host's core and the app are never contacted), against an offline fake `pi`.
//
// The symptom (openrig-8f, live): a Pi seat's `hc get` showed title "" (t37 verify-qa@eztrack) while a Claude seat's title is its
// session name, so the Herdr pane header read only "pi-runner <cwd>". The first row measures the mechanism (hc 0.1.17): OSC 0 and
// OSC 2 set `title`; OSC 1 and an hc label named `title` do not. The rest read the core after the real runner starts.
//
// Not proven here: the Herdr app's header drawing (it shows hc's title; not exercised), a real Pi, macOS vs Linux beyond this host.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!findHc())("a Pi seat's title through a private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;

  beforeAll(() => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "of213-"));
  }, 60_000);
  afterAll(() => { scratch?.cleanup(); });

  it("mechanism: OSC 0 and OSC 2 set the title, the last one wins; OSC 1 and a `title` label do not", async () => {
    const sh = (name: string, script: string, labels: Record<string, string> = {}) => scratch.client().call("terminal.run", {
      argv: ["/bin/sh", "-c", script], name, labels, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await sh("m-osc0", `printf '\\033]0;from-osc0\\007'; sleep 30`);
    await sh("m-osc2", `printf '\\033]2;from-osc2\\033\\\\'; sleep 30`);
    await sh("m-osc1", `printf '\\033]1;from-osc1\\007'; sleep 30`);
    await sh("m-twice", `printf '\\033]2;first\\033\\\\\\033]2;second\\033\\\\'; sleep 30`);
    await sh("m-label", `sleep 30`, { title: "from-label" });
    const titleOf = async (n: string, want: string) => (await until(() => get(n), (t) => t.state === "live" && (want === "" || t.title === want), `${n} title`, 10_000)).title;
    expect(await titleOf("m-osc0", "from-osc0")).toBe("from-osc0");
    expect(await titleOf("m-osc2", "from-osc2")).toBe("from-osc2");
    expect(await titleOf("m-twice", "second")).toBe("second");
    await new Promise((r) => setTimeout(r, 1000));
    expect((await get("m-osc1")).title).toBe("");
    expect((await get("m-label")).title).toBe("");
  }, 60_000);

  async function startRunner(name: string, extraArgs: string[] = []): Promise<void> {
    const bin = path.join(temp, "bin");
    if (!fs.existsSync(bin)) {
      fs.mkdirSync(bin);
      const sessionFile = path.join(temp, "session.jsonl");
      fs.writeFileSync(sessionFile, "fixture\n");
      fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
  if (cmd.type === "prompt") { process.stderr.write("\\x1b]2;hijacked-by-pi-stderr\\x07 pi-stderr-oops\\n"); out({ type: "agent_start" }); setTimeout(() => out({ type: "agent_end", messages: [], willRetry: false }), 300); }
});\n`, { mode: 0o700 });
    }
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", path.join(RUNNERS, "pi-runner.ts"), "--session-name", name, "--state-root", path.join(temp, "state"),
        "--cwd", temp, "--launch-id", "of213", "--no-approve", "--model", "openai-codex/gpt-6-luna:medium", ...extraArgs],
      name, cwd: PACKAGE_DIR, env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(temp, "home") },
      labels: { "openrig.seat": name }, no_parent: true, no_notify: true, outlive_parent: true,
    });
  }

  it("the runner's terminal title is the session name, the banner is on the pane, and the title survives a turn, a hostile Pi stderr line and a hostile echoed message", async () => {
    await startRunner("verify-qa");
    await until(() => screen("verify-qa"), (t) => t.includes(PI_RUNNER_READY_MARKER), "the READY marker");
    // The symptom: before the fix this is "".
    expect((await get("verify-qa")).title).toBe("verify-qa");
    const pane = await screen("verify-qa");
    expect(pane.split("\n")[0]!.trim()).toBe("── verify-qa · pi · openai-codex/gpt-6-luna:medium ──");
    expect(pane, "the title record is consumed by the core, never drawn").not.toMatch(/\u001b|\]2;/);

    const sent = await scratch.client().call<{ started: boolean | null }>("terminal.send", { terminal: "verify-qa", text: "run one" }, { timeoutMs: 20_000 });
    expect(sent.started).toBe(true);
    await until(() => get("verify-qa"), (t) => t.status?.state === "idle" && t.turn === 1, "the turn to end idle");
    expect(await screen("verify-qa"), "positive control: Pi's stderr line did reach the pane").toContain("pi-stderr-oops");
    expect((await get("verify-qa")).title, "a turn's output, Pi's stderr carrying an OSC 2 included, does not retitle the seat").toBe("verify-qa");

    // Text the runner echoes cannot retitle the seat: only the runner's own title record reaches the core.
    await scratch.client().call("terminal.send", { terminal: "verify-qa", text: "x \u001b]2;hijacked\u0007 y" }, { timeoutMs: 20_000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await get("verify-qa")).title).toBe("verify-qa");
  }, 90_000);

  it("a restarted runner (a new process for the same seat) sets the title and prints the banner again", async () => {
    await scratch.client().call("terminal.kill", { terminal: "verify-qa" });
    await until(() => get("verify-qa"), (t) => t.state !== "live", "the old runner to end", 10_000);
    await scratch.client().call("terminal.rm", { terminal: "verify-qa" });
    await startRunner("verify-qa");
    const pane = await until(() => screen("verify-qa"), (t) => t.includes(PI_RUNNER_READY_MARKER), "the READY marker after restart");
    expect((await get("verify-qa")).title).toBe("verify-qa");
    expect(pane.split("\n")[0]!.trim()).toBe("── verify-qa · pi · openai-codex/gpt-6-luna:medium ──");
  }, 90_000);
});
