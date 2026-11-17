// workspaces-o9o.70: git does not guarantee .git/info/exclude exists. A repo made with a custom or empty template
// (Sparky's agents run git that way) has no .git/info at all, and projection then skipped the exclusion of the generated
// openrig-core plugin files with only a warning, so `git add .` picked them up. Every repo here is made with an explicit
// empty template, so these rows do not depend on the host's git template. Creating .git/info must keep the module's
// metadata safety: nothing is created through a symlinked info or exclude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(path.join(dir, e.name)).map(p => path.join(e.name, p)) : [e.name]);
}
const fsOps = {
  exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, s: string) => fs.writeFileSync(p, s),
  mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  listFiles: walk, statMode: (p: string) => fs.statSync(p).mode, chmod: fs.chmodSync, copyFile: fs.copyFileSync,
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const PLUGIN_FILE = ".codex/plugins/openrig-core/.codex-plugin/plugin.json";

describe("o9o.70: projection excludes generated plugin files in a repo whose git template has no info/exclude", () => {
  let root: string;
  let repo: string;
  let template: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o70-no-info-"));
    template = path.join(root, "empty-template"); fs.mkdirSync(template);
    repo = path.join(root, "repo"); fs.mkdirSync(repo);
    git(repo, "init", "-q", `--template=${template}`);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
    fs.mkdirSync(path.join(root, "source", ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, "source", ".codex-plugin", "plugin.json"), '{"name":"core"}');
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  const plugin = (): ProjectionEntry => ({ category: "plugin", effectiveId: "openrig-core", sourceSpec: "base", sourcePath: root,
    resourcePath: "source", absolutePath: path.join(root, "source"), classification: "safe_projection", pluginType: "codex" as const });
  async function project(cwd: string) {
    const adapter = new CodexRuntimeAdapter({ fsOps, tmux: {} as TmuxAdapter });
    const result = await adapter.project({ entries: [plugin()], runtime: adapter.runtime, cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      { cwd } as NodeBinding);
    expect(result.failed).toEqual([]);
    return result;
  }

  it("creates .git/info and the exclusion when the repo has no .git/info, so git add leaves the plugin files out", async () => {
    expect(fs.existsSync(path.join(repo, ".git", "info"))).toBe(false);
    const result = await project(repo);
    expect(result.warnings ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain("# BEGIN OpenRig generated files\n/.codex/plugins/openrig-core/");
    expect(git(repo, "status", "--porcelain", "-uall")).not.toContain(PLUGIN_FILE);
  });

  it("writes the exclusion into the common info/ of a linked worktree whose repository has no .git/info", async () => {
    const linked = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    expect(fs.existsSync(path.join(repo, ".git", "info"))).toBe(false);
    expect((await project(linked)).warnings ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain("/.codex/plugins/openrig-core/");
    expect(git(linked, "status", "--porcelain", "-uall")).not.toContain(PLUGIN_FILE);
  });

  it("does not create through an info/ that is a dangling symlink out of the repository", async () => {
    const outside = path.join(root, "outside-info");
    fs.symlinkSync(outside, path.join(repo, ".git", "info"));
    const result = await project(repo);
    expect(result.warnings).toEqual([expect.stringContaining("generated_file_exclude_skipped")]);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("does not append through an info/exclude that is a symlink to a regular file inside the git directory", async () => {
    fs.mkdirSync(path.join(repo, ".git", "info"));
    const other = path.join(repo, ".git", "info", "other-file");
    fs.writeFileSync(other, "# not the exclude file\n");
    fs.symlinkSync(other, path.join(repo, ".git", "info", "exclude"));
    const before = fs.readFileSync(other);
    const result = await project(repo);
    expect(result.warnings).toEqual([expect.stringContaining("generated_file_exclude_skipped")]);
    expect(fs.readFileSync(other)).toEqual(before);
    expect(fs.lstatSync(path.join(repo, ".git", "info", "exclude")).isSymbolicLink()).toBe(true);
  });

  it("does not create through an info/exclude that is a dangling symlink out of the repository", async () => {
    fs.mkdirSync(path.join(repo, ".git", "info"));
    const outside = path.join(root, "outside-exclude");
    fs.symlinkSync(outside, path.join(repo, ".git", "info", "exclude"));
    const result = await project(repo);
    expect(result.warnings).toEqual([expect.stringContaining("generated_file_exclude_skipped")]);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
