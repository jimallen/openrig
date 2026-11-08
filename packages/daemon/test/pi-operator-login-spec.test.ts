// OF-279: the spec and daemon side of the operator-login link: the member field `pi: { link_operator_models: true }`
// (validation, the model_overrides conflict, the codec round trip, the node column from migration 127, the export,
// preflight's notice, both node-creation paths), the host setting pi.operator_login_dir, and both launch paths handing
// the setting and the declaration to the runner. The link itself is test/pi-operator-login.test.ts. Nothing here reaches
// a live seat, a credential, tmux or a daemon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { operatorModelsLinkDiscoveryWarnings, rigPreflight } from "../src/domain/rigspec-preflight.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const LUNA = { "openai-codex": { "gpt-6-luna": { contextWindow: 820000 } } };

describe("the spec member field", () => {
  const spec = (member: Record<string, unknown>): Record<string, unknown> => ({
    version: "0.2", name: "r", pods: [{ id: "build", label: "B", members: [{ id: "arch", agent_ref: "local:agents/arch", profile: "default", runtime: "pi", cwd: ".", ...member }], edges: [] }], edges: []
  });
  const errors = (member: Record<string, unknown>) => PodRigSpecSchema.validate(spec(member)).errors.join("\n");

  it("a pi member declaring the link is valid and reaches the normalised member as true", () => {
    expect(PodRigSpecSchema.validate(spec({ pi: { link_operator_models: true } })).errors).toEqual([]);
    expect(PodRigSpecSchema.normalize(spec({ pi: { link_operator_models: true } })).pods[0]!.members[0]!.piLinkOperatorModels).toBe(true);
  });

  it("controls: absent, `false` and an empty mapping all normalise to no declaration", () => {
    for (const member of [{}, { pi: { link_operator_models: false } }, { pi: {} }]) {
      expect(PodRigSpecSchema.validate(spec(member)).errors).toEqual([]);
      expect(PodRigSpecSchema.normalize(spec(member)).pods[0]!.members[0]!.piLinkOperatorModels).toBeUndefined();
    }
  });

  it("a member that declares BOTH the link and model_overrides is refused, the message names the conflict and says to use one", () => {
    const text = errors({ pi: { link_operator_models: true }, model_overrides: LUNA });
    expect(text).toMatch(/pi\.link_operator_models and model_overrides conflict/);
    expect(text).toMatch(/Use one or the other/);
  });

  it("control: model_overrides with the link set to false is not a conflict; the override path stays on", () => {
    expect(errors({ pi: { link_operator_models: false }, model_overrides: LUNA })).toBe("");
    expect(PodRigSpecSchema.normalize(spec({ pi: { link_operator_models: false }, model_overrides: LUNA })).pods[0]!.members[0]!.modelOverrides).toEqual(LUNA);
  });

  it.each([
    ["on a claude-code member", { runtime: "claude-code", pi: { link_operator_models: true } }, 'only valid when runtime is "pi"'],
    ["on a codex member", { runtime: "codex", pi: { link_operator_models: true } }, 'only valid when runtime is "pi"'],
    ["on an omp member", { runtime: "omp", pi: { link_operator_models: true } }, 'only valid when runtime is "pi"'],
    ["not a mapping", { pi: true }, "must be a mapping"],
    ["a list", { pi: [] }, "must be a mapping"],
    ["null", { pi: null }, "must be a mapping"],
    ["an unknown key", { pi: { link_operator_models: true, auth: "x" } }, 'unknown key "auth"'],
    ["a string value", { pi: { link_operator_models: "yes" } }, "must be true or false"],
  ])("refuses %s", (_n, member, message) => { expect(errors(member)).toContain(message); });

  it("the YAML codec round trips the declaration, and writes nothing for a member without it", () => {
    const text = RigSpecCodec.serialize(PodRigSpecSchema.normalize(spec({ pi: { link_operator_models: true } })));
    expect(RigSpecCodec.parse(text)).toMatchObject({ pods: [{ members: [{ pi: { link_operator_models: true } }] }] });
    expect(RigSpecCodec.serialize(PodRigSpecSchema.normalize(spec({})))).not.toContain("link_operator_models");
  });

  it("preflight says what it will do, and says nothing for a member without it", async () => {
    const normalized = PodRigSpecSchema.normalize(spec({ pi: { link_operator_models: true } }));
    expect(operatorModelsLinkDiscoveryWarnings(normalized)).toEqual([expect.stringMatching(/^build\.arch: pi\.link_operator_models; the runner links the seat's models\.json to the operator's .*refuses the launch if that setting is unset/)]);
    expect(operatorModelsLinkDiscoveryWarnings(PodRigSpecSchema.normalize(spec({})))).toEqual([]);
    const yaml = RigSpecCodec.serialize(normalized);
    const result = await rigPreflight({ rigSpecYaml: yaml, rigRoot: existingRigRoot("env-rig"), fsOps: { readFile: () => "", exists: () => true } as never });
    expect(result.warnings.filter((w) => w.includes("link_operator_models"))).toHaveLength(1);
  });
});

