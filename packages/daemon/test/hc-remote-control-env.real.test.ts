import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { HcHost } from "../src/adapters/hc-host.js";
import { HcLifecycle } from "../src/adapters/hc-lifecycle.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

/** The core's own env, as a core started by the app or a first CLI call would hold it. */
const CORE_ENV = { DISABLE_GROWTHBOOK: "core", DO_NOT_TRACK: "core", ANTHROPIC_BASE_URL: "https://core.example", CORE_ONLY: "core" };

describe.skipIf(!HC)("the Remote Control names on a private hc core", () => {
  const core = new PrivateCore("rc", CORE_ENV);
  const daemonEnv = { PATH: process.env.PATH, HOME: core.env.HOME, SHELL: "/bin/sh", DISABLE_TELEMETRY: "daemon" };
  const host = new HcHost(core.client, { daemonEnv });
  const lifecycle = new HcLifecycle(core.client, { daemonEnv });

  beforeAll(() => core.start());
  afterAll(() => core.stop());

  /** What a program in the seat sees, one `NAME=value` per line. */
  async function seen(seat: string): Promise<Map<string, string>> {
    const out = join(core.root, `${seat.replace(/\W/g, "_")}.${Date.now()}.env`);
    await core.client.call("terminal.send", { terminal: hcTerminalName(seat), text: `env > ${out}.tmp; mv ${out}.tmp ${out}` });
    const text = await until(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }, (t) => t.includes("PATH="), `the env of ${seat}`);
    return new Map(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  }

  it("a plain seat is unchanged: it gets the core's names and the daemon's", async () => {
    await expect(host.createSession("plain@rig", core.root, {})).resolves.toEqual({ ok: true });
    const env = await seen("plain@rig");
    expect(env.get("DISABLE_GROWTHBOOK")).toBe("core");
    expect(env.get("DO_NOT_TRACK")).toBe("core");
    expect(env.get("ANTHROPIC_BASE_URL")).toBe("https://core.example");
    expect(env.get("DISABLE_TELEMETRY")).toBe("daemon");
  });

  it("a Remote Control seat sees none of them, and keeps everything else the core gives", async () => {
    await expect(host.createSession("rc@rig", core.root, {}, { remoteControl: true })).resolves.toEqual({ ok: true });
    const env = await seen("rc@rig");
    for (const name of ["DISABLE_GROWTHBOOK", "DO_NOT_TRACK", "ANTHROPIC_BASE_URL", "DISABLE_TELEMETRY"]) expect(env.has(name), name).toBe(false);
    expect(env.get("CORE_ONLY")).toBe("core");
    expect(env.has("HC_TERMINAL_ID")).toBe(true);
  });

  it("a Remote Control seat that set one keeps its own value, and is warned by name", async () => {
    const result = await host.createSession("own@rig", core.root, { DISABLE_GROWTHBOOK: "seat-value" }, { remoteControl: true });
    if (!result.ok) throw new Error(result.code);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("DISABLE_GROWTHBOOK");
    expect(result.warnings?.[0]).not.toContain("seat-value");
    const env = await seen("own@rig");
    expect(env.get("DISABLE_GROWTHBOOK")).toBe("seat-value");
    expect(env.has("DO_NOT_TRACK")).toBe(false);
  });

  it("a respawned successor of a Remote Control seat sees none of them; a plain one is unchanged", async () => {
    await expect(lifecycle.respawnPane("rc@rig", undefined, { cwd: core.root, env: {}, remoteControl: true })).resolves.toMatchObject({ ok: true });
    const rc = await seen("rc@rig");
    for (const name of ["DISABLE_GROWTHBOOK", "DO_NOT_TRACK", "ANTHROPIC_BASE_URL", "DISABLE_TELEMETRY"]) expect(rc.has(name), name).toBe(false);
    await expect(lifecycle.respawnPane("plain@rig", undefined, { cwd: core.root, env: {} })).resolves.toMatchObject({ ok: true });
    const plain = await seen("plain@rig");
    expect(plain.get("DISABLE_GROWTHBOOK")).toBe("core");
    expect(plain.get("DISABLE_TELEMETRY")).toBe("daemon");
  });
});
