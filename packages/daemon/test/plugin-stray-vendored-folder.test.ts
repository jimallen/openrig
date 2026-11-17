// workspaces-o9o.44: one stray folder in OPENRIG_HOME/plugins must not stop the daemon. Measured on Sparky 2026-11-16
// (0.6.10): an operator's backup copy, plugins/openrig-core.bak-20261021-stale, beside the real openrig-core made the
// plugin discovery service throw "Duplicate hook registration" while the daemon was being built. systemd restarted it
// 55 times in about 11 minutes, and every seat's rig CLI was down until the folder was moved out by hand.
// Now the daemon keeps one provider (the folder whose manifest names it), ignores the other, says which folder and why,
// and never moves or deletes it. Every root here is a temp dir (OPENRIG_HOME and HOME): nothing touches ~/.openrig.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";
import { findIgnoredVendoredPlugins, scanVendoredPluginFolders } from "../src/adapters/vendored-plugin-folders.js";
import { killIfRunning, spawnDaemonEntrypoint, type EntrypointDaemon } from "./helpers/daemon-entrypoint.js";

const PACKAGE_CORE = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const STALE = "openrig-core.bak-20261021-stale";

const roots: string[] = [];
const daemons: EntrypointDaemon[] = [];
afterEach(() => {
  for (const d of daemons.splice(0)) killIfRunning(d.child);
  for (const r of roots.splice(0)) {
    fs.chmodSync(r, 0o700);
    for (const p of walkDirs(r)) fs.chmodSync(p, 0o700);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

function walkDirs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const p = nodePath.join(dir, e.name);
      fs.chmodSync(p, 0o700);
      out.push(p, ...walkDirs(p));
    }
  }
  return out;
}

function tempRoot(): string {
  const r = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o44-"));
  roots.push(r);
  return r;
}

/** Every file under dir with its sha256, so a moved, edited or deleted file shows. */
function treeDigest(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = nodePath.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else out.push(`${r} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out;
}

function discovery(pluginsDir: string, warnings: string[]): PluginDiscoveryService {
  const root = nodePath.dirname(pluginsDir);
  return new PluginDiscoveryService({
    openrigPluginsDir: pluginsDir,
    claudeCacheDir: nodePath.join(root, "claude-cache"),
    codexCacheDir: nodePath.join(root, "codex-cache"),
    specLibraryDir: nodePath.join(root, "specs"),
    warn: (message: string) => warnings.push(message),
    scanVendoredPluginFolders,
  });
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A minimal Claude plugin that registers one Stop hook running scripts/<script>. */
function plugin(dir: string, name: string, script: string): void {
  writeJson(nodePath.join(dir, ".claude-plugin", "plugin.json"), { name, version: "0.1.0", hooks: "./hooks/claude.json" });
  writeJson(nodePath.join(dir, "hooks", "claude.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/${script}"`, timeout: 5 }] }] },
  });
}

