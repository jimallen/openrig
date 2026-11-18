// OF-250: the rig-body guard (OF-249) as part of the ONE `--settings` JSON a Claude launch carries.
//
// Measured on Claude Code 2.1.318 (OF-250): a single `--settings` adds its hooks to the user's and the project's; TWO `--settings` flags do NOT merge,
// the last wins and the other is dropped (the guard or the team/kernel permission hook would silently vanish). So the guard is merged INTO the launch's
// one `--settings` JSON as a second PreToolUse group, or is the only content of a `--settings` the launch did not have. Never a second flag, and
// nothing is written to disk (no config file, no state file): it is a launch argument, so the "OpenRig authors no config-file policy" rip-out is untouched.
import nodePath from "node:path";
import { existsSync, statSync } from "node:fs";
import { shellQuote } from "./shell-quote.js";

/** The hook script the settings point at: the plugin asset shipped with this daemon. src/adapters and dist/adapters are the same depth. */
export function claudeRigBodyGuardScriptPath(adaptersDir: string = import.meta.dirname): string {
  return nodePath.resolve(adaptersDir, "../../assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs");
}

/** Why a Claude launch must not happen, or null. Checked before anything is typed into a pane. */
export function claudeRigBodyGuardRefusal(scriptPath: string = claudeRigBodyGuardScriptPath(), exists: (file: string) => boolean = (f) => existsSync(f) && statSync(f).isFile()): string | null {
  return exists(scriptPath) ? null : `the rig-body guard hook script is missing (${scriptPath}); not launching Claude without it`;
}

interface HookGroup { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }

/** Seconds the wrapper gives the guard before it stops it and falls to the degraded check. Shorter than the hook timeout below (Claude Code runs the command unguarded on a hook timeout). */
export const RIG_BODY_GUARD_WATCHDOG_SECONDS = 3;
const HOOK_TIMEOUT_SECONDS = 5;

/** The guarded rig subcommand words of the guard's tables (MESSAGE_COMMANDS and FLAG_COMMANDS in rig-body-guard.cjs; a test keeps this list equal to them). The degraded check
 *  below counts one of them, as a whole word, like the substring "rig": a name spelled apart (r$''ig) leaves `send` or `queue` next to it. */
export const RIG_BODY_GUARD_SUBCOMMANDS: readonly string[] = [
  "send", "broadcast", "ask", "chatroom", "stream", "queue", "proof", "scope", "watchdog", "workflow",
  "seat", "edge", "gateway", "project", "launch", "agent-image", "bundle", "host", "slack", "startup-proof", "mode", "restore-packet",
];
const SUBCOMMAND_CASE = RIG_BODY_GUARD_SUBCOMMANDS.map((w) => `*[!A-Za-z0-9_]${w}[!A-Za-z0-9_]*`).join("|");
/** workspaces-o9o.173: the kill words, whole words bounded by anything but [A-Za-z0-9_-] (so `tmux kill-session` is none). */
const KILL_WORDS = ["kill", "pkill", "killall"];
const KILL_CASE = KILL_WORDS.map((w) => `*[!A-Za-z0-9_-]${w}[!A-Za-z0-9_-]*`).join("|");


