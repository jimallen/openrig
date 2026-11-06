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

/** OF-253: the inline `sh -c` script that runs the guard. $1 = node, $2 = the guard script, $3 = the watchdog seconds; the hook JSON arrives on stdin.
 *  Measured on Claude Code 2.1.319: only exit 2 (or a deny decision) blocks a tool call; a missing interpreter (127), a missing script, exit 1, a SIGKILL and a timeout all let it run.
 *  So when the guard cannot answer (node or the script is missing, the guard crashes or exits non-zero, or it outruns the watchdog) this script applies a DEGRADED check
 *  of its own to the hook text: it refuses (exit 2, a message the model reads) only a command that mentions `rig` and holds a backtick or `$(`, and lets everything else run.
 *  "Mentions rig" is read after decoding the JSON escapes for backtick, `$`, r, i, g and removing quotes and backslashes, so `r""ig`, `r\ig` and `'r'ig` count; the whole check uses shell
 *  builtins (case, parameter expansion, printf), so a PATH without grep or sed cannot skip it, and PATH is prefixed with /usr/bin:/bin for cat and sleep. A hook text over 16 KB is not
 *  decoded: with a backtick or `$(` in it, it counts as mentioning rig. `set +e` first, so an inherited errexit (SHELLOPTS) cannot end the script on the guard's exit code before the
 *  degraded check. The watchdog is plain sh (no `timeout` binary): TERM at the deadline, KILL one second later. The two paths that cannot be made fail-closed from here: the shell binary
 *  itself missing (the hook command names /bin/sh by absolute path) and the process being killed from outside before the watchdog. */
export const RIG_BODY_GUARD_WRAPPER = String.raw`set +e
PATH=/usr/bin:/bin:@@{PATH:-/usr/bin:/bin}
N=$1; S=$2; W=$3
bt=$(printf '\140')
in=$(cat)
sub() {
  r=
  while :; do
    case $s in
      *"$1"*) r=$r@@{s%%"$1"*}$2; s=@@{s#*"$1"} ;;
      *) break ;;
    esac
  done
  s=$r$s
}
deg() {
  s=$in; big=0
  if [ "@@{#s}" -gt 16384 ]; then big=1; else
    sub '\u0060' "$bt"; sub '\u0024' '$'; sub '\u0072' r; sub '\u0069' i; sub '\u0067' g
  fi
  risk=0
  case $s in *"$bt"*|*'$('*) risk=1 ;; esac
  [ $risk = 1 ] || exit 0
  mention=$big
  if [ $big = 0 ]; then
    sub '\n' ' '; sub '\t' ' '; sub '\r' ' '; sub '\' ''; sub '"' ''; sub "'" ''
    case " $s " in *[!A-Za-z0-9_]rig[!A-Za-z0-9_]*) mention=1 ;; esac
  fi
  [ $mention = 1 ] || exit 0
  echo "rig-body-guard is unavailable ($1) and this command mentions rig with a backtick or \$( : refused. Write the text to a file with a command that does not mention rig (cat > /tmp/msg.md <<'EOF' ... EOF), then send it with rig send <session> --file /tmp/msg.md. Or relaunch or restore this seat." >&2
  exit 2
}
[ -x "$N" ] && [ -f "$S" ] || deg "node or the guard script is missing"
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
deg "the guard failed or timed out, exit $rc"`.split("@@{").join("${");

/** The guard's PreToolUse group: a blocking command hook on Bash. It runs RIG_BODY_GUARD_WRAPPER with the daemon's own node (process.execPath, quoted, like the team hook: a bare `node`
 *  fails open on a seat whose PATH has no node, OF-250 review F-1) and the guard script. */
export function claudeRigBodyGuardGroup(scriptPath: string, options: { nodePath?: string; watchdogSeconds?: number } = {}): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  const node = options.nodePath ?? process.execPath;
  const watchdog = options.watchdogSeconds ?? RIG_BODY_GUARD_WATCHDOG_SECONDS;
  return { matcher: "Bash", hooks: [{ type: "command", command: `/bin/sh -c ${shellQuote(RIG_BODY_GUARD_WRAPPER)} sh ${shellQuote(node)} ${shellQuote(scriptPath)} ${watchdog}`, timeout: HOOK_TIMEOUT_SECONDS }] };
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
