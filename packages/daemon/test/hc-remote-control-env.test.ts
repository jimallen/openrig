import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, SEAT_LABEL, seatEnvironment } from "../src/adapters/hc-host.js";
import { HcLifecycle } from "../src/adapters/hc-lifecycle.js";
import { REMOTE_CONTROL_ENV_NAMES, remoteControlEnvWarnings } from "../src/adapters/hc-runtime-requirements.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

const REMOTE_CONTROL = { remoteControl: true };
/** Every name, valued so that each would turn Remote Control off. The URL's host is the secret a warning must not repeat. */
const ALL_SET: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_GROWTHBOOK: "1", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1",
  ANTHROPIC_BASE_URL: "https://needle-host.example",
};

const term = (over: Partial<HcTerminal> = {}): HcTerminal => ({
  address: "t7", labels: { [SEAT_LABEL]: "qa@rig" }, argv: [], cwd: "/w", state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24, ...over,
});

class FakeClient extends HcClient {
  runs: Record<string, unknown>[] = [];
  constructor(private readonly listFails = false) { super("/nonexistent"); }
  override async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "terminal.run") this.runs.push(params!);
    if (method === "terminal.kill") return term({ state: "finished" }) as T;
    if (method === "terminal.list") {
      if (this.listFails) throw new HcUnavailableError("down");
      return { terminals: [] } as T;
    }
    return term() as T;
  }
}

const unsetIn = (run: Record<string, unknown>): string[] => {
  const argv = run.argv as string[];
  return argv.flatMap((word, i) => (word === "-u" ? [argv[i + 1]!] : []));
};

describe("the names a Remote Control seat must not inherit", () => {
  it("covers the five documented names, so a row below cannot pass on an empty list", () => {
    expect(Object.keys(ALL_SET).sort()).toEqual([...REMOTE_CONTROL_ENV_NAMES].sort());
    expect(REMOTE_CONTROL_ENV_NAMES).toHaveLength(5);
  });
});

describe("seatEnvironment with the Remote Control hint", () => {
  it.each(Object.keys(ALL_SET))("neither states %s from the daemon nor leaves it to the core", (name) => {
    const { env, unset } = seatEnvironment({}, { [name]: ALL_SET[name]!, KEEP: "k" }, REMOTE_CONTROL);
    expect(env).not.toHaveProperty(name);
    expect(unset).toContain(name);
    expect(env.KEEP).toBe("k");
  });
  it.each(Object.keys(ALL_SET))("keeps %s when the seat set it itself, and only that one", (name) => {
    const { env, unset } = seatEnvironment({ [name]: ALL_SET[name]! }, { [name]: "from-daemon" }, REMOTE_CONTROL);
    expect(env[name]).toBe(ALL_SET[name]);
    expect(unset).not.toContain(name);
    expect(unset.filter((key) => REMOTE_CONTROL_ENV_NAMES.includes(key))).toHaveLength(4);
  });
  it("leaves a seat with no hint exactly as it was, whatever the daemon holds", () => {
    const daemon = { ...ALL_SET, KEEP: "k" };
    const plain = seatEnvironment({ A: "1" }, daemon);
    expect(plain.env).toMatchObject(ALL_SET);
    expect(plain.unset.filter((key) => REMOTE_CONTROL_ENV_NAMES.includes(key))).toEqual([]);
    expect(seatEnvironment({ A: "1" }, daemon, { remoteControl: false })).toEqual(plain);
    expect(plain.warnings).toEqual([]);
  });
  it("still clears the names every seat loses", () => {
    expect(seatEnvironment({}, {}, REMOTE_CONTROL).unset).toEqual(expect.arrayContaining(["CLAUDECODE", "TMUX", "OPENRIG_AUTH_BEARER_TOKEN"]));
  });
});

