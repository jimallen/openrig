// OF-92 (security review pda-l2a, N6): the duplicate-binding re-check must be made against the agent a pda seat will
// ACTUALLY drive, which on a restore is the agent its RESUME TOKEN names, not only the saved binding column
// (nodes.pda_binding) of the other seats. An operator can set a token (POST /api/sessions/:name/resume-token) that
// names an agent bound to another seat; before this change both seats then drove one pi-durable agent.
//
// Production consequence these rows pin: two OpenRig seats typing into one pda conversation. Nothing here talks to a
// pda host or a tmux server; the fake tmux records the keystrokes a launch would have typed.
//
// Census of the paths that set or launch with a pda resume token (instrument: `rg -n "launchHarness\\(|updateResumeToken\\(|
// recordResumeAttempt\\(|resume_token\\s*=" packages/daemon/src`, classified; see the PR body). One row (or more) per path:
//   P1 operator set                    POST /api/sessions/:name/resume-token        -> row "operator-set token ..."
//   P2 fresh launch, binding.pda       startup-orchestrator -> adapter.launchHarness  -> row "fresh launch"
//   P3 launch/restore with a token     startup-orchestrator -> adapter.launchHarness  -> row "restore token"
//   P4 legacy restore                  PdaResumeAdapter.resume                        -> row "legacy restore"
//   P5 post-launch record of the token startup-orchestrator updateResumeToken(scrape) -> row "records the token it launched"
//   P6 pda-release                     POST /api/sessions/:name/pda-release           -> row "pda-release touches no token"
//   P7 attempt record on attention     startup-orchestrator recordResumeAttempt       -> not a launch path; the token written
//                                      is the attempted one, which the P2/P3/P4 check already cleared (no row)
// Not in this file: the activity hooks route (OF-91, another owner), claim and handover (noop / refused for pda).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { PdaRuntimeAdapter, type PdaRuntimeAdapterDeps } from "../src/adapters/pda-runtime-adapter.js";
import { PdaResumeAdapter } from "../src/adapters/pda-resume.js";
import { pdaSeatPaths } from "../src/adapters/pda-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const PORT = "http://127.0.0.1:8150";
const X = { agent: "research", baseUrl: PORT };
const X_TOKEN = `${PORT}/agents/research`;
const Z_TOKEN = `${PORT}/agents/zeta`;
const Y = { agent: "other", baseUrl: PORT };
const SESSION_A = "dev-a@rig-a";
const SESSION_B = "dev-b@rig-b";

let db: Database.Database;
let repo: RigRepository;
let sessions: SessionRegistry;
let dir: string;
let stateRoot: string;
let tokenFile: string;

beforeEach(() => {
  db = createFullTestDb();
  repo = new RigRepository(db);
  sessions = new SessionRegistry(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-of92-"));
  stateRoot = path.join(dir, "state", "pda");
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(43), { mode: 0o600 });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** A pda seat in its own rig, with a running session. `binding` is the saved column (nodes.pda_binding). */
function seat(rigName: string, logicalId: string, sessionName: string, binding: { agent: string; baseUrl: string }) {
  const rig = repo.createRig(rigName);
  const node = repo.addNode(rig.id, logicalId, { runtime: "pda", pda: binding });
  const session = sessions.registerSession(node.id, sessionName);
  sessions.updateStatus(session.id, "running");
  return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
}

/** POST /api/sessions/:name/resume-token, the operator door (P1), against the real route and the real registry. */
function operatorSets(sessionName: string, token: string) {
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("sessionRegistry" as never, sessions as never);
    c.set("rigRepo" as never, repo as never);
    c.set("eventBus" as never, new EventBus(db) as never);
    c.set("terminalBearerToken" as never, "term-token" as never);
    await next();
  });
  hono.route("/api/sessions", sessionAdminRoutes);
  return hono.request(`/api/sessions/${encodeURIComponent(sessionName)}/resume-token`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer term-token" },
    body: JSON.stringify({ token, reason: "OF-92 test: point this seat at another agent" }),
  });
}

