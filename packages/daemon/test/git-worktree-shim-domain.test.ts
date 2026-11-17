// workspaces-o9o.50: the shim refresh decided in the domain, driven through an in-memory fake of its ShimFiles port. No
// file is touched here; the node adapter (src/adapters/node-shim-files.ts) is covered by git-worktree-shim.test.ts.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  __shimSource,
  ensureGitWorktreeShim,
  refreshGitWorktreeShim,
  type ShimEntry,
  type ShimFiles,
} from "../src/domain/git-worktree-shim.js";

type Node = { kind: "file"; body: string; mode: number } | { kind: "directory" | "symlink" | "other" };

class FakeShimFiles implements ShimFiles {
  readonly nodes = new Map<string, Node>();
  readonly calls: string[] = [];
  failWrite: Error | null = null;

  async entryAt(p: string): Promise<ShimEntry> {
    this.calls.push(`entryAt ${p}`);
    return this.nodes.get(p)?.kind ?? "absent";
  }

  async makeFolder(p: string): Promise<void> {
    this.calls.push(`makeFolder ${p}`);
    this.nodes.set(p, { kind: "directory" });
  }

  async readShim(p: string): Promise<{ body: Uint8Array; mode: number }> {
    this.calls.push(`readShim ${p}`);
    const n = this.nodes.get(p);
    if (n?.kind !== "file") throw new Error(`fake: ${p} is not a regular file`);
    return { body: new TextEncoder().encode(n.body), mode: n.mode };
  }

  async writeAtomically(folder: string, file: string, body: string, mode: number): Promise<void> {
    this.calls.push(`writeAtomically ${folder} ${file} mode=${mode.toString(8)}`);
    if (this.failWrite) throw this.failWrite;
    this.nodes.set(file, { kind: "file", body, mode });
  }

  writes(): string[] {
    return this.calls.filter((c) => c.startsWith("writeAtomically") || c.startsWith("makeFolder"));
  }
}

const HOME = "/fake/openrig";
const DIR = `${HOME}/rig-bin`;
const FILE = `${DIR}/git`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const WANT = sha(__shimSource());
const OLD = "#!/usr/bin/env bash\nexec /usr/bin/git \"$@\"\n";

function withShim(body: string, mode: number): FakeShimFiles {
  const f = new FakeShimFiles();
  f.nodes.set(DIR, { kind: "directory" });
  f.nodes.set(FILE, { kind: "file", body, mode });
  return f;
}

describe("refreshGitWorktreeShim through the ShimFiles port", () => {
  it("nothing there: makes rig-bin, writes the package's shim once at 0755, reports created", async () => {
    const f = new FakeShimFiles();
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "created", path: FILE, sha256: WANT });
    expect(f.writes()).toEqual([`makeFolder ${DIR}`, `writeAtomically ${DIR} ${FILE} mode=755`]);
    expect(f.nodes.get(FILE)).toEqual({ kind: "file", body: __shimSource(), mode: 0o755 });
  });

  it("the package's shim at 0755: nothing is written, reports unchanged", async () => {
    const f = withShim(__shimSource(), 0o755);
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "unchanged", path: FILE, sha256: WANT });
    expect(f.writes()).toEqual([]);
  });

  it("the package's shim at 0644: rewritten at 0755, reports mode-fixed", async () => {
    const f = withShim(__shimSource(), 0o644);
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "mode-fixed", path: FILE, fromMode: 0o644, toMode: 0o755 });
    expect(f.writes()).toEqual([`writeAtomically ${DIR} ${FILE} mode=755`]);
  });

  it("another shim: replaced with the package's, reports both hashes", async () => {
    const f = withShim(OLD, 0o755);
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "replaced", path: FILE, fromSha256: sha(OLD), toSha256: WANT });
    expect(f.writes()).toEqual([`writeAtomically ${DIR} ${FILE} mode=755`]);
    expect(f.nodes.get(FILE)).toEqual({ kind: "file", body: __shimSource(), mode: 0o755 });
  });

  it("rig-bin is a symlink: refused, nothing made, read or written", async () => {
    const f = new FakeShimFiles();
    f.nodes.set(DIR, { kind: "symlink" });
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "refused", path: FILE, reason: `${DIR} is a symlink` });
    expect(f.calls).toEqual([`entryAt ${DIR}`]);
  });

  it("rig-bin is not a directory: refused, nothing made, read or written", async () => {
    const f = new FakeShimFiles();
    f.nodes.set(DIR, { kind: "other" });
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "refused", path: FILE, reason: `${DIR} is not a directory` });
    expect(f.calls).toEqual([`entryAt ${DIR}`]);
  });

  it("rig-bin/git is a symlink: refused before any read or write", async () => {
    const f = new FakeShimFiles();
    f.nodes.set(DIR, { kind: "directory" });
    f.nodes.set(FILE, { kind: "symlink" });
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "refused", path: FILE, reason: `${FILE} is a symlink` });
    expect(f.calls).toEqual([`entryAt ${DIR}`, `entryAt ${FILE}`]);
  });

  it("rig-bin/git is a directory: refused before any read or write", async () => {
    const f = new FakeShimFiles();
    f.nodes.set(DIR, { kind: "directory" });
    f.nodes.set(FILE, { kind: "directory" });
    expect(await refreshGitWorktreeShim(HOME, f)).toEqual({ kind: "refused", path: FILE, reason: `${FILE} is not a regular file` });
    expect(f.calls).toEqual([`entryAt ${DIR}`, `entryAt ${FILE}`]);
  });

  it("a failed write is the caller's error, not a report", async () => {
    const f = withShim(OLD, 0o755);
    f.failWrite = new Error("fake: EXDEV");
    await expect(refreshGitWorktreeShim(HOME, f)).rejects.toThrow("fake: EXDEV");
    expect(f.nodes.get(FILE)).toEqual({ kind: "file", body: OLD, mode: 0o755 });
  });
});

describe("ensureGitWorktreeShim (the seat-launch form) through the port", () => {
  it("returns the rig-bin dir once the shim is in place", async () => {
    const f = new FakeShimFiles();
    expect(await ensureGitWorktreeShim(HOME, f)).toBe(DIR);
    expect(f.nodes.get(FILE)).toEqual({ kind: "file", body: __shimSource(), mode: 0o755 });
  });

  it("throws the refusal line on a refusal", async () => {
    const f = new FakeShimFiles();
    f.nodes.set(DIR, { kind: "symlink" });
    await expect(ensureGitWorktreeShim(HOME, f)).rejects.toThrow(`git worktree shim: refused ${FILE}: ${DIR} is a symlink`);
  });
});