describe("warning about a name the seat kept", () => {
  it("says a blocking name by name, once, with no value", () => {
    const { warnings } = seatEnvironment({ ANTHROPIC_BASE_URL: ALL_SET.ANTHROPIC_BASE_URL!, DISABLE_GROWTHBOOK: "tok-needle" }, {}, REMOTE_CONTROL);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DISABLE_GROWTHBOOK");
    expect(warnings[0]).toContain("ANTHROPIC_BASE_URL");
    expect(JSON.stringify(warnings)).not.toContain("needle");
  });
  it("tells a conditional name from a blocking one", () => {
    const warnings = remoteControlEnvWarnings({ DO_NOT_TRACK: "1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DO_NOT_TRACK");
    expect(warnings[0]).toContain("Trusted Devices");
    expect(remoteControlEnvWarnings({ DISABLE_GROWTHBOOK: "1" })[0]).not.toContain("Trusted Devices");
  });
  it("has nothing to say about a value that does not turn Remote Control off", () => {
    expect(seatEnvironment({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", DISABLE_GROWTHBOOK: "" }, {}, REMOTE_CONTROL).warnings).toEqual([]);
  });
  it("never warns a daemon name the wrapper removed", () => {
    expect(seatEnvironment({}, ALL_SET, REMOTE_CONTROL).warnings).toEqual([]);
  });
});

describe("HcHost.createSession", () => {
  const launch = async (hint?: { remoteControl?: boolean }, seat: Record<string, string> = {}) => {
    const client = new FakeClient();
    const result = await new HcHost(client, { daemonEnv: { SHELL: "/bin/sh", DISABLE_TELEMETRY: "1" } }).createSession("qa@rig", "/w", seat, hint);
    return { result, run: client.runs[0]! };
  };
  it("removes the names for a Remote Control seat, stated env included", async () => {
    const { result, run } = await launch(REMOTE_CONTROL);
    expect(result).toEqual({ ok: true });
    expect(unsetIn(run)).toEqual(expect.arrayContaining([...REMOTE_CONTROL_ENV_NAMES]));
    expect(run.env).not.toHaveProperty("DISABLE_TELEMETRY");
  });
  it("leaves a plain seat alone", async () => {
    const { run } = await launch();
    expect(unsetIn(run).filter((key) => REMOTE_CONTROL_ENV_NAMES.includes(key))).toEqual([]);
    expect(run.env).toHaveProperty("DISABLE_TELEMETRY", "1");
  });
  it("launches, and warns, when the seat kept a blocking name", async () => {
    const { result } = await launch(REMOTE_CONTROL, { DISABLE_GROWTHBOOK: "1" });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("DISABLE_GROWTHBOOK");
  });
});

describe("HcLifecycle.respawnPane", () => {
  const daemonEnv = { SHELL: "/bin/sh", DISABLE_TELEMETRY: "1" };
  it("removes the names for a Remote Control successor, stated env included", async () => {
    const client = new FakeClient();
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig", "/bin/sh", { cwd: "/w", env: {}, remoteControl: true })).resolves.toEqual({ ok: true });
    expect(unsetIn(client.runs[0]!)).toEqual(expect.arrayContaining([...REMOTE_CONTROL_ENV_NAMES]));
    expect(client.runs[0]!.env).not.toHaveProperty("DISABLE_TELEMETRY");
  });
  it("leaves a plain respawn alone", async () => {
    const client = new FakeClient();
    await new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig", "/bin/sh", { env: {} });
    expect(unsetIn(client.runs[0]!).filter((key) => REMOTE_CONTROL_ENV_NAMES.includes(key))).toEqual([]);
    expect(client.runs[0]!.env).toHaveProperty("DISABLE_TELEMETRY", "1");
  });
  it("warns by name for what the seat kept, alongside a prune warning", async () => {
    const result = await new HcLifecycle(new FakeClient(true), { daemonEnv }).respawnPane("qa@rig", "/bin/sh", { env: { DISABLE_GROWTHBOOK: "1" }, remoteControl: true });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings!.some((w) => w.includes("DISABLE_GROWTHBOOK"))).toBe(true);
    expect(result.warnings!.some((w) => w.includes("older finished terminals"))).toBe(true);
  });
  it("warns with nothing to prune, too", async () => {
    const result = await new HcLifecycle(new FakeClient(), { daemonEnv }).respawnPane("qa@rig", "/bin/sh", { env: { DISABLE_GROWTHBOOK: "1" }, remoteControl: true });
    expect(result.warnings).toHaveLength(1);
  });
});

describe("HcAdapter", () => {
  it("hands the hint on, to both ways a seat's terminal is made", async () => {
    const client = new FakeClient();
    const adapter = new HcAdapter(client);
    await adapter.createSession("a@rig", "/w", {}, REMOTE_CONTROL);
    await adapter.respawnPane("qa@rig", "/bin/sh", { env: {}, remoteControl: true });
    expect(client.runs).toHaveLength(2);
    for (const run of client.runs) expect(unsetIn(run)).toContain("DISABLE_GROWTHBOOK");
  });
});

describe("NodeLauncher", () => {
  const launch = async (declared: boolean, createResult: TmuxResult = { ok: true }) => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { runtime: "claude-code", ...(declared ? REMOTE_CONTROL : {}) });
    const calls: unknown[][] = [];
    const tmuxAdapter = {
      createSession: async (...args: unknown[]) => { calls.push(args); return createResult; },
      killSession: async () => ({ ok: true }), listPanes: async () => [],
    } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter });
    const result = await launcher.launchNode(rig.id, "dev1-impl");
    db.close();
    return { calls, result };
  };
  it("reads the persisted declaration and hands the host the hint, for every launch that comes through it", async () => {
    expect((await launch(true)).calls[0]![3]).toEqual(REMOTE_CONTROL);
  });
  it("gives a seat that did not declare it no hint at all", async () => {
    expect((await launch(false)).calls[0]).toHaveLength(3);
  });
  it("passes on the host's warning about a kept name", async () => {
    const { result } = await launch(true, { ok: true, warnings: ["kept DISABLE_GROWTHBOOK"] });
    expect(result).toMatchObject({ ok: true, warnings: expect.arrayContaining(["kept DISABLE_GROWTHBOOK"]) });
  });
});

