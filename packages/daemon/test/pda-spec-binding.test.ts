// pda L2b (pda-runtime-design-9l, "The seat spec", T19): the `pda:` member block, its storage on the node
// (migration 115), its round trip through the codec and the exporter, and the one-seat-per-pda-agent rule.
//
// What nothing here proves: a pda seat launching. Preflight still refuses `runtime: pda` until L2a registers it,
// so the instantiation paths are pinned in pda-spec-binding-paths.test.ts with preflight stubbed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigRepository, readSavedPdaBinding } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { retainedPdaBindingAgrees } from "../src/domain/rigspec-instantiator.js";
import type { RigSpec } from "../src/domain/types.js";

const member = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/pda-seat", profile: "default", runtime: "pda", cwd: "/work", pda: { agent: "research" }, ...over,
});
const spec = (members: Record<string, unknown>[], podId = "dev"): Record<string, unknown> => ({
  version: "0.2", name: "pda-rig", pods: [{ id: podId, label: "Dev", members, edges: [] }], edges: [],
});
const errorsOf = (raw: Record<string, unknown>): string => RigSpecSchema.validate(raw).errors.join("\n");

describe("migration 115: nodes.pda_binding", () => {
  it("adds a nullable TEXT column named pda_binding, and 116 is still unregistered", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; type: string; notnull: number }>;
    expect(columns.find((c) => c.name === "pda_binding")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(columns.length).toBeGreaterThan(10); // positive control: the table was read
    expect(ALL_MIGRATIONS.map((m) => m.name)).toContain("115_node_pda_binding.sql");
    expect(ALL_MIGRATIONS.map((m) => m.name).filter((n) => n.startsWith("116"))).toEqual([]);
    db.close();
  });
});

