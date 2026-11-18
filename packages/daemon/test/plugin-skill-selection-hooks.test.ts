// uses.plugin_skills narrows only the plugin skills projected into a seat's skill folder. The shipped openrig-core
// hooks read files under the plugin's own skills/ folder (the PreCompact hook runs
// skills/claude-compaction-restore/scripts/precompact-hook.mjs; refocus.cjs reads skills/refocusing/...). These pins use
// the real shipped plugin: with every hook-read skill left out of the selection, the plugin folder a seat gets still
// holds every file the hooks name, and the seat's skill folder holds only the selected skills.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { planProjection } from "../src/domain/projection-planner.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { reconcileSkillLoadout } from "../src/domain/skill-catalog.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { AgentSpec } from "../src/domain/types.js";
import { mkTemp } from "./helpers/temp-roots.js";

const PLUGIN_ROOT = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core");

function realFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: (dir: string) => {
      const r: string[] = [];
      const walk = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      walk(dir, "");
      return r;
    },
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, mode: number) => fs.chmodSync(p, mode),
  };
}

const tmux = {} as TmuxAdapter; // project() must not launch or contact a provider

/** Every `skills/<name>/<file>` path the plugin's hook manifests and hook scripts name. */
function hookReadSkillFiles(): string[] {
  const sources = [
    ...fs.readdirSync(nodePath.join(PLUGIN_ROOT, "hooks")).filter((name) => name.endsWith(".json")).map((name) => nodePath.join("hooks", name)),
    ...fs.readdirSync(nodePath.join(PLUGIN_ROOT, "hooks", "scripts"), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => nodePath.join("hooks", "scripts", e.name)),
  ];
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of fs.readFileSync(nodePath.join(PLUGIN_ROOT, source), "utf8").matchAll(/skills\/([a-z0-9-]+)\/([A-Za-z0-9._/-]+\.[a-z]+)/g)) {
      found.add(`skills/${match[1]}/${match[2]}`);
    }
  }
  return [...found].sort();
}

function resolveLean(cwd: string, runtime: "claude-code" | "codex", include: string[]) {
  const spec: AgentSpec = {
    version: "1.0", name: "lean", imports: [], startup: { files: [], actions: [] },
    resources: { skills: [], guidance: [], subagents: [], plugins: [{ id: "openrig-core", source: { kind: "local", path: PLUGIN_ROOT } }], runtimeResources: [] },
    profiles: { default: { uses: { skills: [], guidance: [], subagents: [], plugins: ["openrig-core"], runtimeResources: [], pluginSkills: { "openrig-core": include } } } },
  };
  return resolveNodeConfig({
    baseSpec: { spec, sourcePath: cwd, hash: "h" }, importedSpecs: [], collisions: [], profileName: "default",
    member: { id: "impl", agentRef: "local:agents/lean", profile: "default", runtime, cwd },
    pod: { id: "build", label: "Build", members: [], edges: [] },
    rig: { version: "0.2", name: "proj", pods: [], edges: [] },
    skillsRoot: nodePath.join(cwd, "no-catalog"), homedir: nodePath.join(cwd, "home"),
  });
}

describe("uses.plugin_skills keeps every file the openrig-core hooks read", () => {
  it("the shipped hooks do read files under the plugin's skills folder (the pin below is not vacuous)", () => {
    const files = hookReadSkillFiles();
    expect(files).toEqual(expect.arrayContaining([
      "skills/claude-compaction-restore/scripts/precompact-hook.mjs",
      "skills/refocusing/references/refocus.md",
    ]));
    for (const file of files) expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, file)), file).toBe(true);
  });

  it.each([
    ["claude-code", ".claude", (fsOps: ReturnType<typeof realFsOps>) => new ClaudeCodeAdapter({ tmux, fsOps })],
    ["codex", ".codex", (fsOps: ReturnType<typeof realFsOps>) => new CodexRuntimeAdapter({ tmux, fsOps })],
  ] as const)("%s: the seat gets the whole plugin folder but only the selected skills", async (runtime, pluginHome, makeAdapter) => {
    const cwd = mkTemp(nodePath.join(os.tmpdir(), "openrig-plugin-skill-hooks-"));
    const resolved = resolveLean(cwd, runtime, ["messaging-the-human"]);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.skillLoadout?.entries.map((entry) => entry.id)).toEqual(["messaging-the-human"]);

    const planned = planProjection({ config: resolved.config, collisions: [], fsOps: realFsOps() });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.entries.filter((entry) => entry.category === "plugin").map((entry) => entry.absolutePath)).toEqual([PLUGIN_ROOT]);
    const binding: NodeBinding = { id: "b1", nodeId: "n1", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd };
    const projected = await makeAdapter(realFsOps()).project(planned.plan, binding);
    expect(projected.failed).toEqual([]);
    for (const file of hookReadSkillFiles()) {
      expect(fs.existsSync(nodePath.join(cwd, pluginHome, "plugins", "openrig-core", file)), file).toBe(true);
    }

    const skills = reconcileSkillLoadout({ loadout: resolved.config.skillLoadout!, runtime, cwd, topologyOwner: "impl@proj", apply: true });
    expect(skills).toMatchObject({ ok: true, applied: true });
    const skillDir = nodePath.join(cwd, runtime === "claude-code" ? ".claude" : ".agents", "skills");
    expect(fs.readdirSync(skillDir).filter((name) => name !== ".gitignore")).toEqual(["messaging-the-human"]);
  });
});