/** OF-253: the inline `sh -c` script that runs the guard. $1 = node, $2 = the guard script, $3 = the watchdog seconds; the hook JSON arrives on stdin.
 *  Measured on Claude Code 2.1.319: only exit 2 (or a deny decision) blocks a tool call; a missing interpreter (127), a missing script, exit 1, a SIGKILL and a timeout all let it run.
 *  So when the guard cannot answer (node or the script is missing, the guard crashes or exits non-zero, or it outruns the watchdog) this script applies a DEGRADED check
 *  of its own to the hook text: it refuses (exit 2, a message the model reads) the two classes the guard exists for, and lets everything else run:
 *  - a command that mentions `rig` and holds a backtick or `$(`;
 *  - workspaces-o9o.173: a command with `kill`, `pkill` or `killall` as a whole word (bounded by anything but letters, digits, `_` and `-`, so `tmux kill-session`
 *    is not one), read from the same decoded text. The guard's finer verdicts (a kill by pid, `kill %job`, `pkill -P <pid>`) are not reproduced in plain sh: while
 *    the guard is down every kill word is refused, and the message says why and how to repair it. Refusing every Bash call instead would leave a seat whose guard is
 *    down (a node upgrade removes the daemon's node from under every seat at once) unable to look into it or report it. `rig doctor` reports such a seat
 *    (running_seats_guard) before a refusal does.
 *  "Mentions rig" is read after decoding the JSON escapes and removing backslash-newline pairs, quotes and backslashes: the substring `rig` anywhere, OR a guarded rig subcommand word
 *  (send, queue, ...) as a whole word, so `r""ig`, `r\ig`, `'r'ig` and a name spelled apart (`r$''ig send`) count (a deliberately obfuscated NAME *and* SUBCOMMAND, `r$''ig s$''end`, does not: this is an accident guard, not a sandbox); the whole check uses shell
 *  builtins (case, parameter expansion, printf), so a PATH without grep or sed cannot skip it, and PATH is prefixed with /usr/bin:/bin for cat and sleep. A hook text over 16 KB is not
 *  decoded: with a backtick or `$(` in it, it counts as mentioning rig. `set +e` first, so an inherited errexit (SHELLOPTS) cannot end the script on the guard's exit code before the
 *  degraded check. The watchdog is plain sh (no `timeout` binary): TERM at the deadline, KILL one second later. The two paths that cannot be made fail-closed from here: the shell binary
 *  itself missing (the hook command names /bin/sh by absolute path) and the process being killed from outside before the watchdog. */
