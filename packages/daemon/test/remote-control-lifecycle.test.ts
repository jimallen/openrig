import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// The user-facing promise: a CoS seat declared `remote_control: true` comes back WITH Remote Control
// after `rig down` + `rig up <rig> --existing` (restore) and after rig-here's restore. Restore reads the
// persisted node (via the snapshot), not the spec, so these tests go through the real down -> snapshot
// -> restore chain rather than handing the adapter a pre-built binding.

const token = "00000000-0000-4000-8000-0000000000aa";
const autoScreen = "Restored conversation\n────────────────\n❯ \n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";

describe("restore re-applies --remote-control (pod-aware down/up, real teardown + restore + adapter)", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each([
    ["declared", true, " --remote-control=exec-cos@restore-test"],
    ["not declared", false, ""],
  ])("seat %s -> the restored launch command is exact", async (_label, remoteControl, flag) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("restore-test");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
    const node = rigRepo.addNode(rig.id, "exec.cos", { runtime: "claude-code", podId: "restore-pod", ...(remoteControl ? { remoteControl: true } : {}) });
    new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "auto" }, "fixture", "retained posture");
    const name = "exec-cos@restore-test";
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    let live = true;
    const tmux = {
      hasSession: vi.fn(async () => live),
      probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
      killSession: vi.fn(async () => { live = false; return { ok: true }; }),
      createSession: vi.fn(async () => { live = true; return { ok: true }; }),
      listSessions: vi.fn(async () => live ? [{ name }] : []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => ["%new"].map(id => ({ id, index: 0, cwd: "/", width: 80, height: 24, active: true }))),
      getPanePid: vi.fn(async () => 100),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => autoScreen),
      sendText: vi.fn(async () => ({ ok: true })),
      sendShellCommand: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    const startedAt = "Thu Oct  1 05:53:16 2026";
    const listProcesses = async () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /tmp/fixture-launch.txt", startedAt },
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude.exe --permission-mode auto${flag} --resume ${token} --name ${name}`, startedAt },
    ];
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
    expect(down.errors).toEqual([]);
    const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
      claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch,
      fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux),
      codexResume: new CodexResumeAdapter(tmux), listProcesses });
    const up = await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
    if (!up.ok) throw new Error(up.message);
    expect(up.result.nodes[0]).toMatchObject({ status: "resumed" });
    expect(tmux.sendShellCommand).toHaveBeenCalledExactlyOnceWith(name, `claude --permission-mode auto${flag} --resume ${token} --name ${name}`, expect.any(Function));
  });
});

describe("legacy (non-pod) restore passes the persisted declaration to the resume adapter", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each([[true], [false]])("remote_control=%s", async (remoteControl) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "cos", { runtime: "claude-code", cwd: "/workspace", ...(remoteControl ? { remoteControl: true } : {}) });
    const session = sessionRegistry.registerSession(node.id, "cos@legacy-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-1' WHERE id = ?").run(session.id);
    const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
    const claudeResume = { canResume: vi.fn(() => true), resume: vi.fn(async () => ({ ok: true, code: "resumed" })) } as unknown as ClaudeResumeAdapter;
    const codexResume = { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter;
    const tmux = {
      createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []), getPaneCommand: vi.fn(async () => "claude"),
    } as unknown as TmuxAdapter;
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher, tmuxAdapter: tmux, claudeResume, codexResume });
    expect((await restore.restore(snapshot.id)).ok).toBe(true);
    const calls = (claudeResume.resume as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    // (sessionName, resumeType, resumeToken, cwd, posture, model, permissionMode, nodeId, ...tail)
    const tail = calls[0]!.slice(8);
    // Today's tail for this seat is [effort=null, nonInterruptive=false, kernelAuthority=false,
    // teamPermissionDefault=true] (a seat with no policy gets the team default). Declared: that tail
    // plus remoteControl=true in the 5th slot. Not declared: EXACTLY today's call, nothing appended.
    expect(tail).toEqual(remoteControl ? [null, false, false, true, true] : [null, false, false, true]);
  });
});

// Anti-increment fence, same idea as model-fidelity-enumeration-guard.test.ts: the census of claude
// seat-launch builders is pinned by source, so a NEW launch template that forgets the flag fails here.
describe("enumeration guard: every claude seat-launch builder threads remote_control", () => {
  const SRC = nodePath.resolve(fileURLToPath(import.meta.url), "../../src");
  const read = (rel: string) => readFileSync(nodePath.join(SRC, rel), "utf-8");
  const allSrcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? allSrcFiles(nodePath.join(dir, e.name)) : e.name.endsWith(".ts") ? [nodePath.join(dir, e.name)] : []);

  it("claude-code-adapter: all 3 shell templates and both managed argv builders carry the fragment", () => {
    const src = read("adapters/claude-code-adapter.ts");
    const templates = [...src.matchAll(/`(?:\$\{claudeResumeLaunchPrefix\([^)]*\)\})?(?:\$\{rendererPrefix\})?claude \$\{[^`]*`/g)].map(m => m[0])
      .filter(t => /--resume|--session-id|--fork-session/.test(t));
    expect(templates).toHaveLength(3);
    for (const t of templates) expect(t, `shell template must thread remoteControlArg:\n${t}`).toContain("${remoteControlArg}");
    // Managed argv builders: fork, and the one shared by resume + fresh (a ternary on resumeToken).
    // Every one spreads the fragment: as many spreads as builders.
    expect(src.match(/managed\.command\(\[/g)).toHaveLength(2);
    expect(src.match(/\.\.\.remoteControlArgv/g)).toHaveLength(2);
  });

  it("claude-resume (restore): the shell template and the managed argv both carry the fragment", () => {
    const src = read("adapters/claude-resume.ts");
    const template = src.match(/`\$\{claudeResumeLaunchPrefix[^`]*`/)?.[0] ?? "";
    expect(template).toContain("claudeRemoteControlArg(remoteControl, tmuxSessionName)");
    expect(src.match(/managed\.command\(\[/g)).toHaveLength(1);
    expect(src.match(/\.\.\.claudeRemoteControlArgs\(remoteControl, tmuxSessionName\)/g)).toHaveLength(1);
  });

  it("the helper emits ONLY the `=` form (a separate-argument name starting with `-` is parsed as an unknown option)", () => {
    const helper = read("adapters/claude-remote-control.ts");
    expect(helper).toContain('["--remote-control=" + sessionName.trim()]');
    expect(helper).toContain("shellQuote(`--remote-control=${sessionName.trim()}`)");
    expect(helper).not.toMatch(/"--remote-control",/);
    expect(helper).not.toMatch(/--remote-control \$\{/);
  });

  it("handover: lookupNode SELECTs remote_control AND the successor binding carries it (same fence as model/effort)", () => {
    const handover = read("domain/seat-handover-service.ts");
    expect(handover).toMatch(/SELECT id, runtime, cwd, model, codex_config_profile, effort, remote_control FROM nodes/);
    expect(handover).toMatch(/node\.remote_control === 1 \? \{ remoteControl: true \}/);
    const launcher = read("domain/successor-session-launcher.ts");
    expect(launcher).toMatch(/remoteControl\?: boolean;/);
    expect(launcher).toMatch(/node\.remoteControl \? \{ remoteControl: true \}/);
  });

  it("exactly these source files build or spawn a `claude` command (positive control: both builders are found)", () => {
    // A claude launch template or spawn array in NON-comment code. It does not depend on what flags the
    // template carries: a new launcher that omits --permission-mode is still caught.
    const LAUNCH = /`[^`]*\bclaude (?:\$\{|--)[^`]*`|"claude",\s*\[|\bclaude\s*\$\{/;
    const code = (text: string) => text.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const launchers = allSrcFiles(SRC).filter(f => code(readFileSync(f, "utf-8")).split("\n").some(l => LAUNCH.test(l)))
      .map(f => nodePath.relative(SRC, f)).sort();
    // The two seat-launch builders (every emission site is pinned above), plus two named non-launchers:
    // native-resume-probe.ts builds the operator-facing `claude --resume` text and the resume-metadata
    // probe's throwaway command (deliberately WITHOUT the flag: a probe would register a second remote
    // session), and permission-drift-observer.ts runs `claude --help`. native-process-lineage.ts only
    // PARSES a running claude's argv (it skips `--remote-control[=name]`), so it is not a builder.
    expect(launchers).toEqual([
      "adapters/claude-code-adapter.ts",
      "adapters/claude-resume.ts",
      "domain/native-resume-probe.ts",
      "domain/permission-drift-observer.ts",
    ]);
  });
});
