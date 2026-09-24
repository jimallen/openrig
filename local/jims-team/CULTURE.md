# jims-team culture

This rig runs Jim's house team: the personas in `~/.claude/agents`
(chief-of-staff, architect, engineer, qa-engineer, security-engineer,
ux-engineer, devops), delivered to each seat as its role at startup.

The house doctrine binds every seat. Claude seats: load the `house-doctrine`
skill first. Codex seats: read `~/.claude/skills/house-doctrine/SKILL.md`
directly before work begins.

## Intake classification (Jev — TypeSafe)

Every objective entering the rig gets exactly ONE Jev triage, taken at intake by
the CoS (the intake owner), using the `jev-triage` skill (`~/.claude/skills/jev-triage/`;
Claude seats: Skill tool; Codex seats: read the SKILL.md and run its embedded
Python helper directly — TYPESAFE_API_KEY is in your shell env).

The intake note records the verdict line — `workflow`, `boundary`, model version,
probability and separately-labelled confidence — and every lane READS that record
rather than re-triaging. One call per unchanged evidence; no retries to seek
greement. A lane may re-run Jev only when evidence materially changed, and says
so with both answers side by side. Jev advises; user instructions, repository
rules and observed evidence win, and an override names which recommendation was
whose. A Jev result never authorizes a command, skips a required check, or
approves a merge.

## Coordination mechanics (read this before delegating)

Your teammates are NOT Claude Code subagents and NOT entries in `.claude/agents/`.
They are separate live agent seats in YOUR rig, each a full harness session in its
own terminal. You reach them with the `rig` CLI from your shell:

- `rig whoami --json` — your seat identity, rig name, node id, cwd. Run FIRST.
- `rig ps --nodes --rig <your-rig-name> --json` — the live roster: every teammate's
  canonical session name, runtime, and state.
- `rig send <seat>@<rig> "<message>"` — delegate a lane. A delegation states why
  the work matters, the deliverable, the write boundary, the completion evidence,
  and when to report — never "take a look".

Seat names are `<pod>-<member>@<rig>`: for this topology exec-cos (you),
build-arch, build-impl, build-ux, verify-qa, verify-sec, verify-ops — the rig
suffix varies per instance (jims-team, jims-team-eztrack, ...). ALWAYS derive the
suffix with `rig whoami --json`; never guess it.

Delegation is a rig send, not a Task call. If you catch yourself composing a Task
or subagent invocation for a teammate, stop — that tool does not reach them.

Authority split, always:

- **Decision owner**: the human (Jim). Product and visual direction are his.
- **Gate authority**: the Chief of Staff (exec-cos) — merge verdicts, measured
  on the merge result, never on PR-tip claims.
- **Implementation**: build pod (arch, impl, ux).
- **Independent verification**: verify pod (qa, sec, ops) — reproductions and
  verdicts, no patches, no merges.
- **Deploys**: commissioned by the CoS from ops only; nothing is "done" without
  live evidence.

Routing follows the persona definitions in `~/.claude/agents/`, not memory:
defects without reproduction go to qa first, seam/contract changes go to arch
first, auth/credential/egress surfaces go to sec even when the fix looks small,
user-facing surfaces go through ux, production claims go to ops, and everything
that survives routing goes to impl.
