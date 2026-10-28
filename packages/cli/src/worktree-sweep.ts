// z3 — merged-worktree cleanup. Local, daemon-free: every fact comes from git itself
// (`git worktree list`), so it works for worktrees any seat created, wherever it put them.
//
// Safety posture (read before changing anything):
//  - The only deletion primitive is `git worktree remove <path>` WITHOUT --force. Git refuses
//    dirty (tracked-modified or untracked) and locked worktrees on its own, so it is a second
//    guard behind our own checks. This module never recursive-deletes a path itself.
//  - Every probe that cannot be read yields a KEEP with the reason, never "absent, so proceed".
//  - Merged means: the worktree HEAD is an ancestor of one named target ref (the remote default
//    branch unless --into). A local-only `main` is never guessed: commits merged only into an
//    unpushed local branch would not be safe on any remote.
//  - Branches are left alone; only the checkout directory goes.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type KeepCode =
  | "locked"
  | "prunable-missing"
  | "in-use"
  | "in-use-probe-failed"
  | "contains-another-worktree"
  | "status-unreadable"
  | "uncommitted-changes"
  | "secret-looking-ignored-file"
  | "ignored-files-unreadable"
  | "operation-in-progress"
  | "head-unreadable"
  | "not-merged"
  | "merge-check-failed"
  | "too-recent"
  | "age-unreadable"
  | "remove-refused";

export interface KeepReason {
  code: KeepCode;
  detail: string;
}

export type WorktreeOutcome = "would-remove" | "removed" | "kept";

export interface WorktreeVerdict {
  path: string;
  branch: string | null;
  head: string | null;
  outcome: WorktreeOutcome;
  reasons: KeepReason[];
  /** Best-effort `du -sk` in KiB; informational only, never an input to a decision. */
  sizeKiB: number | null;
}

export interface RepoReport {
  repo: string;
  mainWorktree: string | null;
  into: string | null;
  intoSha: string | null;
  /** Set when the repo could not be assessed at all; nothing in it was touched. */
  error: string | null;
  worktrees: WorktreeVerdict[];
}

export interface SweepReport {
  apply: boolean;
  olderThanMs: number;
  /** Processes whose cwd could not be read (other users'); not counted as "not in use". */
  unreadableProcesses: number;
  repos: RepoReport[];
}

export interface CwdProbeResult {
  cwds: string[];
  unreadable: number;
}

export interface SweepOptions {
  repos: string[];
  into?: string;
  olderThanMs: number;
  apply: boolean;
  /** Injectable for tests. Default reads every process's cwd (/proc on Linux, lsof elsewhere). */
  cwdProbe?: () => Promise<CwdProbeResult>;
  now?: () => number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? (err as unknown as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
}

export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const out: ListedWorktree[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const wt: ListedWorktree = { path: "", head: null, branch: null, bare: false, locked: null, prunable: null };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") wt.bare = true;
      else if (line === "locked" || line.startsWith("locked ")) wt.locked = line.slice(7);
      else if (line === "prunable" || line.startsWith("prunable ")) wt.prunable = line.slice(9);
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

export function parseDuration(text: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}": use a number and a unit, e.g. 30m, 24h, 7d (0s disables the age guard).`);
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export async function defaultCwdProbe(): Promise<CwdProbeResult> {
  if (process.platform === "linux") {
    const cwds: string[] = [];
    let unreadable = 0;
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        cwds.push(await fs.readlink(`/proc/${entry}/cwd`));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue; // process exited between readdir and readlink
        unreadable += 1;
      }
    }
    return { cwds, unreadable };
  }
  // lsof exits 1 when it could not inspect some processes yet still prints the rest; a spawn
  // failure or empty output is a probe failure (thrown), never an empty "nothing in use".
  const res = await new Promise<{ stdout: string; spawnError: Error | null }>((resolve) => {
    execFile("lsof", ["-d", "cwd", "-Fn"], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      const spawnErr = err && (err as NodeJS.ErrnoException).code === "ENOENT" ? err : null;
      resolve({ stdout: String(stdout), spawnError: spawnErr });
    });
  });
  if (res.spawnError) throw new Error(`lsof unavailable: ${res.spawnError.message}`);
  const cwds = res.stdout.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  if (cwds.length === 0) throw new Error("lsof returned no process working directories");
  return { cwds, unreadable: 0 };
}

async function dirSizeKiB(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", dir], (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const n = Number(String(stdout).split(/\s+/)[0]);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

// Ignored files may be deleted (they are regenerable by git's own definition) EXCEPT ones that look
// like secrets: .env / .env.*, *.pem, *.key. Dependency trees (node_modules) are skipped because
// packages ship fixture keys; template suffixes are not secrets.
const TEMPLATE_ENV = /\.(example|sample|template|dist)$/i;
export function looksSecret(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.includes("node_modules")) return false;
  const base = parts[parts.length - 1] ?? "";
  if (base === ".env" || (base.startsWith(".env.") && !TEMPLATE_ENV.test(base))) return true;
  return /\.(pem|key)$/i.test(base);
}

