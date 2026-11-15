// OF-283: `rig seat apply-spec`. A Pi seat's retained spec fields (env_passthrough, model_overrides, pi.link_operator_models)
// are written to its node only when the node is created; each launch reads them from the database. So a spec change (the live
// case: jims-team c84c5ba3 added env_passthrough: [OPENAI_API_KEY] to verify.ops) never reaches verify-ops@eztrack. These rows pin
// the explicit step that carries it: a dry run by default, a write only on --yes, in one transaction with one audit line, from a
// spec the recorded-spec-source judge trusts, and nothing else on the node or the seat changes.
// Deployed entrypoint: startup.ts hands SeatLifecycleService its mcpTrust; routes/seat.ts `POST /api/seat/apply-spec/:seatRef`
// calls SeatLifecycleService.applySpec; the CLI `rig seat apply-spec` calls that route. The rows go through the service and the route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { mcpTrustFixture } from "./helpers/mcp-trust-fixture.js";
import type { PathJudgeIo } from "../src/domain/codex-mcp-servers.js";

const NEW_ENV = ["OPENAI_API_KEY"];
const wins = (w: number) => ({ "openai-codex": { "gpt-6-luna": { contextWindow: w } } });

describe("rig seat apply-spec: a Pi seat takes its retained spec fields from the spec, on an explicit step", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let service: SeatLifecycleService;
  let bus: EventBus;
  let root: string;
  let TRUST: PathJudgeIo;
  let specPath: string;
  const tmuxCalls: string[] = [];
  // A real TmuxAdapter whose exec records and refuses every command: the apply touches no terminal, session or process, so
  // `tmuxCalls` must stay empty.
  const strictTmux = () => new TmuxAdapter(async (cmd) => { tmuxCalls.push(cmd); throw new Error(`apply-spec touched tmux: ${cmd}`); });

  /** The verify.ops member of the spec, with the given extra member lines (already indented 8 spaces). */
  function writeSpec(extra: string, runtime = "pi", file = specPath): void {
    writeFileSync(file, `version: "0.2"\nname: jims-team\npods:\n  - id: verify\n    label: Verify\n    members:\n      - id: ops\n        runtime: ${runtime}\n        agent_ref: local:agents/ops\n        profile: default\n        cwd: .\n${extra}`);
  }
  const envLines = (names: string[]) => `        env_passthrough: [${names.join(", ")}]\n`;
  const modelLines = (w: number) => `        model_overrides:\n          openai-codex:\n            gpt-6-luna:\n              contextWindow: ${w}\n`;
  const linkLines = "        pi:\n          link_operator_models: true\n";

  function seat(rigName: string, retained: { env?: string[]; models?: ReturnType<typeof wins>; link?: boolean; runtime?: string; spec?: boolean } = {}) {
    const rig = rigRepo.createRig(rigName);
    if (retained.spec !== false) rigRepo.setRigSpecSource(rig.id, specPath);
    const cwd = join(root, `ws-${rigName}`);
    mkdirSync(cwd, { recursive: true });
    const node = rigRepo.addNode(rig.id, "verify.ops", { runtime: retained.runtime ?? "pi", cwd, agentRef: "local:agents/ops", profile: "default",
      ...(retained.env ? { envPassthrough: retained.env } : {}), ...(retained.models ? { modelOverrides: retained.models } : {}), ...(retained.link ? { piLinkOperatorModels: true } : {}) });
    new SessionRegistry(db).registerSession(node.id, `verify-ops@${rigName}`);
    return { rig, node, ref: `verify-ops@${rigName}` };
  }
  const row = (nodeId: string) => db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as Record<string, unknown>;
  const retainedOf = (nodeId: string) => ({ env: rigRepo.getNodeEnvPassthrough(nodeId), models: rigRepo.getNodeModelOverrides(nodeId), link: rigRepo.getNodeLinkOperatorModels(nodeId) });
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'node.spec_fields_applied' ORDER BY seq").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const apply = (ref: string, extra: Partial<Parameters<SeatLifecycleService["applySpec"]>[0]> = {}) => service.applySpec({ seatRef: ref, yes: false, actor: null, ...extra });

  beforeEach(() => {
    tmuxCalls.length = 0;
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    ({ dir: root, io: TRUST } = mcpTrustFixture("apply-spec"));
    bus = new EventBus(db);
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: bus, tmuxAdapter: strictTmux(),
      mcpTrust: { io: TRUST, specRoots: () => [join(root, "spec")] } });
    mkdirSync(join(root, "spec"));
    chmodSync(join(root, "spec"), 0o755);
    specPath = join(root, "spec", "rig.yaml");
    writeSpec(envLines(NEW_ENV));
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  describe("the dry run (the default) shows retained -> spec and writes nothing", () => {
    it("the live case: a spec that names OPENAI_API_KEY, a seat that retains nothing", async () => {
      const s = seat("eztrack");
      const before = changes();
      const result = await apply(s.ref);
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ dryRun: true, written: false, changed: true, declaredIn: specPath, specSource: "recorded", envAdded: NEW_ENV, envRemoved: [] });
      expect(result.fields).toEqual([
        { field: "env_passthrough", retained: [], spec: NEW_ENV, changed: true },
        { field: "model_overrides", retained: [], spec: [], changed: false },
        { field: "pi.link_operator_models", retained: [], spec: [], changed: false },
      ]);
      expect(result.effect).toContain("Dry run");
      expect(changes()).toBe(before);
      expect(retainedOf(s.node.id)).toEqual({ env: [], models: undefined, link: false });
      expect(events()).toEqual([]);
      expect(tmuxCalls).toEqual([]);
    });

    it("says no change when the seat already retains what the spec says", async () => {
      const s = seat("eztrack", { env: NEW_ENV });
      const result = await apply(s.ref);
      expect(result).toMatchObject({ ok: true, dryRun: true, changed: false, envAdded: [], envRemoved: [] });
      expect(result.ok && result.fields.map((f) => f.changed)).toEqual([false, false, false]);
    });

    it("shows model overrides by provider/model with their window, and a changed window as a change", async () => {
      writeSpec(modelLines(900000));
      const s = seat("eztrack", { models: wins(820000) });
      const result = await apply(s.ref);
      if (!result.ok) throw new Error(result.message);
      expect(result.fields[1]).toEqual({ field: "model_overrides", retained: ["openai-codex/gpt-6-luna contextWindow=820000"], spec: ["openai-codex/gpt-6-luna contextWindow=900000"], changed: true });
    });

    it("a reorder of the env names is a change (the stored order is the spec's order)", async () => {
      writeSpec(envLines(["B_NAME", "A_NAME"]));
      const s = seat("eztrack", { env: ["A_NAME", "B_NAME"] });
      const result = await apply(s.ref);
      expect(result).toMatchObject({ ok: true, changed: true, envAdded: [], envRemoved: [] });
    });

    it("never prints an environment value: the variable's value is in the process environment and nowhere in the answer", async () => {
      const SECRET = "sk-of283-sentinel-0123456789";
      vi.stubEnv("OPENAI_API_KEY", SECRET);
      try {
        const s = seat("eztrack");
        const dry = await apply(s.ref);
        const wrote = await apply(s.ref, { yes: true, actor: "jim@host", reason: "release c84c5ba3" });
        expect(JSON.stringify(dry)).not.toContain(SECRET);
        expect(JSON.stringify(wrote)).not.toContain(SECRET);
        expect(JSON.stringify(events())).not.toContain(SECRET);
        expect(JSON.stringify(row(s.node.id))).not.toContain(SECRET);
        expect(JSON.stringify(dry)).toContain("OPENAI_API_KEY"); // control: the NAME is shown
      } finally { vi.unstubAllEnvs(); }
    });
  });

  describe("--yes writes all three fields in one transaction", () => {
    // The seat retains one OTHER field than the spec states for the tested one, so the spec's silence on it clears it:
    // the row proves each of the three columns is written (and cleared) on its own.
    const none = { env: [] as string[], models: undefined, link: false };
    it.each([
      ["env_passthrough", { env: ["OLD_NAME"] }, envLines(NEW_ENV), { ...none, env: NEW_ENV }],
      ["model_overrides", { models: wins(820000) }, modelLines(900000), { ...none, models: wins(900000) }],
      ["pi.link_operator_models", {}, linkLines, { ...none, link: true }],
    ] as const)("%s: the spec's value replaces the retained one", async (_name, retained, specLines, expected) => {
      writeSpec(specLines);
      const s = seat("eztrack", retained as never);
      const result = await apply(s.ref, { yes: true, actor: "jim@host", reason: "r" });
      expect(result).toMatchObject({ ok: true, dryRun: false, written: true, changed: true });
      expect(retainedOf(s.node.id)).toEqual(expected);
    });

    it("all three at once: env and models replaced, link cleared", async () => {
      writeSpec(envLines(NEW_ENV) + modelLines(900000));
      const s = seat("eztrack", { env: ["OLD_NAME"], models: wins(820000) });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(retainedOf(s.node.id)).toEqual({ env: NEW_ENV, models: wins(900000), link: false });
    });

    it("a field the spec no longer states is CLEARED (env, models; and the link on its own)", async () => {
      writeSpec("");
      const a = seat("alpha", { env: NEW_ENV, models: wins(820000) });
      const b = seat("beta", { link: true });
      expect(await apply(a.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(await apply(b.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(retainedOf(a.node.id)).toEqual({ env: [], models: undefined, link: false });
      expect(retainedOf(b.node.id)).toEqual({ env: [], models: undefined, link: false });
      expect(row(a.node.id)["env_passthrough"]).toBeNull();
      expect(row(a.node.id)["model_overrides"]).toBeNull();
      expect(row(b.node.id)["pi_link_operator_models"]).toBeNull();
    });

    it("changes nothing else: every other column of the node, its sessions, and its sibling seats are as they were; no tmux call", async () => {
      const s = seat("eztrack", { env: ["OLD_NAME"] });
      const other = seat("openrig", { env: ["OLD_NAME"] });
      // columns a wrong UPDATE could clobber alongside the three: give them values first
      db.prepare("UPDATE nodes SET effort = 'high', model = 'provider/model', role = 'ops', label = 'Ops seat' WHERE id IN (?, ?)").run(s.node.id, other.node.id);
      const strip = (r: Record<string, unknown>) => { const { env_passthrough, model_overrides, pi_link_operator_models, ...rest } = r; return rest; };
      const nodeBefore = strip(row(s.node.id));
      const otherBefore = row(other.node.id);
      const sessionsBefore = db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id);
      await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(strip(row(s.node.id))).toEqual(nodeBefore);
      expect(row(other.node.id)).toEqual(otherBefore);
      expect(db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id)).toEqual(sessionsBefore);
      expect(tmuxCalls).toEqual([]);
    });

    it("says it takes effect at the next launch and that nothing was relaunched", async () => {
      const s = seat("eztrack");
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result.ok && result.effect).toContain("next launch");
      expect(result.ok && result.effect).toContain("nothing was relaunched");
    });

    it("is one transaction: if the audit event cannot be stored, none of the three fields is written", async () => {
      writeSpec(envLines(NEW_ENV) + modelLines(900000));
      const s = seat("eztrack", { env: ["OLD_NAME"], models: wins(820000) });
      vi.spyOn(bus, "persistWithinTransaction").mockImplementation(() => { throw new Error("disk full"); });
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false });
      expect(retainedOf(s.node.id)).toEqual({ env: ["OLD_NAME"], models: wins(820000), link: false });
    });

    it("a stored value a launch would refuse is shown as unreadable, and applying the spec repairs it", async () => {
      writeSpec(modelLines(900000));
      const s = seat("eztrack");
      db.prepare("UPDATE nodes SET model_overrides = ? WHERE id = ?").run("{not json", s.node.id);
      const dry = await apply(s.ref);
      expect(dry.ok && dry.fields[1]).toMatchObject({ field: "model_overrides", retained: ["unreadable (damaged stored value)"], changed: true });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(retainedOf(s.node.id).models).toEqual(wins(900000));
    });
  });

  describe("the --yes guard and the audit line", () => {
    it("without --yes nothing is written, however the other arguments are filled in", async () => {
      const s = seat("eztrack");
      const before = changes();
      const result = await apply(s.ref, { yes: false, actor: "jim@host", reason: "r" });
      expect(result).toMatchObject({ ok: true, dryRun: true, written: false });
      expect(changes()).toBe(before);
      expect(retainedOf(s.node.id).env).toEqual([]);
    });

    it("a write needs an actor, and without one writes nothing and records nothing", async () => {
      const s = seat("eztrack");
      const result = await apply(s.ref, { yes: true, actor: "  " });
      expect(result).toMatchObject({ ok: false, code: "missing_actor" });
      expect(retainedOf(s.node.id).env).toEqual([]);
      expect(events()).toEqual([]);
    });

    it("a write records exactly one event: the seat, the fields that changed, the env names added and removed, who and why; names only", async () => {
      writeSpec(envLines(["KEEP_ME", "OPENAI_API_KEY"]) + "");
      const s = seat("eztrack", { env: ["KEEP_ME", "DROP_ME"] });
      await apply(s.ref, { yes: true, actor: "jim@host", reason: "release c84c5ba3" });
      expect(events()).toEqual([{ type: "node.spec_fields_applied", rigId: s.rig.id, nodeId: s.node.id, logicalId: "verify.ops", fields: ["env_passthrough"],
        envAdded: ["OPENAI_API_KEY"], envRemoved: ["DROP_ME"], actor: "jim@host", reason: "release c84c5ba3", declaredIn: specPath, specSource: "recorded",
        specSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    });

    it("a no-change --yes writes nothing and records nothing", async () => {
      const s = seat("eztrack", { env: NEW_ENV });
      const before = changes();
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: true, written: false, changed: false });
      expect(changes()).toBe(before);
      expect(events()).toEqual([]);
    });
  });

  describe("which spec, and whether it is trusted", () => {
    /** A copy of the spec in a folder the trusted roots do not cover. */
    function untrustedCopy(extra: string): string {
      const dir = join(root, "elsewhere");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      const file = join(dir, "rig.yaml");
      writeSpec(extra, "pi", file);
      return file;
    }
    it("refuses a recorded source outside the trusted roots, naming why, and writes nothing", async () => {
      const s = seat("eztrack");
      rigRepo.setRigSpecSource(s.rig.id, untrustedCopy(envLines(NEW_ENV)));
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false, code: "apply_spec_source_untrusted" });
      expect(!result.ok && result.message).toContain("is not trusted for applying seat fields");
      expect(retainedOf(s.node.id).env).toEqual([]);
      expect(events()).toEqual([]);
    });

    it("control: the same file in a trusted root is read", async () => {
      const s = seat("eztrack");
      expect(await apply(s.ref)).toMatchObject({ ok: true, declaredIn: specPath });
    });

    it("refuses a rig with no recorded spec source (unless --spec names one)", async () => {
      const s = seat("jims-team", { spec: false }); // --spec must declare this rig by name
      expect(await apply(s.ref)).toMatchObject({ ok: false, code: "apply_spec_source_unrecorded" });
      expect(await apply(s.ref, { specFile: specPath })).toMatchObject({ ok: true, specSource: "operator", declaredIn: specPath });
    });

    it("--spec <file> in a trusted root is used instead of the recorded source, and says so", async () => {
      const s = seat("jims-team");
      const other = join(root, "spec", "other.yaml");
      writeSpec(envLines(["FROM_OTHER"]), "pi", other);
      const result = await apply(s.ref, { specFile: other });
      expect(result).toMatchObject({ ok: true, specSource: "operator", declaredIn: other, envAdded: ["FROM_OTHER"] });
    });

    it("refuses a --spec file outside the trusted roots, and a relative one", async () => {
      const s = seat("eztrack");
      expect(await apply(s.ref, { specFile: untrustedCopy(envLines(NEW_ENV)) })).toMatchObject({ ok: false, code: "apply_spec_file_untrusted" });
      expect(await apply(s.ref, { specFile: "rig.yaml" })).toMatchObject({ ok: false, code: "apply_spec_invalid_spec_file" });
    });

    it("refuses a --spec file that declares another rig", async () => {
      const s = seat("eztrack");
      const other = join(root, "spec", "elsewhere-rig.yaml");
      writeSpec(envLines(NEW_ENV), "pi", other);
      writeFileSync(other, `${(await import("node:fs")).readFileSync(other, "utf-8")}`.replace("name: jims-team", "name: some-other-rig"));
      expect(await apply(s.ref, { specFile: other })).toMatchObject({ ok: false, code: "apply_spec_rig_mismatch" });
    });

    it("refuses a spec that cannot be read or does not validate, naming why", async () => {
      const s = seat("eztrack");
      writeFileSync(specPath, "version: [unterminated");
      expect(await apply(s.ref)).toMatchObject({ ok: false, code: "apply_spec_source_unavailable" });
      writeSpec(envLines(NEW_ENV).replace(NEW_ENV[0]!, "not a name!"));
      const invalidDry = await apply(s.ref); // a dry run refuses it too: the diff is never shown for a spec the load would refuse
      expect(invalidDry).toMatchObject({ ok: false });
      expect(!invalidDry.ok && invalidDry.message).toContain("not a name!");
      const invalid = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(invalid).toMatchObject({ ok: false });
      expect(!invalid.ok && invalid.message).toContain("not a name!");
      expect(retainedOf(s.node.id).env).toEqual([]);
    });

    it("refuses a spec that does not validate ANYWHERE, even when the seat's own member is fine (the whole spec is validated, as at spec load)", async () => {
      const s = seat("eztrack");
      writeSpec(envLines(NEW_ENV) + "      - id: qa\n        runtime: codex\n        agent_ref: local:agents/qa\n        profile: default\n        cwd: .\n        env_passthrough: [OPENAI_API_KEY]\n");
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false, code: "apply_spec_source_unavailable" });
      expect(!result.ok && result.message).toContain("no longer validates");
      expect(retainedOf(s.node.id).env).toEqual([]);
    });

    it("a refused name refuses the WHOLE apply: the valid fields in the same spec are not written either", async () => {
      writeSpec(envLines(["OPENAI_API_KEY", "PATH"]) + "");
      const s = seat("eztrack", { env: ["OLD_NAME"] });
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false });
      expect(retainedOf(s.node.id).env).toEqual(["OLD_NAME"]);
      expect(events()).toEqual([]);
    });
  });

  describe("which seat", () => {
    it("refuses a seat the spec does not declare", async () => {
      const s = seat("eztrack");
      db.prepare("UPDATE nodes SET logical_id = 'verify.qa' WHERE id = ?").run(s.node.id);
      expect(await apply("verify.qa@eztrack")).toMatchObject({ ok: false, code: "apply_spec_seat_undeclared" });
    });

    it("refuses a seat whose runtime is neither pi nor claude-code", async () => {
      const s = seat("eztrack", { runtime: "codex" });
      writeSpec("", "codex");
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false, code: "apply_spec_unsupported_runtime" });
      expect(events()).toEqual([]);
    });

    it("refuses a spec that declares the member with another runtime than the node's, even when the node is pi", async () => {
      const s = seat("eztrack", { env: NEW_ENV });
      writeSpec("", "codex");
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false, code: "apply_spec_runtime_mismatch" });
      expect(retainedOf(s.node.id).env).toEqual(NEW_ENV);
      expect(events()).toEqual([]);
    });

    it("refuses an unknown seat", async () => {
      expect(await apply("nobody@nowhere")).toMatchObject({ ok: false, code: "seat_not_found" });
    });
  });

  // The live case (2026-11-15): jims-team gained `ask_in_modal: true` on exec.cos, but exec-cos@eztrack's node keeps ask_in_modal
  // NULL until `rig up` relaunches it from the spec; `rig seat launch --startup-from stored`, restore and handover read the node.
  describe("a Claude Code seat: remote_control and ask_in_modal", () => {
    const rcLine = "        remote_control: true\n";
    const askLine = "        ask_in_modal: true\n";
    function claudeSeat(rigName: string, retained: { rc?: boolean; ask?: boolean } = {}) {
      const rig = rigRepo.createRig(rigName);
      rigRepo.setRigSpecSource(rig.id, specPath);
      const cwd = join(root, `ws-${rigName}`);
      mkdirSync(cwd, { recursive: true });
      const node = rigRepo.addNode(rig.id, "verify.ops", { runtime: "claude-code", cwd, agentRef: "local:agents/ops", profile: "default",
        ...(retained.rc ? { remoteControl: true } : {}), ...(retained.ask ? { askInModal: true } : {}) });
      new SessionRegistry(db).registerSession(node.id, `verify-ops@${rigName}`);
      return { rig, node, ref: `verify-ops@${rigName}` };
    }
    const claudeOf = (nodeId: string) => rigRepo.getNodeClaudeRetainedFields(nodeId);
    /** What every launch other than `rig up` reads: the node as the repository hands it to seat launch and restore. */
    const launchView = (rigId: string, nodeId: string) => {
      const n = rigRepo.getRig(rigId)!.nodes.find((x) => x.id === nodeId)!;
      return { remoteControl: n.remoteControl === true, askInModal: n.askInModal === true };
    };

    it("the dry run shows retained -> spec for both fields and writes nothing", async () => {
      writeSpec(rcLine + askLine, "claude-code");
      const s = claudeSeat("eztrack", { rc: true });
      const before = changes();
      const result = await apply(s.ref);
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ dryRun: true, written: false, changed: true, declaredIn: specPath, envAdded: [], envRemoved: [] });
      expect(result.fields).toEqual([
        { field: "remote_control", retained: ["true"], spec: ["true"], changed: false },
        { field: "ask_in_modal", retained: [], spec: ["true"], changed: true },
      ]);
      expect(result.effect).toContain("two fields");
      expect(changes()).toBe(before);
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: true, askInModal: false });
      expect(events()).toEqual([]);
      expect(tmuxCalls).toEqual([]);
    });

    it("--yes writes ask_in_modal, keeps remote_control, records one audit event, and the next launch reads it; nothing relaunched", async () => {
      writeSpec(rcLine + askLine, "claude-code");
      const s = claudeSeat("eztrack", { rc: true });
      const sessionsBefore = db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id);
      const result = await apply(s.ref, { yes: true, actor: "jim@host", reason: "jims-team adds ask_in_modal" });
      expect(result).toMatchObject({ ok: true, dryRun: false, written: true, changed: true });
      expect(result.ok && result.effect).toContain("nothing was relaunched");
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: true, askInModal: true });
      expect(launchView(s.rig.id, s.node.id)).toEqual({ remoteControl: true, askInModal: true });
      expect(events()).toEqual([{ type: "node.spec_fields_applied", rigId: s.rig.id, nodeId: s.node.id, logicalId: "verify.ops", fields: ["ask_in_modal"],
        envAdded: [], envRemoved: [], actor: "jim@host", reason: "jims-team adds ask_in_modal", declaredIn: specPath, specSource: "recorded",
        specSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      expect(db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id)).toEqual(sessionsBefore);
      expect(tmuxCalls).toEqual([]);
    });

    it("--yes writes remote_control on its own", async () => {
      writeSpec(rcLine, "claude-code");
      const s = claudeSeat("eztrack");
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: true, askInModal: false });
    });

    it("a field the spec no longer states is withdrawn (NULL, as on a node created without it)", async () => {
      writeSpec("", "claude-code");
      const s = claudeSeat("eztrack", { rc: true, ask: true });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: true });
      expect(row(s.node.id)["remote_control"]).toBeNull();
      expect(row(s.node.id)["ask_in_modal"]).toBeNull();
    });

    it("changes nothing else on the node, and nothing on a sibling seat", async () => {
      writeSpec(rcLine + askLine, "claude-code");
      const s = claudeSeat("eztrack");
      const other = claudeSeat("openrig");
      db.prepare("UPDATE nodes SET effort = 'high', model = 'claude-opus-5-5', env_passthrough = '[\"KEEP\"]' WHERE id IN (?, ?)").run(s.node.id, other.node.id);
      const strip = (r: Record<string, unknown>) => { const { remote_control, ask_in_modal, ...rest } = r; return rest; };
      const nodeBefore = strip(row(s.node.id));
      const otherBefore = row(other.node.id);
      await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(strip(row(s.node.id))).toEqual(nodeBefore);
      expect(row(other.node.id)).toEqual(otherBefore);
    });

    it("a no-change --yes writes nothing and records nothing", async () => {
      writeSpec(rcLine + askLine, "claude-code");
      const s = claudeSeat("eztrack", { rc: true, ask: true });
      const before = changes();
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: true, written: false, changed: false });
      expect(changes()).toBe(before);
      expect(events()).toEqual([]);
    });

    it("is one transaction: if the audit event cannot be stored, neither field is written", async () => {
      writeSpec(askLine, "claude-code");
      const s = claudeSeat("eztrack", { rc: true });
      vi.spyOn(bus, "persistWithinTransaction").mockImplementation(() => { throw new Error("disk full"); });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: false });
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: true, askInModal: false });
    });

    it("refuses a kernel seat, and writes nothing", async () => {
      writeSpec(rcLine, "claude-code");
      const s = claudeSeat("kernel");
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: false, code: "apply_spec_kernel_seat" });
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: false, askInModal: false });
      expect(events()).toEqual([]);
    });

    it("refuses a spec that declares the member with another runtime than the claude-code node's", async () => {
      writeSpec("", "pi");
      const s = claudeSeat("eztrack", { rc: true });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: false, code: "apply_spec_runtime_mismatch" });
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: true, askInModal: false });
    });

    it("a Pi seat is not offered the Claude fields, nor a Claude seat the Pi ones", async () => {
      writeSpec(envLines(NEW_ENV));
      const pi = seat("alpha");
      const piDry = await apply(pi.ref);
      expect(piDry.ok && piDry.fields.map((f) => f.field)).toEqual(["env_passthrough", "model_overrides", "pi.link_operator_models"]);
      writeSpec(rcLine, "claude-code");
      const cc = claudeSeat("beta");
      const ccDry = await apply(cc.ref);
      expect(ccDry.ok && ccDry.fields.map((f) => f.field)).toEqual(["remote_control", "ask_in_modal"]);
    });

    it("the route answers a Claude seat's dry run and write", async () => {
      writeSpec(askLine, "claude-code");
      const setup = createTestApp(db, { appDeps: { mcpTrust: { io: TRUST, specRoots: () => [join(root, "spec")] } } });
      const s = claudeSeat("eztrack");
      const post = (body: Record<string, unknown>) => setup.app.request(`/api/seat/apply-spec/${encodeURIComponent(s.ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const dry = await post({});
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ ok: true, dryRun: true, fields: [{ field: "remote_control", changed: false }, { field: "ask_in_modal", retained: [], spec: ["true"], changed: true }] });
      const ok = await post({ yes: true, operator: "jim@host" });
      expect(ok.status).toBe(200);
      expect(claudeOf(s.node.id)).toEqual({ remoteControl: false, askInModal: true });
    });
  });

  describe("the route (deployed entrypoint: POST /api/seat/apply-spec/:seatRef)", () => {
    const post = (setup: ReturnType<typeof createTestApp>, ref: string, body: Record<string, unknown>) =>
      setup.app.request(`/api/seat/apply-spec/${encodeURIComponent(ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    it("answers a dry run by default; --yes needs an actor (400); with one it writes and answers 200", async () => {
      const setup = createTestApp(db, { appDeps: { mcpTrust: { io: TRUST, specRoots: () => [join(root, "spec")] } } });
      const s = seat("eztrack");
      const dry = await post(setup, s.ref, {});
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ ok: true, dryRun: true, written: false, fields: expect.arrayContaining([expect.objectContaining({ field: "env_passthrough", retained: [], spec: NEW_ENV })]) });
      expect(retainedOf(s.node.id).env).toEqual([]);
      const noActor = await post(setup, s.ref, { yes: true });
      expect(noActor.status).toBe(400);
      expect(await noActor.json()).toMatchObject({ ok: false, code: "missing_actor" });
      const ok = await post(setup, s.ref, { yes: true, operator: "jim@host", reason: "r" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, written: true });
      expect(retainedOf(s.node.id).env).toEqual(NEW_ENV);
    });

    it("only a literal true counts as yes", async () => {
      const setup = createTestApp(db, { appDeps: { mcpTrust: { io: TRUST, specRoots: () => [join(root, "spec")] } } });
      const s = seat("eztrack");
      for (const yes of ["true", 1, "yes"]) {
        const res = await post(setup, s.ref, { yes, operator: "jim@host" });
        expect(await res.json()).toMatchObject({ dryRun: true, written: false });
      }
      expect(retainedOf(s.node.id).env).toEqual([]);
    });
  });

  // Seats removed and re-added (`rig add`), and rig-here surge seats (`add-seat <pod> <member><N> --as <member>`), record
  // agent_ref as an absolute `path:` into the release they were added from, while the spec declares `local:...`. A fresh launch
  // from the spec then refuses the seat ("a fresh launch never changes a seat's identity"), so operators replay the old
  // release's stored files forever. apply-spec shows the seat's agent_ref and profile `retained -> spec` and, with --yes,
  // writes them in the same transaction and audit event as the runtime's fields.
  describe("agent_ref and profile: realigned to the spec member, audited, dry run by default", () => {
    const OLD_REF = "path:/Users/someone/.agents-release/e8aad5c9/agents/ops";
    function readded(rigName: string, logicalId = "verify.ops", opts: { runtime?: string; agentRef?: string; profile?: string; rc?: boolean } = {}) {
      const rig = rigRepo.createRig(rigName);
      rigRepo.setRigSpecSource(rig.id, specPath);
      const cwd = join(root, `ws-${rigName}-${logicalId}`);
      mkdirSync(cwd, { recursive: true });
      const node = rigRepo.addNode(rig.id, logicalId, { runtime: opts.runtime ?? "claude-code", cwd, agentRef: opts.agentRef ?? OLD_REF, profile: opts.profile ?? "default",
        ...(opts.rc ? { remoteControl: true } : {}) });
      const ref = `${logicalId.replace(".", "-")}@${rigName}`;
      new SessionRegistry(db).registerSession(node.id, ref);
      return { rig, node, ref };
    }
    const identityOf = (nodeId: string) => db.prepare("SELECT agent_ref AS agentRef, profile FROM nodes WHERE id = ?").get(nodeId) as { agentRef: string | null; profile: string | null };

    it("the dry run shows agent_ref retained -> spec beside the Claude fields, and writes nothing", async () => {
      writeSpec("", "claude-code");
      const s = readded("eztrack");
      const before = changes();
      const result = await apply(s.ref);
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ dryRun: true, written: false, changed: true });
      expect(result.identity).toEqual([
        { field: "agent_ref", retained: OLD_REF, spec: "local:agents/ops", changed: true },
        { field: "profile", retained: "default", spec: "default", changed: false },
      ]);
      expect(result.fields.map((f) => f.changed)).toEqual([false, false]);
      expect(result.effect).toContain("agent_ref");
      expect(changes()).toBe(before);
      expect(identityOf(s.node.id)).toEqual({ agentRef: OLD_REF, profile: "default" });
      expect(events()).toEqual([]);
    });

    it("--yes writes agent_ref and profile, records them old -> new on the one audit event, and changes nothing else", async () => {
      writeSpec("", "claude-code");
      const s = readded("eztrack", "verify.ops", { profile: "legacy" });
      const strip = (r: Record<string, unknown>) => { const { agent_ref, profile, ...rest } = r; return rest; };
      const before = strip(row(s.node.id));
      const sessionsBefore = db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id);
      const result = await apply(s.ref, { yes: true, actor: "jim@host", reason: "re-added seat" });
      expect(result).toMatchObject({ ok: true, written: true, changed: true });
      expect(identityOf(s.node.id)).toEqual({ agentRef: "local:agents/ops", profile: "default" });
      expect(strip(row(s.node.id))).toEqual(before);
      expect(db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id)).toEqual(sessionsBefore);
      expect(events()).toEqual([expect.objectContaining({ type: "node.spec_fields_applied", logicalId: "verify.ops", fields: [], actor: "jim@host", reason: "re-added seat",
        identity: [{ field: "agent_ref", from: OLD_REF, to: "local:agents/ops" }, { field: "profile", from: "legacy", to: "default" }] })]);
      expect(tmuxCalls).toEqual([]);
    });

    it("a Pi seat's agent_ref is the same node column and is realigned the same way", async () => {
      writeSpec(envLines(NEW_ENV));
      const s = readded("eztrack", "verify.ops", { runtime: "pi" });
      const result = await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(result).toMatchObject({ ok: true, written: true });
      expect(identityOf(s.node.id).agentRef).toBe("local:agents/ops");
      expect(retainedOf(s.node.id).env).toEqual(NEW_ENV);
      expect(events()[0]).toMatchObject({ fields: ["env_passthrough"], identity: [{ field: "agent_ref", from: OLD_REF, to: "local:agents/ops" }] });
    });

    it("is one transaction: if the audit event cannot be stored, agent_ref is not written", async () => {
      writeSpec("", "claude-code");
      const s = readded("eztrack");
      vi.spyOn(bus, "persistWithinTransaction").mockImplementation(() => { throw new Error("disk full"); });
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: false });
      expect(identityOf(s.node.id).agentRef).toBe(OLD_REF);
    });

    it("a seat that already matches has nothing to write and records no identity on the event", async () => {
      writeSpec("        ask_in_modal: true\n", "claude-code");
      const s = readded("eztrack", "verify.ops", { agentRef: "local:agents/ops" });
      const dry = await apply(s.ref);
      expect(dry.ok && dry.identity.every((f) => !f.changed)).toBe(true);
      await apply(s.ref, { yes: true, actor: "jim@host" });
      expect(Object.keys(events()[0]!)).not.toContain("identity");
    });

    it("the kernel refusal stands for a drifted kernel seat: nothing is written", async () => {
      writeSpec("", "claude-code");
      const s = readded("kernel");
      expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: false, code: "apply_spec_kernel_seat" });
      expect(identityOf(s.node.id).agentRef).toBe(OLD_REF);
    });

    describe("a surge seat (<member><N>, added with rig-here's add-seat --as <member>)", () => {
      it("takes agent_ref and profile from its base member and leaves its own per-seat fields alone", async () => {
        writeSpec("        ask_in_modal: true\n", "claude-code");
        const s = readded("eztrack", "verify.ops2", { rc: true });
        const dry = await apply(s.ref);
        if (!dry.ok) throw new Error(dry.message);
        expect(dry).toMatchObject({ dryRun: true, changed: true, surgeOf: "verify.ops", fields: [] });
        expect(dry.identity[0]).toEqual({ field: "agent_ref", retained: OLD_REF, spec: "local:agents/ops", changed: true });
        const wrote = await apply(s.ref, { yes: true, actor: "jim@host" });
        expect(wrote).toMatchObject({ ok: true, written: true });
        expect(identityOf(s.node.id).agentRef).toBe("local:agents/ops");
        // The surge seat's own remote_control and ask_in_modal are its own: the base member's spec does not rewrite them.
        expect(rigRepo.getNodeClaudeRetainedFields(s.node.id)).toEqual({ remoteControl: true, askInModal: false });
        expect(events()[0]).toMatchObject({ logicalId: "verify.ops2", fields: [], surgeOf: "verify.ops" });
      });

      it("refuses a surge seat whose base member declares another runtime", async () => {
        writeSpec("", "pi");
        const s = readded("eztrack", "verify.ops2");
        expect(await apply(s.ref, { yes: true, actor: "jim@host" })).toMatchObject({ ok: false, code: "apply_spec_runtime_mismatch" });
        expect(identityOf(s.node.id).agentRef).toBe(OLD_REF);
      });

      it("a seat id that is not a surge of exactly one member stays undeclared (ops1 is not a surge; no leading zero)", async () => {
        writeSpec("", "claude-code");
        for (const [i, id] of ["verify.ops1", "verify.ops02", "verify.opsx"].entries()) {
          const s = readded(`rig${i}`, id);
          expect(await apply(s.ref)).toMatchObject({ ok: false, code: "apply_spec_seat_undeclared" });
        }
      });
    });
  });
});
