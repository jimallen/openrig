// pda runtime L2a: a pda seat's resume token (`pda_agent`, census rows 6, 7, 8 and the hook route) and the D4 binding
// warning on restore (L0 review D4). The token names the agent the seat drives, `http://127.0.0.1:<port>/agents/<a>`;
// it is format-validated by L0's one parser, never derived from a hook, and never quoted in an error.

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { activityRoutes } from "../src/routes/activity.js";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { EventBus } from "../src/domain/event-bus.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";

describe("pda_agent resume tokens", () => {
  it("pda has a resume type, and its token is validated by L0's loopback and agent-name rules", () => {
    expect(resumeTypeForRuntime("pda")).toBe("pda_agent");
    expect(validateResumeToken("pda", " http://127.0.0.1:8150/agents/research ")).toEqual({ ok: true, resumeType: "pda_agent", token: "http://127.0.0.1:8150/agents/research" });
    for (const bad of [
      "http://localhost:8150/agents/SECRETNAME", "http://127.0.0.1:8150/agents/main", "http://127.0.0.1:8150/agents/research/",
      "https://127.0.0.1:8150/agents/research", "http://127.0.0.1:08150/agents/research", "/tmp/x.jsonl", "SECRETNAME",
    ]) {
      const result = validateResumeToken("pda", bad);
      expect(result.ok, bad).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SECRETNAME");
      expect(JSON.stringify(result)).not.toContain(bad);
    }
    // Other runtimes are unchanged: a pda-shaped token is not a Pi session file, and terminal still has none.
    expect(validateResumeToken("pi", "http://127.0.0.1:8150/agents/research").ok).toBe(false);
    expect(resumeTypeForRuntime("terminal")).toBeNull();
  });

  it("capture derives nothing for pda (the token is recorded by the launch), and never scrapes a sidecar", async () => {
    const piRunnerStateStore = { readSessionFile: vi.fn(() => ({ ok: true as const, sessionFile: "/x.jsonl" })) };
    const result = await deriveResumeToken({ runtime: "pda", sessionName: "s" }, { piRunnerStateStore, ompRunnerStateStore: piRunnerStateStore } as never);
    expect(result).toEqual({ outcome: "noop" });
    expect(piRunnerStateStore.readSessionFile).not.toHaveBeenCalled();
  });
});

describe("the activity hook route never sets a pda seat's resume token", () => {
  function app(seatRuntime: string) {
    const updateResumeToken = vi.fn(() => true);
    const sessionRegistry = {
      updateResumeToken, resumeTokenMatches: vi.fn(() => false), currentOccupantTenure: vi.fn(() => null),
      armedResumeLaunch: vi.fn(() => null), recordHookSessionIdentity: vi.fn(() => true), db: {},
    };
    const store = { resolveSession: () => ({ sessionId: "sid", rigId: "r", nodeId: "n", sessionName: "seat@rig", runtime: seatRuntime }) };
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, store as never);
      c.set("activityHookToken" as never, "hook-token" as never);
      c.set("sessionRegistry" as never, sessionRegistry as never);
      c.set("eventBus" as never, { emit: vi.fn() } as never);
      await next();
    });
    hono.route("/api/activity", activityRoutes);
    const post = (body: Record<string, unknown>) => hono.request("/api/activity/hooks", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hook-token" }, body: JSON.stringify(body),
    });
    return { post, updateResumeToken };
  }

  it.each([
    ["the hook names runtime pda", { runtime: "pda" }],
    ["the hook names no runtime, the seat is pda", {}],
    ["the hook claims codex, the seat is pda", { runtime: "codex" }],
  ])("%s: 409, nothing persisted", async (_name, extra) => {
    const { post, updateResumeToken } = app("pda");
    const res = await post({ eventFamily: "session_identity", sessionName: "seat@rig", sessionId: "http://127.0.0.1:9001/agents/zeta", ...extra });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "session_identity_not_accepted", tokenPersisted: false });
    expect(updateResumeToken).not.toHaveBeenCalled();
  });

  it("control: a codex seat's hook still records its token", async () => {
    const { post, updateResumeToken } = app("codex");
    const res = await post({ eventFamily: "session_identity", sessionName: "seat@rig", sessionId: "thread-abc", runtime: "codex" });
    expect(res.status).toBe(200);
    expect(updateResumeToken).toHaveBeenCalledWith("sid", "codex_id", "thread-abc", "hook");
  });
});

