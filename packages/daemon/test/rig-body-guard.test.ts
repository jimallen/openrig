// OF-249: the rig-body guard. A shell expands a command substitution BEFORE `rig` starts, so the guard sits in
// the agent harness (a Claude PreToolUse hook, a Pi tool_call extension) and refuses the command first.
// This file drives the shared parser from a table: the shapes of the real 2026-11-03..05 incident commands
// (written synthetically; no message text from the incident logs), the safe forms that must NOT be refused,
// the wrappers and nesting a model reaches for next, and the parse-failure policy.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "assets", "plugins", "openrig-core");
const guardPath = join(pluginRoot, "hooks", "scripts", "rig-body-guard.cjs");
const piExtensionPath = join(pluginRoot, "pi", "rig-body-guard.cjs");
const require = createRequire(import.meta.url);
const guard = require(guardPath) as {
  check: (command: unknown) => { block: boolean; violations: Array<{ kind: string; command: string | null }>; reason: string };
  hookDecision: (raw: string) => { output: unknown; note: string | null };
};

const T = "`"; // a backtick, so the table below stays readable
const NEST = (n: number): string => {
  let s = `rig send a ${"\""}x ${T}y${T}${"\""}`;
  for (let i = 0; i < n; i++) s = `echo $(${s})`;
  return s;
};

interface Row { id: string; cmd: string; deny: boolean; kind?: string; note: string }

