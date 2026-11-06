// OF-249: the rig-body guard. A shell expands a command substitution BEFORE `rig` starts, so the guard sits in
// the agent harness (a Claude PreToolUse hook, a Pi tool_call extension) and refuses the command first.
// This file drives the shared parser from a table: the shapes of the real 2026-11-03..05 incident commands
// (written synthetically; no message text from the incident logs), the safe forms that must NOT be refused,
// the wrappers and nesting a model reaches for next, and the parse-failure policy.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "assets", "plugins", "openrig-core");
const guardPath = join(pluginRoot, "hooks", "scripts", "rig-body-guard.cjs");
const piExtensionPath = join(pluginRoot, "pi", "rig-body-guard.cjs");
const require = createRequire(import.meta.url);
const guard = require(guardPath) as {
  check: (command: unknown) => { block: boolean; violations: Array<{ kind: string; command: string | null }>; reason: string };
  hookDecision: (raw: string) => { output: unknown; note: string | null };
  maskPieces: (text: string, marks: Array<[number, number]>) => string;
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
  { id: "W18", deny: true, kind: "substitution", note: "bash reading its script from a quoted heredoc", cmd: `bash <<'EOF'\nrig send a@b "x ${T}y${T}"\nEOF` },
  { id: "W19", deny: true, kind: "substitution", note: "ssh host reading its script from a heredoc", cmd: `ssh host <<'EOF'\nrig send a@b "x ${T}y${T}"\nEOF` },
  { id: "W20", deny: true, kind: "substitution", note: "bash with a here-string script", cmd: `bash <<< 'rig send a@b "x ${T}y${T}"'` },
  { id: "F1a", deny: true, kind: "substitution", note: "F1: ssh host with outer double quotes; the LOCAL shell runs the backticks inside the inner single quotes", cmd: `ssh host "rig send s '${T}x${T}'"` },
  { id: "F1b", deny: true, kind: "substitution", note: "F1: bash -c with outer double quotes and inner single quotes", cmd: `bash -c "rig send s 'see $(x)'"` },
  { id: "F1c", deny: true, kind: "substitution", note: "F1: eval with outer double quotes and inner single quotes", cmd: `eval "rig send s 'see ${T}x${T}'"` },
  { id: "M3a", deny: true, kind: "substitution", note: "M3: backslash-escaped single quotes are literal characters, so the $( ) between them runs", cmd: `rig send s \\'$(x)\\'` },
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
  { id: "S34", deny: false, note: "bash script from a heredoc that itself sends through a quoted heredoc", cmd: `bash <<'EOF'\nrig send a@b --file - <<'X'\n${T}t${T} $(u)\nX\nEOF` },
  { id: "S35", deny: false, note: "bash running a script file with a heredoc as stdin data (not a script)", cmd: `bash ./run.sh <<'EOF'\nrig send a@b "x ${T}y${T}"\nEOF` },
  { id: "M3b", deny: false, note: "M3: unquoted backslash-escaped backticks are literal", cmd: `rig send s \\${T}x\\${T}` },
  { id: "M5", deny: false, note: "M5: ANSI-C quoting $'..': an escaped quote does not end it, and $( ) inside is literal", cmd: `rig send s $'it\\'s $(x) ${T}y${T}'` },
  { id: "F1d", deny: false, note: "F1 control: ssh with outer double quotes and no substitution", cmd: `ssh host "rig send s 'plain text'"` },
  { id: "F1e", deny: false, note: "F1 control: ssh with a substitution that is not about a rig command", cmd: `ssh host "echo $(date)"` },
  // OF-251: the F1 rule refuses only when a substitution lands in the words or stdin of a guarded rig command.
  { id: "O1", deny: false, note: "OF-251: ssh, unrelated $( ) before plain rig text (stricter than the same text run locally)", cmd: `ssh host "cd $(pwd) && rig send s hi"` },
  { id: "O2", deny: false, note: "OF-251: bash -c, unrelated $( ) before plain rig text", cmd: `bash -c "$(cat f); rig send s hi"` },
  { id: "O3", deny: false, note: "OF-251: ssh, $(pwd) in the --cwd of a flag command (not a text option)", cmd: `ssh host "rig seat ls --cwd $(pwd)"` },
  { id: "O4", deny: false, note: "OF-251: ssh, unrelated $( ) before a separator, then plain rig text", cmd: `ssh host "echo $(date); rig send s hi"` },
  { id: "O5", deny: false, note: "OF-251: eval, unrelated $( ) then plain rig text", cmd: `eval "cd $(pwd); rig send s hi"` },
  { id: "O6", deny: false, note: "OF-251: ssh, unrelated backticks then plain rig text", cmd: `ssh host "cd ${T}pwd${T} && rig send s hi"` },
  { id: "O7", deny: false, note: "OF-251: ssh, unrelated $( ) after plain rig text", cmd: `ssh host "rig send s hi; echo $(date)"` },
  { id: "B1", deny: true, kind: "substitution", note: "OF-251: unrelated $( ) AND one in the single-quoted body of the rig send", cmd: `ssh host "cd $(pwd) && rig send s '$(x)'"` },
  { id: "B2", deny: true, kind: "pipe-producer", note: "OF-251: the substitution is the text echoed into rig send", cmd: `ssh host "echo $(x) | rig send s --file -"` },
  { id: "B3", deny: true, kind: "heredoc", note: "OF-251: a substitution inside a QUOTED inner here-document is still expanded by the outer double quotes", cmd: `ssh host "rig send s --file - <<'EOF'\n$(x)\nEOF"` },
  { id: "B4", deny: true, kind: "substitution", note: "OF-251: unquoted inner argument of rig send", cmd: `ssh host "rig send s hi $(date)"` },
  { id: "B5", deny: true, kind: "substitution", note: "OF-251: bash -c, rig queue create --body", cmd: `bash -c "rig queue create --body '$(x)'"` },
  { id: "B6", deny: true, kind: "substitution", note: "OF-251: ssh, the --reason value of a flag command", cmd: `ssh host "rig seat release s --reason '$(x)'"` },
  { id: "B7", deny: true, kind: "substitution", note: "OF-251: eval with the script in several words", cmd: `eval rig send s "'$(x)'"` },
  { id: "B8", deny: true, kind: "substitution", note: "OF-251: backticks, ssh, after a separator", cmd: `ssh host "cd /x; rig send s '${T}x${T}'"` },
  { id: "B9", deny: true, kind: "substitution", note: "OF-251: a ${x:-$( )} inside the double-quoted script reaches the single-quoted body", cmd: `ssh host "rig send s '\${X:-$(date)}'"` },
  { id: "B10", deny: true, kind: "substitution", note: "OF-251: an unquoted-level $( ) glued between quotes that make the inner text single-quoted", cmd: `ssh host rig send s "'"$(x)"'"` },
  { id: "B11", deny: true, kind: "substitution", note: "OF-251: the same with backticks", cmd: `ssh host rig send s "'"${T}x${T}"'"` },
  { id: "B12", deny: true, kind: "substitution", note: "OF-251: the same with a process substitution", cmd: `ssh host rig send s "'"<(x)"'"` },
  { id: "B13", deny: true, kind: "substitution", note: "OF-251: the same with an unquoted-level ${x:-$( )}", cmd: `ssh host rig send s "'"\${X:-$(d)}"'"` },
  // OF-251 review F-1: a leading word that expands, and runners the guard does not model, no longer hide the rig command
  { id: "L1", deny: true, kind: "substitution", note: "F-1: a leading $( ) word before the rig command (local)", cmd: `$(true) rig send s hi $(date)` },
  { id: "L2", deny: true, kind: "substitution", note: "F-1: the same inside ssh", cmd: `ssh host "$(true) rig send s hi $(date)"` },
  { id: "L3", deny: true, kind: "substitution", note: "F-1: the same inside eval", cmd: `eval "$(true) rig send s hi $(date)"` },
  { id: "L4", deny: true, kind: "substitution", note: "F-1: the same inside sh -c", cmd: `sh -c "$(true) rig send s hi $(date)"` },
  { id: "L5", deny: true, kind: "substitution", note: "F-1: the command name is a substitution and the next word is a guarded rig command", cmd: `$(command -v rig) send s hi $(date)` },
  { id: "L6", deny: true, kind: "substitution", note: "F-1: the same inside ssh (the realistic accident form)", cmd: `ssh host "$(command -v rig) send s hi $(date)"` },
  { id: "L7", deny: true, kind: "substitution", note: "F-1: xargs in ssh", cmd: `ssh host "cd /tmp && echo a | xargs rig send s $(date)"` },
  { id: "L8", deny: true, kind: "substitution", note: "F-1: xargs, local, double-quoted substitution", cmd: `xargs rig send s "$(date)"` },
  { id: "L9", deny: true, kind: "substitution", note: "F-1: find -exec in ssh", cmd: `ssh host "find . -maxdepth 0 -exec rig send s $(date) ;"` },
  { id: "L10", deny: true, kind: "substitution", note: "F-1: watch in ssh", cmd: `ssh host "watch rig send s $(date)"` },
  { id: "L11", deny: true, kind: "substitution", note: "F-1: parallel in ssh", cmd: `ssh host "parallel rig send s ::: $(date)"` },
  { id: "L12", deny: true, kind: "substitution", note: "F-1: su -c in ssh", cmd: `ssh host "su -c 'rig send s hi $(date)'"` },
  { id: "L13", deny: true, kind: "substitution", note: "F-1: script (an unmodelled runner) in ssh", cmd: `ssh host "script -q /dev/null rig send s hi $(date)"` },
  { id: "L14", deny: true, kind: "substitution", note: "F-1: docker exec (an unmodelled runner), local", cmd: `docker exec c rig send s "$(date)"` },
  { id: "L15", deny: true, kind: "substitution", note: "F-1: nice/xargs chain with options that take values", cmd: `echo a | nice -n 5 xargs -n 1 -I X rig queue create --body "$(date)"` },
  { id: "L16", deny: false, note: "F-1 control: a bare substitution is not a rig command", cmd: `$(date)` },
  { id: "L17", deny: false, note: "F-1 control: a leading substitution before a command that is not rig", cmd: `$(true) git status` },
  { id: "L18", deny: false, note: "F-1 control: rig among the arguments of echo is text", cmd: `echo rig send $(date)` },
  { id: "L19", deny: false, note: "F-1 control: rig among the arguments of grep is text", cmd: `grep -rn rig send $(pwd)` },
  { id: "L20", deny: false, note: "F-1 control: xargs rig send with a file and no substitution", cmd: `echo a | xargs rig send s --file /tmp/x` },
  { id: "L21", deny: false, note: "F-1 control: find -exec rig seat with a substitution in --cwd (a flag command, not a text option)", cmd: `find . -maxdepth 0 -exec rig seat ls --cwd $(pwd) ;` },
  { id: "L22", deny: false, note: "F-1 control: su -c with plain rig text and an unrelated substitution after it", cmd: `ssh host "su -c 'rig send s hi'; echo $(date)"` },
  // OF-251 review F-2: a literal marker-range character in the text is plain text
  { id: "E1", deny: false, note: "F-2: U+E000 in a single-quoted body", cmd: `rig send s 'text \uE000 here'` },
  { id: "E2", deny: false, note: "F-2: U+E000 in a quoted here-document body", cmd: `rig send s --file - <<'EOF'\ntext \uE000 here\nEOF` },
  { id: "E3", deny: false, note: "F-2: U+E000 in a single-quoted body of a rig send inside ssh next to an unrelated substitution", cmd: `ssh host "cd $(pwd) && rig send s '\uE000'"` },
  { id: "E4", deny: true, kind: "substitution", note: "F-2: U+E000 present AND a real substitution in the single-quoted body", cmd: `ssh host "rig send s '\uE000$(x)'"` },
  // OF-251 review F-4: two marks in one word (mask order) and arithmetic with a live substitution
  { id: "D1", deny: true, kind: "substitution", note: "F-4: a long first mark must not shift the second (mask order)", cmd: `ssh host "cd $(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa); rig send s '$(b)'; echo trailing filler text that is long enough to take the shifted marker"` },
  { id: "D2", deny: true, kind: "substitution", note: "F-4: $(( )) with a live $( ) inside, double-quoted", cmd: `ssh host "rig send s '$(( $(date) + 1 ))'"` },
  { id: "D3", deny: true, kind: "substitution", note: "F-4: the same unquoted-level", cmd: `ssh host rig send s "'"$(( $(date) + 1 ))"'"` },
  { id: "D4", deny: false, note: "F-4 control: pure arithmetic in a script word is nothing to run", cmd: `ssh host "cd /x; rig send s 'n=$((1+2))'"` },
  // OF-251 review F-3: bounded masking; over the bound a command naming a guarded rig command is refused, not timed out
  { id: "Z1", deny: true, kind: "unparseable", note: "F-3: more substitutions in one script word than the mask bound, with rig text", cmd: `ssh h "${"$(a)".repeat(20_001)}; rig send s hi"` },
  { id: "Z2", deny: true, kind: "unparseable", note: "F-3: a script word over the byte bound with a substitution and rig text", cmd: `ssh h "$(a) ${"x".repeat(270_000)} rig send s hi"` },
  { id: "Z3", deny: false, note: "F-3 control: over the bound without any guarded rig text: allowed", cmd: `ssh h "${"$(a)".repeat(20_001)}; echo hi"` },
  { id: "Z4", deny: false, note: "F-3 control: at the bound minus one", cmd: `ssh h "${"$(a)".repeat(19_999)}; rig send s hi"` },
  // OF-251 review F-6: an UNQUOTED here-document fed to a shell is expanded by this shell first
  { id: "HU1", deny: true, kind: "substitution", note: "F-6: bash <<EOF with a substitution inside the single quotes of the rig body", cmd: `bash <<EOF\nrig send s 'a $(date)'\nEOF` },
  { id: "HU2", deny: true, kind: "substitution", note: "F-6: ssh host <<EOF with backticks inside single quotes", cmd: `ssh host <<EOF\nrig send s 'a ${T}x${T}'\nEOF` },
  { id: "HU5", deny: true, kind: "substitution", note: "F-6: unquoted heredoc to bash, a ${x:-$( )} inside the single quotes of the rig body", cmd: `bash <<EOF\nrig send s 'a \${X:-$(date)}'\nEOF` },
  { id: "HU6", deny: true, kind: "substitution", note: "F-6: unquoted heredoc to bash, $(( $( ) )) inside the single quotes of the rig body", cmd: `bash <<EOF\nrig send s 'n=$(( $(date) + 1 ))'\nEOF` },
  { id: "HU7", deny: false, note: "F-6 control: unquoted heredoc to bash, pure arithmetic inside the single quotes", cmd: `bash <<EOF\nrig send s 'n=$((1+2))'\nEOF` },
  { id: "HU3", deny: false, note: "F-6 control: the same with a QUOTED delimiter: literal to the shell", cmd: `bash <<'EOF'\nrig send s 'a $(date)'\nEOF` },
  { id: "HU4", deny: false, note: "F-6 control: unquoted delimiter, an unrelated substitution, plain rig text", cmd: `bash <<EOF\ncd $(pwd); rig send s hi\nEOF` },
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

describe("OF-251 review F-3: the mask is linear", () => {
  it("maskPieces replaces ascending spans in order and keeps the text between them", () => {
    expect(guard.maskPieces("ab$(x)cd`y`ef", [[2, 6], [8, 11]]).replace(/[\uE000-\uF8FF]/g, "#")).toBe("ab#cd#ef");
    expect(guard.maskPieces("plain", [])).toBe("plain");
  });
  it("200,000 spans mask in well under the 5 s hook timeout (the quadratic version took 8.6 s at 150,000 marks)", () => {
    const n = 200_000;
    const text = "$(a)".repeat(n);
    const marks: Array<[number, number]> = Array.from({ length: n }, (_, k) => [k * 4, k * 4 + 4]);
    const t0 = Date.now();
    const out = guard.maskPieces(text, marks);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.length).toBe(n);
  });
  it("a command just under the bound is judged in a few seconds at most, and one over it is refused before any masking", () => {
    for (const marks of [19_999, 150_000]) {
      const t0 = Date.now();
      guard.check(`ssh h "${"$(a)".repeat(marks)}; rig send s hi"`);
      expect(Date.now() - t0, `${marks} marks`).toBeLessThan(3000);
    }
  });
});