export const RIG_BODY_GUARD_WRAPPER = String.raw`set +e
PATH=/usr/bin:/bin:@@{PATH:-/usr/bin:/bin}
N=$1; S=$2; W=$3
bt=$(printf '\140')
in=$(cat)
# workspaces-o9o.173 (verify-sec review 2): the ONE decoding of a backslash-separated field of the hook text, used by both paths
# below so their rules cannot drift. In: t (the field), and the state lit and after. Out: e, the text the field decodes to.
# An empty field is the first backslash of a JSON escaped backslash (\\): the field after it is plain text (so \\rig keeps its r);
# an empty plain field right after it marks a backslash-newline. u0060 u0024 u0072 u0069 u0067 decode; JSON n, t, r escapes are
# separators (a space), except a newline right after an escaped backslash (backslash-newline, which the shell removes, so
# ri BS NL g is rig); b and f are dropped.
dec1() {
  if [ $lit = 1 ]; then e=$t; lit=0; [ -n "$t" ] || after=1; return; fi
  was=$after; after=0
  case $t in
    '') e=; lit=1 ;;
    u0060*) e=$bt@@{t#u0060} ;;
    u0024*) e='$'@@{t#u0024} ;;
    u0072*) e=r@@{t#u0072} ;;
    u0069*) e=i@@{t#u0069} ;;
    u0067*) e=g@@{t#u0067} ;;
    n*) if [ $was = 1 ]; then e=@@{t#?}; else e=" @@{t#?}"; fi ;;
    [tr]*) e=" @@{t#?}" ;;
    [bf]*) e=@@{t#?} ;;
    *) e=$t ;;
  esac
}
killed() {
  echo "rig-body-guard is unavailable ($why) and this command uses kill, pkill or killall: refused while the guard is down, a kill by pid included.$gone Relaunch or restore this seat to bring the guard back; rig doctor names a seat whose guard is down." >&2
  exit 2
}
deg() {
  why=$1
  # workspaces-o9o.131 (verify-sec FAIL, round 4): a Code Mode REPL call carries JavaScript the degraded sh check cannot parse. While the
  # guard is down it refuses the REPL call outright (fail closed) for ANY tool_name field that names REPL, whatever the JSON whitespace and
  # wherever it sits — round 3 read only the FIRST "tool_name" it met, so a nested '"tool_name":"Bash"' inside tool_input, placed before the
  # top-level "tool_name":"REPL", masked it. Walk EVERY "tool_name" occurrence: strip up to each one and test its value (to the next comma).
  # Pure builtins, no grep/sed, no fixed spacing.
  tnrest=$in
  while :; do
    case $tnrest in
      *'"tool_name"'*) tnrest=@@{tnrest#*'"tool_name"'}; tnv=@@{tnrest%%,*}; case $tnv in *REPL*) echo "rig-body-guard is unavailable ($why) and this is a Code Mode REPL call, which the degraded check cannot read: refused. Run the work as shell commands (await Bash({ command: ... }), which the guard checks), or relaunch or restore this seat." >&2; exit 2 ;; esac ;;
      *) break ;;
    esac
  done
  # Nothing in the hook text can be a risk (no backtick, no "$(", no JSON u00xx escape that could spell one, and no k, i, l, l in order that quotes could
  # split into a kill word, o9o.173): done.
  case $in in *"$bt"*|*'$('*|*'\u00'*|*k*i*l*l*) ;; *) exit 0 ;; esac
  k='"command":'
  case $in in *"$k"*) ;; *) k='"code":' ;; esac   # workspaces-o9o.131: a REPL call carries its JavaScript as "code"
  s=@@{in#*"$k"}          # the command's value onward: cwd and transcript path come before it and may hold "rig" ("openrig")
  if [ "@@{#s}" -gt 16384 ]; then
    # Too long for the decode loop below, which builds the whole decoded text and so is quadratic in escapes (measured on dash:
    # 3.6 s at 256 KB, 53 s at 1 MB, against the hook's 5 s). The kill check still reads decoded text (o9o.173, verify-sec
    # reviews): the same fields, decoded by the same dec1, quotes removed from each piece as the loop removes them at the end,
    # but each piece is checked joined to the last 16 decoded characters only, so every character is read about once. Then a
    # backtick, "$(" or u00xx escape refuses as a rig body. (A for loop's list is expanded before it runs, so set -- inside it
    # is safe.)
    set -f
    q=$(printf '\042\047')
    IFS='\'; set -- $s; unset IFS
    # The first field is plain text, as the short path's r=$1 is; every later field goes through dec1.
    tail=; lit=0; after=0; first=1
    for t in "$@"; do
      if [ $first = 1 ]; then e=$t; first=0; else dec1; fi
      case $e in *[$q]*) IFS=$q; set -- $e; IFS=; e="$*"; unset IFS ;; esac
      w=$tail$e
      case " $w " in KILLCASE) killed ;; esac
      if [ "@@{#w}" -gt 16 ]; then tail=@@{w#"@@{w%????????????????}"}; else tail=$w; fi
    done
    case $in in *"$bt"*|*'$('*|*'\u00'*) ;; *) exit 0 ;; esac
  else
    # Coarse on purpose: split on backslashes, decode u0060 u0024 u0072 u0069 u0067, drop the letter of a JSON escape pair (n t r b f), then drop quotes.
    set -f
    IFS='\'; set -- $s; unset IFS
    r=$1; [ $# -gt 0 ] && shift
    lit=0; after=0
    # JSON n, t, r escapes are SEPARATORS (a space): r$''ig TAB send must not read as r$''igsend (dec1 holds the rules).
    for t in "$@"; do dec1; r=$r$e; done
    IFS=$(printf '\042\047'); set -- $r; IFS=; r="$*"; unset IFS
    case " $r " in KILLCASE) killed ;; esac
    case $r in *"$bt"*|*'$('*) ;; *) exit 0 ;; esac
    case " $r " in *rig*|SUBCASE) ;; *) exit 0 ;; esac
  fi
  echo "rig-body-guard is unavailable ($why) and this command mentions rig with a backtick or \$( : refused. Write the text to a file with a command that does not mention rig (cat > /tmp/msg.md <<'EOF' ... EOF), then send it with rig send <session> --file /tmp/msg.md. Or relaunch or restore this seat.$gone" >&2
  exit 2
}
gone=
[ -x "$N" ] || gone=" Missing: node $N."
[ -f "$S" ] || gone="$gone Missing: guard script $S."
[ -z "$gone" ] || deg "node or the guard script is missing"
out=$(
  printf '%s' "$in" | "$N" "$S" &
  p=$!
  ( sleep "$W"; kill "$p" 2>/dev/null; sleep 1; kill -9 "$p" 2>/dev/null ) >/dev/null 2>&1 &
  k=$!
  wait "$p"; rc=$?
  kill "$k" 2>/dev/null
  exit "$rc"
)
rc=$?
if [ "$rc" -eq 0 ]; then
  [ -z "$out" ] || printf '%s\n' "$out"
  exit 0
fi
deg "the guard failed or timed out, exit $rc"`.split("@@{").join("${").split("SUBCASE").join(SUBCOMMAND_CASE).split("KILLCASE").join(KILL_CASE);

