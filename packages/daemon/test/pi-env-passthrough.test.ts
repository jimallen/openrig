// A Pi seat's extra environment names (spec member `env_passthrough`): the variables its pi child keeps beyond the
// baseline, taken by name from the runner's own environment (the seat pane's, as a Codex seat inherits it). Names
// only, never values. Nothing here reaches a live seat, tmux server or daemon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { parseRunnerArgs } from "../src/adapters/pi-runner.js";
import {
  buildPiChildEnv, buildPiRunnerCommand, piEnvPassthroughRefusal, piSeatPaths, PI_ENV_PASSTHROUGH_MAX, type PiRunnerLaunchOpts,
} from "../src/adapters/pi-runner-protocol.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const NAMES = ["DOCKER_HOST", "SSH_AUTH_SOCK", "TYPESAFE_API_KEY"];

describe("the names a spec may pass through", () => {
  it.each([
    ["DOCKER_HOST", null],
    ["_PRIVATE", null],
    ["lower_case", "is not an environment variable name"],
    ["HAS-DASH", "is not an environment variable name"],
    ["9STARTS_WITH_DIGIT", "is not an environment variable name"],
    [`A${"B".repeat(64)}`, "is not an environment variable name"],
    ["OPENRIG_ACTIVITY_HOOK_TOKEN", "is an OpenRig variable"],
    ["OPENRIG_SESSION_NAME", "is an OpenRig variable"],
    ["RIGGED_NODE_ID", "is an OpenRig variable"],
    ["PI_CODING_AGENT_DIR", "is a Pi isolation variable"],
  ])("%s", (name, refusal) => {
    const got = piEnvPassthroughRefusal(name);
    if (refusal === null) expect(got).toBeNull();
    else expect(got).toContain(refusal);
  });
});

describe("the pi child's environment", () => {
  const base = { agentDir: "/seat/agent", sessionsDir: "/seat/sessions" };
  const source = { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///d.sock", SSH_AUTH_SOCK: "/tmp/ssh", TYPESAFE_API_KEY: "k-123",
    OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", PI_CODING_AGENT_DIR: "/elsewhere", UNLISTED: "x" };

  it("control: without names, only the baseline crosses", () => {
    const env = buildPiChildEnv(source, base);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]);
  });

  it("the listed names cross with the runner's own values; unlisted ones do not", () => {
    const env = buildPiChildEnv(source, { ...base, extraNames: NAMES });
    expect([env.DOCKER_HOST, env.SSH_AUTH_SOCK, env.TYPESAFE_API_KEY]).toEqual(["unix:///d.sock", "/tmp/ssh", "k-123"]);
    expect(env.UNLISTED).toBeUndefined();
  });

  it("a listed name the runner does not have is simply absent", () => {
    expect(buildPiChildEnv({ PATH: "/bin" }, { ...base, extraNames: ["DOCKER_HOST"] })).not.toHaveProperty("DOCKER_HOST");
  });

  it("a refused name never crosses, and Pi's isolation variables keep the runner's values", () => {
    const env = buildPiChildEnv(source, { ...base, extraNames: ["OPENRIG_ACTIVITY_HOOK_TOKEN", "PI_CODING_AGENT_DIR"] });
    expect(env.OPENRIG_ACTIVITY_HOOK_TOKEN).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe("/seat/agent");
  });
});

describe("the runner command and its arguments carry names, never values", () => {
  const opts: PiRunnerLaunchOpts = { runnerEntryPath: "/r.js", sessionName: "verify-qa@ez", stateRoot: "/s", cwd: "/w", trust: "approve", launchId: "l-1" };

  it("--env-pass lists the valid names once each; no flag without names", () => {
    expect(buildPiRunnerCommand({ ...opts, envPassthrough: [...NAMES, "DOCKER_HOST", "OPENRIG_URL"] }))
      .toContain("--env-pass 'DOCKER_HOST,SSH_AUTH_SOCK,TYPESAFE_API_KEY'");
    expect(buildPiRunnerCommand(opts)).not.toContain("--env-pass");
    expect(buildPiRunnerCommand({ ...opts, envPassthrough: ["OPENRIG_URL"] })).not.toContain("--env-pass");
  });

  it("the runner parses --env-pass and refuses a bad, reserved or oversized list", () => {
    const argv = ["--session-name", "s", "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--approve"];
    expect(parseRunnerArgs([...argv, "--env-pass", NAMES.join(",")]).envPassthrough).toEqual(NAMES);
    expect(() => parseRunnerArgs([...argv, "--env-pass", "lower"])).toThrow(/is not an environment variable name/);
    expect(() => parseRunnerArgs([...argv, "--env-pass", "OPENRIG_URL"])).toThrow(/is an OpenRig variable/);
    const many = Array.from({ length: PI_ENV_PASSTHROUGH_MAX + 1 }, (_, i) => `V${i}`).join(",");
    expect(() => parseRunnerArgs([...argv, "--env-pass", many])).toThrow(/at most/);
  });
});

