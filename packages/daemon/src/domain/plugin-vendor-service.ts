// PluginVendorService — vendoring + auto-fetch for plugin trees.
//
// Per plugin-primitive Phase 3a slice 3.2 (IMPL-PRD §2.5 + DESIGN.md §5.5).
//
// Responsibilities:
//   1. ensureVendored(name): make ~/.openrig/plugins/<name>/ match the running
//      package's packages/daemon/assets/plugins/<name>/ byte for byte, whatever
//      version the installed copy says, then verify it (workspaces-o9o.17; Jim,
//      2026-11-16: "Running package wins"). Every seat projects plugin files and
//      skills from that copy, so a copy that drifts gives every seat old content.
//   2. attemptAutoFetch(name): try to fetch latest from
//      github.com/mvschwarz/openrig-plugins. Tolerates 404, network errors,
//      and timeouts silently per orch direction 2026-05-10 (vendored is
//      always the fallback). Logs outcome for operator observability.
//   3. ensureLatest(name): resolves local vendored/installed authority first,
//      then attempts auto-fetch. A local copy remains if fetch fails.
//
// Design notes:
//   - All fs ops + httpClient are injectable (testable without real
//     filesystem or network).
//   - 5s network timeout per IMPL-PRD §2.5.
//   - The repo at github.com/mvschwarz/openrig-plugins is currently empty
//     per founder authorization 2026-05-10 (LICENSE only); 404 is the
//     expected normal-state response until a separate publish authorization.

import nodePath from "node:path";
import { createHash } from "node:crypto";

export interface PluginVendorFs {
  readFile(path: string): string;
  /**
   * Replace `path` with `content` atomically (a temp file in the same directory, renamed over it), so a failed write
   * leaves the old file or none, never a partial one, and leaves no temp behind. `mode` sets the new file's permission
   * bits before the rename.
   */
  writeFile(path: string, content: string, mode?: number): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles(dir: string): string[];
  /** What is at `path` without following a symlink there; null when nothing is. */
  lstat(path: string): "file" | "directory" | "symlink" | "other" | null;
  /** Remove one file or symlink (never its target, never recursively). */
  removeFile(path: string): void;
  /**
   * The top of the git work tree that holds `path` (or, when `path` does not exist yet, its nearest existing
   * parent), with symlinks resolved; null when no git work tree holds it.
   */
  gitWorkTreeOf(path: string): string | null;
  /** Source file permission bits (for mode-preserving vendor staging). Optional: no-op if absent. */
  statMode?(path: string): number;
  /** Apply permission bits to a file (for mode-preserving vendor staging). Optional: no-op if absent. */
  chmod?(path: string, mode: number): void;
}

export interface HttpClientResponse {
  ok: boolean;
  status: number;
  /** Body parsed by caller — not exercised in v0 since fetch failures are
   *  the expected normal-state. Future tarball-extraction would consume this. */
  body?: unknown;
}

export type HttpClient = (url: string, opts?: { timeoutMs?: number }) => Promise<HttpClientResponse>;

export interface PluginVendorServiceDeps {
  vendoredAssetsDir: string;
  userPluginsDir: string;
  fs: PluginVendorFs;
  httpClient: HttpClient;
  logger?: (...args: unknown[]) => void;
  /** Where a copy that still differs from the package after a refresh is reported. Defaults to logger. */
  errorLogger?: (...args: unknown[]) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const REPO_BASE = "https://github.com/mvschwarz/openrig-plugins";
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] as const;
const GLOBAL_VENDOR_VERSION = ".openrig-vendor-version";

function parseNumericVersion(raw: string, source: string): number[] {
  const value = raw.trim();
  if (!/^\d+(?:\.\d+){2}$/.test(value)) {
    throw new Error(`[plugin-vendor] invalid version '${value}' at ${source}; expected numeric x.y.z authority`);
  }
  return value.split(".").map(Number);
}

