// Per-member Codex MCP servers, stage 1 (the seam): what a rig spec may DECLARE.
// Every row goes through a surface that existed before this change (schema validate/normalize,
// codec, rigPreflight, bundle behaviour, the expand route), so at the base commit each row fails on
// behaviour rather than on a missing import.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { describeBundleBehaviour } from "../src/domain/bundle-behaviour.js";
import { normalizeMcpServers } from "../src/domain/codex-mcp-servers.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const TOOLS = ["get_definition", "get_references", "get_hover"];
function server(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: "/opt/mcpls/bin/mcpls", args: ["--workspace-trust", "untrusted"], enabled_tools: TOOLS, startup_timeout_sec: 30, tool_timeout_sec: 60, ...extra };
}
function spec(member: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "0.2", name: "mcp-rig",
    pods: [{ id: "verify", label: "Verify", members: [{ id: "ops", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", ...member }], edges: [] }],
    edges: [],
  };
}
const errorsOf = (raw: Record<string, unknown>) => PodRigSpecSchema.validate(raw).errors;

describe("mcp_servers: the declaration a codex member may carry", () => {
  it("accepts a stdio server with a command, args, enabled_tools and timeouts, and normalizes it", () => {
    const raw = spec({ mcp_servers: { lsp: server() } });
    expect(PodRigSpecSchema.validate(raw)).toMatchObject({ valid: true, errors: [] });
    const member = PodRigSpecSchema.normalize(raw).pods[0]!.members[0]!;
    expect(member.mcpServers).toEqual({ lsp: { command: "/opt/mcpls/bin/mcpls", args: ["--workspace-trust", "untrusted"], enabledTools: TOOLS, startupTimeoutSec: 30, toolTimeoutSec: 60 } });
  });

  it("is refused on a non-codex member", () => {
    expect(errorsOf({ ...spec({ mcp_servers: { lsp: server() } }), pods: [{ id: "verify", label: "V", members: [{ id: "ops", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", mcp_servers: { lsp: server() } }], edges: [] }] }))
      .toContain('pods[0].members[0].mcp_servers: only valid when runtime is "codex"');
  });

  it("requires enabled_tools", () => {
    const s = server(); delete s["enabled_tools"];
    expect(errorsOf(spec({ mcp_servers: { lsp: s } }))).toContain("pods[0].members[0].mcp_servers.lsp.enabled_tools: required; list the exact tools this seat may call");
  });

  it.each(["env", "env_vars", "url", "bearer_token_env_var", "http_headers", "env_http_headers", "cwd"])("refuses %s by name", (key) => {
    expect(errorsOf(spec({ mcp_servers: { lsp: server({ [key]: key === "env" ? { A: "1" } : "x" }) } })))
      .toContain(`pods[0].members[0].mcp_servers.lsp.${key}: not allowed; a rig spec may declare only a stdio server's command, args, enabled_tools and timeouts`);
  });

  it("requires an absolute command", () => {
    expect(errorsOf(spec({ mcp_servers: { lsp: server({ command: "bin/mcpls" }) } })))
      .toContain('pods[0].members[0].mcp_servers.lsp.command: must be an absolute path (got "bin/mcpls")');
  });

  it("refuses a control character in an argument (Codex must receive every byte as declared)", () => {
    expect(errorsOf(spec({ mcp_servers: { lsp: server({ args: ["ok", "line\nbreak"] }) } })))
      .toContain("pods[0].members[0].mcp_servers.lsp.args[1]: must not contain control, format or separator characters");
  });

  it("refuses whitespace in the command or an argument (the seat's ps line must split back exactly)", () => {
    const errors = errorsOf(spec({ mcp_servers: { lsp: server({ command: "/opt/my tools/mcpls", args: ["a b"] }) } }));
    const why = "must not contain whitespace (a seat's process line must split back into the arguments it was launched with)";
    expect(errors).toContain(`pods[0].members[0].mcp_servers.lsp.command: ${why}`);
    expect(errors).toContain(`pods[0].members[0].mcp_servers.lsp.args[0]: ${why}`);
  });

  it("refuses a server name Codex could not take as a bare key", () => {
    expect(errorsOf(spec({ mcp_servers: { "l.sp": server() } })))
      .toContain('pods[0].members[0].mcp_servers: server name "l.sp" must be 1-64 letters, digits, underscores or hyphens');
  });

  it("round-trips through the codec, so a re-serialized spec (bundles, drafts) keeps the declaration", () => {
    const typed = PodRigSpecSchema.normalize(spec({ mcp_servers: { lsp: server() } }));
    const again = PodRigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(typed)) as Record<string, unknown>);
    expect(again.pods[0]!.members[0]!.mcpServers).toEqual(typed.pods[0]!.members[0]!.mcpServers);
    expect(again.pods[0]!.members[0]!.mcpServers).toBeDefined();
  });
});

describe("mcp_servers: rig preflight judges where the executable lives", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const agentYaml = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n';
  const fsOps = (): AgentResolverFsOps => ({
    exists: (p) => /\/agents\/impl(\/agent\.yaml)?$/.test(p),
    readFile: (p) => { if (p.includes("agents/impl")) return agentYaml; throw new Error(`Not found: ${p}`); },
  });
  function yaml(command: string): string {
    return `version: "0.2"\nname: mcp-rig\npods:\n  - id: verify\n    label: Verify\n    members:\n      - id: ops\n        runtime: codex\n        agent_ref: local:agents/impl\n        profile: default\n        cwd: .\n        mcp_servers:\n          lsp:\n            command: ${JSON.stringify(command)}\n            enabled_tools: [get_hover]\n    edges: []\nedges: []\n`;
  }
  function exe(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "mcpls");
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }
  function tmp(): string { const d = realpathSync(mkdtempSync(join(tmpdir(), "mcp-pf-"))); dirs.push(d); return d; }

  it("refuses a command inside the spec's own directory (an archive could ship the program)", async () => {
    const rigRoot = tmp();
    const seat = tmp();
    const command = exe(join(rigRoot, "bin"));
    const result = await rigPreflight({ rigSpecYaml: yaml(command), rigRoot, fsOps: fsOps(), cwdOverride: seat });
    expect(result.ready).toBe(false);
    expect(result.errors).toContain(`verify.ops: mcp_servers.lsp: its command ${command} lies inside the rig spec's directory (${rigRoot}), so content there could choose the program`);
  });

  it("refuses a command inside the seat's working directory even when the spec lives elsewhere", async () => {
    const rigRoot = tmp();
    const seat = tmp();
    const command = exe(join(seat, "tools"));
    const result = await rigPreflight({ rigSpecYaml: yaml(command), rigRoot, fsOps: fsOps(), cwdOverride: seat });
    expect(result.ready).toBe(false);
    expect(result.errors.join("\n")).toContain(`verify.ops: mcp_servers.lsp: its command ${command} lies inside the seat's working directory`);
  });

  it("passes a command that lives outside both, and only warns about one that is missing", async () => {
    const rigRoot = tmp();
    const elsewhere = tmp();
    const command = exe(elsewhere);
    const ok = await rigPreflight({ rigSpecYaml: yaml(command), rigRoot, fsOps: fsOps() });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.filter((w) => w.includes("mcp_servers"))).toEqual([]);
    const missing = join(elsewhere, "absent-binary");
    const warn = await rigPreflight({ rigSpecYaml: yaml(missing), rigRoot, fsOps: fsOps() });
    expect(warn.ready).toBe(true);
    expect(warn.warnings).toContain(`verify.ops: mcp_servers.lsp: its command ${missing} does not exist; it is declared but no seat can switch it on until it exists`);
  });
});

describe("mcp_servers: disclosure and expansion", () => {
  it("bundle behaviour lists a declared server under alsoRuns, as a host program started at launch", () => {
    const files = new Map<string, string>([
      ["rig.yaml", "name: demo\nversion: '1'\npods:\n- id: verify\n  members:\n  - id: ops\n    agent_ref: local:agents/w\n    profile: default\n    runtime: codex\n    cwd: .\n    mcp_servers:\n      lsp: {command: /opt/mcpls/bin/mcpls, enabled_tools: [get_hover]}\n"],
      ["agents/w/agent.yaml", "name: w\nversion: '1'\nprofiles:\n  default: {}\n"],
    ]);
    const view = describeBundleBehaviour({ files, manifest: { schema_version: 2, rig_spec: "rig.yaml", integrity: { files: {} } }, generator: { openrigVersion: "0", commit: "0" }, digestValid: true, filesVerified: true });
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.alsoRuns).toContainEqual({
      seat: "verify.ops", kind: "codex_mcp_server", pathOrRef: "/opt/mcpls/bin/mcpls", resolution: "host_at_launch",
      trigger: 'Codex MCP server "lsp"; off by default, started at each launch of a seat instance switched on with rig seat set-mcp; runs outside Codex\'s sandbox with the user\'s rights',
      sourceRefs: [{ path: "rig.yaml", field: "pods.verify.members.ops.mcp_servers.lsp" }],
    });
  });

  it("expansion refuses mcp_servers by name instead of dropping it, and creates nothing", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db);
      const rig = setup.rigRepo.createRig("mcp-expand");
      const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigRoot: "/project/rigs/x", pod: { id: "vp", label: "VP", edges: [], members: [
          { id: "ops", runtime: "codex", agentRef: "local:agents/impl", profile: "default", cwd: ".", mcp_servers: { lsp: server() } }] } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string; error?: string };
      expect(body).toMatchObject({ code: "validation_failed", error: "mcp_servers cannot be added by expansion (member ops): declare the server in the rig's spec file, which rig seat set-mcp reads" });
      expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE rig_id = ?").get(rig.id)).toMatchObject({ c: 0 });
    } finally { db.close(); }
  });
});

