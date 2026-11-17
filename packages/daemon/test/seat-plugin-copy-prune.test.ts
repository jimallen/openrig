// workspaces-o9o.25: a seat's plugin copy (.claude/plugins/<id>, .codex/plugins/<id>) kept every file the source plugin
// had dropped: projectEntry copied and never removed. Deleting in a seat folder cannot be undone, so the rule is narrow:
// a file is removed only when OpenRig's own projection manifest says it wrote it there, the file still holds exactly
// what OpenRig wrote (an operator's edit is kept), and nothing on its path below the seat folder is a symlink.
// Real files in a temp folder and the real projection_manifest table; no daemon, no ~/.openrig.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ProjectionManifestStore } from "../src/domain/projection-manifest-store.js";
import { SqlitePluginCopyClaims } from "../src/adapters/sqlite-plugin-copy-claims.js";
import Database from "better-sqlite3";
import { pluginCopyClaimsSchema } from "../src/db/migrations/132_plugin_copy_claims.js";
import { pruneDroppedPluginFiles } from "../src/domain/plugin-copy-prune.js";
import { hashContent } from "../src/domain/conflict-detector.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? walk(path.join(dir, e.name)).map((p) => path.join(e.name, p)) : [e.name]);
}
const fsOps = {
  exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, s: string) => fs.writeFileSync(p, s),
  mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  listFiles: walk, statMode: (p: string) => fs.statSync(p).mode, chmod: fs.chmodSync, copyFile: fs.copyFileSync,
  lstat: (p: string): "file" | "directory" | "symlink" | "other" | null => {
    try { const s = fs.lstatSync(p); return s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "directory" : "other"; }
    catch { return null; }
  },
  removeFile: (p: string) => fs.unlinkSync(p),
};

const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