export class PluginVendorService {
  private vendoredAssetsDir: string;
  private userPluginsDir: string;
  private fs: PluginVendorFs;
  private httpClient: HttpClient;
  private logger: (...args: unknown[]) => void;
  private errorLogger: (...args: unknown[]) => void;

  constructor(deps: PluginVendorServiceDeps) {
    this.vendoredAssetsDir = deps.vendoredAssetsDir;
    this.userPluginsDir = deps.userPluginsDir;
    this.fs = deps.fs;
    this.httpClient = deps.httpClient;
    this.logger = deps.logger ?? (() => {});
    this.errorLogger = deps.errorLogger ?? this.logger;
  }

  /** One plugin version across both harness manifests. Divergence is an
   * authority error: choosing either copy would make the other runtime lie. */
  private pluginVersion(pluginDir: string): string {
    const versions = PLUGIN_MANIFESTS
      .map((rel) => nodePath.join(pluginDir, rel))
      .filter((path) => this.fs.exists(path))
      .map((path) => {
        let parsed: { version?: unknown };
        try {
          parsed = JSON.parse(this.fs.readFile(path)) as { version?: unknown };
        } catch {
          throw new Error(`[plugin-vendor] invalid plugin manifest at ${path}`);
        }
        if (typeof parsed.version !== "string") {
          throw new Error(`[plugin-vendor] plugin manifest at ${path} has no string version`);
        }
        parseNumericVersion(parsed.version, path);
        return parsed.version;
      });
    if (versions.length === 0) {
      throw new Error(`[plugin-vendor] no plugin manifest found under ${pluginDir}`);
    }
    if (versions.some((version) => version !== versions[0])) {
      throw new Error(`[plugin-vendor] plugin manifests disagree under ${pluginDir}: ${versions.join(", ")}`);
    }
    return versions[0]!;
  }

  /**
   * Make <userPluginsDir>/<pluginName> match the running package's
   * <vendoredAssetsDir>/<pluginName> byte for byte, then verify it. The running package
   * wins whatever version the installed copy declares, equal, older or newer (Jim,
   * 2026-11-16, workspaces-o9o.17: "Running package wins"): the fork does not bump the
   * plugin version with every change, so a version gate kept a 10-21 copy for weeks.
   * A replaced installed version is logged. A copy with no manifest was not written by
   * OpenRig and is left unchanged; a copy that still differs afterwards is reported
   * through errorLogger. No-op when the plugin is not bundled.
   */
  async ensureVendored(pluginName: string): Promise<void> {
    const sourceDir = nodePath.join(this.vendoredAssetsDir, pluginName);
    const targetDir = nodePath.join(this.userPluginsDir, pluginName);

    if (!this.fs.exists(sourceDir)) {
      this.logger(`[plugin-vendor] no vendored asset for "${pluginName}" at ${sourceDir}; skipping`);
      return;
    }

    const sourceVersion = this.pluginVersion(sourceDir);
    if (this.fs.exists(targetDir)) {
      const hasTargetManifest = PLUGIN_MANIFESTS.some((rel) => this.fs.exists(nodePath.join(targetDir, rel)));
      if (!hasTargetManifest) {
        this.logger(`[plugin-vendor] existing plugin '${pluginName}' has no version authority at ${targetDir}; leaving it unchanged`);
        return;
      }
      const targetVersion = this.pluginVersion(targetDir);
      const differing = this.drift(sourceDir, targetDir, new Set());
      if (differing.length > 0) {
        this.logger(`[plugin-vendor] replacing installed '${pluginName}' ${targetVersion} at ${targetDir} with the running package's ${sourceVersion} (${differing.length} path(s) differ)`);
      }
    }

    this.mirror(sourceDir, targetDir, new Set(), nodePath.dirname(this.userPluginsDir));
    this.reportDrift(`plugin '${pluginName}'`, sourceDir, targetDir, new Set());
  }