// Security review of 97aa027b, N5: the validator's edges, each pinned so a loosening fails a row.
describe("mcp_servers: hardening (security review N5)", () => {
  // Every field of Codex 0.162.1's RawMcpServerConfig (codex-rs config/src/mcp_types.rs at tag rust-v0.162.1).
  const CODEX_FIELDS = ["command", "args", "env", "env_vars", "cwd", "http_headers", "env_http_headers", "url", "bearer_token",
    "bearer_token_env_var", "http_headers_helper", "environment_id", "auth", "startup_timeout_sec", "startup_timeout_ms",
    "tool_timeout_sec", "enabled", "required", "startup_readiness", "supports_parallel_tool_calls", "tool_input_schema_max_bytes",
    "omit_tools_from", "default_tools_approval_mode", "enabled_tools", "disabled_tools", "scopes", "oauth", "oauth_resource", "_name", "tools"];
  const ALLOWED = ["command", "args", "enabled_tools", "startup_timeout_sec", "tool_timeout_sec"];
  it("the census is the 30 fields, and exactly five of them are allowed", () => {
    expect(new Set(CODEX_FIELDS).size).toBe(30);
    expect(ALLOWED.every((k) => CODEX_FIELDS.includes(k))).toBe(true);
    expect(errorsOf(spec({ mcp_servers: { lsp: server() } }))).toEqual([]);
  });
  it.each(CODEX_FIELDS.filter((k) => !ALLOWED.includes(k)))("refuses Codex field %s", (key) => {
    const errors = errorsOf(spec({ mcp_servers: { lsp: server({ [key]: "x" }) } }));
    expect(errors.filter((e) => e.startsWith(`pods[0].members[0].mcp_servers.lsp.${key}: `))).toHaveLength(1);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("refuses the object-property name %s", (name) => {
    const raw = JSON.parse(`{"version":"0.2","name":"r","pods":[{"id":"verify","label":"V","members":[{"id":"ops","agent_ref":"local:agents/impl","profile":"default","runtime":"codex","cwd":".","mcp_servers":{${JSON.stringify(name)}:${JSON.stringify(server())}}}],"edges":[]}],"edges":[]}`);
    expect(errorsOf(raw)).toContain(`pods[0].members[0].mcp_servers: server name "${name}" is reserved (an object property name)`);
  });
  it("normalize keeps a __proto__ key as an own entry instead of setting a prototype", () => {
    const raw = JSON.parse(`{"__proto__":${JSON.stringify(server())}}`) as Record<string, unknown>;
    expect(Object.keys(normalizeMcpServers(raw)!)).toEqual(["__proto__"]);
  });

  it.each([[0, false], [5e-324, false], [0.5, false], [1, true], [3600, true], [3601, false]])("startup and tool timeouts of %s seconds: accepted=%s", (v, ok) => {
    for (const key of ["startup_timeout_sec", "tool_timeout_sec"]) {
      const errors = errorsOf(spec({ mcp_servers: { lsp: server({ [key]: v }) } }));
      expect(errors.includes(`pods[0].members[0].mcp_servers.lsp.${key}: must be a number of seconds from 1 to 3600`)).toBe(!ok);
      if (ok) expect(errors).toEqual([]);
    }
  });

  it("refuses an empty enabled_tools list", () => {
    expect(errorsOf(spec({ mcp_servers: { lsp: server({ enabled_tools: [] }) } })))
      .toContain("pods[0].members[0].mcp_servers.lsp.enabled_tools: must be a non-empty list of tool names");
  });

  it.each([["NEL U+0085", "\u0085"], ["C1 U+009F", "\u009f"], ["LINE SEPARATOR U+2028", " "], ["PARAGRAPH SEPARATOR U+2029", " "],
    ["ZERO WIDTH SPACE U+200B", "​"], ["RLO U+202E", "‮"], ["BOM U+FEFF", "﻿"], ["SOFT HYPHEN U+00AD", "­"], ["private use U+E000", ""]])(
    "refuses %s in an argument", (_label, ch) => {
      expect(errorsOf(spec({ mcp_servers: { lsp: server({ args: [`a${ch}b`] }) } })))
        .toContain("pods[0].members[0].mcp_servers.lsp.args[0]: must not contain control, format or separator characters");
    });
  it("still accepts printable non-ASCII text", () => {
    expect(errorsOf(spec({ mcp_servers: { lsp: server({ args: ["ü-ñ", "日本", "🦀"] }) } }))).toEqual([]);
  });
});
