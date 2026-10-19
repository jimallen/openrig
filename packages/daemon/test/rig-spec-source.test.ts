// OF-32 stage 1: a rig records where its spec came from, in the spelling the operator chose. A spec library link
// keeps its link path (the release it points at can move); the launch itself still runs from the real file
// (68bbb9e6), so this record changes nothing about first launch.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { rigSpecSourceSchema } from "../src/db/migrations/111_rig_spec_source.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { BootstrapRepository } from "../src/domain/bootstrap-repository.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const POD_SPEC = `version: "0.2"
name: team
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
const AGENT = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A release folder holding the rig and its agent, and a library folder that reaches it through a link. */
function linkedRelease() {
  const root = tmp("of32-src-");
  const release = path.join(root, "release-a", "rigs", "team");
  fs.mkdirSync(path.join(release, "agents", "impl"), { recursive: true });
  fs.writeFileSync(path.join(release, "rig.yaml"), POD_SPEC);
  fs.writeFileSync(path.join(release, "agents", "impl", "agent.yaml"), AGENT);
  const library = path.join(root, "library");
  fs.mkdirSync(library);
  fs.symlinkSync(release, path.join(library, "team"));
  return { root, release, library, realSpec: path.join(release, "rig.yaml"), linkSpec: path.join(library, "team", "rig.yaml") };
}

describe("OF-32 rigs.spec_source_path", () => {
  it("an upgraded database records nothing for an existing rig, and a recorded source survives reopen", () => {
    const dir = tmp("of32-db-");
    const file = path.join(dir, "state.sqlite");
    let db = createDb(file);
    try {
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== rigSpecSourceSchema.name));
      const old = new RigRepository(db).createRig("before");
      migrate(db, ALL_MIGRATIONS);
      migrate(db, ALL_MIGRATIONS);
      const repo = new RigRepository(db);
      expect(repo.getRigSpecSource(old.id)).toBeNull();
      const recorded = repo.createRig("after");
      repo.setRigSpecSource(recorded.id, "/library/team/rig.yaml");
      db.close();
      db = createDb(file);
      const reopened = new RigRepository(db);
      expect(reopened.getRigSpecSource(old.id)).toBeNull();
      expect(reopened.getRigSpecSource(recorded.id)).toBe("/library/team/rig.yaml");
    } finally { db.close(); }
  });
});

describe("OF-32 PodRigInstantiator records the spec source when it creates the rig", () => {
  function setup() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = {
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      sendText: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter;
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
    } as never);
    return { db, rigRepo, inst };
  }

  it("stores the given source on the new rig, and nothing when none is given", async () => {
    const { release } = linkedRelease();
    const { db, rigRepo, inst } = setup();
    try {
      const recorded = await inst.instantiate(POD_SPEC, release, { specSourcePath: "/library/team/rig.yaml" });
      expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
      const unrecorded = await inst.instantiate(POD_SPEC.replace("name: team", "name: other"), release);
      expect(unrecorded.ok, JSON.stringify(unrecorded)).toBe(true);
      if (!recorded.ok || !unrecorded.ok) return;
      expect(rigRepo.getRigSpecSource(recorded.result.rigId)).toBe("/library/team/rig.yaml");
      expect(rigRepo.getRigSpecSource(unrecorded.result.rigId)).toBeNull();
    } finally { db.close(); }
  });
});

describe("OF-32 bootstrap chooses the spelling a rig records", () => {
  async function bootstrapWith(sourceRef: string, specSourceRef?: string) {
    const db = createFullTestDb();
    const instantiate = vi.fn(async () => ({ ok: true as const, result: { rigId: "rig-1", specName: "team", specVersion: "0.2", nodes: [] } }));
    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      // Only the pod-aware apply path runs; these satisfy the constructor's same-handle checks.
      runtimeVerifier: { db }, installExecutor: { db }, packageInstallService: { db },
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      podInstantiator: { db, instantiate },
    } as never);
    try {
      const result = await orch.bootstrap({ mode: "apply", sourceRef, ...(specSourceRef ? { specSourceRef } : {}) });
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(instantiate).toHaveBeenCalledTimes(1);
      const opts = (instantiate.mock.calls[0] as unknown[])[2] as { specSourcePath?: string };
      return { rigRoot: (instantiate.mock.calls[0] as unknown[])[1], specSourcePath: opts.specSourcePath };
    } finally { db.close(); }
  }

  it("records the library link when it names the very file being launched, and launches from the real folder", async () => {
    const { realSpec, linkSpec, release } = linkedRelease();
    const seen = await bootstrapWith(realSpec, linkSpec);
    expect(seen.specSourcePath).toBe(linkSpec);
    // The launch itself is unchanged: relative refs still resolve beside the real file.
    expect(seen.rigRoot).toBe(release);
  });

  it("records the launched path when no other spelling is given", async () => {
    const { realSpec } = linkedRelease();
    expect((await bootstrapWith(realSpec)).specSourcePath).toBe(realSpec);
  });

  it("refuses to record a spelling that names a different file", async () => {
    const { realSpec, root } = linkedRelease();
    const elsewhere = path.join(root, "elsewhere.yaml");
    fs.writeFileSync(elsewhere, POD_SPEC);
    expect((await bootstrapWith(realSpec, elsewhere)).specSourcePath).toBe(realSpec);
  });
});

describe("OF-32 spec library exposes the link path of a linked spec", () => {
  it("a spec reached through a link carries its link path; an unlinked spec carries none", () => {
    const { library, linkSpec, realSpec } = linkedRelease();
    const plainDir = path.join(library, "plain");
    fs.mkdirSync(plainDir);
    fs.writeFileSync(path.join(plainDir, "rig.yaml"), POD_SPEC.replace("name: team", "name: plain"));
    const lib = new SpecLibraryService({ roots: [{ path: library, sourceType: "user_file" }], specReviewService: new SpecReviewService() });
    lib.scan();
    const byName = new Map(lib.list({ kind: "rig" }).map((e) => [e.name, e]));
    expect(byName.get("team")).toMatchObject({ sourcePath: realSpec, linkPath: linkSpec });
    expect(byName.get("plain")?.sourcePath).toBe(path.join(plainDir, "rig.yaml"));
    expect(byName.get("plain")).not.toHaveProperty("linkPath");
  });
});

describe("OF-32 POST /api/up forwards the operator's spelling to bootstrap", () => {
  it.each([[{ specSourceRef: "/library/team/rig.yaml" }, "/library/team/rig.yaml"], [{}, undefined], [{ specSourceRef: "" }, undefined]] as const)(
    "body %j reaches bootstrap as specSourceRef %s", async (extra, expected) => {
      const { realSpec } = linkedRelease();
      const db = createFullTestDb();
      const setup = createTestApp(db, {
        upRouterFsOps: {
          exists: (p: string) => fs.existsSync(p),
          readFile: (p: string) => fs.readFileSync(p, "utf-8"),
          readHead: (p: string, n: number) => {
            const fd = fs.openSync(p, "r");
            try { const buf = Buffer.alloc(n); return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0)); } finally { fs.closeSync(fd); }
          },
        },
      });
      const seen: Array<Record<string, unknown>> = [];
      const orch = setup.bootstrapOrchestrator;
      orch.bootstrap = (async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return { runId: "r", status: "failed", stages: [], errors: ["stop here"], warnings: [] };
      }) as unknown as typeof orch.bootstrap;
      try {
        await setup.app.request("/api/up", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceRef: realSpec, ...extra }),
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.specSourceRef).toBe(expected);
      } finally { db.close(); }
    });
});