describe("spec schema: the pda block (T19)", () => {
  it("accepts a pda member and normalizes the binding, defaulting base_url to the loopback default", () => {
    const raw = spec([member("research")]);
    expect(RigSpecSchema.validate(raw)).toMatchObject({ valid: true, errors: [] });
    expect(RigSpecSchema.normalize(raw).pods[0]!.members[0]!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:8150" });
  });

  it("keeps an explicit base_url", () => {
    const raw = spec([member("research", { pda: { agent: "research", base_url: "http://127.0.0.1:9001" } })]);
    expect(RigSpecSchema.validate(raw).valid).toBe(true);
    expect(RigSpecSchema.normalize(raw).pods[0]!.members[0]!.pda?.baseUrl).toBe("http://127.0.0.1:9001");
  });

  it("requires the block on a pda member", () => {
    const { pda: _omit, ...withoutPda } = member("research");
    expect(errorsOf(spec([withoutPda]))).toMatch(/pods\[0\]\.members\[0\]\.pda: required when runtime is "pda"/);
  });

  it.each(["claude-code", "codex", "pi", "omp", "stub"])("refuses a pda block on a %s member", (runtime) => {
    expect(errorsOf(spec([member("m", { runtime })]))).toMatch(/pods\[0\]\.members\[0\]\.pda: only valid when runtime is "pda"/);
  });

  it("refuses a pda block on a terminal member", () => {
    const terminal = { id: "t", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", pda: { agent: "research" } };
    expect(errorsOf(spec([terminal]))).toMatch(/members\[0\]\.pda: only valid when runtime is "pda"/);
  });

  it("refuses the root agent `main`, a bad name, a missing agent, and an unknown key (each with its own path)", () => {
    expect(errorsOf(spec([member("a", { pda: { agent: "main" } })]))).toMatch(/members\[0\]\.pda\.agent: 'main' is pda's root agent/);
    expect(errorsOf(spec([member("a", { pda: { agent: "Research" } })]))).toMatch(/members\[0\]\.pda\.agent: must match/);
    expect(errorsOf(spec([member("a", { pda: {} })]))).toMatch(/members\[0\]\.pda\.agent: required/);
    expect(errorsOf(spec([member("a", { pda: { agent: "research", token: "x" } })]))).toMatch(/members\[0\]\.pda\.token: unknown key/);
    expect(errorsOf(spec([member("a", { pda: null })]))).toMatch(/members\[0\]\.pda: must be a mapping/);
    expect(errorsOf(spec([member("a", { pda: "research" })]))).toMatch(/members\[0\]\.pda: must be a mapping/);
  });

  it.each([
    "http://localhost:8150", "http://[::1]:8150", "https://127.0.0.1:8150", "http://127.0.0.1:8150/", "http://127.0.0.1",
    "http://u@127.0.0.1:8150", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://0.0.0.0:8150", "http://127.0.0.1:08150",
  ])("refuses the base_url %s", (baseUrl) => {
    expect(errorsOf(spec([member("a", { pda: { agent: "research", base_url: baseUrl } })]))).toMatch(/members\[0\]\.pda\.base_url: must be http:\/\/127\.0\.0\.1:<port>/);
  });

  // The design's list of keys a pda member cannot take. Each is refused WITH ITS OWN PATH (so the author sees which),
  // and the member without it is the positive control that the fixture is otherwise valid. Every value here is
  // VALID for its key on a claude-code member, so the refusal is the pda rule's and not the key's own validation
  // (a first draft used the invalid ref "builtin:floor" for permission_policy: the key's own error satisfied the
  // assertion and a mutant that deleted the pda rule survived).
  const PDA_OWN_REFUSAL = "not valid on a pda member";
  it.each([
    ["model", "gpt-9"], ["effort", "high"], ["permission_policy", "builtin:yolo"],
    ["session_source", { mode: "fork", ref: { kind: "native_id", value: "abc" } }],
    ["starter_ref", { name: "s" }], ["startup", { files: [{ path: "role.md", delivery_hint: "send_text", required: true }] }],
    ["compaction_strategy", "default-compaction"], ["mechanic", "m@r"],
  ])("refuses %s on a pda member with the pda rule's own message", (key, value) => {
    expect(RigSpecSchema.validate(spec([member("a")])).valid).toBe(true);
    const claude = RigSpecSchema.validate(spec([member("a", { runtime: "claude-code", pda: undefined, [key as string]: value })]));
    expect(claude.errors.filter((e) => e.includes(`.${key}:`)), `${key} must be valid on a claude-code member`).toEqual([]);
    expect(errorsOf(spec([member("a", { [key as string]: value })]))).toContain(`pods[0].members[0].${key}: ${PDA_OWN_REFUSAL}`);
  });

  // These three are refused on a pda member by their own runtime-pairing checks (codex only, codex only, claude only),
  // which already existed; the row pins that a pda member does not slip past them.
  it.each([
    ["codex_config_profile", "p1"], ["mcp_servers", { s: { command: "/bin/x", enabled_tools: ["t"] } }], ["remote_control", true],
  ])("refuses %s on a pda member through its existing runtime-pairing check", (key, value) => {
    expect(errorsOf(spec([member("a", { [key as string]: value })]))).toContain(`pods[0].members[0].${key}:`);
  });

  it("restore_policy: absent, null and resume_if_possible are legal; relaunch_fresh and checkpoint_only are refused", () => {
    for (const ok of [undefined, null, "resume_if_possible"]) {
      expect(RigSpecSchema.validate(spec([member("a", ok === undefined ? {} : { restore_policy: ok })])).valid).toBe(true);
    }
    for (const bad of ["relaunch_fresh", "checkpoint_only"]) {
      expect(errorsOf(spec([member("a", { restore_policy: bad })]))).toMatch(/members\[0\]\.restore_policy: a pda member takes only resume_if_possible/);
    }
  });

  it("remote_control: false stays legal on a pda member (only `true` is refused)", () => {
    expect(RigSpecSchema.validate(spec([member("a", { remote_control: false })])).valid).toBe(true);
  });

  describe("one pda agent, one seat, in a spec", () => {
    it("refuses two members that bind the same agent at the same address, across pods, naming the first", () => {
      const raw = {
        ...spec([member("a")]),
        pods: [
          { id: "dev", label: "Dev", members: [member("a")], edges: [] },
          { id: "qa", label: "QA", members: [member("b", { pda: { agent: "research", base_url: "http://127.0.0.1:8150" } })], edges: [] },
        ],
      };
      expect(errorsOf(raw)).toMatch(/pods\[1\]\.members\[0\]\.pda: agent "research" at http:\/\/127\.0\.0\.1:8150 is already driven by pods\[0\]\.members\[0\]/);
    });

    it("the default base_url and the same address spelled out are the same pda agent", () => {
      const raw = spec([member("a"), member("b", { pda: { agent: "research", base_url: "http://127.0.0.1:8150" } })]);
      expect(errorsOf(raw)).toMatch(/members\[1\]\.pda: agent "research" at http:\/\/127\.0\.0\.1:8150 is already driven/);
    });

    it("the same name on another port is another pda server, and another name on one port is another agent", () => {
      expect(RigSpecSchema.validate(spec([member("a"), member("b", { pda: { agent: "research", base_url: "http://127.0.0.1:8151" } })])).valid).toBe(true);
      expect(RigSpecSchema.validate(spec([member("a"), member("b", { pda: { agent: "other" } })])).valid).toBe(true);
    });

    it("an invalid block is not also reported as a duplicate", () => {
      const raw = spec([member("a", { pda: { agent: "main" } }), member("b", { pda: { agent: "main" } })]);
      expect(errorsOf(raw)).not.toMatch(/already driven/);
    });
  });
});

describe("codec: the block survives serialize -> parse", () => {
  it("emits pda { agent, base_url } in the snake_case wire spelling and normalizes back to the same binding", () => {
    const normalized = RigSpecSchema.normalize(spec([member("a", { pda: { agent: "research", base_url: "http://127.0.0.1:9001" } })]));
    const yaml = RigSpecCodec.serialize(normalized as unknown as RigSpec);
    expect(yaml).toMatch(/^\s+pda:\n\s+agent: research\n\s+base_url: http:\/\/127\.0\.0\.1:9001$/m);
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(yaml)).pods[0]!.members[0]!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:9001" });
  });

  it("a member without a binding emits no pda key", () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(spec([member("a", { runtime: "codex", pda: undefined })])) as unknown as RigSpec);
    expect(yaml).toContain("runtime: codex"); // positive control: the member was serialized
    expect(yaml).not.toMatch(/^\s+pda:/m);
  });
});