/** The guard's PreToolUse group: a blocking command hook on Bash. `onFailure: "block"` (measured on Claude Code 2.1.317 and 2.1.319, OF-251 round 2) makes a hook that fails to run block the tool call as well: a wrapper that cannot start
 *  (a missing /bin/sh, a bad exit, a timeout, a kill) refuses every Bash call until the seat is relaunched, instead of letting the command run unguarded.  It runs RIG_BODY_GUARD_WRAPPER with the daemon's own node (process.execPath, quoted, like the team hook: a bare `node`
 *  fails open on a seat whose PATH has no node, OF-250 review F-1) and the guard script. */
export function claudeRigBodyGuardGroup(scriptPath: string, options: { nodePath?: string; watchdogSeconds?: number } = {}): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number; onFailure: "block" }> } {
  const node = options.nodePath ?? process.execPath;
  const watchdog = options.watchdogSeconds ?? RIG_BODY_GUARD_WATCHDOG_SECONDS;
  // workspaces-o9o.131: Code Mode's REPL tool as well as Bash (the guard reads tool_input.code for it).
  return { matcher: "Bash|REPL", hooks: [{ type: "command", command: `/bin/sh -c ${shellQuote(RIG_BODY_GUARD_WRAPPER)} sh ${shellQuote(node)} ${shellQuote(scriptPath)} ${watchdog}`, timeout: HOOK_TIMEOUT_SECONDS, onFailure: "block" }] };
}

const SETTINGS_FLAG = "--settings";
const SETTINGS_EQ = "--settings=";

/** Add the guard to a Claude launch's argv. Exactly one `--settings` (`--settings <json>` or `--settings=<json>`, the form it came in) comes out, whatever went in.
 *  Fail closed (OF-252): a launch is refused, by a thrown Error, rather than started without the guard or with a caller's hook silently dropped, when
 *  more than one settings flag goes in (they do not merge), the flag has no value, the value is not a JSON object (a file path is not read here), `hooks` is not an
 *  object or `hooks.PreToolUse` is not an array. */
export function withRigBodyGuard(args: string[], scriptPath: string = claudeRigBodyGuardScriptPath()): string[] {
  const flagAt: number[] = [];
  args.forEach((a, i) => { if (a === SETTINGS_FLAG || a.startsWith(SETTINGS_EQ)) flagAt.push(i); });
  if (flagAt.length > 1) throw new Error("a Claude launch carries more than one --settings; they do not merge");
  const group = claudeRigBodyGuardGroup(scriptPath);
  if (flagAt.length === 0) return [...args, SETTINGS_FLAG, JSON.stringify({ hooks: { PreToolUse: [group] } })];
  const at = flagAt[0]!;
  const equalsForm = args[at]!.startsWith(SETTINGS_EQ);
  const raw = equalsForm ? args[at]!.slice(SETTINGS_EQ.length) : args[at + 1];
  if (raw === undefined) throw new Error("the --settings of a Claude launch has no value; not launching Claude without the rig-body guard");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`the --settings value of a Claude launch is not valid JSON (${error instanceof Error ? error.message : String(error)}); a file path is not supported; not launching Claude without the rig-body guard`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the --settings value of a Claude launch is not a JSON object; not launching Claude without the rig-body guard");
  const settings = parsed as Record<string, unknown>;
  const rawHooks = settings["hooks"];
  if (rawHooks !== undefined && (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks))) throw new Error("the --settings hooks of a Claude launch is not an object; not replacing it, not launching Claude without the rig-body guard");
  const hooks = { ...((rawHooks ?? {}) as Record<string, unknown>) };
  const rawPre = hooks["PreToolUse"];
  if (rawPre !== undefined && !Array.isArray(rawPre)) throw new Error("the --settings hooks.PreToolUse of a Claude launch is not an array; not replacing it, not launching Claude without the rig-body guard");
  const existing = (rawPre ?? []) as HookGroup[];
  const already = existing.some((g) => !!g && typeof g === "object" && Array.isArray(g.hooks) && g.hooks.some((h) => !!h && h.command === group.hooks[0]!.command));
  hooks["PreToolUse"] = already ? existing : [...existing, group];
  const json = JSON.stringify({ ...settings, hooks });
  return equalsForm ? [...args.slice(0, at), `${SETTINGS_EQ}${json}`, ...args.slice(at + 1)] : [...args.slice(0, at + 1), json, ...args.slice(at + 2)];
}
