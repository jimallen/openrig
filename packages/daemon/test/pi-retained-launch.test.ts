// OF-283: after `rig seat apply-spec` the launch paths use the new values, because they read the node, and no launch path
// reads the spec on its own. Deployed entrypoint: startup.ts builds `piRetainedFieldLookups(db, rigRepo)` and hands the three
// lookups to the ONE PiRuntimeAdapter (every launch: stop + `rig launch`, `seat launch --fresh`, `rig up --existing`, a handover
// successor, the first start) and the ONE PiResumeAdapter (every resume and restore). These rows drive those two adapters with
// those lookups, against a real node row and a real SeatLifecycleService.applySpec.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { piRetainedFieldLookups } from "../src/adapters/pi-retained-field-lookups.js";
import { mcpTrustFixture } from "./helpers/mcp-trust-fixture.js";

const STATE_ROOT = "/openrig-home/state/pi";
const SESSION = "verify-ops@eztrack";
const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/s.jsonl`;
const OPERATOR_DIR = "/operator/pi";

describe("a spec change reaches an existing Pi seat's launch only through apply-spec", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let root: string;
  let specPath: string;
  let service: SeatLifecycleService;
  let nodeId: string;
  const applyTmuxCalls: string[] = [];

  const writeSpec = (extra: string) => writeFileSync(specPath,
    `version: "0.2"\nname: jims-team\npods:\n  - id: verify\n    label: Verify\n    members:\n      - id: ops\n        runtime: pi\n        agent_ref: local:agents/ops\n        profile: default\n        cwd: .\n${extra}`);
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
  const binding = (): NodeBinding => ({ id: "b-1", nodeId, tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, updatedAt: "2026-10-31T10:00:00Z", cwd: "/work" });
  /** What a launch (stop + `rig launch`, fresh, `rig up --existing`, successor) types for this seat, with the daemon's lookups. */
  async function launchCommand(): Promise<string> {
    const fs = memFs(); const typed: string[] = [];
    const adapter = new PiRuntimeAdapter({ tmux: tmuxTyping(fs, typed), fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: "/r.js", sleep: async () => {},
      ...piRetainedFieldLookups(db, rigRepo), operatorLoginDirFor: () => OPERATOR_DIR });
    expect((await adapter.launchHarness(binding(), { name: SESSION })).ok).toBe(true);
    return typed[0]!;
  }
  /** What a resume or restore types for this seat. */
  async function resumeCommand(): Promise<string> {
    const fs = memFs({ [SESSION_FILE]: "jsonl" }); const typed: string[] = [];
    const adapter = new PiResumeAdapter(tmuxTyping(fs, typed), fs, { stateRoot: STATE_ROOT, runnerEntryPath: "/r.js" },
      { pollMs: 1, maxWaitMs: 5, sleep: async () => {}, ...piRetainedFieldLookups(db, rigRepo), operatorLoginDirFor: () => OPERATOR_DIR });
    await adapter.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    return typed[0]!;
  }
  const apply = async () => { const r = await service.applySpec({ seatRef: SESSION, yes: true, actor: "jim@host", reason: "test" }); expect(applyTmuxCalls).toEqual([]); return r; };

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const trust = mcpTrustFixture("pi-launch");
    root = trust.dir;
    mkdirSync(join(root, "spec"));
    chmodSync(join(root, "spec"), 0o755);
    specPath = join(root, "spec", "rig.yaml");
    writeSpec("");
    const rig = rigRepo.createRig("eztrack");
    rigRepo.setRigSpecSource(rig.id, specPath);
    const cwd = join(root, "ws");
    mkdirSync(cwd);
    // The seat was created from a spec that did not yet carry the fields (the live case: before jims-team c84c5ba3).
    nodeId = rigRepo.addNode(rig.id, "verify.ops", { runtime: "pi", cwd, agentRef: "local:agents/ops", profile: "default" }).id;
    new SessionRegistry(db).registerSession(nodeId, SESSION);
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: new TmuxAdapter(async (cmd) => { applyTmuxCalls.push(cmd); throw new Error(`apply-spec touched tmux: ${cmd}`); }),
      mcpTrust: { io: trust.io, specRoots: () => [join(root, "spec")] } });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const SPEC_FIELDS = "        env_passthrough: [OPENAI_API_KEY]\n        model_overrides:\n          openai-codex:\n            gpt-6-luna:\n              contextWindow: 820000\n";

  it("NO IMPLICIT APPLY: the spec now names the variable, a plain launch and a plain restore still use the retained (empty) fields", async () => {
    writeSpec(SPEC_FIELDS);
    for (const typed of [await launchCommand(), await resumeCommand()]) {
      expect(typed).not.toContain("--env-pass");
      expect(typed).not.toContain("--model-overrides");
    }
    expect(rigRepo.getNodeEnvPassthrough(nodeId)).toEqual([]);
  });

  it("stop + launch: after apply-spec the launch command passes the new names and model overrides", async () => {
    writeSpec(SPEC_FIELDS);
    expect(await apply()).toMatchObject({ ok: true, written: true });
    const typed = await launchCommand();
    expect(typed).toContain("--env-pass 'OPENAI_API_KEY'");
    expect(typed).toContain(`--model-overrides '{"openai-codex":{"gpt-6-luna":{"contextWindow":820000}}}'`);
  });

  it("restore (resume): after apply-spec the restored seat gets the new names and model overrides", async () => {
    writeSpec(SPEC_FIELDS);
    expect(await apply()).toMatchObject({ ok: true, written: true });
    const typed = await resumeCommand();
    expect(typed).toContain("--env-pass 'OPENAI_API_KEY'");
    expect(typed).toContain(`--model-overrides '{"openai-codex":{"gpt-6-luna":{"contextWindow":820000}}}'`);
  });

  it("pi.link_operator_models: launch and restore link the operator's models only after apply-spec", async () => {
    writeSpec("        pi:\n          link_operator_models: true\n");
    expect(await launchCommand()).not.toContain("--link-operator-models");
    expect(await resumeCommand()).not.toContain("--link-operator-models");
    expect(await apply()).toMatchObject({ ok: true, written: true });
    expect(await launchCommand()).toContain("--link-operator-models");
    expect(await resumeCommand()).toContain("--link-operator-models");
  });

  it("a removal in the spec reaches the launch too: after apply-spec the names are gone from it", async () => {
    writeSpec(SPEC_FIELDS);
    await apply();
    expect(await launchCommand()).toContain("--env-pass");
    writeSpec("");
    expect(await launchCommand()).toContain("--env-pass"); // not applied yet
    await apply();
    const typed = await launchCommand();
    expect(typed).not.toContain("--env-pass");
    expect(typed).not.toContain("--model-overrides");
  });
});
