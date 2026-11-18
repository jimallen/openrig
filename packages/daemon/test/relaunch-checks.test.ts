// workspaces-o9o.8: `rig seat launch --fresh --stop` checks, before it stops anything, what operators checked by hand (openrig-23, Jim's go
// 2026-11-16): (a) a lease a seat's own work holds (a UI test host, say), (b) processes the seat's agent is still running, other than MCP
// servers, language servers and caffeinate, and (c) the seat's handover file, whose time is when the old occupant last wrote down what it
// knew. A stop under (a) or (b) leaves the lease held for every other seat, or orphans writing into the worktree. A held check refuses the
// launch unless the operator names it with --despite; a check it cannot read only warns, so a broken seat can still be recovered.
//
// The real SeatLifecycleService.launchFresh runs here, as in relaunch-message-race.test.ts: tmux is a fake that stops and starts sessions in
// memory, the process table and the seat's leases and folder are fakes of their ports.
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { MessageHandOff } from "../src/domain/seat-messaging/hand-off.js";
import type { MessageAcceptInput } from "../src/domain/seat-messaging/message-store.js";
import type { RelaunchCheckPort, SeatLeaseObservation } from "../src/domain/relaunch-checks.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";
import { mcpTrustFixture } from "./helpers/mcp-trust-fixture.js";

const SEAT = "dev-impl@checks-rig";
const PANE_PID = 4242;
const STARTED = "Sat Jan  1 12:00:00 2000";

function row(pid: number, ppid: number, executableName: string, command: string): NativeProcessRow {
  return { pid, ppid, pgid: PANE_PID, tpgid: PANE_PID, executableName, command, startedAt: STARTED };
}

const AGENT = row(PANE_PID, 1, "claude", "claude --session-id fresh-native-uuid");

