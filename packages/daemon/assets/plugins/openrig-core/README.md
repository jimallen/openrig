# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (19):** canonical OpenRig operating knowledge, including the public `refocusing` skill and
its path-only topology/work trace.

**Hooks:** activity tracking, compaction continuity, and the default-on refocus channel. Refocus is
post-compaction on both runtimes, threshold-triggered on Claude, on-demand on both, configurable
off, and never runs at fresh session start.

**Guard:** `hooks/scripts/rig-body-guard.cjs` is a `PreToolUse` hook on Claude Code's `Bash` tool, active where this plugin is installed (the daemon delivers it to managed Claude seats separately, OF-250) (and, through `pi/rig-body-guard.cjs`, the Pi `tool_call`
extension the OpenRig pi-runner loads for every Pi seat). It refuses, before the shell runs it, a `rig send` / `rig queue ...` command whose text holds a command
substitution (backticks or `$(...)`) in double quotes, unquoted, or in an unquoted here-document, and tells the model to use `--file - <<'EOF'`.
On both Claude and Pi, it also refuses a kill that is not by PID (workspaces-o9o.108): `pkill -f`, `pkill` with a name pattern or an owner,
group or session selector, `killall`, `kill` of a negative pid, `-1` or `0`, and `kill` of what `pgrep` or `pidof` selects (`kill $(pgrep -f x)`,
`pgrep -f x | xargs kill`), through the same wrappers and shell forms the rig rule reads. Every seat on a host is the same user, so these reach other
seats' processes. `kill <pid>`, `kill %job`, `kill -l`, `pkill -F <pidfile>`, `pkill -P <pid>` and help or listing stay allowed; the refusal says to
find the pid with `pgrep -af '<exact path>'`, confirm it is yours, and `kill <pid>`.
In Claude Code's Code Mode the hook also runs on the `REPL` tool (workspaces-o9o.131): it judges every string and template literal in the code by the same shell rules, and refuses code that reaches a host API — `child_process` (including a `require`/`import` specifier), `process.binding`, `process.dlopen`, or a Function-constructor chain or alias. A property access is normalised first, so the member is caught however it is spelled (bracket string, optional chaining, `globalThis`/`self`, unicode-escaped names); the API rules do not scan string contents other than a module specifier. When the guard cannot run, a REPL call is refused outright. That is defence in depth over Claude Code's own refusal of module loading in REPL code, not a sandbox; a name assembled at run time is a documented residual.
On Claude Code only, the same hook also refuses a Bash call that is not `run_in_background: true` and starts a shell background job (a top-level `&` with no later
`wait`, or `nohup`, `disown` or `setsid` as a command word): nothing wakes the seat when such a job ends. The refusal points at `run_in_background: true` or Monitor.

**Ask-in-modal guard:** `hooks/scripts/ask-in-modal-guard.cjs` is a Claude Code `Stop` hook that sends a turn back once when it ends with a question for the human in prose, so the seat asks it in an `AskUserQuestion` modal instead. It is not in `hooks/claude.json`: the daemon puts it in the launch `--settings` of a seat whose rig-spec member declares `ask_in_modal: true`, and no other seat runs it.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`. Use it with:

- **Claude Code** — install via `/plugin` after the OpenRig daemon vendors `openrig-core/` to `~/.openrig/plugins/openrig-core/` on first run, or install the plugin directly through Claude Code's own plugin commands when remote distribution is available
- **Codex CLI** — install via `/plugins` after the same vendoring step, or directly through Codex's own plugin commands

One skill targets Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files

This is NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke this skill when restoring a peer Claude that has compacted — that's exactly when it's needed. Both runtimes ship it.

All other skills are cross-runtime by design.

## Distribution

The npm package includes an offline baseline under the daemon's
`assets/plugins/openrig-core/`. The daemon resolves local plugin authority before
attempting a network fetch, using the configured OpenRig home (normally
`~/.openrig/plugins/openrig-core/` for the installed copy):

| Installed state | Local vendoring behavior |
| --- | --- |
| Absent | Seed the bundled plugin. |
| Older manifest version | Advance files from the newer bundled version. |
| Equal manifest version | Preserve installed content; executable modes may be reconciled on byte-identical files. |
| Newer manifest version | Preserve the installed copy. |

Version authority comes from the plugin manifests. An existing directory without
a manifest is left unchanged; invalid or disagreeing manifest versions are
reported rather than guessed. Updating the CLI therefore does not unconditionally
overwrite an equal/newer or independently managed plugin copy.

After local resolution, the daemon attempts the GitHub release endpoint for
`openrig-core.tar.gz` with a five-second timeout. This path currently fetches and
logs the response only: it does not extract the archive, compare its version, or
install its content. Fetch failures, including 404 and network errors, leave the
resolved local copy in place. A successful fetch also leaves it unchanged.
This describes the fetch implementation, not a claim that a release artifact is
currently available at the external repository.

You can also install directly via Claude Code or Codex's own plugin commands if you prefer to manage plugins outside OpenRig.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
