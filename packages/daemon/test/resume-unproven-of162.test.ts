// OF-162 (measured live 2026-10-26 19:39, improve-engineer@kernel): a fresh Claude launch whose first message was never
// seen submitted stored its session id as a usable resume token, although Claude writes a transcript only after the
// first message. Restore then ran `claude --resume fe08b428-...` and got "No conversation found".
// The resume id is kept but marked `unproven` until a prompt is submitted by the current occupant.
// Nothing here pins whether such a launch should also fail readiness: that is a product call (see the unit report).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const CLAUDE_ID = "fe08b428-e2c5-49da-ad48-ea8d604e99c3";
const probeOf = (db: Database.Database, sessionId: string) =>
  db.prepare("SELECT resume_type, resume_token, resume_last_probe_status AS probe, resume_last_verified IS NULL AS never_verified FROM sessions WHERE id = ?").get(sessionId);

describe("OF-162: SessionRegistry resume proof", () => {
  let db: Database.Database; let reg: SessionRegistry; let sessionId: string;
  beforeEach(() => {
    db = createFullTestDb(); reg = new SessionRegistry(db);
    const rig = new RigRepository(db).createRig("r");
    const node = new RigRepository(db).addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionId = reg.registerSession(node.id, "dev-impl@r").id;
    reg.updateStatus(sessionId, "running");
  });
  afterEach(() => db.close());

  it("marks a stored Claude id unproven, and a late hook re-writing the SAME id does not certify it", () => {
    reg.updateResumeToken(sessionId, "claude_id", CLAUDE_ID, "scrape");
    expect(probeOf(db, sessionId)).toMatchObject({ probe: "resumable", never_verified: 0 });
    expect(reg.markResumeUnproven(sessionId)).toBe(true);
    expect(probeOf(db, sessionId)).toEqual({ resume_type: "claude_id", resume_token: CLAUDE_ID, probe: "unproven", never_verified: 1 });
    reg.updateResumeToken(sessionId, "claude_id", CLAUDE_ID, "hook");
    expect(probeOf(db, sessionId)).toMatchObject({ resume_token: CLAUDE_ID, probe: "unproven", never_verified: 1 });
  });

  it("a different id written later is a new conversation and is not held back by the old mark", () => {
    reg.updateResumeToken(sessionId, "claude_id", CLAUDE_ID, "scrape");
    reg.markResumeUnproven(sessionId);
    reg.updateResumeToken(sessionId, "claude_id", "11111111-2222-4333-8444-555555555555", "hook");
    expect(probeOf(db, sessionId)).toMatchObject({ resume_token: "11111111-2222-4333-8444-555555555555", probe: "resumable", never_verified: 0 });
  });

  it("marks nothing when no Claude id is stored", () => {
    expect(reg.markResumeUnproven(sessionId)).toBe(false);
    reg.updateResumeToken(sessionId, "codex_id", "thread-1", "hook");
    expect(reg.markResumeUnproven(sessionId)).toBe(false);
    expect(probeOf(db, sessionId)).toMatchObject({ probe: "resumable" });
  });

  it("confirmResumeProven lifts only the unproven mark", () => {
    reg.updateResumeToken(sessionId, "claude_id", CLAUDE_ID, "scrape");
    reg.markResumeProbeResult(sessionId, "not_resumable");
    expect(reg.confirmResumeProven(sessionId)).toBe(false);
    expect(probeOf(db, sessionId)).toMatchObject({ probe: "not_resumable" });
    reg.markResumeUnproven(sessionId);
    expect(reg.confirmResumeProven(sessionId)).toBe(true);
    expect(probeOf(db, sessionId)).toMatchObject({ probe: "resumable", never_verified: 0 });
  });
});