/** The real pda adapter, its duplicate check wired exactly as startup.ts wires it, over a fake tmux that records keystrokes. */
function pda() {
  const typed: string[] = [];
  const deps: PdaRuntimeAdapterDeps = {
    tmux: {
      sendShellCommand: async (_t: string, command: string) => { typed.push(command); return { ok: true as const }; },
      hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
    } as unknown as PdaRuntimeAdapterDeps["tmux"],
    fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } } },
    stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js", tokenFile: () => tokenFile,
    reserveBinding: (binding, nodeId) => repo.reservePdaLaunch(binding, nodeId),
    newLaunchId: () => "launch-1", sleep: async () => {}, pollMs: 1, launchWaitMs: 5,
    // The runner attaches: the sidecar it would write for this launch, naming the agent the command was typed for.
    now: () => new Date("2026-10-26T09:00:00.000Z"),
  };
  const adapter = new PdaRuntimeAdapter(deps);
  return { adapter, typed };
}

/** Plays the runner for one seat: writes the ready sidecar of launch-1 for the agent named. */
function runnerAttaches(sessionName: string, agent: string, typedBy: { typed: string[] }) {
  const paths = pdaSeatPaths(stateRoot, sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true });
  const at = "2026-10-26T09:00:00.000Z";
  fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
    ready: true, launchId: "launch-1", updatedAt: at, aliveAt: at, agent, baseUrl: PORT, connected: true, busy: false, outboxPending: 0,
  }));
  void typedBy;
}

const nodeBinding = (nodeId: string, sessionName: string, pdaBinding?: { agent: string; baseUrl: string }): NodeBinding => ({
  id: "b", nodeId, tmuxSession: sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
  updatedAt: "", cwd: "/work", ...(pdaBinding ? { pda: pdaBinding } : {}),
});

/** Everything a refusal must leave alone: the whole sessions and nodes tables, byte for byte. */
const snapshot = () => JSON.stringify({
  sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all(),
  nodes: db.prepare("SELECT * FROM nodes ORDER BY id").all(),
});

/** The reported scenario: A (column Y) was pointed by the operator at X; B's column is X. */
function scenario() {
  const a = seat("rig-a", "dev.a", SESSION_A, Y);
  const b = seat("rig-b", "dev.b", SESSION_B, X);
  return { a, b };
}

