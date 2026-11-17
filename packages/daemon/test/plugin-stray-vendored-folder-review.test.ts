// workspaces-o9o.44, verify-qa review (FAIL, 3 confirmed): one row set per finding. Temp folders only.
//  1. The obsolete openrig-lab refocus migration runs at daemon start and wrote through a symlinked plugin folder: an
//     outside hooks file was rewritten. It must refuse any write whose path from OPENRIG_HOME down crosses a symlink.
//  2. A self-named stale folder sorting before "openrig-core" won a hook conflict with it. The canonical openrig-core
//     folder (the one seats load) always wins; folder order breaks ties only between other folders.
//  3. The selection rule is pure domain logic over in-memory folders; the folder scan is an adapter behind it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as discovery from "../src/domain/plugin-discovery-service.js";
import { findIgnoredVendoredPlugins } from "../src/vendored-plugin-conflicts-surface.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function home(): { root: string; plugins: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o44-review-"));
  roots.push(root);
  const plugins = path.join(root, ".openrig", "plugins");
  const outside = path.join(root, "outside");
  fs.mkdirSync(plugins, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { root, plugins, outside };
}

const REFOCUS = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"';
function plugin(dir: string, name: string, command = REFOCUS): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "0.1.0", hooks: "./hooks/claude.json" }));
  fs.writeFileSync(path.join(dir, "hooks", "claude.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }));
}

function service(plugins: string, warnings: string[]): discovery.PluginDiscoveryService {
  const spare = path.join(path.dirname(plugins), "spare");
  return new discovery.PluginDiscoveryService({
    openrigPluginsDir: plugins, claudeCacheDir: path.join(spare, "c"), codexCacheDir: path.join(spare, "x"),
    specLibraryDir: path.join(spare, "s"), warn: (m) => warnings.push(m),
  });
}

describe("o9o.44 review 1: the openrig-lab migration never writes through a symlink", () => {
  it("leaves an outside folder byte-identical when plugins/openrig-lab is a symlink to it, and says why", () => {
    const { plugins, outside } = home();
    plugin(outside, "openrig-lab");
    fs.symlinkSync(outside, path.join(plugins, "openrig-lab"));
    const sentinel = path.join(outside, "hooks", "claude.json");
    const before = fs.readFileSync(sentinel);
    const manifestBefore = fs.readFileSync(path.join(outside, ".claude-plugin", "plugin.json"));
    const warnings: string[] = [];
    service(plugins, warnings);
    expect(fs.readFileSync(sentinel)).toEqual(before);
    expect(fs.readFileSync(path.join(outside, ".claude-plugin", "plugin.json"))).toEqual(manifestBefore);
    expect(fs.readdirSync(path.join(outside, "hooks"))).toEqual(["claude.json"]);
    expect(warnings.some((w) => w.includes("symlink") && w.includes("openrig-lab"))).toBe(true);
  });

  it("leaves an outside file byte-identical when the lab's hooks file is a symlink to it", () => {
    const { plugins, outside } = home();
    const lab = path.join(plugins, "openrig-lab");
    plugin(lab, "openrig-lab");
    const target = path.join(outside, "claude.json");
    fs.renameSync(path.join(lab, "hooks", "claude.json"), target);
    fs.symlinkSync(target, path.join(lab, "hooks", "claude.json"));
    const before = fs.readFileSync(target);
    service(plugins, []);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.lstatSync(path.join(lab, "hooks", "claude.json")).isSymbolicLink()).toBe(true);
  });

  it("leaves an outside tree byte-identical when OPENRIG_HOME/plugins itself is a symlink to it", () => {
    const { root, outside } = home();
    const home2 = path.join(root, "home2", ".openrig");
    fs.mkdirSync(home2, { recursive: true });
    plugin(path.join(outside, "openrig-lab"), "openrig-lab");
    fs.symlinkSync(outside, path.join(home2, "plugins"));
    const sentinel = path.join(outside, "openrig-lab", "hooks", "claude.json");
    const before = fs.readFileSync(sentinel);
    service(path.join(home2, "plugins"), []);
    expect(fs.readFileSync(sentinel)).toEqual(before);
  });

  it("still retires the refocus hook from a real (unlinked) lab folder, so the refusal is not a blanket skip", () => {
    const { plugins } = home();
    const lab = path.join(plugins, "openrig-lab");
    plugin(lab, "openrig-lab");
    service(plugins, []);
    expect(JSON.parse(fs.readFileSync(path.join(lab, "hooks", "claude.json"), "utf8"))).toEqual({ hooks: {} });
  });
});

describe("o9o.44 review 2: the canonical openrig-core folder always wins a conflict with it", () => {
  it.each(["00-stale", "zz-stale"])("a self-named %s copy of core's hooks is ignored, whichever side of openrig-core it sorts", (stale) => {
    const { plugins } = home();
    plugin(path.join(plugins, "openrig-core"), "openrig-core");
    plugin(path.join(plugins, stale), stale);
    expect(findIgnoredVendoredPlugins(plugins)).toEqual([expect.objectContaining({
      path: path.join(plugins, stale), keptPath: path.join(plugins, "openrig-core") })]);
  });

  it("between two non-core folders, the one whose manifest names it beats a copy that sorts first", () => {
    const { plugins } = home();
    plugin(path.join(plugins, "foo"), "foo", "node /x/foo-hook.js");
    plugin(path.join(plugins, "a-copy-of-foo"), "foo", "node /x/foo-hook.js");
    expect(findIgnoredVendoredPlugins(plugins).map((i: { path: string }) => path.basename(i.path))).toEqual(["a-copy-of-foo"]);
  });

  it("between two non-core folders, folder order still breaks the tie", () => {
    const { plugins } = home();
    plugin(path.join(plugins, "bbb"), "bbb", "node /x/hook.js");
    plugin(path.join(plugins, "aaa"), "aaa", "node /x/hook.js");
    expect(findIgnoredVendoredPlugins(plugins).map((i: { path: string }) => path.basename(i.path))).toEqual(["bbb"]);
  });
});

describe("o9o.44 review 3: the selection rule is pure; the scan is an adapter", () => {
  it("selectIgnoredVendoredPlugins decides from in-memory folders, with no filesystem", () => {
    const hook = { identity: '["claude","Stop","","command","x"]', hooksPath: "/nowhere/hooks.json" };
    const select = (discovery as unknown as { selectIgnoredVendoredPlugins: (f: unknown[]) => Array<{ path: string; keptPath: string }> })
      .selectIgnoredVendoredPlugins;
    expect(select([
      { entry: "00-stale", pluginPath: "/nowhere/00-stale", manifestNames: ["00-stale"], hooks: [hook] },
      { entry: "openrig-core", pluginPath: "/nowhere/openrig-core", manifestNames: ["openrig-core"], hooks: [hook] },
      { entry: "other", pluginPath: "/nowhere/other", manifestNames: ["other"], hooks: [] },
    ])).toEqual([expect.objectContaining({ path: "/nowhere/00-stale", keptPath: "/nowhere/openrig-core" })]);
  });

  it("the domain module no longer exports a filesystem scan", () => {
    expect("findIgnoredVendoredPlugins" in discovery).toBe(false);
  });
});