const OPERATION_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];

async function newestActivityMs(gitDir: string): Promise<{ ms: number | null; error: string | null }> {
  let newest: number | null = null;
  for (const rel of ["HEAD", "index", path.join("logs", "HEAD")]) {
    try {
      const st = await fs.stat(path.join(gitDir, rel));
      newest = newest === null ? st.mtimeMs : Math.max(newest, st.mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ms: null, error: `${rel}: ${(err as Error).message}` };
    }
  }
  return newest === null ? { ms: null, error: "no HEAD/index/reflog timestamps found" } : { ms: newest, error: null };
}

async function resolveTarget(repo: string, into: string | undefined): Promise<{ ref: string; sha: string } | { error: string }> {
  let ref = into;
  if (!ref) {
    const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
    ref = head.code === 0 ? head.stdout.trim() : undefined;
    if (!ref) {
      return {
        error:
          "cannot determine the merge target: refs/remotes/origin/HEAD is not set. Pass --into <ref> (for example origin/main); a local branch is never guessed.",
      };
    }
  }
  const sha = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  if (sha.code !== 0 || !sha.stdout.trim()) return { error: `merge target "${ref}" does not resolve to a commit` };
  return { ref, sha: sha.stdout.trim() };
}

async function sweepRepo(
  repoArg: string,
  opts: SweepOptions,
  probe: { result: CwdProbeResult | null; error: string | null },
  seenCommonDirs: Set<string>,
): Promise<RepoReport | null> {
  const repo = path.resolve(repoArg);
  const report: RepoReport = { repo, mainWorktree: null, into: null, intoSha: null, error: null, worktrees: [] };

  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo);
  if (common.code !== 0) {
    report.error = `not a readable git repository: ${common.stderr.trim() || `git exited ${common.code}`}`;
    return report;
  }
  const commonDir = await realpathOr(common.stdout.trim());
  if (seenCommonDirs.has(commonDir)) return null; // two --repo args naming the same repository
  seenCommonDirs.add(commonDir);

  const list = await git(["worktree", "list", "--porcelain"], repo);
  if (list.code !== 0) {
    report.error = `git worktree list failed: ${list.stderr.trim() || `exit ${list.code}`}`;
    return report;
  }
  const listed = parseWorktreeList(list.stdout);
  const main = listed[0];
  if (main && !main.bare) report.mainWorktree = main.path;

  const target = await resolveTarget(repo, opts.into);
  if ("error" in target) {
    report.error = target.error;
    return report;
  }
  report.into = target.ref;
  report.intoSha = target.sha;

  const linked = listed.slice(1);
  const linkedReal = await Promise.all(linked.map((w) => realpathOr(w.path)));
  const mainReal = main ? await realpathOr(main.path) : null;
  const now = (opts.now ?? Date.now)();

  for (let i = 0; i < linked.length; i++) {
    const wt = linked[i]!;
    const real = linkedReal[i]!;
    const reasons: KeepReason[] = [];
    const keep = (code: KeepCode, detail: string): void => void reasons.push({ code, detail });

    if (wt.locked !== null) keep("locked", wt.locked || "locked without a reason");
    if (wt.prunable !== null) {
      keep("prunable-missing", `${wt.prunable || "directory is missing"}; leave to 'git worktree prune'`);
    }

    // Defence in depth: the main checkout must never be removed even if listing order surprises us.
    if (mainReal !== null && real === mainReal) keep("in-use", "this is the main checkout");

    const dirExists = wt.prunable === null;
    if (dirExists) {
      if (probe.result === null) {
        keep("in-use-probe-failed", `could not enumerate process working directories: ${probe.error}`);
      } else if ([...probe.result.cwds, process.cwd()].some((c) => within(real, c))) {
        keep("in-use", "a running process has its working directory inside this worktree");
      }
      if (linkedReal.some((other, j) => j !== i && within(real, other)) || (mainReal !== null && within(real, mainReal))) {
        keep("contains-another-worktree", "removing it would take another checkout with it");
      }

      const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "-z"], wt.path);
      if (status.code !== 0) keep("status-unreadable", status.stderr.trim() || `git status exited ${status.code}`);
      else if (status.stdout.length > 0) {
        keep("uncommitted-changes", `${status.stdout.split("\0").filter(Boolean).length} changed or untracked path(s)`);
      }

      const ignored = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], wt.path);
      if (ignored.code !== 0) {
        keep("ignored-files-unreadable", ignored.stderr.trim() || `git ls-files exited ${ignored.code}`);
      } else {
        const secrets = ignored.stdout.split("\0").filter((f) => f && looksSecret(f));
        if (secrets.length > 0) {
          keep("secret-looking-ignored-file", `${secrets.slice(0, 5).join(", ")}${secrets.length > 5 ? ` (+${secrets.length - 5} more)` : ""}`);
        }
      }

      const gd = await git(["rev-parse", "--path-format=absolute", "--git-dir"], wt.path);
      if (gd.code !== 0) {
        keep("age-unreadable", `git-dir unreadable: ${gd.stderr.trim()}`);
      } else {
        const gitDir = gd.stdout.trim();
        for (const marker of OPERATION_MARKERS) {
          const present = await fs.stat(path.join(gitDir, marker)).then(() => true, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? false : null));
          if (present === null) keep("operation-in-progress", `could not check ${marker}`);
          else if (present) keep("operation-in-progress", `${marker} present`);
        }
        const act = await newestActivityMs(gitDir);
        if (act.ms === null) keep("age-unreadable", act.error ?? "unknown");
        else if (opts.olderThanMs > 0 && now - act.ms < opts.olderThanMs) {
          keep("too-recent", `last git activity ${Math.round((now - act.ms) / 60_000)} minute(s) ago`);
        }
      }

      const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], wt.path);
      if (head.code !== 0) keep("head-unreadable", "HEAD does not resolve to a commit");
      else {
        const anc = await git(["merge-base", "--is-ancestor", head.stdout.trim(), target.sha], wt.path);
        if (anc.code === 1) keep("not-merged", `HEAD is not an ancestor of ${target.ref} (squash-merged branches cannot be proven merged by git alone)`);
        else if (anc.code !== 0) keep("merge-check-failed", anc.stderr.trim() || `git merge-base exited ${anc.code}`);
      }
    }

    const verdict: WorktreeVerdict = {
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      outcome: reasons.length === 0 ? "would-remove" : "kept",
      reasons,
      sizeKiB: dirExists ? await dirSizeKiB(wt.path) : null,
    };

    if (verdict.outcome === "would-remove" && opts.apply) {
      const rm = await git(["worktree", "remove", wt.path], repo); // never --force
      if (rm.code === 0) verdict.outcome = "removed";
      else {
        verdict.outcome = "kept";
        verdict.reasons.push({ code: "remove-refused", detail: rm.stderr.trim() || `git worktree remove exited ${rm.code}` });
      }
    }
    report.worktrees.push(verdict);
  }
  return report;
}