type Runtime = "claude" | "codex";
const MANIFEST: Record<Runtime, string> = { claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json" };
const SEAT_DIR: Record<Runtime, string> = { claude: ".claude/plugins/openrig-core", codex: ".codex/plugins/openrig-core" };

function world(runtime: Runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-"));
  roots.push(root);
  const source = path.join(root, "source");
  const cwd = path.join(root, "seat");
  fs.mkdirSync(cwd, { recursive: true });
  const put = (rel: string, content: string) => { const f = path.join(source, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  put(MANIFEST[runtime], '{"name":"openrig-core"}');
  put("hooks/scripts/kept.cjs", "kept\n");
  put("hooks/scripts/dropped.cjs", "dropped\n");
  const db = createFullTestDb(); dbs.push(db);
  const store = new ProjectionManifestStore(db);
  const deps = {
    fsOps, tmux: {} as TmuxAdapter,
    recordProjection: (targetPath: string, content: string) => store.record({ targetPath, lastHash: hashContent(content), writtenAt: "2026-11-17T06:00:00Z", category: "plugin" }),
    projectionLedger: store, pluginCopyClaims: new SqlitePluginCopyClaims(db),
  };
  const adapter = runtime === "claude" ? new ClaudeCodeAdapter(deps) : new CodexRuntimeAdapter(deps);
  const entry: ProjectionEntry = { category: "plugin", effectiveId: "openrig-core", sourceSpec: "base", sourcePath: root, resourcePath: "source",
    absolutePath: source, classification: "safe_projection", pluginType: runtime };
  const project = async () => {
    const result = await adapter.project({ entries: [entry], runtime: adapter.runtime, cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      { cwd, nodeId: "node-A" } as NodeBinding);
    expect(result.failed).toEqual([]);
    return result;
  };
  const seatPlugin = path.join(cwd, SEAT_DIR[runtime]);
  return { root, source, cwd, seatPlugin, project, store, drop: (rel: string) => fs.rmSync(path.join(source, rel)) };
}

describe.each(["claude", "codex"] as const)("o9o.25 (%s): the seat's plugin copy follows the source, deleting only what OpenRig wrote", (runtime) => {
  it("a file the source dropped is removed from the seat copy on the next projection; the rest stays", async () => {
    const w = world(runtime);
    await w.project();
    expect(fs.existsSync(path.join(w.seatPlugin, "hooks/scripts/dropped.cjs"))).toBe(true);
    w.drop("hooks/scripts/dropped.cjs");
    await w.project();
    expect(fs.existsSync(path.join(w.seatPlugin, "hooks/scripts/dropped.cjs"))).toBe(false);
    expect(fs.readFileSync(path.join(w.seatPlugin, "hooks/scripts/kept.cjs"), "utf8")).toBe("kept\n");
    expect(w.store.get(path.join(w.seatPlugin, "hooks/scripts/dropped.cjs"))).toBeNull();
  });

  it("a seat copy made before this change (no record) is adopted when a projection confirms it, then a later drop removes it", async () => {
    const w = world(runtime);
    // The copy an older OpenRig left: byte-identical to the source, but nothing in the manifest.
    fs.cpSync(w.source, w.seatPlugin, { recursive: true });
    expect(w.store.get(path.join(w.seatPlugin, "hooks/scripts/dropped.cjs"))).toBeNull();
    await w.project();
    w.drop("hooks/scripts/dropped.cjs");
    await w.project();
    expect(fs.existsSync(path.join(w.seatPlugin, "hooks/scripts/dropped.cjs"))).toBe(false);
  });

  it("a dropped file the operator edited after OpenRig wrote it is kept, and said so", async () => {
    const w = world(runtime);
    await w.project();
    const target = path.join(w.seatPlugin, "hooks/scripts/dropped.cjs");
    fs.writeFileSync(target, "operator edit\n");
    w.drop("hooks/scripts/dropped.cjs");
    const result = await w.project();
    expect(fs.readFileSync(target, "utf8")).toBe("operator edit\n");
    expect(result.warnings ?? []).toEqual(expect.arrayContaining([expect.stringContaining(target)]));
  });

  it("a file OpenRig never wrote (the operator's own) is never removed", async () => {
    const w = world(runtime);
    await w.project();
    const own = path.join(w.seatPlugin, "hooks/scripts/operator-own.cjs");
    fs.writeFileSync(own, "mine\n");
    await w.project();
    expect(fs.readFileSync(own, "utf8")).toBe("mine\n");
  });

  it("nothing is removed through a symlinked folder: an outside file with the recorded name and content stays", async () => {
    const w = world(runtime);
    await w.project();
    // The seat's hooks/ folder is swapped for a link to an outside copy holding the same bytes OpenRig wrote.
    const outside = path.join(w.root, "outside-hooks");
    fs.cpSync(path.join(w.seatPlugin, "hooks"), outside, { recursive: true });
    fs.rmSync(path.join(w.seatPlugin, "hooks"), { recursive: true });
    fs.symlinkSync(outside, path.join(w.seatPlugin, "hooks"));
    w.drop("hooks/scripts/dropped.cjs");
    await w.project();
    expect(fs.readFileSync(path.join(outside, "scripts/dropped.cjs"), "utf8")).toBe("dropped\n");
  });
});

describe.each(["claude", "codex"] as const)("o9o.25 review (%s): seats sharing a cwd never delete a file another seat still projects", (runtime) => {
  it("seat B's source drops a file seat A still has: B's projection leaves it; once A drops it too, it goes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-shared-"));
    roots.push(root);
    const cwd = path.join(root, "shared-cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const sourceFor = (seat: string) => {
      const source = path.join(root, `source-${seat}`);
      const put = (rel: string, content: string) => { const f = path.join(source, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
      put(MANIFEST[runtime], '{"name":"openrig-core"}');
      put("hooks/scripts/kept.cjs", "kept\n");
      put("hooks/scripts/shared.cjs", "shared\n");
      return source;
    };
    const sources = { A: sourceFor("A"), B: sourceFor("B") };
    const db = createFullTestDb(); dbs.push(db);
    const store = new ProjectionManifestStore(db);
    const deps = { fsOps, tmux: {} as TmuxAdapter,
      recordProjection: (targetPath: string, content: string) => store.record({ targetPath, lastHash: hashContent(content), writtenAt: "2026-11-17T09:00:00Z", category: "plugin" }),
      projectionLedger: store, pluginCopyClaims: new SqlitePluginCopyClaims(db) };
    const adapter = runtime === "claude" ? new ClaudeCodeAdapter(deps) : new CodexRuntimeAdapter(deps);
    const project = async (seat: "A" | "B") => {
      const entry: ProjectionEntry = { category: "plugin", effectiveId: "openrig-core", sourceSpec: "base", sourcePath: root, resourcePath: `source-${seat}`,
        absolutePath: sources[seat], classification: "safe_projection", pluginType: runtime };
      const result = await adapter.project({ entries: [entry], runtime: adapter.runtime, cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        { cwd, nodeId: `node-${seat}` } as NodeBinding);
      expect(result.failed).toEqual([]);
    };
    const shared = path.join(cwd, SEAT_DIR[runtime], "hooks/scripts/shared.cjs");
    await project("A");
    await project("B");
    fs.rmSync(path.join(sources.B, "hooks/scripts/shared.cjs"));
    await project("B");
    expect(fs.readFileSync(shared, "utf8")).toBe("shared\n");
    // Control: once the last seat that projects it drops it too, it goes.
    fs.rmSync(path.join(sources.A, "hooks/scripts/shared.cjs"));
    await project("A");
    expect(fs.existsSync(shared)).toBe(false);
  });
});

describe("o9o.25 review r2: the claim check and the delete are one unit", () => {
  function fileDb(root: string): Database.Database {
    const db = new Database(path.join(root, "claims.sqlite"));
    db.exec(pluginCopyClaimsSchema.sql);
    db.exec("CREATE TABLE IF NOT EXISTS projection_manifest (target_path TEXT PRIMARY KEY, last_hash TEXT NOT NULL, written_at TEXT NOT NULL, source_spec TEXT, category TEXT)");
    dbs.push(db);
    return db;
  }

  it("seat B claiming between seat A's check and A's unlink keeps the file and B's claim (verify-sec's interleaving)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-race-")); roots.push(root);
    const cwd = path.join(root, "seat");
    const dir = path.join(cwd, ".claude/plugins/openrig-core");
    const target = path.join(dir, "hooks/scripts/shared.cjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "shared\n");
    const db = fileDb(root);
    const ledger = new ProjectionManifestStore(db);
    const claims = new SqlitePluginCopyClaims(db);
    ledger.record({ targetPath: target, lastHash: hashContent("shared\n"), writtenAt: "2026-11-17T10:00:00Z", category: "plugin" });
    claims.setClaims(dir, "node-A", new Set([target]), "2026-11-17T10:00:00Z");
    // A's hash read is inside the window between its first claimants check and its unlink: seat B writes the same
    // bytes and claims the file right there.
    let injected = false;
    const raceFs = { ...fsOps, readFile: (p: string) => {
      if (p === target && !injected) { injected = true; fs.writeFileSync(target, "shared\n"); claims.setClaims(dir, "node-B", new Set([target]), "2026-11-17T10:00:01Z"); }
      return fsOps.readFile(p);
    } };
    pruneDroppedPluginFiles({ cwd, targetDir: dir, wanted: new Set(), owner: "node-A", ledger, claims, fs: raceFs });
    expect(injected).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(claims.claimants(target)).toEqual(["node-B"]);
  });

  it("forgetting a claim removes only that seat's row, never another seat's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-forget-")); roots.push(root);
    const claims = new SqlitePluginCopyClaims(fileDb(root));
    const dir = "/seat/.claude/plugins/openrig-core";
    const target = `${dir}/hooks/a.cjs`;
    claims.setClaims(dir, "node-A", new Set([target]), "t");
    claims.setClaims(dir, "node-B", new Set([target]), "t");
    claims.forgetClaim(target, "node-A");
    expect(claims.claimants(target)).toEqual(["node-B"]);
  });

  it("while one projection holds a target's lock, another process using the same database cannot claim", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-lock-")); roots.push(root);
    const claims = new SqlitePluginCopyClaims(fileDb(root));
    const other = new Database(path.join(root, "claims.sqlite"), { timeout: 0 }); dbs.push(other);
    const otherClaims = new SqlitePluginCopyClaims(other);
    const dir = "/seat/.claude/plugins/openrig-core";
    let blocked: unknown = null;
    claims.withTargetLock(dir, () => {
      try { otherClaims.setClaims(dir, "node-B", new Set([`${dir}/a.cjs`]), "t"); } catch (err) { blocked = err; }
    });
    expect(String((blocked as { code?: string } | null)?.code ?? blocked)).toMatch(/SQLITE_BUSY/);
    // Once the lock is released, the other process's claim goes through.
    otherClaims.setClaims(dir, "node-B", new Set([`${dir}/a.cjs`]), "t");
    expect(claims.claimants(`${dir}/a.cjs`)).toEqual(["node-B"]);
  });
});