describe("the node keeps the declaration; a launch reads it back", () => {
  function repo() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    dbs.push(db);
    const r = new RigRepository(db);
    return { db, r, rig: r.createRig("r") };
  }
  it("migration 127 adds the nullable column; stored as 1; a seat without it reads false", () => {
    const { db, r, rig } = repo();
    expect((db.prepare("SELECT name, type, \"notnull\" AS nn FROM pragma_table_info('nodes') WHERE name = 'pi_link_operator_models'").get() as { type: string; nn: number })).toMatchObject({ type: "INTEGER", nn: 0 });
    const node = r.addNode(rig.id, "build.arch", { runtime: "pi", piLinkOperatorModels: true });
    expect(r.getNodeLinkOperatorModels(node.id)).toBe(true);
    expect((db.prepare("SELECT pi_link_operator_models AS v FROM nodes WHERE id = ?").get(node.id) as { v: number }).v).toBe(1);
    const bare = r.addNode(rig.id, "build.other", { runtime: "pi" });
    expect(r.getNodeLinkOperatorModels(bare.id)).toBe(false);
    expect((db.prepare("SELECT pi_link_operator_models AS v FROM nodes WHERE id = ?").get(bare.id) as { v: number | null }).v).toBeNull();
    expect(r.getNodeLinkOperatorModels("no-such-node")).toBe(false);
  });
  it("fails LOUD on a damaged stored value (anything but 1 or NULL), so that launch refuses", () => {
    const { db, r, rig } = repo();
    const node = r.addNode(rig.id, "build.arch", { runtime: "pi" });
    for (const bad of [0, 2, -1]) {
      db.prepare("UPDATE nodes SET pi_link_operator_models = ? WHERE id = ?").run(bad, node.id);
      expect(() => r.getNodeLinkOperatorModels(node.id)).toThrow(/pi_link_operator_models .* is not 1/);
    }
    db.prepare("UPDATE nodes SET pi_link_operator_models = NULL WHERE id = ?").run(node.id);
    expect(r.getNodeLinkOperatorModels(node.id)).toBe(false);
  });
  it("a declaration is never silently dropped when the column is missing", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS.filter((m) => !m.name.startsWith("127_")));
    dbs.push(db);
    const r = new RigRepository(db);
    expect(() => r.addNode(r.createRig("r").id, "build.arch", { runtime: "pi", piLinkOperatorModels: true })).toThrow(/migration 127 has not run/);
    expect(r.getNodeLinkOperatorModels("x")).toBe(false);
  });
  it("the exporter writes it back on the member (export -> import keeps it) and only on the seat that has it", () => {
    const { db, r, rig } = repo();
    const pod = new PodRepository(db).createPod(rig.id, "build", "Build", {});
    r.addNode(rig.id, "build.arch", { runtime: "pi", podId: pod.id, agentRef: "local:agents/a", profile: "default", cwd: "/w", piLinkOperatorModels: true });
    r.addNode(rig.id, "build.sec", { runtime: "pi", podId: pod.id, agentRef: "local:agents/s", profile: "default", cwd: "/w" });
    const exported = new RigSpecExporter({ rigRepo: r, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id);
    expect(exported).toMatchObject({ pods: [{ members: expect.arrayContaining([expect.objectContaining({ id: "arch", piLinkOperatorModels: true })]) }] });
    expect(JSON.stringify(exported)).not.toMatch(/"id":"sec"[^}]*piLinkOperatorModels/);
  });
});

