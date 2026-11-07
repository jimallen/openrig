// OF-270: the spec side of a Pi seat's `model_overrides`: validation (`rig spec`), the codec round trip, the node column,
// the export, preflight's notice, both node-creation paths, and both launch paths handing the stored overrides to the
// runner. The merge into models.json is test/pi-model-overrides.test.ts. Nothing here reaches a live seat, tmux or daemon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { modelOverrideDiscoveryWarnings, rigPreflight } from "../src/domain/rigspec-preflight.js";
import { lexicalAgentFs } from "./helpers/lexical-agent-fs.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const LUNA = { "openai-codex": { "gpt-6-luna": { contextWindow: 820000 } } };

describe("the spec member field", () => {
  const spec = (member: Record<string, unknown>): Record<string, unknown> => ({
    version: "0.2", name: "r", pods: [{ id: "verify", label: "V", members: [{ id: "qa", agent_ref: "local:agents/qa", profile: "default", runtime: "pi", cwd: ".", ...member }], edges: [] }], edges: [],
  });

  it("a pi member with overrides is valid and they reach the normalised member", () => {
    expect(PodRigSpecSchema.validate(spec({ model_overrides: LUNA })).errors).toEqual([]);
    expect(PodRigSpecSchema.normalize(spec({ model_overrides: LUNA })).pods[0]!.members[0]!.modelOverrides).toEqual(LUNA);
  });

  it("control: a pi member without the field has none", () => {
    expect(PodRigSpecSchema.normalize(spec({})).pods[0]!.members[0]!.modelOverrides).toBeUndefined();
  });

  it("round-trips through serialize and parse (a bundle or draft keeps them)", () => {
    const normalized = PodRigSpecSchema.normalize(spec({ model_overrides: LUNA }));
    expect(RigSpecCodec.parse(RigSpecCodec.serialize(normalized))).toMatchObject({ pods: [{ members: [{ model_overrides: LUNA }] }] });
  });

  it.each([
    ["on a claude-code member", { runtime: "claude-code", model_overrides: LUNA }, 'only valid when runtime is "pi"'],
    ["on a codex member", { runtime: "codex", model_overrides: LUNA }, 'only valid when runtime is "pi"'],
    ["on an omp member", { runtime: "omp", model_overrides: LUNA }, 'only valid when runtime is "pi"'],
    ["not a mapping", { model_overrides: "openai-codex" }, "non-empty mapping"],
    ["empty", { model_overrides: {} }, "non-empty mapping"],
    ["a zero window", { model_overrides: { p: { m: { contextWindow: 0 } } } }, "positive integer"],
    ["a string window", { model_overrides: { p: { m: { contextWindow: "820000" } } } }, "positive integer"],
    ["an unknown key", { model_overrides: { p: { m: { contextWindow: 1, apiKey: "x" } } } }, 'unknown key "apiKey"'],
  ])("refused: %s", (_label, member, message) => {
    const text = PodRigSpecSchema.validate(spec(member)).errors.join("\n");
    expect(text).toContain("model_overrides");
    expect(text).toContain(message);
  });

  describe("rigPreflight (what `rig spec preflight` and the `rig up --plan` preflight stage run)", () => {
    const ROOT = existingRigRoot("overrides-preflight");
    const AGENT = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n';
    const fsOps = () => lexicalAgentFs({
      exists: (p: string) => /\/agents\/impl(\/agent\.yaml)?$/.test(p),
      readFile: (p: string) => { if (p.includes("agents/impl")) return AGENT; throw new Error(`Not found: ${p}`); },
    });
    const yaml = (extra: string) => `version: "0.2"\nname: overrides-preflight\npods:\n  - id: verify\n    label: V\n    members:\n      - id: qa\n        runtime: pi\n        agent_ref: local:agents/impl\n        profile: default\n        cwd: .\n${extra}    edges: []\nedges: []\n`;
    const notices = (warnings: string[]) => warnings.filter((w) => w.includes("model_overrides"));

    it("lists the seat's overrides among the warnings, and a seat without them adds nothing", async () => {
      const withIt = await rigPreflight({ rigSpecYaml: yaml("        model_overrides:\n          openai-codex:\n            gpt-6-luna:\n              contextWindow: 820000\n"), rigRoot: ROOT, fsOps: fsOps() });
      expect(withIt.errors).toEqual([]);
      expect(notices(withIt.warnings)).toEqual([expect.stringMatching(/^verify\.qa: model_overrides openai-codex\/gpt-6-luna contextWindow=820000;/)]);
      const without = await rigPreflight({ rigSpecYaml: yaml(""), rigRoot: ROOT, fsOps: fsOps() });
      expect(notices(without.warnings)).toEqual([]);
    });

    it("refuses an invalid block as a preflight error", async () => {
      const bad = await rigPreflight({ rigSpecYaml: yaml("        model_overrides:\n          openai-codex:\n            gpt-6-luna:\n              contextWindow: 0\n"), rigRoot: ROOT, fsOps: fsOps() });
      expect(bad.ready).toBe(false);
      expect(bad.errors.join("\n")).toContain("model_overrides");
    });
  });

  it("the notice helper names provider, model and window per seat", () => {
    const normalized = PodRigSpecSchema.normalize(spec({ model_overrides: LUNA }));
    expect(modelOverrideDiscoveryWarnings(normalized)).toEqual([expect.stringMatching(/^verify\.qa: model_overrides openai-codex\/gpt-6-luna contextWindow=820000;.*symlink/)]);
    expect(modelOverrideDiscoveryWarnings(PodRigSpecSchema.normalize(spec({})))).toEqual([]);
  });
});