describe("o9o.8: rig seat launch --fresh --stop checks the seat's leases, its agent's children and its handover file", () => {
  let db: Database.Database;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let service: SeatLifecycleService;
  let seatDir: string;
  let processes: NativeProcessRow[];
  let leases: SeatLeaseObservation[] | Error;
  let accepted: MessageAcceptInput[];
  let folderError: Error | null;
  let nodeId: string;
  let rigId: string;
  let deps: ConstructorParameters<typeof SeatLifecycleService>[0];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    seatDir = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), "o9o8-seat-"));
    alive = new Set();
    processes = [AGENT];
    leases = [];
    accepted = [];
    folderError = null;
    tmux = Object.assign(mockTmuxAdapter(), {
      createSession: vi.fn(async (name: string) => { alive.add(name); return { ok: true as const }; }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => (alive.has(name) ? { state: "present" as const } : { state: "absent" as const })),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => (alive.has(name) ? [{ id: "%1", index: 0, cwd: seatDir, width: 80, height: 24, active: true }] : [])),
      getPanePid: vi.fn(async (): Promise<number | null> => PANE_PID),
      getPaneCommand: vi.fn(async () => "claude"),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    });
    const handOff: Pick<MessageHandOff, "takes" | "accept" | "handOverFromRetiringOccupant" | "holdContentLane"> = {
      takes: () => true,
      accept: (input) => { accepted.push(input); return { kind: "accepted", id: input.id }; },
      handOverFromRetiringOccupant: () => ({ carried: [], reissued: [], notHandedOver: [] }),
      holdContentLane: () => () => undefined,
    };
    tmux.messageHandOff = handOff as MessageHandOff;
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "fresh-native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    const relaunchChecks: RelaunchCheckPort = {
      leases: () => { if (leases instanceof Error) throw leases; return leases; },
      folderFiles: (dir: string) => { if (folderError) throw folderError; return fs.readdirSync(dir).map((name) => ({ name, modifiedAt: fs.statSync(nodePath.join(dir, name)).mtime.toISOString() })); },
    };
    deps = {
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
      listProcesses: async () => processes,
      nodeLauncher: new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined }),
      runtimeAdapters: { "claude-code": adapter, pi: { ...adapter, runtime: "pi" } },
      relaunchChecks,
    };
    service = new SeatLifecycleService(deps);

    const rig = rigRepo.createRig("checks-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: seatDir, model: "claude-current" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%1" });
    alive.add(SEAT);
    // The retiring occupant's tenure began at 08:30Z on the 16th; a handover written before that is an earlier tenure's.
    const tenure = sessionRegistry.mintOccupantTenure(node.id, "fresh");
    db.prepare("UPDATE occupant_tenures SET boot_at = '2026-11-16 08:30:00' WHERE id = ?").run(tenure.id);
    nodeId = node.id;
    rigId = rig.id;
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
  });
  afterEach(() => { db.close(); fs.rmSync(seatDir, { recursive: true, force: true }); });

  const relaunch = (extra: { despite?: Array<"lease" | "children">; handOverSince?: string } = {}) =>
    service.launchFresh({ seatRef: SEAT, fresh: true, stop: true, reason: "relaunch checks", ...extra });
  const writeHandover = (name: string, iso: string): string => {
    const path = nodePath.join(seatDir, name);
    fs.writeFileSync(path, "what I knew\n");
    fs.utimesSync(path, new Date(iso), new Date(iso));
    return path;
  };

  // (a) leases
  it("lease: a live lease on the seat refuses the launch before the old occupant is stopped, naming holder and pid", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, reason: "UI tests on the shared host", liveness: "alive" }];
    const result = await relaunch();
    expect(result).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(result.ok ? "" : result.message).toContain("ui-test-host");
    expect(result.ok ? "" : result.message).toContain("9001");
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(alive.has(SEAT)).toBe(true);
  });

  it("lease: a lease whose holder process is gone is stale; the launch goes ahead and names it", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "gone" }];
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.lease).toMatchObject({ verdict: "clear", stale: [{ holder: "ui-test-host", pid: 9001 }] });
  });

  it("lease: --despite lease goes ahead with the lease held, and the launch event records it", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    const result = await relaunch({ despite: ["lease"] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.lease).toMatchObject({ verdict: "held", overridden: true });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ despite: ["lease"] });
  });

  it("lease: --despite children does not cover a held lease", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    const result = await relaunch({ despite: ["children"] });
    expect(result).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("lease: unreadable leases warn and do not refuse", async () => {
    leases = new Error("EACCES");
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.lease).toMatchObject({ verdict: "unknown" });
    expect(result.ok && result.warnings?.join("\n")).toContain("lease");
  });

  // (b) the agent's children
  it("children: a build the agent is running refuses the launch before the old occupant is stopped, naming its pid", async () => {
    processes = [AGENT, row(5001, PANE_PID, "zsh", "/bin/zsh -c npm test"), row(5002, 5001, "node", "node vitest run")];
    const result = await relaunch();
    expect(result).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(result.ok ? "" : result.message).toContain("5001");
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("children: caffeinate, an MCP server and a language server are expected and do not refuse", async () => {
    processes = [AGENT,
      row(5001, PANE_PID, "caffeinate", "caffeinate -i"),
      row(5002, PANE_PID, "node", "node /opt/servers/context7-mcp/dist/index.js"),
      row(5003, PANE_PID, "node", "node /usr/lib/node_modules/typescript-language-server/lib/cli.mjs --stdio")];
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.children).toMatchObject({
      verdict: "clear", ignored: [{ pid: 5001, kind: "caffeinate" }, { pid: 5002, kind: "mcp_server" }, { pid: 5003, kind: "language_server" }],
    });
  });

  it("children: --despite children goes ahead", async () => {
    processes = [AGENT, row(5001, PANE_PID, "zsh", "/bin/zsh -c npm test")];
    const result = await relaunch({ despite: ["children"] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.children).toMatchObject({ verdict: "held", overridden: true });
  });

  it("children: a pane pid that cannot be read warns and does not refuse", async () => {
    vi.mocked(tmux.getPanePid).mockResolvedValueOnce(null);  // the check's read only; the launch's own identity check reads it again
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.children).toMatchObject({ verdict: "unknown" });
  });

  it("children: a process outside the seat's pane is not the seat's", async () => {
    processes = [AGENT, row(6001, 1, "zsh", "/bin/zsh -c npm test")];
    const result = await relaunch();
    expect(result.ok).toBe(true);
  });

  // (c) the handover file's time
  it("handover: the newest HANDOVER*.md in the seat's folder sets the since-time when it is earlier than the launch, and is named", async () => {
    writeHandover("HANDOVER-2026-11-14.md", "2026-11-14T10:00:00.000Z");
    const newest = writeHandover("HANDOVER-2026-11-16-notes.md", "2026-11-16T09:00:00.000Z");
    writeHandover("NOTES.md", "2026-11-16T09:30:00.000Z");
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.handOver).toMatchObject({ since: "2026-11-16T09:00:00.000Z", sinceSource: "handover_file", handoverFile: newest });
  });

  it("handover: an operator's --hand-over-since earlier than the handover file wins", async () => {
    writeHandover("HANDOVER.md", "2026-11-16T09:00:00.000Z");
    const result = await relaunch({ handOverSince: "2026-11-16T08:00:00Z" });
    expect(result.ok && result.handOver).toMatchObject({ since: "2026-11-16T08:00:00.000Z", sinceSource: "hand_over_since" });
  });

  // workspaces-o9o.94 (release 5 on stu): an operator's --hand-over-since LATER than the seat's handover file lost to the file,
  // which re-delivered 144 two-day-old messages to a fresh seat. An explicit time wins in both directions; the file only sets
  // the default, and the result names it and its time so the CLI can say it was not used.
  it("handover: an operator's --hand-over-since LATER than the handover file wins, and the file and its time are named", async () => {
    const path = writeHandover("HANDOVER.md", "2026-11-16T09:00:00.000Z");
    const asked: string[] = [];
    const handOff = tmux.messageHandOff as MessageHandOff;
    handOff.handOverFromRetiringOccupant = ((_seat: string, since: string) => { asked.push(since); return { carried: [], reissued: [], notHandedOver: [] }; }) as MessageHandOff["handOverFromRetiringOccupant"];
    const result = await relaunch({ handOverSince: "2026-11-16T09:30:00Z" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.handOver).toMatchObject({
      since: "2026-11-16T09:30:00.000Z", sinceSource: "hand_over_since", handoverFile: path, handoverFileWrittenAt: "2026-11-16T09:00:00.000Z",
    });
    expect(asked).toEqual(["2026-11-16T09:30:00.000Z"]);
  });

  // (d) the fresh occupant is handed its predecessor's handover path
  it("handover: the fresh occupant is told where its predecessor's handover is, bound to its own generation", async () => {
    const path = writeHandover("HANDOVER.md", "2026-11-16T09:00:00.000Z");
    const result = await relaunch();
    expect(result.ok).toBe(true);
    const pointer = accepted.filter((message) => message.body.includes(path));
    expect(pointer).toHaveLength(1);
    expect(pointer[0]).toMatchObject({ seat: SEAT, occupantGeneration: result.ok ? result.generation : "none" });
  });

  it("handover: no handover file, no pointer message", async () => {
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(accepted.filter((message) => message.body.includes("handover"))).toEqual([]);
  });

  // verify-qa FAIL attempt 1 (o9o.8), one row per finding.
  it("finding 1: a build whose arguments mention mcp is the agent's work, not an MCP server", async () => {
    processes = [AGENT, row(5001, PANE_PID, "node", "node ./scripts/build --suite mcp-smoke")];
    const result = await relaunch();
    expect(result).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(result.ok ? "" : result.message).toContain("5001");
  });

  it("finding 2: on a Pi seat, OpenRig's runner and the pi it spawns are the agent, not its work", async () => {
    db.prepare("UPDATE nodes SET runtime = 'pi' WHERE id = ?").run(nodeId);
    db.prepare("UPDATE node_startup_context SET runtime = 'pi' WHERE node_id = ?").run(nodeId);
    processes = [row(PANE_PID, 1, "node", "node /usr/lib/node_modules/@openrig/cli/daemon/dist/adapters/pi-runner.js --session-name dev-impl@checks-rig"),
      row(5001, PANE_PID, "pi", "pi")];
    const plan = await service.planFresh({ seatRef: SEAT, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, relaunchChecks: { children: { verdict: "clear" } } });
  });

  it("finding 3: a lease whose holder cannot be told apart from a reused pid warns and does not refuse", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "unknown" }];
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.lease).toMatchObject({ verdict: "unknown" });
    expect(result.ok && result.warnings?.join("\n")).toContain("ui-test-host (pid 9001)");
  });

  it("finding 4: a handover written before the retiring occupant's tenure began is an earlier tenure's: not used, named in a warning", async () => {
    const old = writeHandover("HANDOVER.md", "2026-11-16T08:00:00.000Z");
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.handOver).toMatchObject({ sinceSource: "launch_began" });
    expect(result.ok && result.handOver?.handoverFile).toBeUndefined();
    expect(accepted.filter((message) => message.body.includes(old))).toEqual([]);
    expect(result.ok && result.warnings?.join("\n")).toContain(`${old} was not used`);
  });

  it("finding 4: with no recorded tenure the handover cannot be shown to be the retiring occupant's: not used, named in a warning", async () => {
    db.prepare("DELETE FROM occupant_tenures WHERE node_id = ?").run(nodeId);
    const file = writeHandover("HANDOVER.md", "2026-11-16T09:00:00.000Z");
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.handOver).toMatchObject({ sinceSource: "launch_began" });
    expect(result.ok && result.warnings?.join("\n")).toContain(`${file} was not used`);
  });

  it("finding 5: a seat folder that cannot be read warns, and the launch goes on without a handover", async () => {
    folderError = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
    const result = await relaunch();
    expect(result.ok).toBe(true);
    expect(result.ok && result.handOver).toMatchObject({ sinceSource: "launch_began" });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be looked for");
  });

  it("finding 6: the process table is read only through the service's process-lister port", async () => {
    const { listProcesses: _unused, ...withoutLister } = deps;
    void _unused;
    const unwired = new SeatLifecycleService(withoutLister);
    const plan = await unwired.planFresh({ seatRef: SEAT, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, relaunchChecks: { children: { verdict: "unknown", cause: "this daemon has no process lister wired" } } });
  });

  // workspaces-o9o.71: the TUI's explicit fresh action launches a seat whose pane it observed stopped (launchFresh stop:false). Nothing is
  // stopped there, but a lease the seat's work still holds is still held: the lease check runs on every fresh launch. The children check
  // needs a live agent, so with no pane it does not apply (and says so, without a warning).
  const freshOfStoppedPane = (extra: { despite?: Array<"lease" | "children"> } = {}) =>
    service.launchFresh({ seatRef: SEAT, fresh: true, stop: false, reason: "TUI explicit fresh consent", ...extra });

  it("o9o.71: a fresh launch of a seat whose pane is gone refuses under a live lease, before anything is cleaned or started", async () => {
    alive.delete(SEAT);
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    const result = await freshOfStoppedPane();
    expect(result).toMatchObject({ ok: false, code: "relaunch_check_held" });
    expect(result.ok ? "" : result.message).toContain("ui-test-host (pid 9001)");
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("o9o.71: with no live lease the stopped-pane fresh launch goes ahead; the children check does not apply and warns nothing", async () => {
    alive.delete(SEAT);
    const result = await freshOfStoppedPane();
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks).toMatchObject({ lease: { verdict: "clear" }, children: { verdict: "not_applicable" } });
    expect(result.ok && (result.warnings ?? []).join("\n")).not.toContain("Relaunch check children");
  });

  it("o9o.71: --despite lease launches the stopped-pane seat anyway", async () => {
    alive.delete(SEAT);
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    const result = await freshOfStoppedPane({ despite: ["lease"] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.relaunchChecks?.lease).toMatchObject({ verdict: "held", overridden: true });
  });

  it("o9o.71: --plan of a seat whose pane is gone shows a live lease as a blocker", async () => {
    alive.delete(SEAT);
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    const plan = await service.planFresh({ seatRef: SEAT, fresh: true });
    expect(plan).toMatchObject({ ok: true, launchable: false, relaunchChecks: { lease: { verdict: "held" }, children: { verdict: "not_applicable" } } });
    expect(plan.ok && plan.blockers.map((b) => b.code)).toContain("relaunch_check_held");
  });

  // workspaces-o9o.64: the seat's spec overrides the defaults, read at launch through the trusted read of the rig's recorded spec source.
  /** The rig records a spec source declaring this seat with `relaunch` under the member; the service is the daemon's (trust anchored).
   *  Its launches replay the stored startup files (`--startup-from stored`): where startup files come from is not what these rows test. */
  function withSeatSpec(relaunch: string): { service: SeatLifecycleService; specPath: string; cleanup: () => void } {
    const trust = mcpTrustFixture("o9o64");
    fs.mkdirSync(nodePath.join(trust.dir, "spec"));
    fs.chmodSync(nodePath.join(trust.dir, "spec"), 0o755);
    const specPath = nodePath.join(trust.dir, "spec", "rig.yaml");
    fs.writeFileSync(specPath, `version: "0.2"\nname: checks-rig\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        runtime: claude-code\n`
      + `        agent_ref: local:agents/impl\n        profile: default\n        cwd: .\n${relaunch}`);
    deps.rigRepo.setRigSpecSource(rigId, specPath);
    const seatService = new SeatLifecycleService({ ...deps, mcpTrust: { io: trust.io, specRoots: () => [nodePath.join(trust.dir, "spec")] } });
    return { service: seatService, specPath, cleanup: () => fs.rmSync(trust.dir, { recursive: true, force: true }) };
  }

  it("o9o.64 SV1: the seat's ignore_children clears a process the defaults would hold", async () => {
    const seat = withSeatSpec("        relaunch_checks:\n          ignore_children: [sccache]\n");
    try {
      processes = [AGENT, row(5001, PANE_PID, "sccache", "sccache --start-server")];
      const plan = await seat.service.planFresh({ seatRef: SEAT, fresh: true, stop: true, startupFrom: "stored" });
      expect(plan).toMatchObject({ ok: true, relaunchChecks: { settings: "spec", children: { verdict: "clear", ignored: [{ pid: 5001, kind: "seat_spec" }] } } });
    } finally { seat.cleanup(); }
  });

  // workspaces-o9o.93: a handover's successor replaces the live occupant, so it asks the same judgement through judgeReplacement.
  it("o9o.93: judgeReplacement judges the live occupant's children with the seat's own settings", async () => {
    const seat = withSeatSpec("        relaunch_checks:\n          ignore_children: [sccache]\n");
    try {
      processes = [AGENT, row(5001, PANE_PID, "sccache", "sccache --start-server")];
      expect(await seat.service.judgeReplacement({ seatRef: SEAT, despite: [] })).toMatchObject({
        checks: { settings: "spec", children: { verdict: "clear", ignored: [{ pid: 5001, kind: "seat_spec" }] } },
      });
      processes = [AGENT, row(5002, PANE_PID, "node", "node build.js")];
      expect(await seat.service.judgeReplacement({ seatRef: SEAT, despite: [] })).toMatchObject({ checks: { children: { verdict: "held" } } });
    } finally { seat.cleanup(); }
  });

  it("o9o.93: judgeReplacement takes the operator's despite", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    expect(await service.judgeReplacement({ seatRef: SEAT, despite: [] })).toMatchObject({ checks: { lease: { verdict: "held", overridden: false } } });
    expect(await service.judgeReplacement({ seatRef: SEAT, despite: ["lease"] })).toMatchObject({ checks: { lease: { verdict: "held", overridden: true } } });
  });

  it("o9o.93: judgeReplacement of a seat it cannot find says so, and a daemon with no checks wired judges nothing", async () => {
    expect(await service.judgeReplacement({ seatRef: "nobody@nowhere", despite: [] })).toMatchObject({ checks: null, warnings: [expect.stringContaining("not run")] });
    const unwired = new SeatLifecycleService({ ...deps, relaunchChecks: undefined });
    expect(await unwired.judgeReplacement({ seatRef: SEAT, despite: [] })).toBeNull();
  });

  it("o9o.64 SV2: the seat's handover_file names its handover; HANDOVER.md is then not it", async () => {
    const seat = withSeatSpec("        relaunch_checks:\n          handover_file: \"NOTES-*.md\"\n");
    try {
      writeHandover("HANDOVER.md", "2026-11-16T09:30:00.000Z");
      const notes = writeHandover("NOTES-tuesday.md", "2026-11-16T09:00:00.000Z");
      const result = await seat.service.launchFresh({ seatRef: SEAT, fresh: true, stop: true, reason: "relaunch checks", startupFrom: "stored" });
      expect(result.ok && result.handOver).toMatchObject({ sinceSource: "handover_file", handoverFile: notes });
    } finally { seat.cleanup(); }
  });

  it("o9o.64 SV3: a recorded spec source that cannot be read gives the defaults, with a warning naming why", async () => {
    const seat = withSeatSpec("        relaunch_checks:\n          ignore_children: [sccache]\n");
    try {
      fs.rmSync(seat.specPath);
      processes = [AGENT, row(5001, PANE_PID, "sccache", "sccache --start-server")];
      const plan = await seat.service.planFresh({ seatRef: SEAT, fresh: true, stop: true, startupFrom: "stored" });
      expect(plan).toMatchObject({ ok: true, relaunchChecks: { settings: "defaults", children: { verdict: "held" } } });
      expect(plan.ok && plan.warnings.join("\n")).toContain("relaunch_checks");
    } finally { seat.cleanup(); }
  });

  it("o9o.64 SV4: with no spec source recorded the defaults apply, and nothing warns about it", async () => {
    const plan = await service.planFresh({ seatRef: SEAT, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, relaunchChecks: { settings: "defaults" } });
    expect(plan.ok && plan.warnings.join("\n")).not.toContain("relaunch_checks");
  });

  it("plan: --plan shows every check's verdict and a held check as a blocker", async () => {
    leases = [{ holder: "ui-test-host", pid: 9001, liveness: "alive" }];
    processes = [AGENT, row(5001, PANE_PID, "zsh", "/bin/zsh -c npm test")];
    const plan = await service.planFresh({ seatRef: SEAT, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, launchable: false, relaunchChecks: { lease: { verdict: "held" }, children: { verdict: "held" } } });
    expect(plan.ok && plan.blockers.map((b) => b.code)).toContain("relaunch_check_held");
  });
});