  /**
   * Make targetDir hold exactly sourceDir's files (and their modes), apart from the names in `keep`. Every mutating
   * step (mkdirp, write, chmod, unlink) is preceded, immediately, by a check that walks every component from `anchor`
   * down to the path it touches and refuses a symlink or a non-directory among them (workspaces-o9o.17, verify-sec
   * review): a symlinked ancestor (OPENRIG_HOME/plugins -> elsewhere) or a link inside the copy cannot carry a write or a
   * delete outside it. A refused target is reported, not written.
   *
   * Residual, not closable in Node: a directory swapped for a symlink between that check and the syscall that follows
   * it. Node has no openat/renameat/unlinkat on a directory handle. rename and unlink act on the final component itself
   * (never through a link there), and temps are created O_EXCL, so the window is an ancestor swap in those few
   * microseconds, by someone who can already write inside the managed tree.
   */
  private mirror(sourceDir: string, targetDir: string, keep: ReadonlySet<string>, anchor: string): void {
    const refusal = this.unsafe(anchor, targetDir, targetDir);
    if (refusal !== null) {
      this.errorLogger(`[plugin-vendor] not writing ${targetDir}: ${refusal}`);
      return;
    }
    this.fs.mkdirp(targetDir);
    const sourceFiles = this.fs.listFiles(sourceDir);
    const wanted = new Set(sourceFiles);
    for (const relPath of sourceFiles) {
      const srcPath = nodePath.join(sourceDir, relPath);
      const destPath = nodePath.join(targetDir, relPath);
      if (this.unsafe(anchor, targetDir, destPath)) continue;
      const content = this.fs.readFile(srcPath);
      const mode = this.fs.statMode ? this.fs.statMode(srcPath) & 0o777 : undefined;
      // Hash-skip: only write if content differs (idempotent re-runs). Reconcile mode even on
      // skip — a byte-identical copy staged earlier may still carry the wrong (default) mode.
      if (this.fs.exists(destPath) && hashContent(this.fs.readFile(destPath)) === hashContent(content)) {
        if (this.unsafe(anchor, targetDir, destPath)) continue;
        this.preserveMode(srcPath, destPath);
        continue;
      }
      if (this.unsafe(anchor, targetDir, destPath)) continue;
      this.fs.mkdirp(nodePath.dirname(destPath));
      if (this.unsafe(anchor, targetDir, destPath)) continue;
      this.fs.writeFile(destPath, content, mode);
    }
    for (const relPath of this.fs.listFiles(targetDir)) {
      if (wanted.has(relPath) || keep.has(relPath)) continue;
      const destPath = nodePath.join(targetDir, relPath);
      if (this.unsafe(anchor, targetDir, destPath)) continue;
      this.fs.removeFile(destPath);
    }
  }

