# RigSpec Reference

Version: 0.2 (pod-aware)
Last validated against code: 2026-10-07, at the 0.6.6 cut `2620dea8` (whole document at `fcaf1f8e`; changes to its sources since then checked)
Source of truth: `packages/daemon/src/domain/rigspec-schema.ts`, `packages/daemon/src/domain/types.ts`, `packages/daemon/src/domain/startup-validation.ts`, `packages/daemon/src/domain/permission-policy/policy-ref.ts`, `packages/daemon/src/domain/profile-resolver.ts`, `packages/daemon/src/domain/rigspec-preflight.ts`, `packages/daemon/src/adapters/kernel-authority.ts`, `packages/daemon/src/domain/native-permission-store.ts`, `packages/daemon/src/domain/codex-team-workspace.ts`

This is the canonical reference for the pod-aware RigSpec YAML format. Every field, validation rule, and default documented here was traced from the actual parser and validator code, not from prior documentation.

---

For choosing IDs, see [naming rigs, pods and seats](topology-naming.md). Keep the same
logical names in edges, startup instructions, workflow targets and runtime presets.

## Minimal Valid Example

```yaml
version: "0.2"
name: my-rig

pods:
  - id: dev
    label: Development
    members:
      - id: build
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
    edges: []

edges: []
```

## Complete Example (all features)

```yaml
version: "0.2"
name: my-product-team
summary: A full product squad with orchestration, development, and review pods.

culture_file: culture/CULTURE.md

docs:
  - path: SETUP.md
  - path: README.md

startup:
  files:
    - path: guidance/team-norms.md
      delivery_hint: guidance_merge
      required: true
  actions: []

services:
  kind: compose
  compose_file: docker-compose.yaml
  project_name: my-product
  profiles: [core]
  down_policy: down
  wait_for:
    - url: http://127.0.0.1:5432/health
    - service: redis
      condition: healthy
  surfaces:
    urls:
      - name: App
        url: http://127.0.0.1:3000
    commands:
      - name: psql
        command: "psql postgresql://app:dev@127.0.0.1:5432/app"
  checkpoints:
    - id: postgres
      export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
      import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"

pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: peer
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

  - id: dev
    label: Development
    summary: Implementation and quality assurance pair.
    continuity_policy:
      enabled: true
      sync_triggers: [pre_compaction, pre_shutdown]
      artifacts:
        session_log: true
        restore_brief: true
      restore_protocol:
        peer_driven: true
        verify_via_quiz: false
    startup:
      files:
        - path: guidance/dev-sop.md
          delivery_hint: guidance_merge
          required: true
      actions: []
    members:
      - id: build
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
        label: "Implementation Lead"
        model: claude-opus-4-6
        restore_policy: resume_if_possible
        startup:
          files:
            - path: guidance/impl-specific.md
              delivery_hint: send_text
              required: false
              applies_on: [fresh_start]
          actions:
            - type: send_text
              value: "Read your guidance and begin."
              phase: after_ready
              idempotent: true
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: codex
        cwd: "."
    edges:
      - kind: delegates_to
        from: build
        to: qa

  - id: rev
    label: Review
    members:
      - id: r1
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: r2
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

edges:
  - kind: delegates_to
    from: orch.lead
    to: dev.build
  - kind: delegates_to
    from: orch.peer
    to: dev.qa
  - kind: can_observe
    from: rev.r1
    to: dev.build
  - kind: can_observe
    from: rev.r2
    to: dev.qa
```