describe("OF-92: the re-check is against the agent the seat will actually drive", () => {
  it("P1 operator-set token: B's restore onto X is refused once A's token names X, though A's saved binding does not (reported symptom: two seats drive one agent)", async () => {
    const { a, b } = scenario();
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]); // before the operator acts: nobody else holds X
    const set = await operatorSets(SESSION_A, X_TOKEN);
    expect(set.status).toBe(200); // the door still works; this change adds no set-time refusal
    expect(db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(a.sessionId)).toEqual({ resume_type: "pda_agent", resume_token: X_TOKEN });
    expect(repo.getRig(a.rigId)?.nodes.find((n) => n.id === a.nodeId)?.pda).toEqual(Y); // the saved binding still says Y
    const conflicts = repo.findPdaLaunchConflicts(X, b.nodeId);
    expect(conflicts).toHaveLength(1);
    // Both seats are named: the one that cannot take the agent, and the one that holds it.
    expect(conflicts[0]).toContain('seat "dev.b" in rig "rig-b"');
    expect(conflicts[0]).toContain('seat "dev.a" in rig "rig-a"');
    expect(conflicts[0]).toContain('pda agent "research" at http://127.0.0.1:8150');
    expect(conflicts[0]).toContain("that seat's resume token names it"); // says WHY A holds it, though its saved binding is Y
    expect(conflicts[0]).not.toContain("/agents/research"); // never the token itself
  });

  it("P2 fresh launch (binding.pda): refused with 0 keystrokes, both seats named, and nothing changed", async () => {
    const { b } = scenario();
    await operatorSets(SESSION_A, X_TOKEN);
    const before = snapshot();
    const p = pda();
    const result = await p.adapter.launchHarness(nodeBinding(b.nodeId, SESSION_B, X), { name: SESSION_B });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a" in rig "rig-a"') });
    expect((result as { error: string }).error).toContain('seat "dev.b" in rig "rig-b"');
    expect(result).not.toHaveProperty("recovery");
    expect(p.typed).toEqual([]);
    expect(snapshot()).toBe(before);
    expect(fs.existsSync(pdaSeatPaths(stateRoot, SESSION_B).seatRoot)).toBe(false);
  });

  it("P3 restore token: a seat whose own binding is another agent but whose token names the held agent is refused (the token's agent is the one checked)", async () => {
    const { b } = scenario();
    await operatorSets(SESSION_A, X_TOKEN);
    const c = seat("rig-c", "dev.c", "dev-c@rig-c", { agent: "quiet", baseUrl: PORT });
    const p = pda();
    const result = await p.adapter.launchHarness(nodeBinding(c.nodeId, "dev-c@rig-c", { agent: "quiet", baseUrl: PORT }), { name: "dev-c@rig-c", resumeToken: X_TOKEN });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.c" in rig "rig-c"') });
    expect((result as { error: string }).error).toContain('seat "dev.a" in rig "rig-a"');
    expect((result as { error: string }).error).toContain('seat "dev.b" in rig "rig-b"'); // B holds X by its column: both holders are named
    expect(p.typed).toEqual([]);
    void b;
  });

  it("P4 legacy restore (PdaResumeAdapter): refused with attention-free plain failure, nothing typed", async () => {
    const { b } = scenario();
    await operatorSets(SESSION_A, X_TOKEN);
    const p = pda();
    const resume = new PdaResumeAdapter(p.adapter);
    // B restores from a token that names X (its own column agrees); A's token holds X.
    sessions.updateResumeToken(b.sessionId, "pda_agent", X_TOKEN, "scrape");
    const before = snapshot();
    const result = await resume.resume(b.nodeId, SESSION_B, "pda_agent", X_TOKEN, "/work");
    expect(result).toMatchObject({ ok: false, code: "resume_failed", message: expect.stringContaining('seat "dev.a" in rig "rig-a"') });
    expect(p.typed).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("a seat restoring its OWN agent keeps working: A's operator token names zeta and A restores onto zeta (its own token is not a holder)", async () => {
    const { a } = scenario();
    await operatorSets(SESSION_A, Z_TOKEN); // A's operator token is zeta; nobody else holds zeta
    const p = pda();
    runnerAttaches(SESSION_A, "zeta", p);
    const result = await p.adapter.launchHarness(nodeBinding(a.nodeId, SESSION_A, Y), { name: SESSION_A, resumeToken: Z_TOKEN });
    expect(result).toMatchObject({ ok: true, resumeType: "pda_agent", resumeToken: Z_TOKEN });
    expect(p.typed).toHaveLength(1);
  });

  it("a fresh seat creating a new agent keeps working: nothing holds it", async () => {
    scenario();
    const d = seat("rig-d", "dev.d", "dev-d@rig-d", { agent: "brand-new", baseUrl: PORT });
    const p = pda();
    runnerAttaches("dev-d@rig-d", "brand-new", p);
    const result = await p.adapter.launchHarness(nodeBinding(d.nodeId, "dev-d@rig-d", { agent: "brand-new", baseUrl: PORT }), { name: "dev-d@rig-d" });
    expect(result).toMatchObject({ ok: true, resumeToken: `${PORT}/agents/brand-new` });
    expect(p.typed).toHaveLength(1);
  });

  it("P5 records the token it launched: the returned token is the checked target, not the saved column", async () => {
    scenario();
    const c = seat("rig-c", "dev.c", "dev-c@rig-c", { agent: "quiet", baseUrl: PORT });
    const p = pda();
    runnerAttaches("dev-c@rig-c", "zeta", p);
    const result = await p.adapter.launchHarness(nodeBinding(c.nodeId, "dev-c@rig-c", { agent: "quiet", baseUrl: PORT }), { name: "dev-c@rig-c", resumeToken: Z_TOKEN });
    expect(result).toMatchObject({ ok: true, resumeToken: Z_TOKEN }); // zeta, not "quiet"
  });

  it("P6 pda-release touches no token: a release leaves every session's resume type and token as it was, and the holder stays", async () => {
    const { a, b } = scenario();
    await operatorSets(SESSION_A, X_TOKEN);
    const at = new Date().toISOString();
    const paths = pdaSeatPaths(stateRoot, SESSION_A);
    fs.mkdirSync(paths.seatRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
      ready: true, launchId: "l1", updatedAt: at, aliveAt: at, agent: "research", baseUrl: PORT, connected: true, busy: false, outboxPending: 1,
      held: { requestId: "openrig/n/l/1", code: "pda_message_held", at },
    }));
    const tokens = () => JSON.stringify(db.prepare("SELECT id, resume_type, resume_token, resume_provenance FROM sessions ORDER BY id").all());
    const before = tokens();
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("sessionRegistry" as never, sessions as never);
      c.set("rigRepo" as never, repo as never);
      c.set("eventBus" as never, new EventBus(db) as never);
      c.set("runtimeAdapters" as never, { pda: new PdaRuntimeAdapter({ ...(pdaDeps()) }) } as never);
      c.set("terminalBearerToken" as never, "term-token" as never);
      await next();
    });
    hono.route("/api/sessions", sessionAdminRoutes);
    const res = await hono.request(`/api/sessions/${encodeURIComponent(SESSION_A)}/pda-release`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer term-token" }, body: JSON.stringify({ reason: "retry" }),
    });
    expect(res.status).toBe(200);
    expect(tokens()).toBe(before);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1);
    void a;
  });

  it("a holder is counted once: a seat whose column AND token both name the agent is one conflict, not two", () => {
    const { b } = scenario();
    const c = seat("rig-c", "dev.c", "dev-c@rig-c", X);
    sessions.updateResumeToken(c.sessionId, "pda_agent", X_TOKEN, "operator");
    const conflicts = repo.findPdaLaunchConflicts(X, b.nodeId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('seat "dev.c"');
  });
});