describe("OF-162: a fresh launch with an unverified first message", () => {
  let db: Database.Database; let reg: SessionRegistry; let bus: EventBus; let seed: { rigId: string; nodeId: string; sessionId: string };
  beforeEach(() => {
    db = createFullTestDb(); reg = new SessionRegistry(db); bus = new EventBus(db);
    const repo = new RigRepository(db);
    const rig = repo.createRig("r");
    const node = repo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const s = reg.registerSession(node.id, "r01-impl"); reg.updateStatus(s.id, "running");
    seed = { rigId: rig.id, nodeId: node.id, sessionId: s.id };
  });
  afterEach(() => db.close());

  function run(opts: { runtime?: string; submissionUnverified: boolean; type?: string; resume?: boolean }) {
    // Reads: launch readiness, (a resume's settle read,) then the post-delivery read that goes unverified.
    const lastRead = opts.resume ? 3 : 2;
    let reads = 0;
    const checkReady = vi.fn(async () => {
      reads += 1;
      if (opts.submissionUnverified && reads === lastRead) throw new Error("composer capture unavailable");
      return { ready: true };
    });
    const adapter: RuntimeAdapter = {
      runtime: opts.runtime ?? "claude-code",
      listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady,
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: CLAUDE_ID, resumeType: opts.type ?? "claude_id" })),
    };
    const tmux: TmuxAdapter = Object.assign(Object.create(TmuxAdapter.prototype), {
      sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true), sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: vi.fn(async () => "❯ \n") });
    const settings: Pick<SettingsStore, "resolveOne"> = { resolveOne: () => ({ value: 30, source: "default", defaultValue: 30 }) };
    const orch = new StartupOrchestrator({ db, sessionRegistry: reg, eventBus: bus, tmuxAdapter: tmux, readFile: () => "Read the project instructions.",
      readinessSettings: settings, sleep: async () => {} });
    const binding: NodeBinding = { id: "b1", nodeId: seed.nodeId, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
    const input: StartupInput = { ...seed, binding, adapter, isRestore: opts.resume === true,
      ...(opts.resume ? { resumeToken: CLAUDE_ID, resumeType: "claude_id", allowFreshFallback: false } : {}),
      plan: { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] }],
      startupActions: [] };
    return orch.startNode(input);
  }

  it("keeps the launch's id but marks it unproven (the live 10-26 case)", async () => {
    const result = await run({ submissionUnverified: true });
    expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh", submission: { status: "unverified" } });
    expect(probeOf(db, seed.sessionId)).toEqual({ resume_type: "claude_id", resume_token: CLAUDE_ID, probe: "unproven", never_verified: 1 });
  });

  it("control: a submission that was verified leaves the id resumable", async () => {
    const result = await run({ submissionUnverified: false });
    expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh" });
    expect(result.ok && result.submission).toBeFalsy();
    expect(probeOf(db, seed.sessionId)).toMatchObject({ resume_token: CLAUDE_ID, probe: "resumable", never_verified: 0 });
  });

  it("control: a RESUMED seat's id was persisted by its earlier conversation, so an unverified submission leaves it resumable", async () => {
    reg.updateResumeToken(seed.sessionId, "claude_id", CLAUDE_ID, "hook");
    const result = await run({ resume: true, submissionUnverified: true });
    expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed", submission: { status: "unverified" } });
    expect(probeOf(db, seed.sessionId)).toMatchObject({ resume_token: CLAUDE_ID, probe: "resumable", never_verified: 0 });
  });

  it("control: only Claude has the first-message transcript rule", async () => {
    await run({ runtime: "codex", type: "codex_id", submissionUnverified: true });
    expect(probeOf(db, seed.sessionId)).toMatchObject({ resume_type: "codex_id", probe: "resumable" });
  });
});

describe("OF-162: a submitted prompt proves the conversation over the hook route", () => {
  let db: Database.Database; let reg: SessionRegistry; let sessionId: string; let nodeId: string; let generation: string; let post: (event: string, gen: string | null) => Promise<Response>;
  beforeEach(() => {
    db = createFullTestDb(); reg = new SessionRegistry(db);
    const repo = new RigRepository(db);
    const rig = repo.createRig("r");
    nodeId = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code" }).id;
    generation = reg.reserveOccupantGeneration()!;
    sessionId = reg.registerSession(nodeId, "dev-impl@r", "initial", generation).id; reg.updateStatus(sessionId, "running");
    reg.updateResumeToken(sessionId, "claude_id", CLAUDE_ID, "hook");
    reg.markResumeUnproven(sessionId);
    const { app } = createTestApp(db, { activityHookToken: "tok" });
    post = (event, gen) => Promise.resolve(app.request("/api/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" },
      body: JSON.stringify({ runtime: "claude-code", sessionName: "dev-impl@r", nodeId, hookEvent: event, ...(gen ? { generation: gen } : {}) }) }));
  });
  afterEach(() => db.close());

  it("UserPromptSubmit from the current occupant generation lifts the unproven mark", async () => {
    expect((await post("UserPromptSubmit", generation)).status).toBe(200);
    expect(probeOf(db, sessionId)).toMatchObject({ resume_token: CLAUDE_ID, probe: "resumable", never_verified: 0 });
  });

  it("a Stop, a prior-tenure prompt, and a prompt with no generation prove nothing", async () => {
    await post("Stop", generation);
    await post("UserPromptSubmit", "00000000-0000-4000-8000-000000000000");
    await post("UserPromptSubmit", null);
    expect(probeOf(db, sessionId)).toMatchObject({ probe: "unproven", never_verified: 1 });
  });
});
