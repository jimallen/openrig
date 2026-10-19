import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { freshSeatLaunchCommand } from "../src/domain/active-occupant.js";

const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** A rig of two seats: `dev.worker` HAD a session (so a restore stops for a decision when it has no token) and
 *  `dev.newcomer` never ran (so the same restore fresh-primes it, leaving a live sibling). */
function fixture(opts: { token?: string | null; policy?: string; nodePolicy?: string; withSibling?: boolean; occupied?: boolean } = {}) {
  const db = createFullTestDb(); databases.push(db);
  const live = new Set<string>();
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    createSession: vi.fn(async (name: string) => { live.add(name); return { ok: true }; }),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true }; }),
    listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%fixture", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    setSessionOption: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const setup = createTestApp(db, { tmux, wireRuntimeAdapters: true, listProcesses: async () => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "bash", command: "-bash", startedAt: "Sat Oct 10 20:00:00 2026" },
  ] });
  const { rigRepo, sessionRegistry, snapshotCapture } = setup;
  const rig = rigRepo.createRig("advice-rig");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "Dev");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "claude-code", podId: "pod", cwd: "/tmp", ...(opts.nodePolicy ? { restorePolicy: opts.nodePolicy } : {}) });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
  const row = sessionRegistry.registerSession(node.id, "dev-worker@advice-rig");
  // `occupied`: the seat's session was running when the snapshot was taken, so restore resolves it as the occupant.
  sessionRegistry.updateStatus(row.id, opts.occupied ? "running" : "exited");
  sessionRegistry.updateStartupStatus(row.id, "ready");
  if (opts.token !== null) sessionRegistry.updateResumeToken(row.id, "claude_id", opts.token ?? "00000000-0000-4000-8000-000000000005", "hook");
  if (opts.policy) db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?").run(opts.policy, row.id);
  let peer: { id: string } | null = null;
  if (opts.withSibling !== false) {
    peer = rigRepo.addNode(rig.id, "dev.newcomer", { runtime: "claude-code", podId: "pod", cwd: "/tmp" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(peer.id);
  }
  const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
  if (opts.occupied) sessionRegistry.updateStatus(row.id, "exited");
  const post = (path: string, body: unknown = {}) => setup.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...setup, db, tmux, rig, node, peer, snapshot, post, live };
}

/** The advised command, as the operator would copy it: everything from `rig seat launch` to the end of the reason. */
function advisedCommand(text: string): string | null {
  return /rig seat launch '[^']+' --fresh --reason "<why>"/.exec(text)?.[0] ?? null;
}

/** Execute an advised `rig seat launch '<ref>' --fresh --reason "<why>"` the way the CLI does: the ref is the first
 *  quoted word, and the CLI posts `{fresh, reason}` to `/api/seat/launch/<encoded ref>`. */
async function executeAdvised(h: ReturnType<typeof fixture>, command: string) {
  const ref = /rig seat launch '([^']+)' --fresh --reason "<why>"/.exec(command)![1]!;
  return h.post(`/api/seat/launch/${encodeURIComponent(ref)}`, { fresh: true, reason: "pinned advice executes" });
}

