import { Command } from "commander";
import { parseDuration, renderSweepReport, sweepWorktrees, type SweepReport } from "../worktree-sweep.js";

/**
 * `rig worktree sweep` - z3. Removes git worktrees that are merged, clean, not locked, not in use
 * and not freshly touched. DRY RUN unless --apply. Local and daemon-free: the facts come from git.
 * Branches are never deleted; run dirs (non-git directories) are out of scope here.
 */
export function worktreeCommand(): Command {
  const cmd = new Command("worktree").description("Git worktree hygiene for the checkouts seats leave behind");

  cmd
    .command("sweep")
    .description(
      "Report (default) or remove (--apply) linked git worktrees that are merged into the target ref, clean, unlocked, not in use and not recently touched. Never touches the main checkout, uncommitted work or unmerged commits.",
    )
    .option("--repo <path>", "Repository to sweep (repeatable; defaults to the repo containing the current directory)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--into <ref>", "Ref a worktree's HEAD must be merged into (default: the remote default branch, origin/HEAD; a local branch is never guessed)")
    .option("--older-than <duration>", "Keep worktrees with git activity newer than this (e.g. 30m, 24h, 7d; 0s disables)", "24h")
    .option("--apply", "Actually remove the worktrees reported as REMOVE (default is a dry run)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { repo: string[]; into?: string; olderThan: string; apply?: boolean; json?: boolean }) => {
      let olderThanMs: number;
      try {
        olderThanMs = parseDuration(opts.olderThan);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
      }
      const report: SweepReport = await sweepWorktrees({
        repos: opts.repo.length > 0 ? opts.repo : [process.cwd()],
        into: opts.into,
        olderThanMs,
        apply: opts.apply === true,
      });
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(renderSweepReport(report));
      const failed = report.repos.some((r) => r.error !== null || r.worktrees.some((w) => w.reasons.some((x) => x.code === "remove-refused")));
      if (failed) process.exitCode = 1;
    });

  return cmd;
}