const ROWS: Row[] = [
  // ---- the incident shapes (verify-qa 18:28Z: the `--` before a double-quoted body that ran an unbounded swift test)
  { id: "I1", deny: true, kind: "substitution", note: "2026-11-05 18:28Z shape: -- then a double-quoted body with a backticked command",
    cmd: `rig send exec-cos@eztrack -- "full unfiltered ${T}swift test --no-parallel${T} passed"` },
  { id: "I2", deny: true, kind: "substitution", note: "double-quoted body with several backticked words (the common shape, 20 of 27)",
    cmd: `rig send exec-cos@eztrack "result: ${T}bd show x-1${T} is closed and ${T}rig down eztrack${T} was not run"` },
  { id: "I3", deny: true, kind: "substitution", note: "multi-line double-quoted body",
    cmd: `rig send exec-cos@eztrack "line one\nline two with ${T}cmd${T}\nline three"` },
  { id: "I4", deny: true, kind: "substitution", note: "$(cat <<'EOF' ... EOF) wrapper in double quotes: runs cat before rig; blocked by design (benign payload)",
    cmd: `rig send exec-cos@eztrack -- "$(cat <<'EOF'\nreport with ${T}ticks${T}\nEOF\n)"` },
  { id: "I5", deny: false, note: "single-quoted body holding backticks (verify-sec 2026-11-04 shape): literal",
    cmd: `rig send exec-cos@eztrack 'C1 mutation done in ${T}worktree${T} and ${T}suite${T} green'` },

  // ---- catch: substitutions
  { id: "C1", deny: true, kind: "substitution", note: "double quotes, $( )", cmd: `rig send a@b "now $(date) ok"` },
  { id: "C2", deny: true, kind: "substitution", note: "unquoted backticks", cmd: `rig send a@b ${T}echo hi${T}` },
  { id: "C3", deny: true, kind: "substitution", note: "unquoted $( )", cmd: `rig send a@b $(echo hi)` },
  { id: "C4", deny: true, kind: "substitution", note: "backtick glued to plain text in one word", cmd: `rig send a@b done:${T}date${T}` },
  { id: "C5", deny: true, kind: "substitution", note: "nested quoting: single quotes inside double quotes are literal, the backtick runs",
    cmd: `rig send a@b "outer 'inner ${T}x${T} text' end"` },
  { id: "C6", deny: true, kind: "substitution", note: "double quotes inside a $( ) inside double quotes",
    cmd: `rig send a@b "a $(echo "b ${T}c${T}") d"` },
  { id: "C7", deny: true, kind: "substitution", note: "$( ) spread over lines",
    cmd: `rig send a@b "before $(\n  ls\n  pwd\n) after"` },
  { id: "C8", deny: true, kind: "substitution", note: "unquoted $( ) spread over lines", cmd: `rig send a@b $(\nls\n)` },
  { id: "C9", deny: true, kind: "substitution", note: "${x:-$(cmd)} runs cmd", cmd: `rig send a@b "v=\${X:-$(date)}"` },
  { id: "C10", deny: true, kind: "substitution", note: "$(( $(cmd) )) runs cmd", cmd: `rig send a@b "n=$(( $(date +%s) + 1 ))"` },
  { id: "C11", deny: true, kind: "substitution", note: "process substitution is a command too", cmd: `rig send a@b <(echo hi)` },
  { id: "C12", deny: true, kind: "substitution", note: "backslash-newline continuation before the body", cmd: `rig send a@b \\\n  "x ${T}y${T}"` },
  { id: "C13", deny: true, kind: "substitution", note: "$(cat <<EOF) unquoted heredoc inside a substitution", cmd: `rig send a@b "$(cat <<EOF\nhi\nEOF\n)"` },
  { id: "C14", deny: true, kind: "substitution", note: "--flag=value form on a message command", cmd: `rig queue create --source a --destination b --body="x ${T}y${T}"` },

  // ---- catch: body-carrying rig commands
  { id: "Q1", deny: true, kind: "substitution", note: "queue create --body", cmd: `rig queue create --source a@r --destination b@r --body "see ${T}x${T}"` },
  { id: "Q2", deny: true, kind: "substitution", note: "queue update --body", cmd: `rig queue update qitem-1 --actor a@r --body "see $(x)"` },
  { id: "Q3", deny: true, kind: "substitution", note: "queue handoff --note", cmd: `rig queue handoff qitem-1 --from a --to b --note "x ${T}y${T}"` },
  { id: "Q4", deny: true, kind: "substitution", note: "queue handoff-and-complete --body", cmd: `rig queue handoff-and-complete qitem-1 --from a --to b --body "x ${T}y${T}"` },
  { id: "Q5", deny: true, kind: "substitution", note: "queue resolve --decision (text)", cmd: `rig queue resolve qitem-1 --decision "x ${T}y${T}"` },
  { id: "Q6", deny: true, kind: "substitution", note: "broadcast text", cmd: `rig broadcast "all hands ${T}ls${T}"` },
  { id: "Q7", deny: true, kind: "substitution", note: "chatroom send message", cmd: `rig chatroom send r "hi ${T}ls${T}"` },
  { id: "Q8", deny: true, kind: "substitution", note: "stream emit --body", cmd: `rig stream emit --body "x ${T}y${T}"` },
  { id: "Q9", deny: true, kind: "substitution", note: "seat cancel-message --reason (flag class)", cmd: `rig seat cancel-message s@r 1 --reason "x ${T}y${T}"` },
  { id: "Q10", deny: true, kind: "substitution", note: "seat --reason=value", cmd: `rig seat retire-held-message s@r 1 --reason="x $(y)"` },
  { id: "Q11", deny: true, kind: "substitution", note: "send --reason (dangerously-interact audit text)", cmd: `rig send s@r --dangerously-interact y --reason "x ${T}y${T}"` },
  { id: "Q12", deny: true, kind: "substitution", note: "ask question", cmd: `rig ask r "what is ${T}x${T}?"` },

  // ---- catch: stdin routes
  { id: "H1", deny: true, kind: "heredoc", note: "unquoted heredoc with backticks", cmd: `rig send a@b --file - <<EOF\nreport ${T}ticks${T}\nEOF` },
  { id: "H2", deny: true, kind: "heredoc", note: "unquoted heredoc with $( )", cmd: `rig send a@b --file - <<EOF\nreport $(date)\nEOF` },
  { id: "H3", deny: true, kind: "heredoc", note: "<<- unquoted heredoc (tab-stripped terminator)", cmd: `rig send a@b --file - <<-EOF\n\treport ${T}x${T}\n\tEOF` },
  { id: "H4", deny: true, kind: "heredoc", note: "cat <<EOF | rig send: the heredoc belongs to cat, the pipe feeds rig", cmd: `cat <<EOF | rig send a@b --file -\nreport ${T}x${T}\nEOF` },
  { id: "H5", deny: true, kind: "heredoc", note: "queue --body-file - <<EOF", cmd: `rig queue create --source a --destination b --body-file - <<EOF\n$(x)\nEOF` },
  { id: "H9", deny: true, kind: "substitution", note: "<<- terminator indented with a tab: the next command is still scanned", cmd: `cat <<-EOF\n\tplain\n\tEOF\nrig send a@b "x ${T}y${T}"` },
  { id: "H10", deny: true, kind: "substitution", note: "a command after a quoted heredoc is still scanned", cmd: `rig send a@b --file - <<'EOF'\nsafe ${T}text${T}\nEOF\nrig send c@d "x ${T}y${T}"` },
  { id: "H6", deny: true, kind: "here-string", note: "here-string with a substitution", cmd: `rig send a@b --file - <<< "x ${T}y${T}"` },
  { id: "H7", deny: true, kind: "pipe-producer", note: "echo with backticks piped into --file -", cmd: `echo "report ${T}x${T}" | rig send a@b --file -` },
  { id: "H8", deny: true, kind: "pipe-producer", note: "printf with $( ) piped into --file -", cmd: `printf '%s\\n' "report $(x)" | rig send a@b --file -` },

  // ---- catch: wrappers, nesting and structure
  { id: "W1", deny: true, kind: "substitution", note: "env prefix", cmd: `env OPENRIG_URL=http://x rig send a@b "x ${T}y${T}"` },
  { id: "W2", deny: true, kind: "substitution", note: "VAR=val prefix", cmd: `FOO=1 rig send a@b "x ${T}y${T}"` },
  { id: "W3", deny: true, kind: "substitution", note: "command rig", cmd: `command rig send a@b "x ${T}y${T}"` },
  { id: "W4", deny: true, kind: "substitution", note: "absolute path to rig", cmd: `/opt/homebrew/bin/rig send a@b "x ${T}y${T}"` },
  { id: "W5", deny: true, kind: "substitution", note: "timeout / nice / sudo wrappers", cmd: `timeout 20 nice -n 5 sudo -u x rig send a@b "x ${T}y${T}"` },
  { id: "W6", deny: true, kind: "substitution", note: "after &&", cmd: `cd /tmp && rig send a@b "x ${T}y${T}"` },
  { id: "W7", deny: true, kind: "substitution", note: "after a newline", cmd: `echo ok\nrig send a@b "x ${T}y${T}"` },
  { id: "W8", deny: true, kind: "substitution", note: "inside a subshell", cmd: `( rig send a@b "x ${T}y${T}" )` },
  { id: "W9", deny: true, kind: "substitution", note: "inside if/then", cmd: `if true; then rig send a@b "x ${T}y${T}"; fi` },
  { id: "W10", deny: true, kind: "substitution", note: "inside a command substitution", cmd: `echo "$(rig send a@b "x ${T}y${T}")"` },
  { id: "W11", deny: true, kind: "substitution", note: "bash -c", cmd: `bash -c 'rig send a@b "x ${T}y${T}"'` },
  { id: "W12", deny: true, kind: "substitution", note: "sh -lc", cmd: `sh -lc 'rig send a@b "x ${T}y${T}"'` },
  { id: "W13", deny: true, kind: "substitution", note: "eval", cmd: `eval 'rig send a@b "x ${T}y${T}"'` },
  { id: "W14", deny: true, kind: "substitution", note: "ssh remote command", cmd: `ssh host 'rig send a@b "x ${T}y${T}"'` },
  { id: "W15", deny: true, kind: "substitution", note: "rig send after rig options", cmd: `rig --json send a@b "x ${T}y${T}"` },
  { id: "W16", deny: true, kind: "substitution", note: "with a trailing redirect", cmd: `rig send a@b "x ${T}y${T}" > /dev/null 2>&1` },
  { id: "W17", deny: true, kind: "substitution", note: "nested 6 deep", cmd: NEST(6) },

  // ---- safe forms: must NOT be refused
  { id: "S1", deny: false, note: "single quotes with backticks, $( ) and double quotes", cmd: `rig send a@b 'report ${T}x${T} $(y) "q"'` },
  { id: "S2", deny: false, note: "quoted heredoc", cmd: `rig send a@b --file - <<'EOF'\nreport ${T}x${T} $(y) \$z\nEOF` },
  { id: "S3", deny: false, note: "double-quoted heredoc delimiter is quoted too", cmd: `rig send a@b --file - <<"EOF"\nreport ${T}x${T}\nEOF` },
  { id: "S4", deny: false, note: "backslash heredoc delimiter is quoted too", cmd: `rig send a@b --file - <<\\EOF\nreport ${T}x${T}\nEOF` },
  { id: "S5", deny: false, note: "<<-'EOF' with tab-indented body", cmd: `rig send a@b --file - <<-'EOF'\n\treport ${T}x${T}\n\tEOF` },
  { id: "S6", deny: false, note: "--file path", cmd: `rig send a@b --file /tmp/report.md` },
  { id: "S7", deny: false, note: "--file - with a pipe from cat", cmd: `cat /tmp/report.md | rig send a@b --file -` },
  { id: "S8", deny: false, note: "--file - with a pipe from printf of a single-quoted string", cmd: `printf '%s' 'report ${T}x${T} $(y)' | rig send a@b --file -` },
  { id: "S9", deny: false, note: "$ and $(...) only inside single quotes", cmd: `rig send a@b '$HOME and $(ls) and \${X}'` },
  { id: "S10", deny: false, note: "backslash-escaped backticks inside double quotes are literal", cmd: `rig send a@b "run \\${T}cmd\\${T} then \\$(x)"` },
  { id: "S11", deny: false, note: "variables and arithmetic only: nothing executes", cmd: `rig send a@b "home $HOME user \${USER} sum $((1+2))"` },
  { id: "S12", deny: false, note: "--file value may itself be a substitution (a path, not text)", cmd: `rig send a@b --file "$(mktemp)"` },
  { id: "S13", deny: false, note: "queue --body-file - <<'EOF'", cmd: `rig queue create --source a --destination b --body-file - <<'EOF'\n${T}x${T} $(y)\nEOF` },
  { id: "S14", deny: false, note: "queue --body-file path", cmd: `rig queue update q-1 --actor a --body-file ./m.md` },
  { id: "S15", deny: false, note: "unquoted heredoc with a plain variable only", cmd: `rig send a@b --file - <<EOF\nuser $USER\nEOF` },
  { id: "S16", deny: false, note: "unquoted heredoc with an escaped backtick", cmd: `rig send a@b --file - <<EOF\nuse \\${T}x\\${T}\nEOF` },
  { id: "S17", deny: false, note: "a non-message rig command with a deliberate substitution", cmd: `rig up spec.yaml --cwd "$(pwd)"` },
  { id: "S18", deny: false, note: "a flag-class command with a substitution in a non-text flag", cmd: `rig seat launch s@r --cwd "$(pwd)"` },
  { id: "S19", deny: false, note: "rig only mentioned in text", cmd: `echo "rig send a@b ${T}x${T}"` },
  { id: "S20", deny: false, note: "rig in a commit message", cmd: `git commit -m "fix: rig send ${T}x${T} guard"` },
  { id: "S21", deny: false, note: "rig in a comment", cmd: `# rig send a@b "${T}x${T}"\necho hi` },
  { id: "S22", deny: false, note: "trailing comment", cmd: `echo hi # rig send a@b "${T}x${T}"` },
  { id: "S23", deny: false, note: "an unquoted heredoc to a non-rig command", cmd: `cat > /tmp/f <<EOF\n$(date)\nEOF\nrig send a@b --file /tmp/f` },
  { id: "S24", deny: false, note: "plain short body", cmd: `rig send a@b 'Context update: QA approved. Proceed.'` },
  { id: "S25", deny: false, note: "double quotes with no substitution", cmd: `rig send a@b "Context update: QA approved."` },
  { id: "S26", deny: false, note: "rig ps / whoami", cmd: `rig ps --json && rig whoami` },
  { id: "S27", deny: false, note: "non-rig command with substitutions", cmd: `echo "$(date) ${T}uname${T}"` },
  { id: "S28", deny: false, note: "heredoc body mentions a closing paren and quotes", cmd: `rig send a@b --file - <<'EOF'\n) ' " ${T}\nEOF` },
  { id: "S29", deny: false, note: "empty command", cmd: `` },
  { id: "S30", deny: false, note: "rig send with --id and --verify flags, single quotes", cmd: `rig send a@b 'hi' --id m1 --verify --json` },
  { id: "S31", deny: false, note: "rig mentioned as an argument of another command", cmd: `grep -rn "rig send" docs/ | head` },
  { id: "S33", deny: false, note: "unquoted heredoc with arithmetic $((1+2)) only: nothing executes", cmd: `rig send a@b --file - <<EOF\nsum $((1+2))\nEOF` },
  { id: "S32", deny: false, note: "2>&1 file descriptor redirect", cmd: `rig send a@b 'hi' 2>&1 | tail -3` },

  // ---- parse failures: refuse only when the plain-text signal is there
  { id: "P1", deny: true, kind: "unparseable", note: "unterminated double quote around a rig send with a backtick", cmd: `rig send a@b "text ${T}x${T} still open` },
  { id: "P2", deny: true, kind: "unparseable", note: "truncated $(cat <<'EOF' wrapper", cmd: `rig send a@b "$(cat <<'EOF'\nreport that was cut off` },
  { id: "P3", deny: false, note: "unparseable but no rig command: allowed", cmd: `echo "unterminated $(` },
  { id: "P4", deny: false, note: "unparseable rig send with no substitution signal: allowed (the shell reports the syntax error)", cmd: `rig send a@b 'unterminated` },
  { id: "P5", deny: true, kind: "unparseable", note: "nested deeper than the cap", cmd: NEST(12) },
  { id: "P6", deny: true, kind: "unparseable", note: "over the length cap with the signal", cmd: `rig send a@b "x ${T}y${T}" ${"#".repeat(1_100_000)}` },
  { id: "P7", deny: false, note: "over the length cap without the signal", cmd: `echo hi ${"#".repeat(1_100_000)}` },
];