describe("restore of a pda token: the D4 binding warning, and the legacy pda resume branch", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());

  /** A launched seat, brought down, whose snapshot now records a pda token, with `binding` as its saved spec binding. */
  async function seatWithPdaToken(token: string, binding: string | null) {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    for (const s of data.sessions) { s.resumeType = "pda_agent"; s.resumeToken = token; }
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
    h.db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run(binding, seat.nodeId);
    return { snapshotId, seat };
  }
  const restoreWarnings = async (snapshotId: string) => {
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) } } as never);
    if (!out.ok) throw new Error(JSON.stringify(out));
    return out.result.warnings.join("\n");
  };

  it("the token names another agent than the spec: restore resumes the token's agent and says so, naming both", async () => {
    const { snapshotId } = await seatWithPdaToken("http://127.0.0.1:9001/agents/zeta", JSON.stringify({ agent: "research", base_url: "http://127.0.0.1:8150" }));
    const warnings = await restoreWarnings(snapshotId);
    expect(warnings).toContain("binds pda agent 'research' at http://127.0.0.1:8150, but its resume token names 'zeta' at http://127.0.0.1:9001");
    expect(warnings).toContain("Restore resumes 'zeta'");
  });

  it("they agree: no warning", async () => {
    const { snapshotId } = await seatWithPdaToken("http://127.0.0.1:8150/agents/research", JSON.stringify({ agent: "research", base_url: "http://127.0.0.1:8150" }));
    expect(await restoreWarnings(snapshotId)).not.toMatch(/pda agent|pda binding/);
  });

  it("the saved binding is damaged: restore says it resumes the token's agent and the binding needs repair", async () => {
    const { snapshotId } = await seatWithPdaToken("http://127.0.0.1:8150/agents/research", "{damaged");
    expect(await restoreWarnings(snapshotId)).toContain("saved pda binding cannot be read (pda_binding is not JSON); restore resumes pda agent 'research'");
  });

  it("legacy path (attemptResume): a pda token goes to the pda resume adapter; attention stays attention, never retry_fresh", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const outcomes = [{ ok: true }, { ok: false, code: "attention_required", message: "pda has no such agent", evidence: "EXITED code=3" }, { ok: false, code: "resume_failed", message: "timed out" }];
    const pdaResume = { canResume: (t: string | null, tok: string | null) => t === "pda_agent" && !!tok, resume: vi.fn(async () => outcomes.shift()) };
    const restore = new RestoreOrchestrator({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, eventBus: new EventBus(h.db), snapshotRepo: h.snapshotRepo,
      snapshotCapture: h.snapshotCapture, checkpointStore: new CheckpointStore(h.db), nodeLauncher: { db: h.db }, tmuxAdapter: h.tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() }, codexResume: { canResume: () => false, resume: vi.fn() },
      pdaResume,
    } as never);
    const attempt = (restore as unknown as { attemptResume(...a: unknown[]): Promise<unknown> }).attemptResume.bind(restore);
    const token = "http://127.0.0.1:8150/agents/research";
    expect(await attempt(seat.nodeId, seat.sessionName, "pda_agent", token, "/w")).toEqual({ kind: "resumed" });
    expect(await attempt(seat.nodeId, seat.sessionName, "pda_agent", token, "/w")).toEqual({ kind: "attention_required", message: "pda has no such agent", evidence: "EXITED code=3" });
    expect(await attempt(seat.nodeId, seat.sessionName, "pda_agent", token, "/w")).toEqual({ kind: "failed", message: "timed out" });
    expect(pdaResume.resume).toHaveBeenCalledWith(seat.nodeId, seat.sessionName, "pda_agent", token, "/w");
  });
});