describe("repository: nodes.pda_binding", () => {
  let db: Database.Database;
  let repo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); });
  afterEach(() => { db.close(); });
  const column = (logicalId: string): string | null =>
    (db.prepare("SELECT pda_binding FROM nodes WHERE logical_id = ?").get(logicalId) as { pda_binding: string | null }).pda_binding;

  it("stores the binding as {agent, base_url} JSON and reads it back; a seat with none has a NULL column and no key", () => {
    const rig = repo.createRig("r");
    const bound = repo.addNode(rig.id, "dev.research", { runtime: "pda", pda: { agent: "research", baseUrl: "http://127.0.0.1:9001" } });
    const plain = repo.addNode(rig.id, "dev.plain", { runtime: "codex" });
    expect(column("dev.research")).toBe('{"agent":"research","base_url":"http://127.0.0.1:9001"}');
    expect(column("dev.plain")).toBeNull();
    const nodes = repo.getRig(rig.id)!.nodes;
    expect(nodes.find((n) => n.id === bound.id)!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:9001" });
    // Snapshots serialize Node objects: a seat that is not a pda seat must be byte-identical to before.
    const plainNode = nodes.find((n) => n.id === plain.id)!;
    expect("pda" in plainNode).toBe(false);
    expect("pdaBindingUnreadable" in plainNode).toBe(false);
  });

  it.each([
    ["not JSON", "{agent"],
    ["an array", "[]"],
    ["a number", "7"],
    ["no base_url (a stored row has no defaults)", '{"agent":"research"}'],
    ["no agent", '{"base_url":"http://127.0.0.1:8150"}'],
    ["the root agent", '{"agent":"main","base_url":"http://127.0.0.1:8150"}'],
    ["a non-loopback address", '{"agent":"research","base_url":"http://localhost:8150"}'],
    ["an unknown key", '{"agent":"research","base_url":"http://127.0.0.1:8150","token":"x"}'],
  ])("a damaged column (%s) reads as no binding WITH the reason, never as a clean absence", (_label, text) => {
    const read = readSavedPdaBinding(text);
    expect(read.value).toBeUndefined();
    expect(read.unreadable).toMatch(/^pda_binding /);
    const rig = repo.createRig("r");
    const node = repo.addNode(rig.id, "dev.x", { runtime: "pda" });
    db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run(text, node.id);
    const read2 = repo.getRig(rig.id)!.nodes[0]!;
    expect(read2.pda).toBeUndefined();
    expect(read2.pdaBindingUnreadable).toMatch(/^pda_binding /);
  });

  it("NULL and the empty string are the real absence", () => {
    expect(readSavedPdaBinding(null)).toEqual({});
    expect(readSavedPdaBinding(undefined)).toEqual({});
    expect(readSavedPdaBinding("")).toEqual({});
  });

  describe("a database that has not run migration 115", () => {
    it("storing a binding is refused loudly (a seat bound to nothing must never be created), and the holder lookup finds nothing", () => {
      db.exec("ALTER TABLE nodes DROP COLUMN pda_binding");
      const rig = repo.createRig("r");
      expect(() => repo.addNode(rig.id, "dev.x", { runtime: "pda", pda: { agent: "research", baseUrl: "http://127.0.0.1:8150" } })).toThrow(/migration 115/);
      expect(repo.addNode(rig.id, "dev.y", { runtime: "codex" }).logicalId).toBe("dev.y"); // a non-pda seat is unaffected
      expect(repo.findPdaBindingHolders({ agent: "research", baseUrl: "http://127.0.0.1:8150" })).toEqual([]);
    });
  });

  describe("findPdaBindingHolders", () => {
    const research = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
    it("finds the seat that drives the agent, in any rig, and names it", () => {
      const a = repo.createRig("rig-a");
      const b = repo.createRig("rig-b");
      const held = repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
      repo.addNode(b.id, "dev.codex", { runtime: "codex" });
      expect(repo.findPdaBindingHolders(research)).toEqual([{ nodeId: held.id, rigId: a.id, rigName: "rig-a", logicalId: "dev.research" }]);
    });

    it("matches the pair: another port, or another name, is not a holder", () => {
      const a = repo.createRig("rig-a");
      repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
      expect(repo.findPdaBindingHolders({ agent: "research", baseUrl: "http://127.0.0.1:8151" })).toEqual([]);
      expect(repo.findPdaBindingHolders({ agent: "other", baseUrl: "http://127.0.0.1:8150" })).toEqual([]);
    });

    it("an archived rig holds nothing; unarchiving makes it a holder again", () => {
      const a = repo.createRig("rig-a");
      repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
      expect(repo.archiveRig(a.id)).toBe(true);
      expect(repo.findPdaBindingHolders(research)).toEqual([]);
      expect(repo.unarchiveRig(a.id)).toBe(true);
      expect(repo.findPdaBindingHolders(research)).toHaveLength(1);
    });

    it("excludeRigIds and excludeNodeId drop exactly their own seat", () => {
      const a = repo.createRig("rig-a");
      const b = repo.createRig("rig-b");
      const inA = repo.addNode(a.id, "dev.research", { runtime: "pda", pda: research });
      const inB = repo.addNode(b.id, "dev.other", { runtime: "pda", pda: research });
      expect(repo.findPdaBindingHolders(research, { excludeRigIds: [a.id] }).map((h) => h.nodeId)).toEqual([inB.id]);
      expect(repo.findPdaBindingHolders(research, { excludeNodeId: inB.id }).map((h) => h.nodeId)).toEqual([inA.id]);
      expect(repo.findPdaBindingHolders(research, { excludeRigIds: [a.id, b.id] })).toEqual([]);
    });

    it("a damaged row is not a holder of anything", () => {
      const a = repo.createRig("rig-a");
      const node = repo.addNode(a.id, "dev.research", { runtime: "pda" });
      db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run('{"agent":"research"}', node.id);
      expect(repo.findPdaBindingHolders(research)).toEqual([]);
    });
  });
});