describe("rig-body-guard parser table", () => {
  it("has a unique id per row and both verdict classes", () => {
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length);
    expect(ROWS.filter((r) => r.deny).length).toBeGreaterThan(40);
    expect(ROWS.filter((r) => !r.deny).length).toBeGreaterThan(30);
  });

  for (const row of ROWS) {
    it(`${row.id} ${row.deny ? "refuses" : "allows"}: ${row.note}`, () => {
      const verdict = guard.check(row.cmd);
      expect(verdict.block).toBe(row.deny);
      if (row.deny) {
        expect(verdict.violations[0]?.kind).toBe(row.kind);
        expect(verdict.reason).toContain("--file - <<'EOF'");
      } else {
        expect(verdict.violations).toEqual([]);
        expect(verdict.reason).toBe("");
      }
    });
  }

  it("never throws, whatever it is given", () => {
    for (const bad of [undefined, null, 5, {}, [], "\u0000", "(((((", "\"", "$(", "`", "<<", "<<EOF", "rig send ${", "rig send \"${"]) {
      expect(() => guard.check(bad)).not.toThrow();
    }
  });
});

describe("rig-body-guard refusal text", () => {
  it("tells the model exactly what to write instead, and says nothing ran", () => {
    const { reason } = guard.check(`rig send a@b "x ${T}y${T}"`);
    expect(reason).toContain("Nothing was executed");
    expect(reason).toContain("rig send ... --file - <<'EOF'");
    expect(reason).toContain("BEFORE rig starts");
  });
  it("names --body-file - for queue commands and still states the --file - <<'EOF' form", () => {
    const { reason } = guard.check(`rig queue create --source a --destination b --body "x ${T}y${T}"`);
    expect(reason).toContain("--body-file - <<'EOF'");
    expect(reason).toContain("--file - <<'EOF'");
  });
  it("points a command with no --file option at rig send --file -", () => {
    const { reason } = guard.check(`rig broadcast "x ${T}y${T}"`);
    expect(reason).toContain("rig broadcast has no --file option");
    expect(reason).toContain("rig send <session> --file - <<'EOF'");
  });
  it("never repeats the offending text (it may hold content)", () => {
    const secret = "SECRET-BODY-7f3a";
    const { reason } = guard.check(`rig send a@b "${secret} ${T}x${T}"`);
    expect(reason).not.toContain(secret);
  });
});