describe("the node keeps the overrides; a launch reads them back", () => {
  function repo() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    dbs.push(db);
    const r = new RigRepository(db);
    return { db, r, rig: r.createRig("r") };
  }

  it("stored as canonical JSON and read back; a seat without them reads undefined", () => {
    const { db, r, rig } = repo();
    // Inserted out of order at BOTH levels (provider "openai-codex" before "b"; model "z" before "a"), so the stored text
    // is canonical only if the writer sorts both.
    const node = r.addNode(rig.id, "verify.qa", { runtime: "pi", modelOverrides: { "openai-codex": LUNA["openai-codex"], b: { z: { contextWindow: 2 }, a: { contextWindow: 1 } } } });
    expect(r.getNodeModelOverrides(node.id)).toEqual({ "openai-codex": LUNA["openai-codex"], b: { a: { contextWindow: 1 }, z: { contextWindow: 2 } } });
    expect((db.prepare("SELECT model_overrides AS v FROM nodes WHERE id = ?").get(node.id) as { v: string }).v)
      .toBe('{"b":{"a":{"contextWindow":1},"z":{"contextWindow":2}},"openai-codex":{"gpt-6-luna":{"contextWindow":820000}}}');
    expect(r.getNodeModelOverrides(r.addNode(rig.id, "verify.sec", { runtime: "pi" }).id)).toBeUndefined();
  });

  it("refuses to store an invalid value", () => {
    const { r, rig } = repo();
    expect(() => r.addNode(rig.id, "verify.qa", { runtime: "pi", modelOverrides: { p: { m: { contextWindow: -1 } } } as never })).toThrow(/not valid/);
  });

  it("fails LOUD, unlike the env names: a stored value that is damaged throws, so the launch refuses", () => {
    const { db, r, rig } = repo();
    const node = r.addNode(rig.id, "verify.qa", { runtime: "pi" });
    const set = (v: string) => db.prepare("UPDATE nodes SET model_overrides = ? WHERE id = ?").run(v, node.id);
    set("not json"); expect(() => r.getNodeModelOverrides(node.id)).toThrow(/not JSON/);
    set('{"p":{"m":{"contextWindow":0}}}'); expect(() => r.getNodeModelOverrides(node.id)).toThrow(/not valid/);
    set(""); expect(r.getNodeModelOverrides(node.id)).toBeUndefined();
  });

  it("the exporter writes them back on the member (export -> import keeps them)", () => {
    const { db, r, rig } = repo();
    const pod = new PodRepository(db).createPod(rig.id, "verify", "Verify", {});
    r.addNode(rig.id, "verify.qa", { runtime: "pi", podId: pod.id, agentRef: "local:agents/qa", profile: "default", cwd: "/w", modelOverrides: LUNA });
    r.addNode(rig.id, "verify.sec", { runtime: "pi", podId: pod.id, agentRef: "local:agents/sec", profile: "default", cwd: "/w" });
    const exported = new RigSpecExporter({ rigRepo: r, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id);
    expect(exported).toMatchObject({ pods: [{ members: expect.arrayContaining([expect.objectContaining({ id: "qa", modelOverrides: LUNA })]) }] });
    expect(JSON.stringify(exported)).not.toMatch(/"id":"sec"[^}]*modelOverrides/);
  });
});