export async function sweepWorktrees(opts: SweepOptions): Promise<SweepReport> {
  let result: CwdProbeResult | null = null;
  let error: string | null = null;
  try {
    result = await (opts.cwdProbe ?? defaultCwdProbe)();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const probe = { result, error };
  const seen = new Set<string>();
  const repos: RepoReport[] = [];
  for (const r of opts.repos) {
    const rep = await sweepRepo(r, opts, probe, seen);
    if (rep) repos.push(rep);
  }
  return { apply: opts.apply, olderThanMs: opts.olderThanMs, unreadableProcesses: result?.unreadable ?? 0, repos };
}

export function renderSweepReport(report: SweepReport): string {
  const lines: string[] = [];
  lines.push(report.apply ? "rig worktree sweep: APPLY" : "rig worktree sweep: DRY RUN (nothing removed)");
  if (report.unreadableProcesses > 0) {
    lines.push(`note: ${report.unreadableProcesses} process working directories were unreadable (other users); in-use is judged from the rest.`);
  }
  let removable = 0;
  let removed = 0;
  let kept = 0;
  let freeableKiB = 0;
  for (const repo of report.repos) {
    lines.push("", `${repo.repo}${repo.into ? `  (merged = ancestor of ${repo.into} @ ${repo.intoSha?.slice(0, 8)})` : ""}`);
    if (repo.error) {
      lines.push(`  SKIPPED: ${repo.error}`);
      continue;
    }
    if (repo.worktrees.length === 0) lines.push("  no linked worktrees");
    for (const w of repo.worktrees) {
      const size = w.sizeKiB === null ? "" : ` [${(w.sizeKiB / 1024).toFixed(0)} MiB]`;
      const label = w.outcome === "kept" ? "KEEP  " : w.outcome === "removed" ? "REMOVED" : "REMOVE ";
      lines.push(`  ${label} ${w.path}${w.branch ? ` (${w.branch})` : " (detached)"}${size}`);
      for (const r of w.reasons) lines.push(`         - ${r.code}: ${r.detail}`);
      if (w.outcome === "kept") kept += 1;
      else if (w.outcome === "removed") removed += 1;
      else removable += 1;
      if (w.outcome !== "kept") freeableKiB += w.sizeKiB ?? 0;
    }
  }
  lines.push("");
  lines.push(
    report.apply
      ? `removed ${removed}, kept ${kept} (${(freeableKiB / 1024).toFixed(0)} MiB freed, best-effort). Branches were left in place.`
      : `${removable} would be removed, ${kept} kept (${(freeableKiB / 1024).toFixed(0)} MiB reclaimable, best-effort). Re-run with --apply to remove.`,
  );
  return lines.join("\n");
}