---

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | yes | — | Use `"0.2"`. Any non-empty string validates; a spec is treated as pod-aware because `pods` is an array. |
| `name` | string | yes | — | Rig name. Used in session naming (`{pod}-{member}@{name}`), snapshot identification, and spec library lookup. |
| `summary` | string | no | — | Human-readable description. Shown in the spec library, review surfaces and `rig specs preview` (in `rig specs show` only with `--json`). |
| `culture_file` | string | no | — | Relative path to a rig-wide culture/constitution file. Must be a safe relative path (no `..`, no absolute). |
| `non_interruptive` | boolean | no | — | Pod-aware rig launch-warning default. With full-bypass Claude/Codex seats, true accepts or hides supported harness warnings using launch flags. Explicit CLI choices override this field; this field overrides the machine default. It does not grant permissions, change native settings files, or bypass login. |
| `permission_policy` | string | no | — | Permission policy attached to the rig. Either a built-in (`builtin:locked`, `builtin:standard`, `builtin:open`, `builtin:yolo`, `builtin:auto`) or a safe relative path to a custom policy file (resolved from this spec's directory; no `..`, no absolute, no empty segments, each segment `[A-Za-z0-9][A-Za-z0-9._-]*`), or `none`, a recorded choice of the floor. Absent uses the default floor with the scoped team launch allowances described below. A bare built-in name such as `yolo` is refused ("use 'builtin:yolo'"), and so is an explicit `null`. A custom file that is missing, unreadable or invalid isn't a validation error: it resolves to the floor, and preflight warns. A member may set its own `permission_policy` (not on a terminal member), which takes precedence over the rig-level one; there is no pod level. See "Attaching a permission policy" below. |
| `managed_blocks` | map | no | `CLAUDE.md` | File that receives OpenRig's managed instruction blocks for Claude Code members. Only the `claude-code` key is accepted, with `CLAUDE.md` or `CLAUDE.local.md`. Codex, Pi and OMP members use `AGENTS.md`. See "Choosing the Claude instruction file" below. |
| `workspace` | object | no | — | The rig's workspace: `workspace_root` (required), `repos[]` of `{name, path, kind}` with `kind` one of `user`, `project`, `knowledge`, `lab` or `delivery` and unique names, an optional `default_repo` naming one of them, and an optional `knowledge_root`. Relative repo paths resolve against `workspace_root`. |
| `docs` | Doc[] | no | — | Documentation files that should travel with the rig. Included in rig bundles. Each entry has a `path` field (safe relative path). The engine does not consume these — they are for humans and agents setting up the environment before launch. |
| `startup` | StartupBlock | no | — | Rig-level startup files and actions. Applied to all members via the startup layering model. |
| `services` | ServicesBlock | no | — | Optional managed services (Docker Compose). When present, `rig up` boots them before any agent launches; `rig import` doesn't boot them. |
| `pods` | Pod[] | yes | — | At least one pod required. Each pod is a bounded context containing members and pod-local edges. |
| `edges` | CrossPodEdge[] | no | `[]` | Cross-pod edges connecting members in different pods. Must use fully-qualified `pod.member` IDs. |

### Attaching a permission policy

Attach a policy to a rig with `permission_policy`, either at the rig level or on a member:

```yaml
# a built-in, by name:
permission_policy: builtin:standard

# or a custom policy file, by relative path (resolved from this spec's directory):
permission_policy: policies/my-cautious-dev.policy.md
```

Built-in policies (`locked` / `standard` / `open` / `yolo` / `auto`) are read-only and are
referenced as `builtin:<name>`. A custom policy lives in your own project and is
referenced by a safe relative path (no `..`, no absolute). A shipped example of the
custom shape is `packages/daemon/policies/examples/my-cautious-dev.policy.md` — copy it
into your project and edit it to taste.

This records a selection, not a live permission change. Flag-surface policies
select launch flags; config-surface policies still need native configuration
application and inspection. In particular, `builtin:yolo` selects Codex's
`danger-full-access` sandbox and `never` approval policy, and replaces
any `codex_config_profile` argument. See [practical permission choices](getting-started.md#opt-in-permissive-operation).

An explicit `rig seat set-permissions` choice overrides member/rig policy for
future managed launches of that stable seat; it does not rewrite this spec or
its inherited policy provenance. `inherit` removes that override. See
[per-seat permission mode](getting-started.md#per-seat-permission-mode).

### Team launch defaults

A non-kernel Claude or Codex seat with no authored permission policy, explicit
seat permission selection, or named Codex profile receives the team launch
default. An explicit policy, including `none` or `builtin:locked`, keeps its
existing meaning. The default is derived again for fresh launch, resume, fork
and handover; it is not saved as a user choice. Kernel, Pi and terminal behavior
is unchanged.

Claude keeps `acceptEdits` and receives inline session settings allowing ordinary
`rig` commands, project reads and common project test commands (for example,
`npm test`, `pnpm test`, `pytest`, `go test` and `cargo test`). Lifecycle commands
such as `rig up`, `rig down`, `rig restore`, `rig bundle install` and seat stop or
handover ask through a session `PreToolUse` hook. Their literal help forms, such
as `rig down --help`, `rig bundle install -h` and `rig help down`, run without
that lifecycle prompt. Native personal, project and managed deny/ask rules still
apply; OpenRig does not remove or override them.

For allowances, the hook recognizes literal command words (including quoted or absolute paths),
leading environment assignments that do not change executable lookup or startup,
and `env`, `command` and `exec` wrappers without options other than `--`.
Relative executable paths and assignments such as `PATH` or `NODE_OPTIONS` stay
with native checks. The same existing team allowances apply after spelling
normalization; project `node_modules/.bin/vitest` and `jest` paths match their
existing `npx` allowances. It does not automatically allow pipelines, command
substitutions, redirects, heredocs, shell functions or other unrecognized syntax.
Lifecycle prefixes are checked at every word position, including after wrappers,
control-flow words and CLI argument separators. A `--` separator before or after
the subcommand ends option parsing, so a later `--help` is an operand and still
asks. Ask detection also scans with comment text retained, so a `#` inside a
substitution does not hide a later lifecycle command. Unquoted prose or comments
containing a lifecycle command may also ask; ordinary trailing comments do not
change allowance matching. Quoted messages and quoted heredoc bodies remain data.
Arithmetic shifts are not treated as heredoc operators. These are command
allowances, not containment: a project's test command can execute code. The
hook and allowances are passed with `--settings` at launch, including resume
and fork; nothing is written to personal or project permission files.

If the helper asset is missing at launch, OpenRig falls back to the native lifecycle
ask rules; help can prompt in that fallback. A helper that disappears or times out
after launch cannot supply a decision, leaving Claude's remaining native rules
in effect. The hook is a convenience policy, not a containment boundary.

Codex keeps `workspace-write` with its existing approval policy and receives the
configured OpenRig workspace root plus its pod's shared state directory as
additional writable directories. The team workspace preparer creates missing
directory ancestors and excludes the home directory and its ancestors from its
prepared scopes. Unavailable optional directories are warned about and omitted
from that list without blocking launch. When no prepared scopes remain, the
runtime adapter retains its existing pod-state `--add-dir` fallback, which this
step does not prepare. This does not modify Codex permission files or enable
non-interruptive mode.

**Codex lifecycle commands do not gain a new approval rule.** With Codex's
existing `on-request` policy, non-escalated sandboxed commands, including
`rig up` and `rig down`, can run without asking. This default addresses writable
workspace access; it does not promise a lifecycle confirmation prompt.

### Built-in permission policies

The five built-ins live in `packages/daemon/policies/builtin/`. Action names are the
policies' own semantic classes.

| Policy | Surface | Runs without asking | Asks a person | Denied |
|--------|---------|---------------------|---------------|--------|
| `builtin:locked` | config | `run_toolchain` (npm, node, tsc, tests, lint), `rig_up`, `rig_down` | nothing | everything else (`default_posture: deny`) |
| `builtin:standard` | config | everything not listed, including `push_to_remote` (`default_posture: allow`) | `create_pr`, `publish_package`, `merge_or_release`, `force_push`, and the destructive class | nothing |
| `builtin:open` | config | everything, including PRs, publishing, merges and force pushes (`default_posture: allow`) | the destructive class only | nothing |
| `builtin:yolo` | flag (`launch_posture: full_bypass`) | everything; the runtime's permission prompts are bypassed at launch | nothing | nothing |
| `builtin:auto` | flag (`launch_posture: auto`) | Claude runs with `--permission-mode auto`; Codex, Pi and OMP launch at the floor | Claude: decided by auto mode; others: as at the floor | Claude: decided by auto mode; others: as at the floor |

The destructive class is `delete_everything`, `drop_persistent_store` and
`reset_or_discard_vcs`; `builtin:locked`'s list also names `delete_files` and `force_push`.

**At launch.** `builtin:yolo` selects Claude `--dangerously-skip-permissions`, Codex
`-s danger-full-access -a never`, and Pi `--approve`. `builtin:auto` selects Claude
`--permission-mode auto`, while Codex and Pi do not have an auto mode and launch at the floor.
Every other seat launches at the floor (a non-kernel seat with no policy also gets the
[team launch default](#team-launch-defaults) above):
- Claude `--permission-mode acceptEdits`;
- Codex `-s workspace-write`, or `-p <profile>` when the member sets
  `codex_config_profile`, in which case the profile governs its own sandbox;
- Pi `--no-approve` by default.

Seats of the rig named `kernel` are the exception. With no member or rig policy, no
per-seat choice and (for Codex) no named profile, Claude launches in `acceptEdits` with a
per-launch `--settings` allow list for its file tools and operational commands, and Codex
launches with `-s danger-full-access -a never`, plus per-launch `-c` overrides that hide its
full-access and GPT-5.1 migration notices, whatever the rig's non-interruptive choice.

**Config-surface policies are recorded, not applied at launch.** The seat still starts at
the floor. The `allow`, `ask` and `deny` rules take effect once they are translated into the
runtime's native settings. The `applying-a-permission-policy` skill in `openrig-core` does
that translation, with per-runtime limits. For example, Claude's prefix rules can't
reliably tell `git push --force` from `git push`. An `ask` waits for a person, so it pauses
an autonomous seat. Standard suits interactive work, and the policy files point
autonomous teams to Open or YOLO.

**Pi has no permission policy.** `--approve` and `--no-approve` set Pi's resource trust. The
OMP variant maps that trust to its approval mode: `yolo` under `--approve`, otherwise
`always-ask`.

**A custom policy file** is Markdown with frontmatter: `policy_schema_version: 1`, `name`,
`source: custom`, `description`, and `surface`.
- `surface: flag` adds `launch_posture` (`floor`, `full_bypass` or `auto`).
- `surface: config` adds `default_posture` (`allow`, `ask` or `deny`) and the `allow`, `ask`,
  `deny` and `destructive_class` lists (`[]` for none).

**Claude Code's own checks.** The first time Claude Code starts an interactive session
with permissions bypassed, it shows a warning dialog asking you to accept responsibility;
declining exits. OpenRig reports such a seat as `attention_required` and holds its startup
context for `rig seat continue`; `rig up --non-interruptive` or `rig bundle install
--non-interruptive` accepts the warning with a launch flag instead (see
[non-interruptive mode](non-interruptive-mode.md)). That choice is saved on the rig, not in
`rig.yaml`. On Linux and macOS Claude Code refuses that mode when run as root or under `sudo`,
except inside a recognized sandbox. See Claude Code's
[Choose a permission mode](https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).

### Choosing the Claude instruction file

OpenRig writes its instructions for Claude Code members into managed blocks in
the member's working directory. By default the file is `CLAUDE.md`. If your
repository tracks `CLAUDE.md`, write the blocks to `CLAUDE.local.md` instead:

```yaml
managed_blocks:
  claude-code: CLAUDE.local.md
```

Claude Code loads `CLAUDE.local.md` from the working directory as well. By
convention the file is kept out of git, for example with a `.gitignore` entry.

- Accepted values are `CLAUDE.md` and `CLAUDE.local.md`. Any other value or
  runtime key is rejected before a member launches.
- The setting applies to launch, restore, relaunch, handover, adding members,
  and export. `rig down` removes OpenRig's blocks from the selected file only.
- OpenRig never edits, moves or deletes blocks in the other file.

A rig that already wrote blocks into `CLAUDE.md` keeps them there after you
switch. Until you remove them, `CLAUDE.md` stays modified and Claude Code loads
both copies. Delete each `<!-- BEGIN OpenRig MANAGED BLOCK: … -->` …
`<!-- END OpenRig MANAGED BLOCK: … -->` section by hand and keep the rest of the
file. If `CLAUDE.md` has no other uncommitted edits you need to keep, you can
instead run `git restore CLAUDE.md`; that command discards every unstaged change
to the file, not only OpenRig's blocks. Running `rig down` on a rig that still uses
the default is not a substitute: it strips every OpenRig block from that
directory's `CLAUDE.md`, including blocks written by other rigs.

---

## Pod

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Pod identifier. Must not contain dots or `@`. Must be unique within the rig. Used as the first segment of session names and logical IDs. |
| `label` | string | yes | — | Human-readable pod name. Shown in UI explorer, graph groupings, and detail surfaces. |
| `summary` | string | no | — | Pod description. |
| `continuity_policy` | ContinuityPolicy | no | — | Pod-level continuity/restore policy, validated and stored with the pod (see "Continuity Policy"). |
| `startup` | StartupBlock | no | — | Pod-level startup files and actions. Applied to all members in this pod via the startup layering model. |
| `members` | Member[] | yes | — | The pod's members. It must be an array; validation doesn't refuse an empty one. |
| `edges` | PodLocalEdge[] | no | `[]` | Edges between members within this pod. Must use unqualified member IDs (not `pod.member`). |

### Pod ID Rules

- Must not contain dots (`.`)
- Must not contain `@`, which separates the pod/member portion from the rig name in session addresses
- Must be unique across all pods in the rig
- Becomes the first segment of the qualified logical ID: `{podId}.{memberId}`
- Becomes the first segment of the canonical session name: `{podId}-{memberId}@{rigName}`

---

## Member

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Member identifier. Must not contain dots or `@`. Must be unique within the pod. |
| `agent_ref` | string | yes | — | Reference to an AgentSpec. Must start with `local:` (relative) or `path:` (absolute). Exception: `builtin:terminal` for infrastructure nodes. |
| `profile` | string | yes | — | Profile name from the referenced AgentSpec. Use `default` for the default profile. Exception: `none` for terminal nodes. |
| `codex_config_profile` | string | no | — | Codex-only native profile passed as `-p <name>`; letters, numbers, `_`, `.`, `-`. Separate from the AgentSpec `profile`. With the normal launch mode, this replaces OpenRig's explicit workspace-write sandbox flag. A full-bypass policy instead emits danger-full-access and omits this profile argument. |
| `runtime` | string | yes | — | Agent runtime. Current supported values: `claude-code`, `codex`, `pi`, `omp`, `terminal`, `stub`. `stub` is a deterministic test harness, not an agent: a Node runner in the seat's tmux pane goes through the normal launch, skill projection, startup-file and readiness path, follows `<cwd>/.openrig/stub/script.json` when present, and calls no model. See "What a stub can and cannot prove" in `docs/as-built/test-layers.md`. |
| `cwd` | string | yes | — | Working directory for the agent. A relative path resolves against the rig root (the directory containing the rig spec). If that path exists as written, it is used. Otherwise a leading `~` or `~/` expands to the home directory (`~user` does not) and `$VAR` / `${VAR}` expand from the daemon host's environment; a relative result still resolves against the rig root. A reference to an unset variable stays as written, so the cwd is that literal path and works only if it exists. Use `"."` for the rig root itself. Can be overridden at launch time with `rig up --cwd`. A cwd inside the OpenRig installation fails preflight unless `--cwd` is given. |
| `label` | string | no | — | Human-readable member name. Shown in UI when present. |
| `model` | string | no | — | Model override. Runtime-specific (e.g., `claude-opus-4-6` for Claude Code). |
| `effort` | string | no | — | Reasoning effort override, trimmed. A non-string value is ignored with an advisory. |
| `remote_control` | boolean | no | `false` | Claude Code only. `true` starts Claude Code Remote Control for the seat: every Claude launch of it (fresh, resume, restore after `rig down`, fork, handover successor) carries `--remote-control <the seat's session name>`, the same name `--name` uses. `true` on any other runtime is a validation error; a non-boolean is an error. Absent or `false` leaves the launch command unchanged. The flag is persisted on the seat, so a restore after a daemon restart still applies it. A settings fragment cannot do this: Claude ignores `remoteControlAtStartup` from project and local settings. |
| `env_passthrough` | string[] | no | `[]` | Pi only. Names (never values, at most 32) of variables the seat's pi child keeps from the seat pane's environment, beyond the baseline. Refused: OpenRig and Pi isolation variables, and names that change what a process runs or loads (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH` and the like). A listed variable's value, a secret's included, is exposed to that seat's tools and model, as it is for a Codex seat today; spec authors are trusted. |
| `permission_policy` | string | no | — | Member-level permission policy; overrides the rig's. Not valid on terminal members. |
| `role` | string | no | — | The seat's role, letters, digits, `_`, `.` and `-`. Not valid on terminal members. |
| `restore_policy` | string | no | the AgentSpec's | Restore behavior. One of: `resume_if_possible`, `relaunch_fresh`, `checkpoint_only`. The default comes from the AgentSpec's `defaults.lifecycle` (else `resume_if_possible`) as narrowed by its profile; a member value may only narrow it further, in that order. |
| `compaction_strategy` | string | no | — | `default-compaction`, `managed-compaction`, `handover` or `apprentice-handover`; `harness_native` and `pod_continuity` are accepted as deprecated aliases, and `custom_prompt` is refused. |
| `mechanic` | string | no | — | A canonical `seat@rig` session address, for `apprentice-handover`. |
| `session_source` | object | no | — | Start the seat from an existing session: `fork` with `native_id`, `rebuild` with `artifact_set`, or `agent_image` with `image_name`. A Claude Code `fork` needs Claude Code 2.0.73 or later. Not valid on terminal members. |
| `starter_ref` | object | no | — | `{ name }` of an agent starter (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) whose files lead the seat's startup. Not valid on terminal members or with a fork. |
| `startup` | StartupBlock | no | — | Member-level startup files and actions. Applied only to this member. |
| `mcp_servers` | map | no | — | Codex only. Declares stdio MCP servers that are OFF for every seat of this member until one seat instance is switched on with `rig seat set-mcp`. See [Codex MCP servers](#codex-mcp-servers-mcp_servers). |
| `pda` | object | pda members only | — | `{ agent, base_url }`, required exactly when `runtime` is `pda` and refused on any other runtime. See [pda seats](#pda-seats-pda). |

### pda seats (`pda`)

A pda seat drives one agent on a pda server. The block names the agent and where its server listens:

```yaml
- id: research
  runtime: pda
  agent_ref: local:agents/pda-seat      # copy docs/reference/templates/pda-seat/ to agents/pda-seat/ beside the rig spec
  profile: default
  cwd: /home/me/.workspaces/durable-research
  pda:
    agent: research                     # required, no default
    base_url: http://127.0.0.1:8150     # optional; this is the default
```

- `agent` is required and has no default. It matches `^[a-z0-9][a-z0-9_-]{0,39}$`, and `main` (pda's root agent) is refused.
- `base_url` is `http://127.0.0.1:<port>` with a port from 1 to 65535 and nothing else: pda listens on loopback only, `localhost` is a name and not an address, and `https`, a path, userinfo, a trailing slash or a leading-zero port are refused. Any other key in the block is refused.
- A pda member refuses `model`, `effort`, `permission_policy`, `session_source`, `starter_ref`, `startup`, `compaction_strategy`, `mechanic`, `codex_config_profile`, `mcp_servers` and `remote_control: true`: the pda agent owns them, and OpenRig delivers no startup content to a pda agent. `restore_policy` may be absent or `resume_if_possible`.
- **One pda agent is driven by one seat.** Two members that name the same `agent` at the same `base_url` are refused in the spec. The same name on another port is another pda server and is allowed. Beyond the spec, the daemon enforces it against every rig of the SAME daemon that is not archived:
  - at instantiation (`rig up <spec>`, `rig expand`, adding a member), refused naming the seat and rig that hold the agent; `rig up` re-checks inside the transaction that creates each seat, so a rig created while it runs cannot slip in;
  - when an archived rig is brought back (`rig unarchive`, `POST /api/rigs/:id/unarchive`), refused with 409 naming the holder; the rollback of a failed `rig up` replacement leaves the earlier generation archived, with a note, for the same reason;
  - a live seat whose saved binding is damaged counts as a possible holder of every agent: the refusal names it and asks for it to be repaired or its rig archived.

  **Not covered:** two daemons on one host (different `OPENRIG_HOME`, different ports) share that host's loopback pda and cannot see each other's seats, so nothing stops both from driving one agent. The same pair on different hosts is two different pda servers and is correct.
- The binding is stored on the seat (`nodes.pda_binding`) and written back by `rig spec export`.
- `runtime: pda` is launchable: preflight accepts it, and the seat's pane runs OpenRig's pda runner, which attaches to the agent on the pda server and reads pda's token file itself (`$OPENRIG_PDA_TOKEN_FILE`, default `~/.pi-durable/token`). The agent must already exist: OpenRig never creates, resets or forks a pda agent. A launch or restore is refused before any keystroke while another seat drives the same agent.
- Readiness comes from the runner: its sidecar first, then the runner's own READY/exit/error markers in the pane. It never comes from reading pda's output. `rig send` asks the runner's sidecar first. When there is no valid runner answer (the sidecar is absent, stale, unparseable or not ready), it falls back to the same pane and hook checks other runtimes get. A restore resumes the same agent (resume token type `pda_agent`). A pda seat has no fresh start and no handover: `rig seat launch --fresh` and `rig seat handover` are refused, and restore's advice never offers a fresh start for it. OpenRig delivers no startup content to it.
- A message pda refused repeatedly is held at the head of the seat's queue, and later messages wait behind it. `rig seat pda-release <session> --reason <text>` asks the runner to retry the held message once more. It is audited, and the message may be delivered twice if pda took it on an earlier attempt that never answered.
- Usage: the setting `usage.pda_cost_facts` is **off by default**. With it off, the daemon stores no pda usage. With it on, the runner reports the usage of its agent's assistant entries to `rig usage cost`. Each report carries the conversation and entry ids, the entry's timestamp, provider, model, api, response id and stop reason, its input/output/cache-read/cache-write token counts, a cost and its basis, and an origin (own, other or unknown). It never carries message text. Compaction and tool usage are not included, and pda's declared zero price is shown as no cost, not $0. See `rig config` and `rig usage cost --help`.

### Codex MCP servers (`mcp_servers`)

```yaml
mcp_servers:
  lsp:
    command: /Users/me/.local/opt/mcpls-0.8.0/bin/mcpls   # absolute, no whitespace
    args: ["--config", "/Users/me/.local/opt/mcpls-0.8.0/mcpls.toml"]
    enabled_tools: [get_definition, get_references, get_hover]   # required, non-empty
    startup_timeout_sec: 30   # optional, 1..3600
    tool_timeout_sec: 60      # optional, 1..3600
```

- Only `command`, `args`, `enabled_tools` and the two timeouts are accepted; every other Codex server key (`env`, `cwd`, `url`, headers, `enabled`, ...) is refused. Server names are letters, digits, `_` and `-`, and never an object property name such as `__proto__`. Text may not contain control, format or separator characters.
- A declaration runs nothing. `rig seat set-mcp <seat> <server> on --reason ...` switches it on for ONE seat instance. It reads the declaration from the rig's recorded spec file, or from `--spec <file>`. It then stores a snapshot and the sha256 of the binary the command resolves to. Every Codex launch of that seat (fresh, resume, restore, fork, restart) renders one `-c 'mcp_servers.<name>={...}'`. `off` removes it.
- Every launch re-checks the declaration and the binary's place. It refuses to render when the binary's sha256 changed (switch it on again to accept an upgrade). It also refuses when another Codex config layer (the shared `config.toml`, a selected profile, a project `.codex/config.toml`) already defines a server of the same name, because Codex would merge that definition into this one.
- **Codex does not sandbox MCP server processes.** On a seat whose launch is not full_bypass the server can do what the seat's own commands cannot. `set-mcp on` and every such launch print a warning.

**Trust boundary.** What runs is decided by two files: the server binary, and the spec the declaration is read from. A sandboxed seat must not be able to write either.

- **A `--spec` file is accepted only from an allow-list.** It must lie under one of these roots:
  - the released spec copies (`~/.agents-release`);
  - the spec library;
  - the rig's recorded spec directory.

  Containment is decided by the identity (device and inode) of the resolved file's directories, so letter case, firmlinks such as `/System/Volumes/Data/...` and links cannot change the answer. Any other location is refused, including places a seat can write that nobody listed (its `--add-dir` state folder, a configured writable root). The file must also be a regular file with exactly one link, and it must pass the binary rules below. For example, `--spec ~/.agents-release/current/rigs/jims-team/rig.yaml` is accepted, while the same file in a `~/.agents` git checkout is refused.
- **The binary is refused, as written and as resolved, when it lies:**
  - inside the seat's working directory;
  - inside the spec's own directory;
  - inside any `.workspaces` directory (any letter case);
  - inside any git work tree;
  - inside a temporary directory (`/tmp`, `$TMPDIR`, `/var/folders`).

  The seat folder, spec folder and temporary directories are compared by identity, not by path text. It is also refused when any component of either path is not owned by you or root, or a non-link component is writable by group or others. There is no sticky-bit exemption.

The rig-name check on a `--spec` file is a typo guard, **not** a security boundary. A `project_rig: true` spec matches any seat of a project it could be launched into, and a plain spec's `name` is whatever the file says. Do not rely on the name match to decide whether a spec is trustworthy.

### Pi (`runtime: pi`)

`runtime: pi` launches the Pi coding agent (`pi --mode rpc`) through OpenRig's RPC runner.

- **State:** Each seat uses `$OPENRIG_HOME/state/pi/<session>/agent` as its Pi agent directory, with `sessions/` beside it, instead of your default `~/.pi/agent`. The runner sets `PI_CODING_AGENT_DIR` to that directory. `<session>` is the seat's session name, unchanged; for a pod member it is `{podId}-{memberId}@{rigName}`. `$OPENRIG_HOME` defaults to `~/.openrig`. OpenRig creates these directories at launch and does not copy anything from `~/.pi/agent`.
- **Custom models:** Pi reads `models.json` from its agent directory, so a seat reads `$OPENRIG_HOME/state/pi/<session>/agent/models.json`, not `~/.pi/agent/models.json`. Custom provider and model definitions for a seat go in that file. A seat that uses only providers Pi already includes does not need one. OpenRig does not create or write `models.json`.
- **Credentials:** The Pi process receives only `PATH`, `HOME`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SHELL`, `TMPDIR`, a fixed set of OpenRig seat and instance variables, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and at most one provider key. That key is `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY` or `MINIMAX_API_KEY`, passed only when it is set in the seat's environment and the seat's `model` is written as `openrouter/<id>`, `zai/<id>`, `kimi-coding/<id>` or `minimax/<id>`. Naming that variable in `recovery.provider_auth_env_allowlist` (empty by default) makes the daemon add it, when set in the daemon's environment, to the seat's launch environment. No other variable reaches Pi, including other providers' keys and a custom provider's own key variable.

### Oh My Pi (`runtime: omp`)

`runtime: omp` launches Oh My Pi through OpenRig's RPC runner. It is separate from `runtime: pi`; OMP does not use Pi's `--name` or `--approve` flags.

- **State:** Each seat uses `$OPENRIG_HOME/state/omp/<seat>/agent` and `sessions/` instead of your default `~/.omp` profile, and runs with that seat directory as `HOME`. OpenRig does not copy OMP credentials. The runner finds the real `omp` binary before switching `HOME`, so a version-manager shim such as mise on the daemon's `PATH` still works.
- **Credentials:** Provision each seat separately, or put the provider's key variable in `recovery.provider_auth_env_allowlist` (for example `ANTHROPIC_API_KEY` or `MISTRAL_API_KEY`). The allowlist accepts the key variable of every provider in OpenRig's OMP provider map, from `anthropic` through `litellm`. A seat receives a key only when its `model` is written as `provider/id`, such as `anthropic/claude-sonnet-4-5`. Short names such as `opus` pass no key. A provider whose key is scoped to one endpoint also accepts that endpoint's variable: `anthropic`, `openai` and `litellm` each take their `<PROVIDER>_BASE_URL` — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `LITELLM_BASE_URL`. The allowlist admits each variable on its own, so an endpoint named without its key is admitted too, which suits a keyless local proxy. The launch gate admits these endpoint names for OMP seats; the match against the seat's declared `provider/id` happens at the OMP child, which forwards a matching endpoint already in the runner's environment just as it forwards a key. OMP also reads the launch directory's `.env`, so use a trusted working directory.
- **Approval posture:** The default floor is `--approval-mode always-ask`. Because the runner is headless, OMP approval requests are cancelled and the seat stays in needing-attention after the turn ends, until the next agent run starts. A `full_bypass` permission policy selects `--approval-mode yolo`.
- **Model errors:** A rejected prompt, a provider or authentication error during a turn, or exhausted automatic retries is printed in the pane and keeps the seat in needing-attention until the next agent run starts.
- **Restore:** OMP creates its session file after the first persisted turn. A new seat with no persisted turn has no resume token; restoring it requires a fresh start: `rig seat launch '<seat>@<rig>' --fresh --reason "<why>"` (or `rig up --existing <rig> --fresh <seat>` when the whole rig is stopped). After that file exists, OpenRig restores that exact session file. If a full rig restore leaves an OMP seat in `attention_required` or `failed`, `rig seat clear-attention` cannot yet reconcile it to `operator_recovered`, even with `--reason`, because restore reconciliation only verifies Claude Code and Codex processes ([#41](https://github.com/mvschwarz/openrig/issues/41)). Relaunch that seat with `rig seat launch '<seat>@<rig>' --fresh --reason "<why>"`, or restore it manually.

### Terminal Nodes

Terminal nodes are infrastructure processes (servers, log tails, build watchers) that are not agent runtimes. They require an exact triple:

```yaml
runtime: terminal
agent_ref: "builtin:terminal"
profile: none
```

All three must be present together. Any partial combination is a validation error.

### agent_ref Rules

- Must start with `local:` or `path:`
- `local:` paths are relative to the rig spec file's directory (the rig root)
- `path:` paths are absolute filesystem paths
- The referenced path must contain an `agent.yaml` file
- Exception: `builtin:terminal` for terminal nodes

### Session Naming

The canonical session name is derived from the pod ID, member ID, and rig name:

```
{podId}-{memberId}@{rigName}
```

Example: pod `dev`, member `build`, rig `my-team` → session `dev-build@my-team`

Pod and member IDs cannot contain `@` because the first `@` separates their portion
of the session address from the rig name. Rig names may still contain `@`.

This is human-authored (you choose the pod/member IDs) and system-validated (the system enforces the format).

---

## Edges

### Edge Kinds

| Kind | Meaning | Use When |
|------|---------|----------|
| `delegates_to` | Source delegates work to target. Constrains launch order. | Orchestrator → implementer, lead → worker |
| `spawned_by` | Source was spawned by target; the target launches first. Constrains launch order. | Child → parent in hierarchical topologies |
| `can_observe` | Source can observe target's output. Does NOT constrain launch order. | Reviewer → implementer, monitor → worker |
| `collaborates_with` | Peer collaboration relationship. Does NOT constrain launch order. | Co-equal peers working together |
| `escalates_to` | Source escalates to target for decisions. Does NOT constrain launch order. | Worker → lead for escalation |

### Pod-Local Edges

Edges within a pod use **unqualified member IDs** (just the member `id`, not `pod.member`):

```yaml
pods:
  - id: dev
    members:
      - id: build
        # ...
      - id: qa
        # ...
    edges:
      - kind: delegates_to
        from: build     # NOT dev.build
        to: qa          # NOT dev.qa
```

Both `from` and `to` must reference members that exist in the same pod.

### Cross-Pod Edges

Edges between pods use **fully-qualified `pod.member` IDs**:

```yaml
edges:
  - kind: delegates_to
    from: orch.lead     # pod.member format
    to: dev.build       # pod.member format
```

Cross-pod edges must reference different pods. An edge where both `from` and `to` are in the same pod is a validation error — use pod-local edges instead.

---

## Startup Block

Startup blocks can appear at three levels: rig, pod, and member. They are merged additively via the startup layering model (see [the layering model](agent-startup-guide.md#the-layering-model)). The rig's `culture_file` joins as a required file with the `auto` hint in the culture layer, on both fresh start and restore.

### Files

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | yes | — | Relative path to the file. Must be a safe relative path. |
| `orientation` | string | no | — | Set to `role` to identify a per-seat role file for `rig queue whoami --json` and refocus. Does not change delivery or replay startup. |
| `delivery_hint` | string | no | `auto` | How the file is delivered. One of: `auto`, `guidance_merge`, `skill_install`, `send_text`. |
| `required` | boolean | no | `true` | Whether startup fails if this file cannot be delivered. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this file is delivered. Subset of: `fresh_start`, `restore`. |

#### Delivery Hints

| Hint | Behavior |
|------|----------|
| `auto` | System chooses based on file type and context. |
| `guidance_merge` | Merged as a managed block into the runtime's guidance file: for Claude, the `managed_blocks` file (`CLAUDE.md` or `CLAUDE.local.md`); for Codex, Pi and OMP, `AGENTS.md`. Delivered before harness boot. |
| `skill_install` | Installed as a skill in the runtime's skill directory. Delivered before harness boot. |
| `send_text` | Sent as text to the agent's terminal after the harness is ready. Requires the agent TUI to be active. |

### Actions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | yes | — | Action type. One of: `slash_command`, `send_text`, `startup_proof`. Note: `shell` is explicitly NOT supported in v1. |
| `value` | string | yes | — | Command/text to send, or `authenticated` / `none` for `startup_proof`. |
| `phase` | string | no | `after_files` | When to execute text/commands. One of: `after_files` (after startup files are delivered), `after_ready` (after harness readiness check passes). Proof selection is resolved before projection regardless of phase. |
| `idempotent` | boolean | yes | — | Whether this action is safe to replay on restore. **Required field.** Non-idempotent actions must NOT include `restore` in `applies_on`. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this action runs. Subset of: `fresh_start`, `restore`. |

### Startup proof selection

Startup adds no orientation exercise by default. To select the authenticated
startup challenge, declare an action in an agent, profile, rig, pod, member, or
operator startup block:

```yaml
startup:
  actions:
    - type: startup_proof
      value: authenticated
      idempotent: true
```

Use `value: none` in a later layer to select lean startup explicitly. The last
applicable declaration wins in agent → profile → rig → pod → member → operator
order. Culture contributes files, not a proof selection. With no applicable
declaration, the result is `none`; the number of startup files never selects
proof. Invalid values and non-idempotent proof declarations fail validation,
including declarations overridden later. These actions declare policy and are
never typed into a terminal.

An authenticated selection challenges only a fresh or fresh-fallback managed
agent launch. Resumed, forked, rebuilt, and adopted sessions receive no new
challenge; terminal nodes never receive one. `applies_on` follows the requested
startup context, so a fresh fallback during restore uses `restore` selections.
Keep the default `[fresh_start, restore]` to cover both fresh launch paths.

Identity delivery, projection, readiness, and ordinary startup actions still
run. `startup_status: ready` means startup completed, while `oriented: missing`
means a selected proof awaits authenticated submission. Omission/`none` yields
`oriented: n-a` on a new fresh launch and retires an older challenge without
deleting its audit history. Retirement follows successful harness launch,
before readiness checks, so attention, timeout, or a readiness exception cannot
retain the preceding proof. A replacement that fails to launch does not retire
the current proof; resume/adoption also preserves existing proof history.
The effective selection is recorded on `node.startup_pending`; actions are
persisted in startup context for restore. A fresh relaunch (`rig seat launch
--fresh`, or a seat listed with `rig up --existing --fresh <seat>`) reads
them again from the rig's spec as it is now, or replays the ones saved by the
seat's last successful launch with `--startup-from stored`.

The harness readiness window defaults to 30 seconds. On a loaded machine, set
`rig config set runtime.readiness_timeout_seconds 60` to give new seats and
handover successors longer to become interactive. The setting accepts 1–600
seconds, applies to the next launch without a daemon restart, and can also be
set with `OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS`. It does not change the
time spent by the runtime adapter before readiness polling starts.

---

## Services Block

The services block is optional. When present, services boot before any agent node launches. If service health checks fail, agent launch is blocked.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | string | yes | — | Service backend. Only `compose` is supported in v1. |
| `compose_file` | string | yes | — | Relative path to the Docker Compose file. Must be a safe relative path. Resolved relative to rig root. |
| `project_name` | string | no | stored predecessor project or unique rig-ID default | Docker Compose project name. Must match `[a-z0-9][a-z0-9_-]*`. An explicit value takes precedence. A new rig uses a stable, unique rig-ID-derived name. A same-name replacement inherits the stored project of the exact generations it replaces; conflicting predecessor projects require an explicit value. Existing stored names remain unchanged. |
| `profiles` | string[] | no | — | Compose profiles to activate. |
| `down_policy` | string | no | `down` | What happens on `rig down`. One of: `leave_running`, `down`, `down_and_volumes`. |
| `wait_for` | WaitTarget[] | no | — | Health targets that must pass before agent launch. |
| `surfaces` | Surfaces | no | — | Metadata about accessible URLs and commands. Not executed — informational only. |
| `checkpoints` | CheckpointHook[] | no | — | Shell commands for checkpoint export/import during snapshot/restore. |

### Wait Targets

Each target must define exactly one of `service`, `url`, or `tcp`:

```yaml
wait_for:
  # HTTP probe — any 2xx or 3xx response passes the HTTP wait target; redirects are not followed.
  # This proves the server answered, not application readiness.
  - url: http://127.0.0.1:8200/v1/sys/health

  # TCP probe — connects to host:port
  - tcp: "127.0.0.1:5432"

  # Compose health check — requires Docker health to report "healthy"
  - service: postgres
    condition: healthy
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | one of three | HTTP URL to probe. |
| `tcp` | string | one of three | `host:port` for TCP probe. |
| `service` | string | one of three | Compose service name. Requires `condition: healthy`. |
| `condition` | string | only with `service` | Must be `healthy`. Only valid with `service` targets. |

### Surfaces

```yaml
surfaces:
  urls:
    - name: Vault UI
      url: http://127.0.0.1:8200/ui
  commands:
    - name: Vault status
      command: "vault status -address=http://127.0.0.1:8200"
```

Surfaces are metadata only. They are displayed in the UI and in `rig env status --json` output (the text output lists only services) but are NOT executed by OpenRig.

### Checkpoint Hooks

```yaml
checkpoints:
  - id: postgres
    export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
    import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier for this checkpoint. |
| `export` | string | yes | Shell command to export state. |
| `import` | string | no | Shell command to import state on restore. |

Checkpoint hooks are validated and stored with the spec. In this version the daemon doesn't run them during snapshot or restore, and doesn't substitute `{{artifacts_dir}}`.

---

## Continuity Policy

Optional pod-level configuration for compaction recovery behavior.

```yaml
continuity_policy:
  enabled: true
  sync_triggers: [pre_compaction, pre_shutdown, manual, milestone]
  artifacts:
    session_log: true
    restore_brief: true
    quiz: false
  restore_protocol:
    peer_driven: true
    verify_via_quiz: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | yes | — | Whether continuity is active for this pod. |
| `sync_triggers` | string[] | no | — | When to sync. Values: `pre_compaction`, `pre_shutdown`, `manual`, `milestone`. |
| `artifacts.session_log` | boolean | no | — | Whether to maintain a session log. |
| `artifacts.restore_brief` | boolean | no | — | Whether to maintain a restore brief. |
| `artifacts.quiz` | boolean | no | — | Whether to use quiz-based verification. |
| `restore_protocol.peer_driven` | boolean | no | — | Whether peers drive the restore process. |
| `restore_protocol.verify_via_quiz` | boolean | no | — | Whether to verify restoration via quiz. |

These fields are validated, stored on the pod and written back on export. In this version nothing acts on
`sync_triggers`, `artifacts` or `restore_protocol`.

---

## Validation Rules Summary

Unknown keys at the rig, pod, member and edge levels are refused ("unknown key … refusing the spec because
normalization would otherwise discard it"). Keys inside `startup`, `services`, `continuity_policy` and `workspace` are
not checked this way. Some rules are enforced at preflight rather than validation: the runtime must be one of the
supported values, rig, pod and member names may use only letters, digits, `-`, `_`, `.` and `@` where allowed above,
each `agent_ref` must have an `agent.yaml`, Codex profiles must load, and a cwd may not be inside the OpenRig
installation.

Schema validation checks the structural rules below. Pod and member IDs containing
`@` are additionally rejected during preflight and member creation or launch; a
spec can pass `rig spec validate` and then fail at preflight or import. Run
`rig spec preflight` before creation or import.

1. `version` and `name` are required non-empty strings.
2. `pods` must be a non-empty array.
3. Pod IDs must not contain dots and must be unique.
4. Pod labels are required.
5. Member IDs must not contain dots and must be unique within their pod.
6. `agent_ref`, `profile`, `runtime`, and `cwd` are required for every member.
7. Terminal nodes require the exact triple: `runtime: terminal`, `agent_ref: builtin:terminal`, `profile: none`.
8. `agent_ref` must start with `local:` (relative) or `path:` (absolute), except `builtin:terminal`.
9. `local:` refs must be relative paths. `path:` refs must be absolute paths.
10. `restore_policy` must be one of: `resume_if_possible`, `relaunch_fresh`, `checkpoint_only`.
11. Pod-local edges use unqualified member IDs. Cross-pod edges use `pod.member` format.
12. Cross-pod edges must reference different pods.
13. Edge kinds must be one of: `delegates_to`, `spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`.
14. All file paths (`culture_file`, startup file paths, `compose_file`) must be safe relative paths.
15. `services.kind` must be `compose`.
16. `services.compose_file` is required when services is present.
17. `services.project_name` must match `[a-z0-9][a-z0-9_-]*`.
18. `services.down_policy` must be one of: `leave_running`, `down`, `down_and_volumes`.
19. Each wait target must define exactly one of: `service`, `url`, `tcp`.
20. `condition` is only valid on `service` targets and must be `healthy`.
21. Startup file `delivery_hint` must be one of: `auto`, `guidance_merge`, `skill_install`, `send_text`.
22. Startup action `type` must be one of: `slash_command`, `send_text`, `startup_proof`. (`shell` is explicitly rejected.) Proof selection requires `value: authenticated` or `none` and `idempotent: true`.
23. Startup action `phase` must be one of: `after_files`, `after_ready`.
24. Startup action `idempotent` is a required boolean.
25. Non-idempotent actions must not include `restore` in `applies_on`.
26. `applies_on` values must be from: `fresh_start`, `restore`.

---

## Shipped Examples

These are the built-in specs shipped with OpenRig. Read them as worked examples.

| Spec | Location | Pods | Members | Services |
|------|----------|------|---------|----------|
| `starter` | `packages/daemon/specs/rigs/launch/starter/rig.yaml` | dev | 2 (build, review) | no |
| `factory` | `packages/daemon/specs/rigs/launch/factory/rig.yaml` | orch, dev, review | 7 (lead, advisor, build, qa, design, r1, r2) | no |
| `code-review` | `packages/daemon/specs/rigs/focused/code-review/rig.yaml` | orch, review | 3 (lead, r1, r2) | no |
| `research` | `packages/daemon/specs/rigs/focused/research/rig.yaml` | orch, research | 3 (lead, analyst, synthesizer) | no |
| `pm` | `packages/daemon/specs/rigs/focused/pm/rig.yaml` | pm, dev | 3 (lead, researcher, build) | no |
| `secrets-manager` | `packages/daemon/specs/rigs/launch/secrets-manager/rig.yaml` | vault | 1 (specialist) | yes (Vault) |

Also shipped, in the same tree: `launch/kernel`, OpenRig's own team, which starts automatically. `first-project` is
starter's old name and still resolves to it. `workshop`, the four-agent middle team, is a rig bundle rather than a
built-in. List the built-ins with `rig specs ls --kind rig`.
