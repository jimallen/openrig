# local/ — Jim's personal OpenRig setup (NOT for upstream)

This directory is personal, machine-specific tooling layered on top of a
stock `npm i -g @openrig/cli` install. It lives on the fork only — it is not
part of any upstream PR.

## `jims-team/` — custom rig spec

Role-based delivery team (7 seats) built from the personas in
`~/.claude/agents/` (chief-of-staff, architect, engineer, qa-engineer,
security-engineer, ux-engineer, devops). Build pod on Claude Code, independent
verify pod on Codex. `permission_policy: builtin:yolo` (seats boot at
`--dangerously-skip-permissions` / `-s danger-full-access`).

Install/refresh into the user spec library:

```bash
rig specs remove jims-team && rm -rf ~/.openrig/specs/jims-team
rig specs add <this-repo>/local/jims-team
```

Launch (note: user_file specs do NOT get the builtin cwd convenience default):

```bash
rig up ~/.openrig/specs/jims-team/rig.yaml --cwd "$PWD"   # from the target repo
```

## `bin/` — personal launchers (install to `~/.local/bin/`)

| Script | What it does |
|---|---|
| `rig` | PATH shim: runs the real CLI (and thus its daemon child) under Homebrew `node@22` — required while the published package pins better-sqlite3 11.x (no Node 26 prebuilds); drops out once the v13 N-API bump ships |
| `rig-claude` | `claude` with `CLAUDE_CONFIG_DIR=~/.rig/claude` (personas + skills as subagents; state separate from `~/.claude`) |
| `rig-codex` | `codex` with `CODEX_HOME=~/.rig/codex` (auth.json symlinked from personal; everything else isolated) |
| `rig-cmux` | Tile a rig's seats in cmux via the daemon API directly (CLI's hardcoded 5s timeout is too short for multi-tile layout applies) + auto-names the tab `<rig> · <repo>` |
| `rig-herdr` | Tile a rig's seats in herdr via the socket protocol directly, with a weighted layout (lead seat 50% width full-height, rest gridded right) and a repo-named tab — openrig's adapter only does the equal auto-grid |
| `rig-here` | Open tiles for whichever rig runs in the current directory (`--rig <name>` disambiguates; `cmux` arg switches provider); when no rig lives there it launches a per-directory `jims-team-<dirname>` instance from the library spec and tiles it |
| `claude` | Selective shim: jims-team's CoS seat (`--name exec-cos@jims-team*`) boots via `ollama launch claude --model $JIMS_COS_MODEL` (default `glm-5.3:cloud`); everything else passes through to the real binary. NB: Claude Code's `--name` flag hangs the ollama path — the shim strips it; seat identity lives in the tmux session name anyway |

## Ops notes

- **CoS is text-only** (`glm-5.3:cloud` via ollama rejects image input with HTTP 400, and a pasted image poisons the session — every later turn replays it and fails). Route screenshots/UI evidence to the claude seats (or codex seats) instead. Recovery recipe after a poisoned CoS turn: `/exit` in the pane → `ollama launch claude --model glm-5.3:cloud -- --dangerously-skip-permissions` → paste `~/.openrig/specs/jims-team/agents/chief-of-staff/guidance/role.md` (tmux load-buffer/paste-buffer) → submit → `rig reconcile-session exec-cos@jims-team`.