describe("OF-251 differential: the verdict against what a real bash does (fake rig logs argv, fake ssh runs the joined words in sh -c)", () => {
  const P = "$(printf PW%sN X)";
  const B = "`printf PW%sN X`";
  // lands: the payload text reaches rig's argv or stdin when bash runs the command; block: what the guard must say (true whenever it lands)
  const DIFF: Array<{ id: string; cmd: string; lands: boolean }> = [
    { id: "d1", cmd: `$(true) rig send s hi @P@`, lands: true },
    { id: "d2", cmd: `ssh host "$(true) rig send s hi @P@"`, lands: true },
    { id: "d3", cmd: `eval "$(true) rig send s hi @P@"`, lands: true },
    { id: "d4", cmd: `sh -c "$(true) rig send s hi @P@"`, lands: true },
    { id: "d5", cmd: `$(command -v rig) send s hi @P@`, lands: true },
    { id: "d6", cmd: `ssh host "cd /tmp && echo a | xargs rig send s @P@"`, lands: true },
    { id: "d7", cmd: `ssh host "find . -maxdepth 0 -exec rig send s @P@ \\;"`, lands: true },
    { id: "d8", cmd: `ssh host "rig send s '@P@'"`, lands: true },
    { id: "d9", cmd: `ssh host "rig send s '@B@'"`, lands: true },
    { id: "d10", cmd: `bash -c "rig send s '@P@'"`, lands: true },
    { id: "d11", cmd: `eval "rig send s '@P@'"`, lands: true },
    { id: "d12", cmd: `ssh host "cd /x; rig send s '@P@'"`, lands: true },
    { id: "d13", cmd: `ssh host "echo @P@ | rig send s --file -"`, lands: true },
    { id: "d14", cmd: `ssh host "rig send s --file - <<'EOF'\n@P@\nEOF"`, lands: true },
    { id: "d15", cmd: `ssh host "rig send s '\${X:-@P@}'"`, lands: true },
    { id: "d16", cmd: `bash <<EOF\nrig send s 'a @P@'\nEOF`, lands: true },
    { id: "d17", cmd: `ssh host rig send s "'"@P@"'"`, lands: true },
    { id: "d18", cmd: `ssh host "cd @P@; rig send s hi"`, lands: false },
    { id: "d19", cmd: `ssh host "echo @P@; rig send s hi"`, lands: false },
    { id: "d20", cmd: `bash -c "@P@; rig send s hi"`, lands: false },
    { id: "d21", cmd: `ssh host "rig send s hi; echo @P@"`, lands: false },
    { id: "d22", cmd: `bash <<EOF\ncd @P@; rig send s hi\nEOF`, lands: false },
    { id: "d23", cmd: `echo rig send @P@`, lands: false },
    { id: "d24", cmd: `bash <<'EOF'\nrig send s 'a @P@'\nEOF`, lands: false },
  ];
  let bin = "";
  let work = "";
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "of251-diff-"));
    bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "rig"), `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" >> "${join(work, "rig.log")}"\n[ -t 0 ] || cat >> "${join(work, "rig.log")}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nshift\nexec sh -c "$*"\n`, { mode: 0o755 });
  });
  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  for (const row of DIFF) {
    it(`${row.id}: ${row.lands ? "the payload reaches rig, so the guard blocks" : "the payload never reaches rig, so the guard allows"}: ${row.cmd.replace(/\n/g, "\\n").slice(0, 70)}`, () => {
      const cmd = row.cmd.replace(/@P@/g, P).replace(/@B@/g, B);
      const log = join(work, "rig.log");
      rmSync(log, { force: true });
      const r = spawnSync("bash", ["-c", cmd], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work }, cwd: work, input: "", encoding: "utf8", timeout: 20_000 });
      const landed = existsSync(log) && readFileSync(log, "utf8").includes("PWXN");
      expect(landed, `oracle (bash ${r.status}, ${r.stderr.slice(0, 120)})`).toBe(row.lands);
      expect(guard.check(cmd).block).toBe(row.lands);
    });
  }
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