describe("the spec member field", () => {
  const spec = (member: Record<string, unknown>): Record<string, unknown> => ({
    version: "0.2", name: "r", pods: [{ id: "verify", label: "V", members: [{ id: "qa", agent_ref: "local:agents/qa", profile: "default", runtime: "pi", cwd: ".", ...member }], edges: [] }], edges: [],
  });

  it("a pi member with names is valid, and its names reach the normalised member", () => {
    const v = PodRigSpecSchema.validate(spec({ env_passthrough: NAMES }));
    expect(v.errors).toEqual([]);
    expect(PodRigSpecSchema.normalize(spec({ env_passthrough: NAMES })).pods[0]!.members[0]!.envPassthrough).toEqual(NAMES);
  });

  it("round-trips through serialize and parse (a bundle or draft keeps the names)", () => {
    const normalized = PodRigSpecSchema.normalize(spec({ env_passthrough: NAMES }));
    expect(RigSpecCodec.parse(RigSpecCodec.serialize(normalized))).toMatchObject({ pods: [{ members: [{ env_passthrough: NAMES }] }] });
  });

  it.each([
    ["on a codex member", { runtime: "codex", env_passthrough: NAMES }, 'only valid when runtime is "pi"'],
    ["not a list", { env_passthrough: "DOCKER_HOST" }, "must be a non-empty list"],
    ["an empty list", { env_passthrough: [] }, "must be a non-empty list"],
    ["a bad name", { env_passthrough: ["docker_host"] }, "is not an environment variable name"],
    ["an OpenRig name", { env_passthrough: ["OPENRIG_ACTIVITY_HOOK_TOKEN"] }, "is an OpenRig variable"],
    ["a duplicate", { env_passthrough: ["DOCKER_HOST", "DOCKER_HOST"] }, "is listed twice"],
    ["too many", { env_passthrough: Array.from({ length: PI_ENV_PASSTHROUGH_MAX + 1 }, (_, i) => `V${i}`) }, "at most"],
    ["a non-string", { env_passthrough: [7] }, "every entry must be a name"],
  ])("refused: %s", (_label, member, message) => {
    const v = PodRigSpecSchema.validate(spec(member));
    expect(v.errors.join("\n")).toContain(message);
  });
});

describe("the node keeps the names; a launch reads them back", () => {
  function repo() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    dbs.push(db);
    const r = new RigRepository(db);
    return { db, r, rig: r.createRig("r") };
  }

  it("stored as a JSON list of names and read back", () => {
    const { r, rig } = repo();
    const node = r.addNode(rig.id, "verify.qa", { runtime: "pi", envPassthrough: NAMES });
    expect(r.getNodeEnvPassthrough(node.id)).toEqual(NAMES);
    expect(r.getNodeEnvPassthrough(r.addNode(rig.id, "verify.sec", { runtime: "pi" }).id)).toEqual([]);
  });

  it("the exporter writes the names back on the member (export -> import keeps them)", () => {
    const { db, r, rig } = repo();
    const pod = new PodRepository(db).createPod(rig.id, "verify", "Verify", {});
    r.addNode(rig.id, "verify.qa", { runtime: "pi", podId: pod.id, agentRef: "local:agents/qa", profile: "default", cwd: "/w", envPassthrough: NAMES });
    r.addNode(rig.id, "verify.sec", { runtime: "pi", podId: pod.id, agentRef: "local:agents/sec", profile: "default", cwd: "/w" });
    const exported = new RigSpecExporter({ rigRepo: r, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id);
    expect(exported).toMatchObject({ pods: [{ members: expect.arrayContaining([expect.objectContaining({ id: "qa", envPassthrough: NAMES })]) }] });
    expect(JSON.stringify(exported)).not.toMatch(/"id":"sec"[^}]*envPassthrough/);
  });

  it("fails closed: unreadable, not a list, or a refused name reads as none of it", () => {
    const { db, r, rig } = repo();
    const node = r.addNode(rig.id, "verify.qa", { runtime: "pi" });
    const set = (v: string) => db.prepare("UPDATE nodes SET env_passthrough = ? WHERE id = ?").run(v, node.id);
    set("not json"); expect(r.getNodeEnvPassthrough(node.id)).toEqual([]);
    set('{"DOCKER_HOST":1}'); expect(r.getNodeEnvPassthrough(node.id)).toEqual([]);
    set('["DOCKER_HOST","OPENRIG_URL",7]'); expect(r.getNodeEnvPassthrough(node.id)).toEqual(["DOCKER_HOST"]);
  });
});

