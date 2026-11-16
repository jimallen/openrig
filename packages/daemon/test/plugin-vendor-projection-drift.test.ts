// workspaces-o9o.17: an installed OpenRig package whose bundled openrig-core differs from the copy in
// OPENRIG_HOME/plugins must not project the old content. Measured on Sparky 2026-11-16 (rig 0.6.10, d0303ca8): the
// package and a 10-21 copy both said openrig-core 0.1.9 yet differed in 16 files, and every Claude seat projected that
// day got the old hooks/claude.json (no PreToolUse rig-body guard) and old skill text, because the vendor step only
// replaced the copy on a strictly newer manifest version.
//
// These rows run the same path a daemon start and a seat start take, on real temp directories: PluginVendorService
// (startup.ts) refreshes OPENRIG_HOME/plugins and the global skill seeds, the builtin shared spec's
// `openrig-home:plugins/openrig-core` resolves through resolvePluginPath (projection-planner.ts), the Claude and Codex
// adapters project the plugin folder, and resolvePluginSkills supplies the loadout skills Claude actually reads.
// Every root is a temp dir (OPENRIG_HOME, HOME, seat cwd): nothing touches the real ~/.openrig or ~/.claude.
// The stub runtime cannot reach this: it projects into its own .openrig/stub directory (docs/as-built/arteries.md).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";
import { nodePluginVendorFs } from "../src/adapters/plugin-vendor-fs.js";
import { resolvePluginPath, type ProjectionEntry, type ProjectionPlan } from "../src/domain/projection-planner.js";
import { resolvePluginSkills } from "../src/domain/skill-catalog.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { mkTemp } from "./helpers/temp-roots.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const PLUGIN = "openrig-core";
const VERSION = "0.1.9";