describe("both launch paths pass the seat's overrides to the runner", () => {
  const STATE_ROOT = "/openrig-home/state/pi";
  const SESSION = "verify-qa@eztrack";
  const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/s.jsonl`;
  const FLAG = `--model-overrides '{"openai-codex":{"gpt-6-luna":{"contextWindow":820000}}}'`;
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
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({ ready: true, launchId, sessionFile: SESSION_FILE, sessionId: "s", updatedAt: "2026-10-31T10:00:00Z" });
      return { ok: true };
    });
    return tmux;
  }
  const binding: NodeBinding = { id: "b-1", nodeId: "n-1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null,
    updatedAt: "2026-10-31T10:00:00Z", cwd: "/work" };

  it("a fresh launch asks for this session's overrides", async () => {
    const fs = memFs(); const typed: string[] = []; const asked: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js",
      sleep: async () => {}, modelOverridesFor: (s) => { asked.push(s); return LUNA; } });
    expect((await adapter.launchHarness(binding, { name: SESSION })).ok).toBe(true);
    expect(asked).toEqual([SESSION]);
    expect(typed[0]).toContain(FLAG);
  });

  it("a fork launch carries them too", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {}, modelOverridesFor: () => LUNA });
    await adapter.launchHarness(binding, { name: SESSION, forkSource: { kind: "native_id", value: "abc" } });
    expect(typed[0]).toContain("--fork 'abc'");
    expect(typed[0]).toContain(FLAG);
  });

  it("a launch whose lookup throws (a damaged stored value) does not type a command", async () => {
    const fs = memFs(); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {},
      modelOverridesFor: () => { throw new Error("nodes.model_overrides is not valid"); } });
    await expect(adapter.launchHarness(binding, { name: SESSION })).rejects.toThrow(/not valid/);
    expect(typed).toEqual([]);
  });

  it("a resume asks for this session's overrides too", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const adapter = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" },
      { pollMs: 1, maxWaitMs: 5, sleep: async () => {}, modelOverridesFor: (s) => (s === SESSION ? LUNA : undefined) });
    await adapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(typed[0]).toContain(FLAG);
  });

  it("control: without a lookup, no --model-overrides on either path", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const launch = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {} });
    await launch.launchHarness(binding, { name: SESSION });
    const resume = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" }, { pollMs: 1, maxWaitMs: 5, sleep: async () => {} });
    await resume.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(typed).toHaveLength(2);
    for (const t of typed) expect(t).not.toContain("--model-overrides");
  });
});

describe("instantiating a spec stores the overrides on the node, on both creation paths", () => {
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

  const stored = (logicalId: string) => {
    const row = db.prepare<[string], { id: string }>("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId);
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return new RigRepository(db).getNodeModelOverrides(row!.id);
  };

  it("materialize (createMemberNode)", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("qa", { model_overrides: LUNA }), rawMember("sec")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("verify.qa"), stored("verify.sec")]).toEqual([LUNA, undefined]);
  });

  it("bootstrap from YAML (its own inline addNode)", async () => {
    const yaml = RigSpecCodec.serialize(PodRigSpecSchema.normalize(rawSpec([rawMember("qa", { model_overrides: LUNA }), rawMember("sec")])));
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect([stored("verify.qa"), stored("verify.sec")]).toEqual([LUNA, undefined]);
  });
});
