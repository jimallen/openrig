// Per-member Codex MCP servers, stage 3 (the per-seat switch): a declared server is OFF for every seat
// instance; `rig seat set-mcp <seat> <name> on` turns it on for ONE instance, reading the declaration from
// that rig's recorded spec source as the file is now, and every Codex launch of that seat then renders it.
// Rows go through SeatLifecycleService, the route and the Codex adapter (surfaces that existed at base), so
// at the base commit they fail on behaviour, not on a missing import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const fakeTmux = () => ({ probeSession: async () => ({ state: "absent" }) } as unknown as TmuxAdapter);

describe("rig seat set-mcp: one seat instance, from the rig's recorded spec", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let service: SeatLifecycleService;
  let root: string;
  let mcpls: string;
  let specPath: string;

  function writeSpec(member: string): void {
    writeFileSync(specPath, `version: "0.2"\nname: jims-team\npods:\n  - id: verify\n    label: Verify\n    members:\n      - id: ops\n        runtime: codex\n        agent_ref: local:agents/ops\n        profile: default\n        cwd: .\n${member}    edges: []\nedges: []\n`);
  }
  const lspBlock = () => `        mcp_servers:\n          lsp:\n            command: ${JSON.stringify(mcpls)}\n            args: ["--workspace-trust", "untrusted"]\n            startup_timeout_sec: 30\n            enabled_tools: [get_definition, get_hover]\n`;

  function seat(rigName: string, opts: { spec?: boolean; runtime?: string; cwd?: string } = {}) {
    const rig = rigRepo.createRig(rigName);
    if (opts.spec !== false) rigRepo.setRigSpecSource(rig.id, specPath);
    const cwd = opts.cwd ?? join(root, `ws-${rigName}`);
    mkdirSync(cwd, { recursive: true });
    const node = rigRepo.addNode(rig.id, "verify.ops", { runtime: opts.runtime ?? "codex", cwd, agentRef: "local:agents/ops", profile: "default" });
    new SessionRegistry(db).registerSession(node.id, `verify-ops@${rigName}`);
    return { rig, node, ref: `verify-ops@${rigName}` };
  }
  const column = (nodeId: string) => (db.prepare("SELECT codex_mcp_servers FROM nodes WHERE id = ?").get(nodeId) as { codex_mcp_servers: string | null }).codex_mcp_servers;
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'node.mcp_server_changed' ORDER BY seq").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: fakeTmux() });
    root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-switch-")));
    mkdirSync(join(root, "opt"));
    mcpls = join(root, "opt", "mcpls");
    writeFileSync(mcpls, "#!/bin/sh\nexit 0\n");
    chmodSync(mcpls, 0o755);
    mkdirSync(join(root, "spec"));
    specPath = join(root, "spec", "rig.yaml");
    writeSpec(lspBlock());
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("is off by default, and `on` switches exactly one instance of the member", async () => {
    const eztrack = seat("eztrack");
    const openrig = seat("openrig");
    expect(column(eztrack.node.id)).toBeNull();

    const result = await service.setMcpServer({ seatRef: eztrack.ref, server: "lsp", state: "on", reason: "mcpls pilot", actor: "exec-em@jims-team" });

    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ server: "lsp", from: "off", to: "on", changed: true, declaredIn: specPath, switchedOn: ["lsp"] });
    const stored = JSON.parse(column(eztrack.node.id)!) as Record<string, { declaration: unknown; specDir: string; declaredIn: string }>;
    expect(Object.keys(stored)).toEqual(["lsp"]);
    expect(stored["lsp"]).toMatchObject({
      declaration: { command: mcpls, args: ["--workspace-trust", "untrusted"], enabled_tools: ["get_definition", "get_hover"], startup_timeout_sec: 30 },
      specDir: join(root, "spec"), declaredIn: specPath,
    });
    expect(column(openrig.node.id)).toBeNull();
    expect(events()).toEqual([expect.objectContaining({ nodeId: eztrack.node.id, server: "lsp", from: "off", to: "on", reason: "mcpls pilot", actor: "exec-em@jims-team", declaredIn: specPath })]);
  });

  it("`off` removes it; `off` again is a recorded no-op", async () => {
    const s = seat("eztrack");
    await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
    const off = await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "off", reason: "rollback", actor: "a@r" });
    expect(off).toMatchObject({ ok: true, from: "on", to: "off", changed: true, switchedOn: [] });
    expect(column(s.node.id)).toBeNull();
    const again = await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "off", reason: "rollback", actor: "a@r" });
    expect(again).toMatchObject({ ok: true, from: "off", to: "off", changed: false });
    expect(events().map((e) => `${e["from"]}->${e["to"]}`)).toEqual(["off->on", "on->off"]);
  });

  it("reads the spec file as it is NOW, not as it was at launch", async () => {
    const s = seat("eztrack");
    writeSpec(""); // the member no longer declares it
    const refused = await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
    expect(refused).toMatchObject({ ok: false, code: "mcp_server_undeclared" });
    writeSpec(lspBlock());
    expect(await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" })).toMatchObject({ ok: true });
  });

  it.each([
    ["no recorded spec source", "mcp_spec_source_unrecorded"],
    ["a server the spec does not declare", "mcp_server_undeclared"],
    ["a spec whose seat now names another agent", "mcp_spec_source_changed"],
    ["a command inside the seat's working directory", "mcp_server_unusable"],
    ["a command that does not exist", "mcp_server_unusable"],
    ["a non-codex seat", "mcp_unsupported_runtime"],
    ["no actor", "missing_actor"],
  ])("refuses %s, and stores and audits nothing", async (label, code) => {
    const s = seat("eztrack", { spec: label !== "no recorded spec source", runtime: label === "a non-codex seat" ? "claude-code" : "codex" });
    let server = "lsp";
    let actor = "a@r";
    if (label === "a server the spec does not declare") server = "other";
    if (label === "a spec whose seat now names another agent") writeFileSync(specPath, fs.readFileSync(specPath, "utf-8").replace("local:agents/ops", "local:agents/someone-else"));
    if (label === "a command inside the seat's working directory") {
      const cwd = join(root, "ws-inside");
      mkdirSync(join(cwd, "bin"), { recursive: true });
      const inner = join(cwd, "bin", "mcpls");
      writeFileSync(inner, "#!/bin/sh\n"); chmodSync(inner, 0o755);
      writeFileSync(specPath, fs.readFileSync(specPath, "utf-8").replace(JSON.stringify(mcpls), JSON.stringify(inner)));
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(cwd, s.node.id);
    }
    if (label === "a command that does not exist") rmSync(mcpls);
    if (label === "no actor") actor = " ";
    const result = await service.setMcpServer({ seatRef: s.ref, server, state: "on", reason: "pilot", actor });
    expect(result).toMatchObject({ ok: false, code });
    expect(column(s.node.id)).toBeNull();
    expect(events()).toEqual([]);
  });

  it("the route requires a sender identity and passes the switch through", async () => {
    const setup = createTestApp(db);
    const s = seat("eztrack");
    const noActor = await setup.app.request(`/api/seat/set-mcp/${encodeURIComponent(s.ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "lsp", state: "on", reason: "pilot" }) });
    expect(noActor.status).toBe(400);
    expect(await noActor.json()).toMatchObject({ code: "missing_actor" });
    const ok = await setup.app.request(`/api/seat/set-mcp/${encodeURIComponent(s.ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "lsp", state: "on", reason: "pilot", operator: "jim@host" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, to: "on", switchedOn: ["lsp"] });
  });

  it("end to end: the switched-on seat's next Codex launch renders it; its sibling instance's does not", async () => {
    const { readSeatMcpServers } = await import("../src/domain/seat-mcp-servers.js");
    const eztrack = seat("eztrack");
    const openrig = seat("openrig");
    await service.setMcpServer({ seatRef: eztrack.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
    const commands: string[] = [];
    const tmux = mockShellCommand({
      sendText: vi.fn(async (_t: string, text: string) => { commands.push(text); return { ok: true as const }; }),
      hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"), sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => null), listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
    } as unknown as TmuxAdapter);
    const fsOps: CodexAdapterFsOps = { readFile: () => { throw new Error("nf"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps, listProcesses: () => [], sleep: async () => {}, resolveGitAddDirs: async () => [],
      verifyProfilePreflight: async (n) => ({ ok: true, profile: n }), readSeatMcpServers: (id: string) => readSeatMcpServers(db, id) } as ConstructorParameters<typeof CodexRuntimeAdapter>[0]);
    for (const s of [eztrack, openrig]) {
      const binding: NodeBinding = { id: `b-${s.node.id}`, nodeId: s.node.id, tmuxSession: s.ref, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: s.node.cwd!, launchPosture: "full_bypass", codexConfigProfile: "rig-yolo" };
      await adapter.launchHarness(binding, { name: s.ref, resumeToken: "thread-1" });
    }
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain(` -c 'mcp_servers.lsp={command=${JSON.stringify(mcpls)},args=["--workspace-trust","untrusted"],startup_timeout_sec=30,enabled_tools=["get_definition","get_hover"]}'`);
    expect(commands[0]).not.toContain(" -p ");
    expect(commands[1]).not.toContain("mcp_servers");
    // Apart from the override, the two commands differ only by rig name (seat, queue dir).
    expect(commands[1]).toBe(commands[0]!.replace(/ -c 'mcp_servers\.lsp=[^']*'/, "").replaceAll("eztrack", "openrig"));
  });
});

describe("production wiring", () => {
  it("startup wires the per-seat reader into the Codex launch adapter, and restore reads it by node", () => {
    const startup = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8").split("\n");
    expect(startup.find((line) => line.includes("new CodexRuntimeAdapter("))).toContain("readSeatMcpServers: (nodeId: string) => readSeatMcpServers(db, nodeId)");
  });
});