// The hooks manifest the running package ships: it carries the PreToolUse rig-body guard.
const PACKAGE_HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/rig-body-guard.cjs\"" }] }] } });
// The older copy's manifest: same plugin version, no PreToolUse entry.
const STALE_HOOKS = JSON.stringify({ hooks: { SessionStart: [] } });
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}\n`;

/** Lay a plugin tree down on disk. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
  }
}

const manifests = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: PLUGIN, version: VERSION }),
  ".codex-plugin/plugin.json": JSON.stringify({ name: PLUGIN, version: VERSION, description: "core" }),
};

const PACKAGE_TREE = {
  ...manifests,
  "hooks/claude.json": PACKAGE_HOOKS,
  "hooks/scripts/rig-body-guard.cjs": "// guard\n",
  "skills/openrig-skills/SKILL.md": skill("openrig-skills", "package text"),
  "skills/refocusing/SKILL.md": skill("refocusing", "refocus"),
};

const STALE_TREE = {
  ...manifests,
  "hooks/claude.json": STALE_HOOKS,
  "hooks/scripts/retired-helper.cjs": "// the package no longer ships this\n",
  "skills/openrig-skills/SKILL.md": skill("openrig-skills", "stale text"),
  "skills/refocusing/SKILL.md": skill("refocusing", "refocus"),
};

/** The fs ops startup.ts hands PluginVendorService: the production adapter itself. */
const startupVendorFs = nodePluginVendorFs;

/** The adapter fs ops startup.ts hands the Claude and Codex adapters, over the real filesystem. */
function adapterFs(home: string) {
  return { ...startupVendorFs(), copyFile: (s: string, d: string) => fs.copyFileSync(s, d), readdir: (d: string) => fs.readdirSync(d), homedir: home };
}


/** A host with an installed package newer in content than OPENRIG_HOME/plugins, both at the same plugin version. */
function driftedHost() {
  const root = mkTemp(nodePath.join(os.tmpdir(), "o9o17-drift-"));
  const assetsDir = nodePath.join(root, "package", "assets", "plugins");
  const openrigHome = nodePath.join(root, "openrig-home");
  const home = nodePath.join(root, "home");
  const cwd = nodePath.join(root, "seat");
  writeTree(nodePath.join(assetsDir, PLUGIN), PACKAGE_TREE);
  writeTree(nodePath.join(openrigHome, "plugins", PLUGIN), STALE_TREE);
  // A global seed OpenRig wrote earlier from the stale copy, marked with the same plugin version.
  for (const r of [nodePath.join(home, ".claude", "skills"), nodePath.join(home, ".agents", "skills")]) {
    writeTree(nodePath.join(r, "openrig-skills"), { "SKILL.md": skill("openrig-skills", "stale text"), ".openrig-vendor-version": `${VERSION}\n` });
  }
  fs.mkdirSync(cwd, { recursive: true });
  return { assetsDir, openrigHome, home, cwd, packageDir: nodePath.join(assetsDir, PLUGIN) };
}

/** What a daemon start does with openrig-core (startup.ts: ensureLatest, then the global seeds). */
async function daemonStart(host: ReturnType<typeof driftedHost>, logs: string[] = [], errors: string[] = []) {
  const vendor = new PluginVendorService({
    vendoredAssetsDir: host.assetsDir,
    userPluginsDir: nodePath.join(host.openrigHome, "plugins"),
    fs: startupVendorFs(),
    httpClient: async () => ({ ok: false, status: 404 }),
    logger: (...args: unknown[]) => logs.push(args.join(" ")),
    errorLogger: (...args: unknown[]) => errors.push(args.join(" ")),
  });
  await vendor.ensureLatest(PLUGIN);
  for (const name of ["openrig-skills", "refocusing"]) {
    vendor.ensureSkillGlobally(PLUGIN, name, [nodePath.join(host.home, ".claude", "skills"), nodePath.join(host.home, ".agents", "skills")]);
  }
}

/** The plugin's projection entry as the planner builds it from the builtin shared spec. */
function sharedPluginEntry(openrigHome: string): ProjectionEntry {
  const resourcePath = "openrig-home:plugins/openrig-core";
  return {
    category: "plugin",
    effectiveId: `shared:${PLUGIN}`,
    sourceSpec: "shared",
    sourcePath: "/specs/agents/shared",
    resourcePath,
    absolutePath: resolvePluginPath(resourcePath, "/specs/agents/shared", openrigHome),
    classification: "safe_projection",
    pluginType: "auto",
  };
}

const plan = (runtime: string, cwd: string, entries: ProjectionEntry[]): ProjectionPlan => ({
  runtime, cwd, entries, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
});

const binding = (cwd: string): NodeBinding => ({ id: "b1", nodeId: "n1", tmuxSession: "s", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd });
const read = (p: string) => fs.readFileSync(p, "utf-8");

describe("o9o.17: an installed package newer than OPENRIG_HOME/plugins projects the package's openrig-core", () => {
  it("a Claude seat started after a daemon start gets the package's hooks manifest and guard script, not the old copy", async () => {
    const host = driftedHost();
    await daemonStart(host);
    const adapter = new ClaudeCodeAdapter({ tmux: tmuxStub({}), fsOps: adapterFs(host.home) });
    await adapter.project(plan("claude-code", host.cwd, [sharedPluginEntry(host.openrigHome)]), binding(host.cwd));

    const projected = nodePath.join(host.cwd, ".claude", "plugins", `shared:${PLUGIN}`);
    expect(read(nodePath.join(projected, "hooks", "claude.json")), "projected hooks manifest is the old copy (no PreToolUse guard)").toBe(PACKAGE_HOOKS);
    expect(fs.existsSync(nodePath.join(projected, "hooks", "scripts", "rig-body-guard.cjs")), "projected plugin lacks rig-body-guard.cjs").toBe(true);
  });

  it("a Codex seat started after a daemon start gets the package's plugin folder, not the old copy", async () => {
    const host = driftedHost();
    await daemonStart(host);
    const adapter = new CodexRuntimeAdapter({ tmux: tmuxStub({}), fsOps: adapterFs(host.home) });
    await adapter.project(plan("codex", host.cwd, [sharedPluginEntry(host.openrigHome)]), binding(host.cwd));

    expect(read(nodePath.join(host.cwd, ".codex", "plugins", `shared:${PLUGIN}`, "hooks", "claude.json"))).toBe(PACKAGE_HOOKS);
  });

  it("the plugin skills a Claude seat's loadout reads are the package's text, not the old copy's", async () => {
    const host = driftedHost();
    await daemonStart(host);
    const entry = sharedPluginEntry(host.openrigHome);
    const { entries } = resolvePluginSkills({ pluginId: entry.effectiveId, pluginRoot: entry.absolutePath, runtime: "claude-code", pluginType: "auto" });
    const openrigSkills = entries.find((e) => e.id === "openrig-skills");

    expect(openrigSkills, "openrig-skills missing from the loadout").toBeDefined();
    expect(read(nodePath.join(openrigSkills!.sourceDir, "SKILL.md")), "loadout skill text is the old copy's").toBe(PACKAGE_TREE["skills/openrig-skills/SKILL.md"]);
  });

  it("a global skill seed OpenRig marked at the same plugin version is refreshed to the package's text", async () => {
    const host = driftedHost();
    await daemonStart(host);

    for (const r of [".claude", ".agents"]) {
      expect(read(nodePath.join(host.home, r, "skills", "openrig-skills", "SKILL.md")), `${r} global seed kept the old text`).toBe(PACKAGE_TREE["skills/openrig-skills/SKILL.md"]);
    }
  });

  it("after a daemon start OPENRIG_HOME/plugins holds exactly the package's files, with none the package dropped", async () => {
    const host = driftedHost();
    await daemonStart(host);
    const copy = nodePath.join(host.openrigHome, "plugins", PLUGIN);

    expect(startupVendorFs().listFiles(copy).sort()).toEqual(startupVendorFs().listFiles(host.packageDir).sort());
    for (const rel of Object.keys(PACKAGE_TREE)) expect(read(nodePath.join(copy, rel)), rel).toBe(read(nodePath.join(host.packageDir, rel)));
  });

  it("logs the installed version it replaced and reports no drift once the copy matches", async () => {
    const host = driftedHost();
    const logs: string[] = [];
    const errors: string[] = [];
    await daemonStart(host, logs, errors);

    expect(logs.join("\n")).toMatch(/replacing installed 'openrig-core' 0\.1\.9 .* with the running package's 0\.1\.9/);
    expect(errors).toEqual([]);
  });
});

describe("o9o.17: the refresh never writes or removes outside the managed copy", () => {
  it("a symlink inside OPENRIG_HOME/plugins/openrig-core is not followed: its outside target survives, byte for byte", async () => {
    const host = driftedHost();
    const outsideDir = nodePath.join(host.home, "outside");
    writeTree(outsideDir, { "precious.txt": "keep me\n", "claude.json": "outside manifest\n" });
    const copy = nodePath.join(host.openrigHome, "plugins", PLUGIN);
    // A link the package does not ship (a removal candidate) and a link where the package ships a file (a write candidate).
    fs.symlinkSync(nodePath.join(outsideDir, "precious.txt"), nodePath.join(copy, "hooks", "scripts", "linked.cjs"));
    fs.rmSync(nodePath.join(copy, "hooks", "claude.json"));
    fs.symlinkSync(nodePath.join(outsideDir, "claude.json"), nodePath.join(copy, "hooks", "claude.json"));
    // A linked directory the package does not ship.
    fs.symlinkSync(outsideDir, nodePath.join(copy, "linked-dir"));
    const errors: string[] = [];
    await daemonStart(host, [], errors);

    expect(read(nodePath.join(outsideDir, "precious.txt"))).toBe("keep me\n");
    expect(read(nodePath.join(outsideDir, "claude.json"))).toBe("outside manifest\n");
    expect(fs.readdirSync(outsideDir).sort()).toEqual(["claude.json", "precious.txt"]);
    // The refused paths are reported, never passed off as a verified copy.
    expect(errors.join("\n")).toMatch(/still differs from the running package/);
    expect(errors.join("\n")).toMatch(/hooks\/claude\.json \(differs\)/);
  });

  it("a symlinked file whose outside target holds the package's exact bytes is reported, not passed as verified", async () => {
    const host = driftedHost();
    const outside = nodePath.join(host.home, "outside-hooks.json");
    fs.writeFileSync(outside, PACKAGE_HOOKS);
    const copy = nodePath.join(host.openrigHome, "plugins", PLUGIN);
    fs.rmSync(nodePath.join(copy, "hooks", "claude.json"));
    fs.symlinkSync(outside, nodePath.join(copy, "hooks", "claude.json"));
    const errors: string[] = [];
    await daemonStart(host, [], errors);

    expect(errors.join("\n")).toMatch(/hooks\/claude\.json \(differs\)/);
  });

  it("a path that climbs out of the copy ('..') is never written", async () => {
    const host = driftedHost();
    const escapee = nodePath.join(host.openrigHome, "plugins", "escaped.txt");
    const base = nodePluginVendorFs();
    const vendor = new PluginVendorService({
      vendoredAssetsDir: host.assetsDir,
      userPluginsDir: nodePath.join(host.openrigHome, "plugins"),
      // A listing that names a path outside the plugin folder, as a corrupt or hostile source tree could.
      fs: { ...base, listFiles: (dir) => dir.endsWith(nodePath.join("assets", "plugins", PLUGIN)) ? [...base.listFiles(dir), nodePath.join("..", "escaped.txt")] : base.listFiles(dir), readFile: (p) => p === nodePath.join(host.assetsDir, "escaped.txt") ? "escaped\n" : base.readFile(p) },
      httpClient: async () => ({ ok: false, status: 404 }),
    });
    fs.writeFileSync(nodePath.join(host.assetsDir, "escaped.txt"), "escaped\n");
    await vendor.ensureVendored(PLUGIN);

    expect(fs.existsSync(escapee)).toBe(false);
  });

  it("a path that climbs out of the copy ('..') is never removed", async () => {
    const host = driftedHost();
    const neighbour = nodePath.join(host.openrigHome, "plugins", "neighbour.txt");
    fs.writeFileSync(neighbour, "a neighbour's file\n");
    const base = nodePluginVendorFs();
    const copy = nodePath.join(host.openrigHome, "plugins", PLUGIN);
    const vendor = new PluginVendorService({
      vendoredAssetsDir: host.assetsDir,
      userPluginsDir: nodePath.join(host.openrigHome, "plugins"),
      // A target listing that names a file outside the copy, as a corrupt listing could.
      fs: { ...base, listFiles: (dir) => dir === copy ? [...base.listFiles(dir), nodePath.join("..", "neighbour.txt")] : base.listFiles(dir) },
      httpClient: async () => ({ ok: false, status: 404 }),
    });
    await vendor.ensureVendored(PLUGIN);

    expect(read(neighbour)).toBe("a neighbour's file\n");
  });

  it("a plugin copy that is itself a symlink is left alone and reported", async () => {
    const host = driftedHost();
    const copy = nodePath.join(host.openrigHome, "plugins", PLUGIN);
    const elsewhere = nodePath.join(host.home, "dev-checkout", PLUGIN);
    fs.mkdirSync(nodePath.dirname(elsewhere), { recursive: true });
    fs.renameSync(copy, elsewhere);
    fs.symlinkSync(elsewhere, copy);
    const errors: string[] = [];
    await daemonStart(host, [], errors);

    expect(read(nodePath.join(elsewhere, "hooks", "claude.json"))).toBe(STALE_HOOKS);
    expect(fs.existsSync(nodePath.join(elsewhere, "hooks", "scripts", "retired-helper.cjs"))).toBe(true);
    expect(errors.join("\n")).toMatch(/plugin 'openrig-core' .* still differs/);
  });
});

describe("o9o.17: global skill targets OpenRig did not write are left alone", () => {
  it("an unversioned target and a symlinked target keep their bytes, while a marked target (positive control) is refreshed", async () => {
    const host = driftedHost();
    const claudeRoot = nodePath.join(host.home, ".claude", "skills");
    const agentsRoot = nodePath.join(host.home, ".agents", "skills");
    // ~/.claude: installed another way (no marker).
    fs.rmSync(nodePath.join(claudeRoot, "openrig-skills", ".openrig-vendor-version"));
    // ~/.agents: a symlink to a shared canon that does carry a marker.
    const canon = nodePath.join(host.home, "canon", "openrig-skills");
    writeTree(canon, { "SKILL.md": skill("openrig-skills", "shared canon"), ".openrig-vendor-version": `${VERSION}\n` });
    fs.rmSync(nodePath.join(agentsRoot, "openrig-skills"), { recursive: true });
    fs.symlinkSync(canon, nodePath.join(agentsRoot, "openrig-skills"));
    // A third root holding OpenRig's own marked copy.
    const markedRoot = nodePath.join(host.home, "marked", "skills");
    writeTree(nodePath.join(markedRoot, "openrig-skills"), { "SKILL.md": skill("openrig-skills", "stale text"), "dropped.md": "old\n", ".openrig-vendor-version": "0.2.0\n" });

    await daemonStart(host);
    const vendor = new PluginVendorService({ vendoredAssetsDir: host.assetsDir, userPluginsDir: nodePath.join(host.openrigHome, "plugins"), fs: nodePluginVendorFs(), httpClient: async () => ({ ok: false, status: 404 }) });
    vendor.ensureSkillGlobally(PLUGIN, "openrig-skills", [claudeRoot, agentsRoot, markedRoot]);

    expect(read(nodePath.join(claudeRoot, "openrig-skills", "SKILL.md"))).toBe(skill("openrig-skills", "stale text"));
    expect(fs.existsSync(nodePath.join(claudeRoot, "openrig-skills", ".openrig-vendor-version"))).toBe(false);
    expect(read(nodePath.join(canon, "SKILL.md"))).toBe(skill("openrig-skills", "shared canon"));
    expect(fs.readdirSync(canon).sort()).toEqual([".openrig-vendor-version", "SKILL.md"]);
    // Positive control: OpenRig's own marked copy (marker newer than the package) is made to match the package.
    expect(read(nodePath.join(markedRoot, "openrig-skills", "SKILL.md"))).toBe(PACKAGE_TREE["skills/openrig-skills/SKILL.md"]);
    expect(fs.existsSync(nodePath.join(markedRoot, "openrig-skills", "dropped.md"))).toBe(false);
    expect(read(nodePath.join(markedRoot, "openrig-skills", ".openrig-vendor-version"))).toBe(`${VERSION}\n`);
  });
});