describe("every fresh-start suggestion is a command that works in the state it is printed in", () => {
  it("shared builder: quotes the seat ref and names the per-seat door, never `rig up`", () => {
    expect(freshSeatLaunchCommand("operator.human", "kernel")).toBe(`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`);
    expect(freshSeatLaunchCommand("a'b", "r")).toBe(`rig seat launch 'a'"'"'b@r' --fresh --reason "<why>"`);
  });

  it("restore stops a seat with no token while its sibling is live: the advice launches that seat; the old `rig up --fresh` advice is refused", async () => {
    const h = fixture({ token: null, occupied: true });
    const up = await (await h.post(`/api/rigs/${h.rig.id}/up`)).json();
    const held = up.nodes.find((n: any) => n.nodeId === h.node.id);
    const sibling = up.nodes.find((n: any) => n.nodeId === h.peer!.id);
    expect(held.status).toBe("awaiting-decision");
    // The state the operator was in: a sibling is live, so whole-rig restore (with or without --fresh) is refused.
    expect(sibling.status).toBe("fresh-primed");
    const retry = await h.post("/api/up", { sourceRef: h.rig.name, existing: true, freshLogicalIds: [h.node.logicalId] });
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("rig_not_stopped");
    // The message names the command that does work, and it does.
    expect(held.error).not.toMatch(/Re-run with --fresh/);
    const command = advisedCommand(held.error);
    expect(command, held.error).toBe(`rig seat launch 'dev.worker@advice-rig' --fresh --reason "<why>"`);
    const launched = await executeAdvised(h, command!);
    expect(launched.status).toBe(200);
    expect((await launched.json()).ok).toBe(true);
  });

  it("restore stops a seat whose runtime adapter is missing: the advice launches that seat", async () => {
    const h = fixture({ withSibling: false, occupied: true });
    const result = await h.restoreOrchestrator.restore(h.snapshot.id, { adapters: {} });
    expect(result.ok).toBe(true);
    const held = (result as any).result.nodes.find((n: any) => n.logicalId === "dev.worker");
    expect(held.status).toBe("awaiting-decision");
    expect(held.error).toMatch(/no claude-code adapter available/);
    expect(held.error).not.toMatch(/Re-run with --fresh/);
    const command = advisedCommand(held.error);
    expect(command, held.error).toBe(`rig seat launch 'dev.worker@advice-rig' --fresh --reason "<why>"`);
    const launched = await executeAdvised(h, command!);
    expect(launched.status).toBe(200);
  });

  // The rest of the daemon's stop-for-decision messages sit on resume-failure paths the fakes here cannot drive
  // (a resume that concludes failed, a runtime that reports fresh continuity, a defence-in-depth no-token check).
  // They are pinned by census instead: every `--fresh` suggestion in the orchestrator is built by the one builder.
  it("census: no restore-orchestrator message tells the operator to re-run `--fresh` through `rig up`", () => {
    const source = readFileSync(new URL("../src/domain/restore-orchestrator.ts", import.meta.url), "utf8");
    // Positional predicate: every awaiting-decision message opens with the same fixed words.
    const messages = source.split("\n").filter((line) => line.includes("Original session unresumable"));
    expect(messages.length, "positive control: the population is the 7 stop-for-decision messages at e493aa62").toBe(7);
    for (const line of messages) {
      expect(line, line).not.toMatch(/Re-run with --fresh/);
      expect(line, line).toMatch(/this\.freshStartCommand\(rigId, data, node\.logicalId\)/);
    }
  });
});

describe("a terminal seat's restore policy survives a restart (operator.human@kernel)", () => {
  it("a new occupant inherits its seat's restore policy instead of the column default", () => {
    const h = fixture({ nodePolicy: "checkpoint_only", withSibling: false });
    const next = h.sessionRegistry.registerSession(h.node.id, "dev-worker@advice-rig");
    const stored = h.db.prepare("SELECT restore_policy FROM sessions WHERE id = ?").get(next.id) as { restore_policy: string };
    expect(stored.restore_policy).toBe("checkpoint_only");
    const plain = fixture({ withSibling: false });
    const plainNext = plain.sessionRegistry.registerSession(plain.node.id, "dev-worker@advice-rig");
    expect((plain.db.prepare("SELECT restore_policy FROM sessions WHERE id = ?").get(plainNext.id) as { restore_policy: string }).restore_policy).toBe("resume_if_possible");
  });

  it("a checkpoint_only seat with a token-less history restarts fresh-primed, not awaiting-decision, on every restore", async () => {
    // The seat's session row is written by registerSession, exactly as a restart writes it (the fixture applies no
    // policy of its own). A terminal seat never has a resume token.
    const h = fixture({ nodePolicy: "checkpoint_only", token: null, occupied: true });
    const up = await (await h.post(`/api/rigs/${h.rig.id}/up`)).json();
    expect(up.nodes.find((n: any) => n.nodeId === h.node.id)?.status).toBe("fresh-primed");
  });
});
