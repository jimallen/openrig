import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// OF-46. The activity-hook token (and every provider key) is a credential. A process's command line is readable by every local user
// through `ps`, and a core that keeps its clients' argv would keep it. These tests pin the consequence on hc: no process the adapter
// starts ever has a credential in its argv, no terminal label (shown by `hc ls` and the app) holds one, and the seat still receives
// it in its environment. On tmux the same invariant needed a partition of the launch environment into an argv-safe allowlist and a
// 0600 file the server sourced; hc's `terminal.run.env` crosses the socket, so there is no channel to partition, and the tests of that
// channel (the partition rule, the rendered `set-environment`, the call order of createSession/respawnPane, the OF-113 restore of a
// refused respawn, the OF-132 `$` probe) have no hc form.
//
// All values are synthetic. No test prints one.

const HOOK = "synthetic-hook-token-4f9a1c7e22";
const PROVIDER = "synthetic-provider-key-b83d5e0a91";
const LAUNCH_ENV = {
  OPENRIG_NODE_ID: "node-1",
  OPENRIG_SESSION_NAME: "dev-impl@rig",
  OPENRIG_RUNTIME: "claude-code",
  OPENRIG_HOME: "/state/instance",
  OPENRIG_URL: "http://127.0.0.1:7433",
  OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK,
  ANTHROPIC_API_KEY: PROVIDER,
};

async function until(read: () => string | undefined, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the seat");
    await new Promise(r => setTimeout(r, 50));
  }
}

