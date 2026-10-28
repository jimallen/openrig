# `rig worktree sweep`

Removes the git worktrees that seats and tools leave behind once their work has merged. It is local and
daemon-free: every fact comes from git itself (`git worktree list`), so it covers worktrees any seat created,
wherever it put them. Source: [`packages/cli/src/worktree-sweep.ts`](../../packages/cli/src/worktree-sweep.ts) and
[`commands/worktree.ts`](../../packages/cli/src/commands/worktree.ts).

```sh
rig worktree sweep                         # dry run in the repo containing the current directory
rig worktree sweep --apply                 # remove what the dry run reported as REMOVE
rig worktree sweep --repo ~/Code/a --repo ~/Code/b
rig worktree sweep --repo ~/Code/eztrack --into master
rig worktree sweep --older-than 7d --json
```

## Options

| Option | Meaning |
|---|---|
| `--repo <path>` | Repository to sweep. Repeatable. Defaults to the repo containing the current directory. Two paths naming one repository are swept once. |
| `--into <ref>` | The ref a worktree's HEAD must be merged into. Default: the remote default branch (`origin/HEAD`). Required when the repo has no `origin/HEAD`. A local branch is never guessed. |
| `--older-than <duration>` | Keep worktrees whose git activity is newer than this (`30m`, `24h`, `7d`; `0s` disables the age guard). Default `24h`. |
| `--apply` | Actually remove the worktrees reported as REMOVE. Without it the command is a dry run and changes nothing. |
| `--json` | Print the full report as JSON. |

`--into` matters for repos that have no `origin/HEAD`. eztrack is one: run
`rig worktree sweep --repo <eztrack path> --into master`. Without it the repo is reported with an error
and nothing in it is touched.

Exit status: 0 on a completed sweep; 1 if any repo could not be assessed or a removal was refused by git
(`remove-refused`); 2 for an invalid `--older-than`.

## Safety rules

- The only deletion is `git worktree remove <path>` **without** `--force`. Git refuses dirty and locked
  worktrees by itself, so it is a second guard behind this command's own checks. Nothing is ever recursively
  deleted by the command itself.
- Branches are never deleted. Only the checkout directory goes. Stashes live in the repo and survive.
- The main checkout is never removed. The sweep runs git from the main checkout, so naming a linked worktree
  with `--repo` cannot pull the ground out from under it.
- Every probe that cannot be read yields a KEEP with its reason, never "absent, so proceed".
- Merged means the worktree HEAD is an ancestor of the one named target ref. A squash-merged branch cannot be
  proven merged by git alone, so it is kept (`not-merged`).
- Run it as a dry run first and read the KEEP reasons.

## What gets reported

Each linked worktree is `would-remove` (dry run), `removed` (`--apply`) or `kept`, with every reason that
applies. The summary line counts removable worktrees and a best-effort size; the size never feeds a decision.

## KEEP reasons

| Code | Why the worktree is kept |
|---|---|
| `locked` | `git worktree lock` is set (the lock reason is shown). |
| `prunable-missing` | The directory is gone. Leave it to `git worktree prune`. |
| `in-use` | A running process has its working directory inside the worktree, the caller is standing in it, or it is the main checkout. |
| `in-use-probe-failed` | The process working directories could not be listed (see "In-use probe"). Everything is kept. |
| `contains-another-worktree` | Removing it would take another checkout with it. |
| `status-unreadable` | `git status` failed or printed errors. |
| `uncommitted-changes` | Tracked edits or untracked files exist. |
| `secret-looking-ignored-file` | An ignored file looks like a secret (below). The file is named in the reason. |
| `ignored-files-unreadable` | The ignored files could not be listed or walked (including a very large ignored tree). |
| `nested-repo-in-ignored-path` | An ignored directory contains another git repository whose files git cannot see from here. |
| `hidden-index-flags` | A file is flagged `assume-unchanged` or `skip-worktree`, so edits to it are invisible to `git status` and to `git worktree remove`. |
| `index-flags-unreadable` | `git ls-files -v` failed. |
| `operation-in-progress` | A rebase, merge, cherry-pick, revert, bisect or sequencer operation is under way, or its marker could not be checked. |
| `head-unreadable` | HEAD does not resolve to a commit. |
| `not-merged` | HEAD is not an ancestor of the target ref. |
| `merge-check-failed` | The ancestry check itself failed. |
| `too-recent` | Git activity inside `--older-than`. |
| `age-unreadable` | The git directory timestamps could not be read. |
| `remove-refused` | `--apply` ran and git refused the removal (for example a submodule). The worktree is left in place and the exit status is 1. |

### Secret-looking ignored files

Ignored files are otherwise treated as regenerable and deleted with the worktree, so the sweep keeps any
worktree holding an ignored file matching, case-insensitively on the basename: `.env`, `.env.*` (templates such
as `.env.example` included), `.envrc`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa*`,
`id_ed25519*`, `.npmrc`, `.netrc`, `.pgpass`, `credentials*`, `token*`, `secrets`, or anything under a directory named
`secrets`. Only real dependency trees (a `node_modules`
directly inside a directory holding a `package.json`) are skipped.

### In-use probe

On Linux the probe reads `/proc/<pid>/cwd` and counts processes it cannot read (reported as a note). On macOS and
other hosts it runs `lsof -d cwd -Fn`. `lsof` exit status 1 (some processes not inspectable) with the rest printed
is accepted; `lsof` missing, killed, any other exit status, output cut off at the buffer limit, or an empty or
non-`lsof` listing makes the probe fail and every worktree is kept with `in-use-probe-failed`. `lsof` lists only the
processes it is allowed to inspect and gives no per-process signal for the rest: measured on a macOS laptop as a
non-root user, `lsof -d cwd -Fpfn` exited 0 with empty stderr and listed 1049 of the 1443 processes `ps -A` showed, with no
record at all for the other 394. There is nothing to count, so the macOS probe reports 0 unreadable processes and the
sweep prints no "unreadable" note there. A process of another user standing in a worktree is therefore invisible on
macOS (Linux counts and reports such processes).
