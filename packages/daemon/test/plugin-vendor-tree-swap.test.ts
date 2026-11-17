// workspaces-o9o.55: the vendor refresh replaced OPENRIG_HOME/plugins/<name> file by file. Each write was atomic, the tree
// was not: a full disk partway through left the installed copy mixed (some files new, some old, dropped files still
// there) for that whole boot. Now the new copy is built in a private staging folder beside it, verified, and swapped in
// whole; a failure before the swap leaves the installed copy exactly as it was. Real temp folders through the real
// adapter; only the failing write is simulated (a full disk after the Nth write).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

const failing = vi.hoisted(() => ({ afterWrites: -1, writes: 0, fixedRandom: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  /** Counts content writes; once armed, the write after `afterWrites` successful ones fails as a full disk does. */
  const writeFileSync: typeof real.writeFileSync = (file, data, options) => {
    if (failing.afterWrites >= 0 && failing.writes++ >= failing.afterWrites) {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return real.writeFileSync(file, data, options);
  };
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  /** When pinned, the temp-name suffix is predictable, so a test can plant a link at it. */
  const randomBytes = ((size: number) => (failing.fixedRandom === null ? real.randomBytes(size) : Buffer.from(failing.fixedRandom, "hex"))) as typeof real.randomBytes;
  return { ...real, default: { ...real, randomBytes }, randomBytes };
});

import * as fs from "node:fs";
import { nodePluginVendorFs } from "../src/adapters/plugin-vendor-fs.js";
import { PluginVendorService, refreshPluginAndSeeds } from "../src/domain/plugin-vendor-service.js";

const made: string[] = [];
afterEach(() => {
  failing.afterWrites = -1; failing.writes = 0; failing.fixedRandom = null;
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o55-"));
  made.push(d);
  return d;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(nodePath.join(d, e.name), rel);
      else out[rel] = createHash("sha256").update(fs.readFileSync(nodePath.join(d, e.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

function put(dir: string, rel: string, content: string): void {
  fs.mkdirSync(nodePath.dirname(nodePath.join(dir, rel)), { recursive: true });
  fs.writeFileSync(nodePath.join(dir, rel), content);
}

/** A package with openrig-core 0.2.0 (five files) and an installed 0.1.0 copy that differs in every file and has one the
 *  package dropped. */
function world() {
  const root = tempDir();
  const assets = nodePath.join(root, "package", "assets", "plugins");
  const home = nodePath.join(root, "openrig-home");
  const plugins = nodePath.join(home, "plugins");
  const source = nodePath.join(assets, "openrig-core");
  const installed = nodePath.join(plugins, "openrig-core");
  put(source, ".claude-plugin/plugin.json", JSON.stringify({ name: "openrig-core", version: "0.2.0" }));
  for (const f of ["hooks/a.cjs", "hooks/b.cjs", "skills/x/SKILL.md", "skills/y/SKILL.md"]) put(source, f, `new ${f}\n`);
  put(installed, ".claude-plugin/plugin.json", JSON.stringify({ name: "openrig-core", version: "0.1.0" }));
  for (const f of ["hooks/a.cjs", "hooks/b.cjs", "skills/x/SKILL.md", "skills/y/SKILL.md", "hooks/dropped.cjs"]) put(installed, f, `old ${f}\n`);
  const errors: string[] = [];
  const service = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: plugins, fs: nodePluginVendorFs(),
    httpClient: async () => ({ ok: false, status: 404 }), logger: () => {}, errorLogger: (...args) => errors.push(args.join(" ")) });
  return { plugins, source, installed, service, errors };
}

describe("o9o.55: the vendor refresh swaps the whole tree, never leaves a mixed copy", () => {
  it("a full disk partway through the refresh leaves the installed copy exactly as it was", async () => {
    const w = world();
    const before = tree(w.installed);
    failing.afterWrites = 2;
    await w.service.ensureVendored("openrig-core").catch(() => {});
    failing.afterWrites = -1;
    expect(tree(w.installed)).toEqual(before);
    expect(fs.readdirSync(w.plugins)).toEqual(["openrig-core"]);
  });

  it("a refresh that succeeds leaves exactly the package's files, and nothing beside the copy", async () => {
    const w = world();
    await w.service.ensureVendored("openrig-core");
    expect(tree(w.installed)).toEqual(tree(w.source));
    expect(fs.readdirSync(w.plugins)).toEqual(["openrig-core"]);
  });

  it("a staging or old folder a crashed refresh left is removed at the next refresh; an operator's own folder is not", async () => {
    const w = world();
    put(nodePath.join(w.plugins, ".openrig-core.openrig-staging-1234-abcdef"), "hooks/a.cjs", "half\n");
    put(nodePath.join(w.plugins, ".openrig-core.openrig-old-1234-abcdef"), "hooks/a.cjs", "old\n");
    put(nodePath.join(w.plugins, "openrig-core.bak"), "hooks/a.cjs", "mine\n");
    await w.service.ensureVendored("openrig-core");
    expect(fs.readdirSync(w.plugins).sort()).toEqual(["openrig-core", "openrig-core.bak"]);
  });

  it("an exact copy with leftovers beside it (a crash after the swap, before the old tree went) is cleaned, the copy untouched", async () => {
    const w = world();
    await w.service.ensureVendored("openrig-core");
    const exact = tree(w.installed);
    put(nodePath.join(w.plugins, ".openrig-core.openrig-old-1234-abcdef"), "hooks/a.cjs", "old\n");
    put(nodePath.join(w.plugins, ".openrig-core.openrig-staging-1234-abcdef"), "hooks/a.cjs", "half\n");
    await w.service.ensureVendored("openrig-core");
    expect(fs.readdirSync(w.plugins)).toEqual(["openrig-core"]);
    expect(tree(w.installed)).toEqual(exact);
  });

  it("a staging name planted as a symlink is never followed: its target stays", async () => {
    const w = world();
    const outside = tempDir();
    put(outside, "hooks/a.cjs", "outside\n");
    fs.symlinkSync(outside, nodePath.join(w.plugins, ".openrig-core.openrig-staging-1234-abcdef"));
    await w.service.ensureVendored("openrig-core");
    expect(fs.readFileSync(nodePath.join(outside, "hooks/a.cjs"), "utf-8")).toBe("outside\n");
    expect(tree(w.installed)).toEqual(tree(w.source));
  });
});

describe("o9o.55: a staged copy is swapped in only when it is right, and a failed swap puts the old copy back", () => {
  function worldWith(wrap: (base: ReturnType<typeof nodePluginVendorFs>) => ReturnType<typeof nodePluginVendorFs>) {
    const w = world();
    const errors: string[] = [];
    const service = new PluginVendorService({ vendoredAssetsDir: nodePath.dirname(w.source), userPluginsDir: w.plugins, fs: wrap(nodePluginVendorFs()),
      httpClient: async () => ({ ok: false, status: 404 }), logger: () => {}, errorLogger: (...args) => errors.push(args.join(" ")) });
    return { ...w, service, errors };
  }

  it("a staged copy that does not match the package is not swapped in: the installed copy stays, and it is reported", async () => {
    // A disk that silently loses one write into the staging folder.
    const w = worldWith((base) => ({ ...base, writeFile: (p, c, m) => { if (!(p.includes(".openrig-staging-") && p.endsWith("y/SKILL.md"))) base.writeFile(p, c, m); } }));
    const before = tree(w.installed);
    await w.service.ensureVendored("openrig-core");
    expect(tree(w.installed)).toEqual(before);
    expect(fs.readdirSync(w.plugins)).toEqual(["openrig-core"]);
    expect(w.errors.join("\n")).toMatch(/staged copy still differs/);
  });

  it("a swap whose second rename fails puts the old copy back whole", async () => {
    const w = worldWith((base) => ({ ...base, rename: (from, to) => {
      if (from.includes(".openrig-staging-")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      base.rename(from, to);
    } }));
    const before = tree(w.installed);
    await expect(w.service.ensureVendored("openrig-core")).rejects.toThrow(/EIO/);
    expect(tree(w.installed)).toEqual(before);
    expect(fs.readdirSync(w.plugins)).toEqual(["openrig-core"]);
  });
});

describe("o9o.55: the temp file is created exclusively (O_EXCL)", () => {
  it("a link planted at the temp file's name is refused, never written through", () => {
    const d = tempDir();
    const outside = nodePath.join(tempDir(), "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    failing.fixedRandom = "a1b2c3d4e5f6";
    const target = nodePath.join(d, "claude.json");
    fs.symlinkSync(outside, nodePath.join(d, `.claude.json.openrig-${process.pid}-a1b2c3d4e5f6.tmp`));
    expect(() => nodePluginVendorFs().writeFile(target, "new\n")).toThrow(/EEXIST/);
    expect(fs.readFileSync(outside, "utf-8")).toBe("outside\n");
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("o9o.55: a failed plugin refresh does not skip the global seed refreshes", () => {
  it("a refresh that throws is reported, and every seed is still refreshed", async () => {
    const seeded: string[] = [];
    const warnings: string[] = [];
    await refreshPluginAndSeeds({
      ensureLatest: async () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); },
      ensureSkillGlobally: (_plugin: string, skill: string) => { seeded.push(skill); },
    }, "openrig-core", ["openrig-skills", "refocusing"], ["/nowhere"], (m) => warnings.push(m));
    expect(seeded).toEqual(["openrig-skills", "refocusing"]);
    expect(warnings).toEqual([expect.stringContaining("openrig-core plugin refresh warning: ENOSPC")]);
  });
});