describe.each(["claude", "codex"] as const)("o9o.25 review r2 (%s): the adapter runs the copy, its records and its claims inside the target lock", (runtime) => {
  it("every plugin file record and claim is made while the target's lock is held", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o25-inlock-")); roots.push(root);
    const cwd = path.join(root, "seat"); fs.mkdirSync(cwd, { recursive: true });
    const source = path.join(root, "source");
    for (const [rel, content] of [[MANIFEST[runtime], '{"name":"openrig-core"}'], ["hooks/scripts/kept.cjs", "kept\n"]] as const) {
      fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), content);
    }
    const db = createFullTestDb(); dbs.push(db);
    const store = new ProjectionManifestStore(db);
    const real = new SqlitePluginCopyClaims(db);
    let held = 0;
    const outside: string[] = [];
    const claims = {
      claimedUnder: (d: string, o: string) => real.claimedUnder(d, o),
      claimants: (t: string) => real.claimants(t),
      setClaims: (d: string, o: string, t: ReadonlySet<string>, at: string) => { if (held === 0) outside.push(`setClaims ${d}`); real.setClaims(d, o, t, at); },
      forgetClaim: (t: string, o: string) => real.forgetClaim(t, o),
      withTargetLock: <T>(d: string, fn: () => T): T => { held++; try { return real.withTargetLock(d, fn); } finally { held--; } },
    };
    const deps = { fsOps, tmux: {} as TmuxAdapter, projectionLedger: store, pluginCopyClaims: claims,
      recordProjection: (targetPath: string, content: string) => {
        if (held === 0) outside.push(`record ${targetPath}`);
        store.record({ targetPath, lastHash: hashContent(content), writtenAt: "t", category: "plugin" });
      } };
    const adapter = runtime === "claude" ? new ClaudeCodeAdapter(deps) : new CodexRuntimeAdapter(deps);
    const entry: ProjectionEntry = { category: "plugin", effectiveId: "openrig-core", sourceSpec: "base", sourcePath: root, resourcePath: "source",
      absolutePath: source, classification: "safe_projection", pluginType: runtime };
    const result = await adapter.project({ entries: [entry], runtime: adapter.runtime, cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      { cwd, nodeId: "node-A" } as NodeBinding);
    expect(result.failed).toEqual([]);
    expect(store.get(path.join(cwd, SEAT_DIR[runtime], "hooks/scripts/kept.cjs"))).not.toBeNull();
    expect(outside).toEqual([]);
  });
});
