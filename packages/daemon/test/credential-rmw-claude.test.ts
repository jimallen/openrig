// workspaces-o9o.182 (CoS ruling (A)): Claude's files OpenRig merges into (.claude/settings.local.json, .mcp.json) are judged before they
// are changed: a link, a second name or another user's file is left exactly as it is and the refusal names it; group/other write is
// neither refused nor changed; nothing is written through a link.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { rewriteGuardedFile } from "../src/adapters/guarded-rewrite.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { claudeActivityRelayPath } from "../src/domain/claude-activity-hooks.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

let tmp: string;
let cwd: string;
let stateDir: string;
let settings: string;
let victim: string;
let errors: MockInstance;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o182-claude-")));
  cwd = path.join(tmp, "seat");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  settings = path.join(cwd, ".claude", "settings.local.json");
  victim = path.join(tmp, "victim.json");
  fs.writeFileSync(victim, '{"keep":"me"}\n', { mode: 0o600 });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { errors.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** The daemon's own wiring of the adapter's file ops (startup.ts): node:fs, with the credential rule's guarded rewrite. */
const daemonFs: ClaudeAdapterFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
  copyFile: (s, d) => fs.copyFileSync(s, d),
  rewriteGuarded: (p, policy, mutate, options) => rewriteGuardedFile(p, policy, mutate, options),
};
const tmux = () => ({ sendText: vi.fn(async () => ({ ok: true as const })) }) as Partial<TmuxAdapter> as TmuxAdapter;
const binding = (): NodeBinding => ({ id: "b1", nodeId: "n1", tmuxSession: "r01-dev", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd });
const fragmentPlan = (resourceType: "claude_settings_fragment" | "claude_mcp_fragment", fragment: string): ProjectionPlan => ({
  runtime: "claude-code", cwd,
  entries: [{ category: "runtime_resource", effectiveId: "frag", sourceSpec: "base", sourcePath: tmp, resourcePath: "runtime/frag.json", absolutePath: fragment, classification: "safe_projection", resourceType }],
  startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
});
const writeFragment = (): string => {
  const fragment = path.join(tmp, "fragment.json");
  fs.writeFileSync(fragment, '{"env":{"FROM_FRAGMENT":"1"}}\n');
  return fragment;
};

describe("Claude's files are judged before OpenRig merges into them (workspaces-o9o.182)", () => {
  it("a settings fragment is not merged through a symlinked settings.local.json: the link and its target are left as they are", async () => {
    fs.symlinkSync(victim, settings);
    const result = await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs }).project(fragmentPlan("claude_settings_fragment", writeFragment()), binding());
    expect(fs.readFileSync(victim, "utf-8")).toBe('{"keep":"me"}\n');
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(result.projected).toEqual([]);
    expect(JSON.stringify(result)).toContain(settings);
  });

  it("an MCP fragment is not merged through a symlinked .mcp.json: the link and its target are left as they are", async () => {
    const mcp = path.join(cwd, ".mcp.json");
    fs.symlinkSync(victim, mcp);
    const result = await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs }).project(fragmentPlan("claude_mcp_fragment", writeFragment()), binding());
    expect(fs.readFileSync(victim, "utf-8")).toBe('{"keep":"me"}\n');
    expect(fs.lstatSync(mcp).isSymbolicLink()).toBe(true);
    expect(result.projected).toEqual([]);
  });

  it("the status line collector does not write through a symlinked settings.local.json, and says so", () => {
    fs.symlinkSync(victim, settings);
    const collector = path.join(tmp, "collector.cjs");
    fs.writeFileSync(collector, "// collector");
    const adapter = new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs, stateDir, collectorAssetPath: collector });
    expect(() => adapter.ensureContextCollector({ cwd })).toThrow(new RegExp(`${settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*symbolic link`));
    expect(fs.readFileSync(victim, "utf-8")).toBe('{"keep":"me"}\n');
  });

  it("the activity-hook reconcile leaves a settings.local.json with a second hard link as it is, and so is the other name", async () => {
    // An OpenRig-owned relay entry, so the reconcile (hooks off: strip) has something to write.
    const owned = { hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${shellQuote(claudeActivityRelayPath(stateDir))}` }] }] } };
    const text = `${JSON.stringify(owned, null, 2)}\n`;
    fs.writeFileSync(settings, text, { mode: 0o600 });
    const other = path.join(tmp, "other-name.json");
    fs.linkSync(settings, other);
    const empty: ProjectionPlan = { runtime: "claude-code", cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
    await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs, stateDir }).project(empty, binding());
    expect(fs.readFileSync(other, "utf-8")).toBe(text);
    expect(fs.readFileSync(settings, "utf-8")).toBe(text);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/hard link/);
  });

  it("CoS ruling (A): a settings.local.json the group can write (0664) is merged, and stays 0664", async () => {
    fs.writeFileSync(settings, '{"model":"x"}\n');
    fs.chmodSync(settings, 0o664);
    const result = await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs }).project(fragmentPlan("claude_settings_fragment", writeFragment()), binding());
    expect(result.projected).toEqual(["frag"]);
    expect(JSON.parse(fs.readFileSync(settings, "utf-8"))).toEqual({ model: "x", env: { FROM_FRAGMENT: "1" } });
    expect(fs.statSync(settings).mode & 0o777).toBe(0o664);
    expect(fs.lstatSync(settings).isFile()).toBe(true);
  });

  it("positive control: a first merge creates settings.local.json and leaves no temp file beside it", async () => {
    await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: daemonFs }).project(fragmentPlan("claude_settings_fragment", writeFragment()), binding());
    expect(JSON.parse(fs.readFileSync(settings, "utf-8"))).toEqual({ env: { FROM_FRAGMENT: "1" } });
    expect(fs.readdirSync(path.dirname(settings))).toEqual(["settings.local.json"]);
  });
});

describe("startup wires the guarded rewrite into both adapters (census of production constructions)", () => {
  it("every construction of the Claude and Codex adapters in daemon src passes rewriteGuarded", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
    const constructions = walk(srcRoot).flatMap((f) => fs.readFileSync(f, "utf-8").split("\n")
      .filter((line) => /new (ClaudeCodeAdapter|CodexRuntimeAdapter)\(/.test(line))
      .map((line) => ({ file: path.relative(srcRoot, f), line })));
    expect(constructions.map((c) => c.file)).toEqual(["startup.ts", "startup.ts"]);  // positive control: both were found
    for (const c of constructions) expect(c.line, c.file).toMatch(/rewriteGuarded: \(p(: string)?, policy, mutate, options\) => rewriteGuardedFile\(p, policy, mutate, options\)/);
  });
});