describe("both launch paths pass the seat's names to the runner", () => {
  const STATE_ROOT = "/openrig-home/state/pi";
  const SESSION = "verify-qa@eztrack";
  const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/s.jsonl`;
  function memFs(files: Record<string, string> = {}): PiAdapterFsOps & { files: Record<string, string> } {
    const dirs = new Set<string>();
    return { files, readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]!; },
      writeFile: (p, c) => { files[p] = c; }, exists: (p) => p in files || dirs.has(p), mkdirp: (p) => { dirs.add(p); }, listFiles: () => [] };
  }
  // A real TmuxAdapter whose exec is never reached: only the typed launch command is replaced (and recorded).
  function tmuxTyping(fs: ReturnType<typeof memFs>, typed: string[]): TmuxAdapter {
    const tmux = new TmuxAdapter(async () => { throw new Error("no tmux in this test"); });
    vi.spyOn(tmux, "sendShellCommand").mockImplementation(async (_t, text) => {
      typed.push(text);
      const launchId = /--launch-id '([^']+)'/.exec(text)![1];
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({ ready: true, launchId, sessionFile: SESSION_FILE, sessionId: "s", updatedAt: "2026-10-31T10:00:00Z" });
      return { ok: true };
    });
    return tmux;
  }
  const binding: NodeBinding = { id: "b-1", nodeId: "n-1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "2026-10-31T10:00:00Z", cwd: "/work" };

  it("a fresh launch asks for this session's names", async () => {
    const fs = memFs(); const typed: string[] = []; const asked: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js",
      sleep: async () => {}, envPassthroughFor: (s) => { asked.push(s); return NAMES; } });
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([SESSION]);
    expect(typed[0]).toContain("--env-pass 'DOCKER_HOST,SSH_AUTH_SOCK,TYPESAFE_API_KEY'");
  });

  it("a resume asks for this session's names too", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const adapter = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" },
      { pollMs: 1, maxWaitMs: 5, sleep: async () => {}, envPassthroughFor: (s) => (s === SESSION ? NAMES : []) });
    await adapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(typed[0]).toContain("--env-pass 'DOCKER_HOST,SSH_AUTH_SOCK,TYPESAFE_API_KEY'");
  });

  it("control: without a lookup, no --env-pass", async () => {
    const fs = memFs(); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {} });
    await adapter.launchHarness(binding, { name: SESSION });
    expect(typed[0]).not.toContain("--env-pass");
  });
});

describe("instantiating a spec stores the names on the node, on both creation paths", () => {
  const RIG_ROOT = existingRigRoot("env-rig");
  const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
  const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, agent_ref: "local:agents/impl", profile: "default", runtime: "pi", cwd: ".", ...over,
  });
  const rawSpec = (members: Record<string, unknown>[]): Record<string, unknown> => ({
    version: "0.2", name: "env-rig", pods: [{ id: "verify", label: "Verify", members, edges: [] }], edges: [],
  });
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    const adapter: RuntimeAdapter = {
      runtime: "pi",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn<RuntimeAdapter["launchHarness"]>(async () => ({ ok: true })),
    };
    setup = createTestApp(db, {
      adapters: { pi: adapter },
      podInstantiatorFsOps: {
        readFile: (p: string) => { if (p.includes("agents/impl")) return agentYaml("impl"); throw new Error(`Not found: ${p}`); },
        exists: (p: string) => p.includes("agents/impl"),
      },
    });
  });
  afterEach(() => { db.close(); });

  const stored = (logicalId: string): string[] => {
    const row = db.prepare<[string], { id: string }>("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId);
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return new RigRepository(db).getNodeEnvPassthrough(row!.id);
  };

  it("materialize (createMemberNode)", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("qa", { env_passthrough: NAMES }), rawMember("sec")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("verify.qa"), stored("verify.sec")]).toEqual([NAMES, []]);
  });

  it("bootstrap from YAML (its own inline addNode)", async () => {
    const yaml = RigSpecCodec.serialize(PodRigSpecSchema.normalize(rawSpec([rawMember("qa", { env_passthrough: NAMES }), rawMember("sec")])));
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("verify.qa"), stored("verify.sec")]).toEqual([NAMES, []]);
  });
});