describe("Claude PreToolUse hook contract (rig-body-guard.cjs on stdin/stdout)", () => {
  const run = (stdin: string) => spawnSync(process.execPath, [guardPath], { input: stdin, encoding: "utf8" });
  const event = (command: unknown, tool = "Bash") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });

  it("denies with permissionDecision deny and the reason, exit 0", () => {
    const r = run(event(`rig send a@b "x ${T}y${T}"`));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("--file - <<'EOF'");
  });
  it("prints nothing for a safe command", () => {
    const r = run(event(`rig send a@b 'x ${T}y${T}'`));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
  it("fails OPEN, with a note, on input it cannot read (a hook that wedges every Bash call also blocks the report)", () => {
    for (const input of ["not json", "{}", JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_input: { command: 5 } })]) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("rig-body-guard");
    }
  });
});

describe("wiring", () => {
  const claudeHooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "claude.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number; async?: boolean }> }>>;
  };

  it("claude.json runs the guard as a blocking PreToolUse hook on Bash only", () => {
    const groups = claudeHooks.hooks["PreToolUse"] ?? [];
    const mine = groups.filter((g) => g.hooks.some((h) => h.command.includes("rig-body-guard.cjs")));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.matcher).toBe("Bash");
    expect(mine[0]!.hooks).toHaveLength(1);
    const h = mine[0]!.hooks[0]!;
    expect(h.type).toBe("command");
    expect(h.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/rig-body-guard.cjs"');
    expect(h.async).toBeUndefined(); // an async hook cannot block
    expect(h.timeout).toBeGreaterThan(0);
    expect(h.timeout).toBeLessThanOrEqual(10);
  });

  it("the guard is not an activity-relay event (the relay derivation reads only activity-relay.cjs groups)", () => {
    const relayEvents = Object.entries(claudeHooks.hooks)
      .filter(([, groups]) => groups.some((g) => g.hooks.some((h) => h.command.includes("activity-relay.cjs"))))
      .map(([event]) => event);
    expect(relayEvents).not.toContain("PreToolUse");
  });

  it("the hook script exists where the manifest says", () => {
    expect(readFileSync(guardPath, "utf8")).toContain("PreToolUse");
  });
});

