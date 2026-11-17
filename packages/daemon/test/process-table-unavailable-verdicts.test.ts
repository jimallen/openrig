// workspaces-o9o.67 (review, verify-qa2): a process table that cannot be read is "unavailable", never "no processes".
// Before, listNativeProcesses turned any read failure into [], and SeatIdentityReconciler then wrote a DURABLE mismatch
// (process_identity_ambiguous) for a live Codex seat; and a hung `ps` left every lister pending forever. These rows drive
// the real default listers against a hermetic `ps` on an otherwise empty PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import * as lineage from "../src/domain/native-process-lineage.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";
import { defaultResolveHomeDirByPid } from "../src/domain/codex-thread-id.js";
import { defaultListProcesses as codexDefaultListProcesses } from "../src/adapters/codex-runtime-adapter.js";

const NOW = () => new Date("2026-11-17T01:00:00Z");
let scratch: string | undefined;
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A `ps` on an otherwise empty PATH running `body` (sh). */
function installPs(body: string): void {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o9o67-unavail-"));
  fs.writeFileSync(path.join(scratch, "ps"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
}

// The same seat shape as seat-identity-reconciler.test.ts seedSeat.
function seat(db: Database.Database, nodeId: string, runtime: "codex" | "claude-code", resumeToken: string | null): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(`rig-${nodeId}`, "test-rig");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, ?)").run(nodeId, `rig-${nodeId}`, `pod.${nodeId}`, runtime, "/tmp");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)")
    .run(`sess-${nodeId}`, nodeId, `${nodeId}@rig`, "running", "ready");
  if (resumeToken !== null) db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run(resumeToken, `sess-${nodeId}`);
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, ?, ?, ?)")
    .run(`bind-${nodeId}`, nodeId, "tmux", `${nodeId}@rig`, `%${nodeId}`);
}

function tmux(command: string): Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand"> {
  return {
    listSessions: vi.fn(async () => [{ name: "c1@rig" }, { name: "k1@rig" }] as never),
    getPanePid: vi.fn(async () => 4242),
    getPaneCommand: vi.fn(async () => command),
  };
}

describe("o9o.67 review: an unreadable process table never becomes a false identity verdict", () => {
  it("a live Codex seat gets process_table_unavailable, never a mismatch, when ps exits 1", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installPs("echo 'fixture ps failure' >&2\nexit 1");
    const db = createFullTestDb(); dbs.push(db);
    seat(db, "c1", "codex", "thread-1");
    await new SeatIdentityReconciler({ db, tmux: tmux("codex"), now: NOW }).reconcileAll();
    const verdict = new SeatIdentityStore(db).getForNode("c1");
    expect(verdict?.verdict).toBe("process_table_unavailable");
    expect(verdict?.reason).toBe("process_table_unavailable");
  });

  it("a live Claude seat with a stored conversation behind a shell gets process_table_unavailable, never a mismatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installPs("exit 1");
    const db = createFullTestDb(); dbs.push(db);
    seat(db, "k1", "claude-code", "conv-1");
    await new SeatIdentityReconciler({ db, tmux: tmux("bash"), now: NOW }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("k1")?.verdict).toBe("process_table_unavailable");
  });

  it("the same seat with a readable table that lacks its process is still a mismatch (the unavailable path is not a blanket pass)", async () => {
    installPs("echo 'PID PPID PGID TPGID UCOMM STARTED COMMAND'\necho '1 0 1 -1 init Mon Nov 16 22:00:00 2026 /sbin/init'");
    const db = createFullTestDb(); dbs.push(db);
    seat(db, "c1", "codex", "thread-1");
    await new SeatIdentityReconciler({ db, tmux: tmux("codex"), now: NOW }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("c1")?.verdict).toBe("mismatch");
  });
});

describe("o9o.67 review: the attention rebind records unavailable, never mismatch, on an unreadable table", () => {
  async function rebind(runtime: "codex" | "claude-code", command: string, strict: boolean) {
    const db = createFullTestDb(); dbs.push(db);
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = repo.createRig("o9o67"), name = "worker@o9o67";
    const node = repo.addNode(rig.id, "worker", { role: "worker", runtime });
    registry.registerSession(node.id, name);
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%67" });
    const tmux = { listSessions: vi.fn(async () => [{ name }] as never), listPanes: vi.fn(async () => [{ id: "%67" }] as never),
      getPanePid: vi.fn(async () => 4242), getPaneCommand: vi.fn(async () => command) };
    const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id, sessionName: name, runtime,
      expectedResumeToken: "conv-1", ...(strict ? { requireExactResumeLineage: true } : {}) });
    return { result, verdict: new SeatIdentityStore(db).getForNode(node.id) };
  }

  it.each([
    ["codex", "codex", false],
    ["claude-code", "bash", false],
    ["claude-code", "claude", true],
  ] as const)("%s behind %s (strict=%s): process_table_unavailable and an honest refusal when ps exits 1", async (runtime, command, strict) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installPs("exit 1");
    const { result, verdict } = await rebind(runtime, command, strict);
    expect(verdict?.verdict).toBe("process_table_unavailable");
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("process table could not be read") });
  });
});

describe("o9o.67 review: the two consumers that read [] as unknown keep today's behaviour", () => {
  it("the Codex runtime adapter's default lister (fresh thread-id capture) answers [] rather than failing a launch that ran", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installPs("echo 'codex capture fixture' >&2\nexit 1"); // its own reason: the warning is logged once per reason
    expect(await codexDefaultListProcesses()).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("could not read the process table"))).toBe(true);
  });
});

describe("o9o.67 review: a hung ps settles within the timeout", () => {
  it("readProcessTable kills a ps that never exits once its timeout passes", async () => {
    installPs("exec /bin/sleep 60");
    const started = Date.now();
    await expect(lineage.readProcessTable(["-A"], { timeoutMs: 200 })).rejects.toThrow(/killed \(SIGKILL\)/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the default bound is finite and no longer than the native inbox's 10 s", () => {
    expect(lineage.PROCESS_TABLE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(lineage.PROCESS_TABLE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("both default listers and the per-pid ps eww read settle by their default bounds against a ps that hangs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installPs("exec /bin/sleep 60");
    const started = Date.now();
    const [native, strict, home] = await Promise.allSettled([
      lineage.listNativeProcesses(), defaultListProcessesStrict(), defaultResolveHomeDirByPid(4242),
    ]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(native.status).toBe("rejected");
    expect((native as PromiseRejectedResult).reason).toBeInstanceOf(lineage.ProcessTableUnavailableError);
    expect(strict.status).toBe("rejected");
    expect(home).toEqual({ status: "fulfilled", value: undefined });
  }, 20_000);
});