describe("o9o.44: a stray folder in OPENRIG_HOME/plugins does not stop plugin discovery", () => {
  it("a stale copy of openrig-core beside the real one is ignored and named; the real one is listed", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, "openrig-core"), { recursive: true });
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, STALE), { recursive: true });
    const warnings: string[] = [];

    const service = discovery(plugins, warnings);

    expect(service.listPlugins({ sourceFilter: "vendored" }).map((p) => p.id)).toEqual(["openrig-core"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(nodePath.join(plugins, STALE));
    expect(warnings[0]).toContain(nodePath.join(plugins, "openrig-core"));
    expect(warnings[0]).toMatch(/ignored/);
  });

  it("the folder whose manifest names the plugin wins even when the copy sorts first", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, "a-copy-of-openrig-core"), { recursive: true });
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, "openrig-core"), { recursive: true });
    const warnings: string[] = [];

    const service = discovery(plugins, warnings);

    expect(service.listPlugins({ sourceFilter: "vendored" }).map((p) => p.id)).toEqual(["openrig-core"]);
    expect(findIgnoredVendoredPlugins(plugins).map((i) => i.path)).toEqual([nodePath.join(plugins, "a-copy-of-openrig-core")]);
  });

  it("two plugins registering the same hook: the later one in folder order is ignored, with the hook and both files named", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    plugin(nodePath.join(plugins, "openrig-core"), "openrig-core", "refocus.cjs");
    plugin(nodePath.join(plugins, "openrig-rogue"), "openrig-rogue", "refocus.cjs");
    const warnings: string[] = [];

    const service = discovery(plugins, warnings);

    expect(service.listPlugins({ sourceFilter: "vendored" }).map((p) => p.id)).toEqual(["openrig-core"]);
    const all = findIgnoredVendoredPlugins(plugins);
    expect(all).toHaveLength(1);
    const ignored = all[0]!;
    expect(ignored.path).toBe(nodePath.join(plugins, "openrig-rogue"));
    expect(ignored.keptPath).toBe(nodePath.join(plugins, "openrig-core"));
    expect(ignored.reason).toContain("refocus.cjs");
    expect(ignored.reason).toContain(nodePath.join(plugins, "openrig-core", "hooks", "claude.json"));
    expect(ignored.reason).toContain(nodePath.join(plugins, "openrig-rogue", "hooks", "claude.json"));
  });

  it("plugins with different hooks are all kept and nothing is reported", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    plugin(nodePath.join(plugins, "openrig-core"), "openrig-core", "refocus.cjs");
    plugin(nodePath.join(plugins, "other"), "other", "other.cjs");
    const warnings: string[] = [];

    const service = discovery(plugins, warnings);

    expect(service.listPlugins({ sourceFilter: "vendored" }).map((p) => p.id).sort()).toEqual(["openrig-core", "other"]);
    expect(findIgnoredVendoredPlugins(plugins)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("the ignored folder is left byte for byte, never moved or deleted", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, "openrig-core"), { recursive: true });
    fs.cpSync(PACKAGE_CORE, nodePath.join(plugins, STALE), { recursive: true });
    const before = treeDigest(nodePath.join(plugins, STALE));

    const service = discovery(plugins, []);
    service.listPlugins();
    service.getPlugin(STALE);

    expect(treeDigest(nodePath.join(plugins, STALE))).toEqual(before);
  });

  it.skipIf(process.getuid?.() === 0)("a read-only openrig-lab whose obsolete refocus hook cannot be retired is ignored, not fatal (needs non-root)", () => {
    const plugins = nodePath.join(tempRoot(), "plugins");
    plugin(nodePath.join(plugins, "openrig-core"), "openrig-core", "refocus.cjs");
    const lab = nodePath.join(plugins, "openrig-lab");
    plugin(lab, "openrig-lab", "refocus.cjs");
    const labHooks = nodePath.join(lab, "hooks");
    const before = treeDigest(lab);
    fs.chmodSync(labHooks, 0o555);
    const warnings: string[] = [];

    const service = discovery(plugins, warnings);

    expect(service.listPlugins({ sourceFilter: "vendored" }).map((p) => p.id)).toEqual(["openrig-core"]);
    expect(warnings.join("\n")).toContain(lab);
    fs.chmodSync(labHooks, 0o755);
    expect(treeDigest(lab)).toEqual(before);
  });
});

describe("o9o.44: the daemon starts with a stale openrig-core copy in its plugins folder", () => {
  it("starts, serves openrig-core, names the ignored folder in its log, and leaves the folder as it was", async () => {
    const root = tempRoot();
    const home = nodePath.join(root, "instance");
    const userHome = nodePath.join(root, "home");
    fs.mkdirSync(userHome, { recursive: true });
    const stale = nodePath.join(home, "plugins", STALE);
    fs.cpSync(PACKAGE_CORE, stale, { recursive: true });
    const before = treeDigest(stale);

    const daemon = await spawnDaemonEntrypoint({ home, env: { HOME: userHome }, readyTimeoutMs: 90_000, attempts: 2 });
    daemons.push(daemon);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/plugins?source=vendored`);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("openrig-core");
    expect(ids).not.toContain(STALE);
    expect(daemon.stderr() + daemon.stdout()).toContain(stale);
    expect(treeDigest(stale)).toEqual(before);
  }, 120_000);
});