describe.skipIf(!findHc())("OF-46 hc: the credential reaches the seat and never an argv or a label", () => {
  let scratch: HcScratch;
  let adapter: HcAdapter;
  let home: string;
  beforeAll(() => {
    scratch = startHcScratch();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "of46-"));
    vi.stubEnv("SHELL", "/bin/sh");
    adapter = new HcAdapter(scratch.client());
  }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

  /** Type `command` into the seat's shell and return what it wrote to a file (the seat's own view, as the launch types into it). */
  async function inSeat(name: string, command: string): Promise<string> {
    const out = path.join(home, `${name.replace(/\W/g, "_")}.out`);
    expect(await adapter.sendText(name, `{ ${command}; } > '${out}.tmp' && mv '${out}.tmp' '${out}'`)).toEqual({ ok: true });
    expect(await adapter.sendKeys(name, ["Enter"])).toEqual({ ok: true });
    return until(() => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined));
  }
  const labelsOf = async (name: string) => (await scratch.client().call<{ labels: Record<string, string> }>("terminal.get", { terminal: hcTerminalName(name) })).labels;
  const argvOf = async (name: string) => (await scratch.client().call<{ argv: string[] }>("terminal.get", { terminal: hcTerminalName(name) })).argv;
  const processTable = () => execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  it("pane shell holds the token; no label, no terminal argv, no process on the host does", async () => {
    const name = "of46-hc";
    const result = await adapter.createSession(name, home, { ...LAUNCH_ENV, OPENRIG_HOME: home });
    expect(result.ok).toBe(true);
    try {
      // What later reads of the launch see: identity names, never the credential.
      expect(await adapter.getSessionEnv(name, "OPENRIG_NODE_ID")).toBe("node-1");
      expect(await adapter.getSessionEnv(name, "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBeUndefined();
      expect(await adapter.hasSessionEnv(name, "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(true);
      // The pane's own shell (the process the seat launch types into). One printenv per name: BSD printenv (macOS) prints only the first.
      const got = await inSeat(name, "printenv OPENRIG_ACTIVITY_HOOK_TOKEN; printenv ANTHROPIC_API_KEY");
      expect(got.split("\n").filter(Boolean)).toEqual([HOOK, PROVIDER]);
      // What `ps` could ever have shown, what `hc ls` and the app show (labels), and the terminal's recorded argv.
      // Positive control: the instrument sees a process by its argv, so an absent secret is absent from a table that can show it.
      const canary = spawn("sleep", ["987654"], { stdio: "ignore" });
      let table: string;
      try { table = processTable(); } finally { canary.kill(); }
      expect(table, "the process table lists argv").toContain("sleep 987654");
      const labels = JSON.stringify(await labelsOf(name));
      const argv = JSON.stringify(await argvOf(name));
      for (const secret of [HOOK, PROVIDER]) {
        expect(table).not.toContain(secret);
        expect(labels).not.toContain(secret);
        expect(argv).not.toContain(secret);
      }
    } finally { await adapter.killSession(name); }
  });

  it("values with quotes, dollars, hashes, semicolons, backslashes, spaces and a line break arrive byte-exact", async () => {
    const awkward = "a'b\"c $HOME #d ; e\\f ~ %g {h} \tz\nline2";
    expect((await adapter.createSession("of46-quote", home, { OPENRIG_NODE_ID: "n", ANTHROPIC_API_KEY: awkward })).ok).toBe(true);
    try {
      expect(await inSeat("of46-quote", "printenv ANTHROPIC_API_KEY")).toBe(`${awkward}\n`);
    } finally { await adapter.killSession("of46-quote"); }
  });

  it("getSessionEnv returns a launch value exactly as set: dollars, quotes, backticks and backslashes are not escaped (OF-113)", async () => {
    // The seat reads its launch identity back with getSessionEnv (launch generation, home). A label holds the value as given.
    const awkward = "a$b ${c} \"q\" `t` \\d \\$e #f";
    expect((await adapter.createSession("of113-hc", home, { OPENRIG_NODE_ID: awkward, ANTHROPIC_API_KEY: awkward })).ok).toBe(true);
    try {
      expect(await adapter.getSessionEnv("of113-hc", "OPENRIG_NODE_ID")).toBe(awkward);
      // A provider key is not an identity name: its value is never readable back.
      expect(await adapter.getSessionEnv("of113-hc", "ANTHROPIC_API_KEY")).toBeUndefined();
    } finally { await adapter.killSession("of113-hc"); }
  });

  it("respawnPane in place: the successor receives the credential and no argv or label carries it", async () => {
    expect((await adapter.createSession("of46-resp", home, { OPENRIG_NODE_ID: "n" })).ok).toBe(true);
    const out = path.join(home, "resp.out");
    try {
      const before = await scratch.client().call<{ address: string }>("terminal.get", { terminal: hcTerminalName("of46-resp") });
      const result = await adapter.respawnPane("of46-resp", `printenv OPENRIG_ACTIVITY_HOOK_TOKEN > '${out}'; sleep 5`, { env: { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK } });
      expect(result.ok).toBe(true);
      expect((await until(() => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined))).trim()).toBe(HOOK);
      const after = await scratch.client().call<{ address: string; argv: string[]; labels: Record<string, string> }>("terminal.get", { terminal: hcTerminalName("of46-resp") });
      expect(after.address, "a respawn is a new terminal under the same name").not.toBe(before.address);
      expect(JSON.stringify(after.argv)).not.toContain(HOOK);
      expect(JSON.stringify(after.labels)).not.toContain(HOOK);
      expect(processTable()).not.toContain(HOOK);
    } finally { await adapter.killSession("of46-resp"); }
  });

  it("an undeliverable credential fails the launch and leaves no half-credentialed seat, naming no value", async () => {
    const result = await adapter.createSession("of46-bad", home, { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: `${HOOK}\0kill` });
    expect(result).toMatchObject({ ok: false, code: "invalid_env" });
    expect(JSON.stringify(result)).not.toContain(HOOK);
    expect((await adapter.probeSession("of46-bad")).state).toBe("absent");
    expect((await adapter.listSessions()).map((s) => s.name)).not.toContain("of46-bad");
  });

  it("a respawn refused for its environment leaves the seat as it was (OF-113)", async () => {
    expect((await adapter.createSession("of113-resp", home, { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK })).ok).toBe(true);
    try {
      const before = await scratch.client().call<{ address: string; pid: number; labels: Record<string, string> }>("terminal.get", { terminal: hcTerminalName("of113-resp") });
      const result = await adapter.respawnPane("of113-resp", "sleep 5", { env: { OPENRIG_NODE_ID: "n", "BAD NAME": PROVIDER } });
      expect(result).toMatchObject({ ok: false, code: "invalid_env" });
      expect(JSON.stringify(result)).not.toContain(PROVIDER);
      const after = await scratch.client().call<{ address: string; pid: number; state: string; labels: Record<string, string> }>("terminal.get", { terminal: hcTerminalName("of113-resp") });
      expect(after).toMatchObject({ address: before.address, pid: before.pid, state: "live" });
      expect(after.labels).toEqual(before.labels);
      expect(await adapter.getSessionEnv("of113-resp", "OPENRIG_NODE_ID")).toBe("n");
    } finally { await adapter.killSession("of113-resp"); }
  });
});