  /**
   * Why `path` may not be written or removed as part of `root`, or null when it may: `path` must sit lexically inside
   * `root`, `root` inside `anchor`, and no component from below `anchor` down to `path` may be a symlink or (above `path`)
   * a non-directory. Components that do not exist yet end the walk: mkdirp creates them as real directories.
   */
  private unsafe(anchor: string, root: string, path: string): string | null {
    const inside = (outer: string, inner: string, allowSame: boolean) => {
      const rel = nodePath.relative(outer, inner);
      if (rel === "") return allowSame;
      return !(rel === ".." || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel));
    };
    if (!inside(root, path, path === root)) return "outside the managed directory";
    if (!inside(anchor, root, false)) return `the managed directory is not inside ${anchor}`;
    let current = anchor;
    for (const part of nodePath.relative(anchor, path).split(nodePath.sep)) {
      current = nodePath.join(current, part);
      const kind = this.fs.lstat(current);
      if (kind === null) return null;
      if (kind === "symlink") return `${current} is a symlink`;
      if (current !== path && kind !== "directory") return `${current} is not a directory`;
    }
    return null;
  }

  /** The paths under targetDir that do not match sourceDir (missing, extra or different), apart from `keep`. */
  private drift(sourceDir: string, targetDir: string, keep: ReadonlySet<string>): string[] {
    if (!this.fs.exists(targetDir)) return this.fs.listFiles(sourceDir);
    const source = new Set(this.fs.listFiles(sourceDir));
    const target = new Set(this.fs.listFiles(targetDir).filter((rel) => !keep.has(rel)));
    const differing: string[] = [];
    for (const rel of source) {
      if (!target.has(rel)) differing.push(`${rel} (missing)`);
      else if (
        this.fs.lstat(nodePath.join(targetDir, rel)) !== "file" ||
        hashContent(this.fs.readFile(nodePath.join(targetDir, rel))) !== hashContent(this.fs.readFile(nodePath.join(sourceDir, rel)))
      ) differing.push(`${rel} (differs)`);
    }
    for (const rel of target) if (!source.has(rel)) differing.push(`${rel} (not in the package)`);
    return differing.sort();
  }

  /** Verify a refreshed copy against its source and report what still differs. */
  private reportDrift(what: string, sourceDir: string, targetDir: string, keep: ReadonlySet<string>): void {
    const differing = this.drift(sourceDir, targetDir, keep);
    if (differing.length === 0) return;
    this.errorLogger(`[plugin-vendor] ${what} at ${targetDir} still differs from the running package at ${sourceDir} after the refresh; seats will load these paths from the old copy: ${differing.join(", ")}`);
  }

  /**
   * Reapply the source file's permission bits to the staged/projected dest. Plain
   * readFile+writeFile (writeFileSync) creates the dest with the process default mode,
   * dropping executable bits on nested plugin helpers (e.g. claude-compaction-restore/
   * scripts/*.mjs, 0755). This vendor-staging hop (assets -> ~/.openrig/plugins) runs
   * UPSTREAM of the adapter CWD projection, so an unfixed mode here strands 0644 in the
   * staged copy that the adapters then faithfully preserve. No-op when the fs adapter does
   * not expose mode primitives (keeps existing mock-fs callers unaffected).
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  /** Project one plugin skill, from the running package, into the harness-global skill roots. */
  ensureSkillGlobally(
    pluginName: string,
    skillName: string,
    globalSkillRoots: string[],
  ): void {
    // From the running package, never from OPENRIG_HOME/plugins: a copy the refresh refused (a symlinked one, say)
    // would otherwise carry its old seed over a marked global target (verify-sec review, workspaces-o9o.17).
    const sourceDir = nodePath.join(
      this.vendoredAssetsDir,
      pluginName,
      "skills",
      skillName,
    );
    if (!this.fs.exists(sourceDir)) {
      throw new Error(
        `Required global seed '${skillName}' is missing from the running package's plugin '${pluginName}'`,
      );
    }

    const sourceVersion = this.pluginVersion(nodePath.join(this.vendoredAssetsDir, pluginName));
    this.ensureSkillDirGlobally(sourceDir, skillName, sourceVersion, globalSkillRoots);
  }

  /**
   * Project one skill folder into the harness-global skill roots under `sourceVersion`
   * authority. A target without OpenRig's version marker was installed another way (for
   * example by skills.sh) and is left unchanged, as is a target that is itself a symlink
   * (a shared canon). A target inside a git work tree is left unchanged too, marked or not and
   * existing or not: the repo is its authority, and a write would erase the owner's tracked edits
   * and leave the repo dirty (measured on stu 2026-11-16: ~/.agents is a git repo whose tracked
   * skills/rigs carries OpenRig's marker and Jim's own commits). A target carrying the marker
   * otherwise is OpenRig's own copy: it is made to match the running package's folder whatever
   * version the marker says (Jim, 2026-11-16, workspaces-o9o.17), and a replaced version is logged.
   */
  ensureSkillDirGlobally(
    sourceDir: string,
    skillName: string,
    sourceVersion: string,
    globalSkillRoots: string[],
  ): void {
    if (!this.fs.exists(sourceDir)) {
      throw new Error(`Required global seed '${skillName}' is missing at ${sourceDir}`);
    }
    parseNumericVersion(sourceVersion, `${skillName} source`);
    const keep = new Set([GLOBAL_VENDOR_VERSION]);
    for (const root of globalSkillRoots) {
      const targetDir = nodePath.join(root, skillName);
      const versionMarker = nodePath.join(targetDir, GLOBAL_VENDOR_VERSION);
      const workTree = this.fs.gitWorkTreeOf(targetDir);
      if (workTree !== null) {
        this.logger(`[plugin-vendor] global skill '${skillName}' at ${targetDir} is inside the git work tree at ${workTree}; the repo is its authority, leaving it unchanged`);
        continue;
      }
      if (this.fs.exists(targetDir) || this.fs.lstat(targetDir) !== null) {
        if (this.fs.lstat(targetDir) === "symlink") {
          this.logger(`[plugin-vendor] global skill '${skillName}' at ${targetDir} is a symlink, unversioned/external authority; leaving it unchanged`);
          continue;
        }
        if (!this.fs.exists(versionMarker)) {
          this.logger(`[plugin-vendor] global skill '${skillName}' at ${targetDir} is unversioned/external authority; leaving it unchanged`);
          continue;
        }
        const targetVersion = this.fs.readFile(versionMarker).trim();
        parseNumericVersion(targetVersion, versionMarker);
        const differing = this.drift(sourceDir, targetDir, keep);
        if (differing.length > 0) {
          this.logger(`[plugin-vendor] replacing global skill '${skillName}' ${targetVersion} at ${targetDir} with the running package's ${sourceVersion} (${differing.length} path(s) differ)`);
        }
      }
      // The anchor is the seed root's parent (~/.claude for ~/.claude/skills): a symlinked seed root is refused.
      const anchor = nodePath.dirname(root);
      this.mirror(sourceDir, targetDir, keep, anchor);
      if (!this.unsafe(anchor, targetDir, versionMarker)) this.fs.writeFile(versionMarker, `${sourceVersion}\n`);
      this.reportDrift(`global skill '${skillName}'`, sourceDir, targetDir, keep);
    }
  }

  /**
   * Attempt to fetch the latest plugin tree from
   * github.com/mvschwarz/openrig-plugins. Tolerates 404, network errors,
   * and timeouts silently — vendored copy is ALWAYS the fallback.
   * Logs outcome for operator observability.
   */
  async attemptAutoFetch(pluginName: string): Promise<void> {
    const url = `${REPO_BASE}/releases/latest/download/${pluginName}.tar.gz`;
    try {
      const response = await this.httpClient(url, { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!response.ok) {
        if (response.status === 404) {
          this.logger(`[plugin-vendor] fetch ${pluginName} returned 404 (repo empty or release not published yet); falling back to vendored`);
        } else {
          this.logger(`[plugin-vendor] fetch ${pluginName} returned status ${response.status}; falling back to vendored`);
        }
        return;
      }
      // v0: tarball extraction NOT implemented — when slice 3.6 lands marketplace-
      // consumption, this is where fetch-then-extract logic lives. For now,
      // success path just logs. EXPLICIT MODE DECISION: v0 writes no files here, so there is
      // no mode to preserve; the future extract path MUST route its writes through
      // preserveMode() (or a tar extractor that preserves mode) so fetched executable helpers
      // keep 0755 — same invariant as ensureVendored/ensureSkillGlobally.
      this.logger(`[plugin-vendor] fetch ${pluginName} succeeded (${response.status}); v0 vendored copy still authoritative`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger(`[plugin-vendor] fetch ${pluginName} failed: ${msg}; falling back to vendored`);
    }
  }

  /**
   * Orchestrate vendored-first then fetch-attempt.
   * Local vendored/installed authority resolves first so a usable local copy
   * remains even if the fetch path fails for any reason.
   */
  async ensureLatest(pluginName: string): Promise<void> {
    await this.ensureVendored(pluginName);
    await this.attemptAutoFetch(pluginName);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