describe("exporter: the binding is read from the column and written back", () => {
  it("exports a pda seat's block, and the exported spec validates and round-trips", () => {
    const db = createFullTestDb();
    const repo = new RigRepository(db);
    const rig = repo.createRig("r");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev", {});
    repo.addNode(rig.id, "dev.research", { runtime: "pda", podId: pod.id, agentRef: "local:agents/pda-seat", profile: "default", cwd: "/w", pda: { agent: "research", baseUrl: "http://127.0.0.1:9001" } });
    repo.addNode(rig.id, "dev.plain", { runtime: "codex", podId: pod.id, agentRef: "local:agents/pda-seat", profile: "default", cwd: "/w" });
    const exported = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id) as unknown as RigSpec;
    const members = exported.pods.flatMap((p) => p.members);
    expect(members.find((m) => m.id === "research")!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:9001" });
    expect(members.find((m) => m.id === "plain")!.pda).toBeUndefined();
    const reparsed = RigSpecCodec.parse(RigSpecCodec.serialize(exported));
    expect(RigSpecSchema.validate(reparsed)).toMatchObject({ valid: true });
    expect(RigSpecSchema.normalize(reparsed).pods[0]!.members.find((m) => m.id === "research")!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:9001" });
    db.close();
  });
});

describe("first-start retry: the member must name the retained seat's pda agent", () => {
  const held = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
  it("agrees only for the same agent at the same address", () => {
    expect(retainedPdaBindingAgrees({ ...held }, { pda: held })).toBe(true);
  });
  it("another agent, another base URL, none where the seat has one, or one where it has none are each a different seat", () => {
    expect(retainedPdaBindingAgrees({ agent: "other", baseUrl: held.baseUrl }, { pda: held })).toBe(false);
    expect(retainedPdaBindingAgrees({ agent: held.agent, baseUrl: "http://127.0.0.1:8151" }, { pda: held })).toBe(false);
    expect(retainedPdaBindingAgrees(undefined, { pda: held })).toBe(false);
    expect(retainedPdaBindingAgrees({ ...held }, {})).toBe(false);
  });
  it("a seat that is not a pda seat agrees with a member that has no block", () => {
    expect(retainedPdaBindingAgrees(undefined, {})).toBe(true);
  });
  it("a damaged saved binding agrees with nothing, not even the matching member or no member", () => {
    expect(retainedPdaBindingAgrees({ ...held }, { pdaBindingUnreadable: "pda_binding is not JSON" })).toBe(false);
    expect(retainedPdaBindingAgrees(undefined, { pdaBindingUnreadable: "pda_binding is not JSON" })).toBe(false);
  });
});
