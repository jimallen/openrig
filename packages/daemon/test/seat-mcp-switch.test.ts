// Per-member Codex MCP servers, stage 3 (the per-seat switch): a declared server is OFF for every seat
// instance; `rig seat set-mcp <seat> <name> on` turns it on for ONE instance, reading the declaration from
// that rig's recorded spec source as the file is now, and every Codex launch of that seat then renders it.
// Rows go through SeatLifecycleService, the route and the Codex adapter (surfaces that existed at base), so
// at the base commit they fail on behaviour, not on a missing import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("a prototype-named server is refused by the switch, and storage keeps any name as its own entry", async () => {
    const s = seat("eztrack");
    expect(await service.setMcpServer({ seatRef: s.ref, server: "__proto__", state: "on", reason: "x", actor: "a@r" }))
      .toMatchObject({ ok: false, code: "invalid_mcp_server" });
    const { writeSeatMcpServer, switchedOnNames } = await import("../src/domain/seat-mcp-servers.js");
    const entry = { declaration: { command: mcpls, enabled_tools: ["get_hover"] }, specDir: "/s", declaredIn: "/s/rig.yaml", switchedOnAt: "t" };
    expect(writeSeatMcpServer(db, s.node.id, "__proto__", entry as never)).toBe(true);
    expect(switchedOnNames(db, s.node.id)).toEqual(["__proto__"]);
  });

  it("the route requires a sender identity and passes the switch through", async () => {
    const setup = createTestApp(db);
    const s = seat("eztrack");
    const noActor = await setup.app.request(`/api/seat/set-mcp/${encodeURIComponent(s.ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "lsp", state: "on", reason: "pilot" }) });
    expect(noActor.status).toBe(400);
    // The route refuses before the service runs: its own message, not the service's.
    expect(await noActor.json()).toEqual({ ok: false, code: "missing_actor", message: "Sender identity is required; pass --operator <address> when running outside a managed seat." });
    const ok = await setup.app.request(`/api/seat/set-mcp/${encodeURIComponent(s.ref)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "lsp", state: "on", reason: "pilot", operator: "jim@host" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, to: "on", switchedOn: ["lsp"] });
  });

  /** One fresh managed Codex launch of a seat through the real adapter and the production reader. */
  async function launchFresh(s: ReturnType<typeof seat>, posture: "floor" | "full_bypass" = "full_bypass") {
    const { readSeatMcpServers } = await import("../src/domain/seat-mcp-servers.js");
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
    const binding: NodeBinding = { id: `b-${s.node.id}`, nodeId: s.node.id, tmuxSession: s.ref, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: "", cwd: s.node.cwd!, launchPosture: posture };
    const result = await adapter.launchHarness(binding, { name: s.ref }) as { ok: boolean; error?: string };
    return { ...result, commands };
  }

  describe("a seat that is not full_bypass: allowed, with a warning (Jim, 2026-10-20)", () => {
    const fullBypass = (rigId: string) => rigRepo.setRigPolicyProvenance(rigId,
      { origin: "builtin", resolvedTarget: "policies/builtin/yolo.policy.md", declaringDir: null, launchPosture: "full_bypass" });
    const WARN = 'Codex MCP server "lsp" runs outside Codex\'s sandbox with your full user rights';

    it("switch-on on a floor seat succeeds, says so, and the audit event records the warning", async () => {
      const s = seat("eztrack");
      const r = await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      const expected = `${WARN} (this seat's launch posture is floor, not full_bypass); it can do what this seat's own commands cannot.`;
      expect(r).toMatchObject({ ok: true, to: "on", warning: expected });
      expect(events()[0]).toMatchObject({ warning: expected });
    });

    it("switch-on on a full_bypass seat carries no warning", async () => {
      const s = seat("eztrack");
      fullBypass(s.rig.id);
      const r = await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      expect(r.ok && "warning" in r).toBe(false);
      expect(events()[0]).toMatchObject({ warning: null });
    });

    it("every launch that renders it on a sandboxed posture logs the warning; a full_bypass launch does not", async () => {
      const s = seat("eztrack");
      await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const floor = await launchFresh(s, "floor");
        expect(floor.ok).toBe(true);
        expect(floor.commands[0]).toContain("mcp_servers.lsp=");
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(WARN)))
          .toEqual([`[openrig] ${s.ref}: ${WARN} (this launch's sandbox is workspace-write, not danger-full-access); it can do what this seat's own commands cannot.`]);
        warn.mockClear();
        await launchFresh(s, "full_bypass");
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(WARN))).toEqual([]);
      } finally { warn.mockRestore(); }
    });
  });

  describe("the binary is pinned at switch-on (Jim, 2026-10-20)", () => {
    const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    const AGAIN = 'switch it on again to accept the new binary (rig seat set-mcp <seat> lsp on --reason ...)';

    it("stores the resolved binary and its sha256, and records the sha256 in the audit event", async () => {
      const s = seat("eztrack");
      await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      expect(JSON.parse(column(s.node.id)!)["lsp"]).toMatchObject({ commandPath: mcpls, commandSha256: sha(mcpls) });
      expect(events()[0]).toMatchObject({ commandSha256: sha(mcpls) });
      expect((await launchFresh(s)).ok).toBe(true);
    });

    it("refuses to render when the binary changed after switch-on", async () => {
      const s = seat("eztrack");
      await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      writeFileSync(mcpls, "#!/bin/sh\necho upgraded\n");
      const r = await launchFresh(s);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`now resolves to a binary whose sha256 (${sha(mcpls)}) differs from the one switched on`);
      expect(r.error).toContain(AGAIN);
      expect(r.commands).toEqual([]);
    });

    it("refuses when a link is retargeted to another binary, and accepts it after switching on again", async () => {
      const real1 = mcpls;
      const real2 = join(root, "opt", "mcpls-2");
      writeFileSync(real2, "#!/bin/sh\necho two\n");
      chmodSync(real2, 0o755);
      const link = join(root, "opt", "current");
      symlinkSync(real1, link);
      writeSpec(lspBlock().replace(JSON.stringify(mcpls), JSON.stringify(link)));
      const s = seat("eztrack");
      await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      rmSync(link);
      symlinkSync(real2, link);
      const refused = await launchFresh(s);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain(AGAIN);
      expect(await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "accept upgrade", actor: "a@r" })).toMatchObject({ ok: true });
      expect(JSON.parse(column(s.node.id)!)["lsp"]).toMatchObject({ commandPath: real2, commandSha256: sha(real2) });
      const accepted = await launchFresh(s);
      expect(accepted.ok).toBe(true);
      expect(accepted.commands[0]).toContain(`mcp_servers.lsp={command=${JSON.stringify(link)}`);
    });

    it("refuses the same way when the binary is gone", async () => {
      const s = seat("eztrack");
      await service.setMcpServer({ seatRef: s.ref, server: "lsp", state: "on", reason: "pilot", actor: "a@r" });
      rmSync(mcpls);
      const r = await launchFresh(s);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`its command ${mcpls} does not exist; ${AGAIN}`);
    });
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
