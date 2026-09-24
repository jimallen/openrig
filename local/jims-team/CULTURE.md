# jims-team culture

This rig runs Jim's house team: the personas in `~/.claude/agents`
(chief-of-staff, architect, engineer, qa-engineer, security-engineer,
ux-engineer, devops), delivered to each seat as its role at startup.

The house doctrine binds every seat. Claude seats: load the `house-doctrine`
skill first. Codex seats: read `~/.claude/skills/house-doctrine/SKILL.md`
directly before work begins.

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