describe("both launch paths pass the host setting and the seat's declaration to the runner", () => {
  const STATE_ROOT = "/openrig-home/state/pi";
  const SESSION = "build-arch@eztrack";
  const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/s.jsonl`;
  const DIR = "/home/me/.pi/agent";
  function memFs(files: Record<string, string> = {}): PiAdapterFsOps & { files: Record<string, string> } {
    const dirs = new Set<string>();
    return { files, readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]!; },
      writeFile: (p, c) => { files[p] = c; }, exists: (p) => p in files || dirs.has(p), mkdirp: (p) => { dirs.add(p); }, listFiles: () => [] };
  }
  function tmuxTyping(fs: ReturnType<typeof memFs>, typed: string[]): TmuxAdapter {
    const tmux = new TmuxAdapter(async () => { throw new Error("no tmux in this test"); });
    vi.spyOn(tmux, "sendShellCommand").mockImplementation(async (_t, text) => {
      typed.push(text);
      const launchId = /--launch-id '([^']+)'/.exec(text)![1];
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({ ready: true, launchId, sessionFile: SESSION_FILE, sessionId: "s", updatedAt: "2026-11-08T10:00:00Z" });
      return { ok: true };
    });
    return tmux;
  }
  const binding: NodeBinding = { id: "b-1", nodeId: "n-1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, updatedAt: "2026-11-08T10:00:00Z", cwd: "/work" };

  it("a fresh launch reads the setting at launch and asks for this session's declaration", async () => {
    const fs = memFs(); const typed: string[] = []; const asked: string[] = []; let reads = 0;
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {},
      operatorLoginDirFor: () => { reads++; return DIR; }, linkOperatorModelsFor: (s) => { asked.push(s); return true; } });
    expect((await adapter.launchHarness(binding, { name: SESSION })).ok).toBe(true);
    expect(asked).toEqual([SESSION]);
    expect(reads).toBe(1);
    expect(typed[0]).toContain(`--operator-login-dir '${DIR}' --link-operator-models`);
  });

  it("a fork launch carries them too", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {}, operatorLoginDirFor: () => DIR });
    await adapter.launchHarness(binding, { name: SESSION, forkSource: { kind: "native_id", value: "abc" } });
    expect(typed[0]).toContain("--fork 'abc'");
    expect(typed[0]).toContain(`--operator-login-dir '${DIR}'`);
    expect(typed[0]).not.toContain("--link-operator-models");
  });

  it("a launch whose declaration lookup throws (a damaged row) does not type a command", async () => {
    const fs = memFs(); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {},
      linkOperatorModelsFor: () => { throw new Error("nodes.pi_link_operator_models is not 1"); } });
    await expect(adapter.launchHarness(binding, { name: SESSION })).rejects.toThrow(/not 1/);
    expect(typed).toEqual([]);
  });

  it("a resume asks for both too", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const resume = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" },
      { pollMs: 1, maxWaitMs: 5, sleep: async () => {}, operatorLoginDirFor: () => DIR, linkOperatorModelsFor: (s) => s === SESSION });
    await resume.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(typed[0]).toContain(`--operator-login-dir '${DIR}' --link-operator-models`);
  });

  it("control: without lookups, neither flag on either path", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const launch = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {} });
    await launch.launchHarness(binding, { name: SESSION });
    const resume = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" }, { pollMs: 1, maxWaitMs: 5, sleep: async () => {} });
    await resume.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(typed).toHaveLength(2);
    for (const t of typed) expect(t).not.toMatch(/--operator-login-dir|--link-operator-models/);
  });
});

describe("instantiating a spec stores the declaration on the node, on both creation paths", () => {
  const RIG_ROOT = existingRigRoot("env-rig");
  const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
  const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, agent_ref: "local:agents/impl", profile: "default", runtime: "pi", cwd: ".", ...over });
  const rawSpec = (members: Record<string, unknown>[]): Record<string, unknown> => ({ version: "0.2", name: "env-rig", pods: [{ id: "build", label: "Build", members, edges: [] }], edges: [] });
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    db = createFullTestDb();
    const adapter: RuntimeAdapter = {
      runtime: "pi", listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn<RuntimeAdapter["launchHarness"]>(async () => ({ ok: true })),
    };
    setup = createTestApp(db, { adapters: { pi: adapter }, podInstantiatorFsOps: {
      readFile: (p: string) => { if (p.includes("agents/impl")) return agentYaml("impl"); throw new Error(`Not found: ${p}`); },
      exists: (p: string) => p.includes("agents/impl") } });
  });
  afterEach(() => { db.close(); });
  const stored = (logicalId: string) => {
    const row = db.prepare<[string], { id: string }>("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId);
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return new RigRepository(db).getNodeLinkOperatorModels(row!.id);
  };
  it("materialize (createMemberNode)", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("arch", { pi: { link_operator_models: true } }), rawMember("sec")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("build.arch"), stored("build.sec")]).toEqual([true, false]);
  });
  it("bootstrap from YAML (its own inline addNode)", async () => {
    const yaml = RigSpecCodec.serialize(PodRigSpecSchema.normalize(rawSpec([rawMember("arch", { pi: { link_operator_models: true } }), rawMember("sec")])));
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("build.arch"), stored("build.sec")]).toEqual([true, false]);
  });
  it("a member declaring both is refused by materialize and nothing is stored", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("arch", { pi: { link_operator_models: true }, model_overrides: LUNA })]), RIG_ROOT);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toMatch(/conflict/);
    expect(db.prepare("SELECT count(*) AS c FROM nodes").get()).toEqual({ c: 0 });
  });
});

describe("the host setting pi.operator_login_dir", () => {
  let tmp: string; let file: string; let saved: string | undefined;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "of279-settings-")); file = join(tmp, "config.json"); saved = process.env.OPENRIG_PI_OPERATOR_LOGIN_DIR; delete process.env.OPENRIG_PI_OPERATOR_LOGIN_DIR; });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.OPENRIG_PI_OPERATOR_LOGIN_DIR; else process.env.OPENRIG_PI_OPERATOR_LOGIN_DIR = saved; });

  it("defaults to unset (empty) and resolves a stored absolute folder and the environment name", () => {
    const store = new SettingsStore(file);
    expect(store.resolveOne("pi.operator_login_dir")).toMatchObject({ value: "", source: "default" });
    store.set("pi.operator_login_dir", "/home/me/.pi/agent");
    expect(store.resolveOne("pi.operator_login_dir")).toMatchObject({ value: "/home/me/.pi/agent", source: "file" });
    process.env.OPENRIG_PI_OPERATOR_LOGIN_DIR = "/env/dir";
    expect(store.resolveOne("pi.operator_login_dir")).toMatchObject({ value: "/env/dir", source: "env" });
  });

  it.each([["a relative path", "agent"], ["a dotdot part", "/a/../b"], ["leading space", " /a"], ["a tilde", "~/.pi/agent"]])("refuses %s", (_n, value) => {
    expect(() => new SettingsStore(file).set("pi.operator_login_dir", value)).toThrow(/Invalid pi\.operator_login_dir/);
  });

  it("accepts the empty string (unset again)", () => {
    const store = new SettingsStore(file);
    store.set("pi.operator_login_dir", "/a");
    store.set("pi.operator_login_dir", "");
    expect(store.resolveOne("pi.operator_login_dir").value).toBe("");
  });
});