describe("Pi extension (pi/rig-body-guard.cjs)", () => {
  type Handler = (event: unknown) => Promise<{ block: true; reason: string } | undefined>;
  const load = (): Handler => {
    const handlers = new Map<string, Handler>();
    const factory = require(piExtensionPath) as (pi: { on: (name: string, h: Handler) => void }) => void;
    factory({ on: (name, h) => { handlers.set(name, h); } });
    expect([...handlers.keys()]).toEqual(["tool_call"]);
    return handlers.get("tool_call")!;
  };
  const bash = (command: unknown) => ({ type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command } });

  it("blocks a bash tool call that would run a substitution inside a rig send, with the reason as the result", async () => {
    const r = await load()(bash(`rig send a@b -- "full ${T}swift test${T} passed"`));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("--file - <<'EOF'");
  });
  it("lets safe commands and other tools through", async () => {
    const h = load();
    expect(await h(bash(`rig send a@b --file - <<'EOF'\n${T}x${T}\nEOF`))).toBeUndefined();
    expect(await h(bash(`ls -la`))).toBeUndefined();
    expect(await h({ type: "tool_call", toolName: "read", input: { path: "/x" } })).toBeUndefined();
    expect(await h({ type: "tool_call", toolName: "write", input: { content: `rig send a "${T}x${T}"` } })).toBeUndefined();
  });
  it("never throws on a malformed event (a throwing tool_call handler blocks every bash call in Pi)", async () => {
    const h = load();
    for (const bad of [undefined, null, {}, { toolName: "bash" }, { toolName: "bash", input: null }, { toolName: "bash", input: { command: 7 } }]) {
      await expect(h(bad)).resolves.toBeUndefined();
    }
  });
});