/** Every production call that can make a seat's terminal, read from source so a new path fails here until it is classified. */
describe("the paths that make a terminal", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
  const callers = (method: string): string[] => files(src).flatMap((path) => {
    const rel = relative(src, path);
    if (/^adapters\/(hc-(adapter|host|lifecycle)|tmux)\.ts$/.test(rel)) return [];
    return [...readFileSync(path, "utf8").matchAll(new RegExp(`\\.${method}\\(([^\\n]*)`, "g"))].map((m) => `${rel}: ${m[1]}`);
  }).sort();

  it("creates a session in two places: the launcher, with the hint, and a metadata probe, which is no seat", () => {
    const found = callers("createSession");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^domain\/node-launcher\.ts: .*remoteControl/);
    expect(found[1]).toMatch(/^domain\/resume-metadata-refresher\.ts: probeSession,/);
  });
  it("respawns in two places: the successor, with the hint, and Codex's restart in place, which cannot declare Remote Control", () => {
    const found = callers("respawnPane");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^domain\/seat-restart-in-place\.ts: pane, relaunch\.command, \{ cwd \}/);
    expect(found[1]).toMatch(/^domain\/successor-session-launcher\.ts: .*remoteControl/);
  });
  it("sends terminal.run only from the host, a respawn and a probe", () => {
    const found = files(src).flatMap((path) => (readFileSync(path, "utf8").match(/"terminal\.run"/g) ?? []).map(() => relative(src, path))).sort();
    expect(found).toEqual(["adapters/hc-host.ts", "adapters/hc-lifecycle.ts", "adapters/hc-lifecycle.ts"]);
  });
});