describe("OF-92: what does not count as driving the agent", () => {
  it("an archived rig's seat token holds nothing", async () => {
    const { a, b } = scenario();
    await operatorSets(SESSION_A, X_TOKEN);
    repo.archiveRig(a.rigId);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("a seat's token is its latest token-bearing session's: an older session's token that was replaced holds nothing", () => {
    const { a, b } = scenario();
    sessions.updateResumeToken(a.sessionId, "pda_agent", X_TOKEN, "operator");
    // A restarted: a newer session, now carrying zeta. The older row still says X.
    db.prepare("UPDATE sessions SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(a.sessionId);
    const newer = sessions.registerSession(a.nodeId, SESSION_A);
    db.prepare("UPDATE sessions SET created_at = '2026-06-01 00:00:00' WHERE id = ?").run(newer.id);
    sessions.updateResumeToken(newer.id, "pda_agent", Z_TOKEN, "scrape");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
    expect(repo.findPdaLaunchConflicts({ agent: "zeta", baseUrl: PORT }, b.nodeId)).toHaveLength(1);
  });

  it("a newer session with no token does not hide the older session's token (the restore resumes from that token)", () => {
    const { a, b } = scenario();
    sessions.updateResumeToken(a.sessionId, "pda_agent", X_TOKEN, "operator");
    db.prepare("UPDATE sessions SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(a.sessionId);
    const newer = sessions.registerSession(a.nodeId, SESSION_A);
    db.prepare("UPDATE sessions SET created_at = '2026-06-01 00:00:00' WHERE id = ?").run(newer.id);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1);
  });

  it("only a pda_agent token names an agent: the same URL typed as another resume type, or a damaged pda_agent token, holds nothing and does not throw", () => {
    const { a, b } = scenario();
    const c = seat("rig-c", "dev.c", "dev-c@rig-c", Y);
    sessions.updateResumeToken(a.sessionId, "pi_session_file", X_TOKEN, "operator");
    sessions.updateResumeToken(c.sessionId, "pda_agent", "http://127.0.0.1:8150/agents/", "operator");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("the agent is the pair: the same name at another port is not held by the token", () => {
    const { a, b } = scenario();
    sessions.updateResumeToken(a.sessionId, "pda_agent", "http://127.0.0.1:8151/agents/research", "operator");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });
});

function pdaDeps(): PdaRuntimeAdapterDeps {
  return {
    tmux: {} as never, stateRoot, runnerEntryPath: "/x", tokenFile: () => "/nope",
    fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: () => null },
  };
}
