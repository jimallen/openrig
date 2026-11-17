// workspaces-o9o.108: the seat Bash guard refuses a kill that is not by PID. Every seat on a host runs as the same user, so
// `pkill -f <pattern>` stops every matching process of every seat: on 2026-11-17 at 17:28:56Z a seat ran
// `pkill -f 'unittest discover -s Tests/ScriptTests'` to stop its own run and stopped four other seats' runs. The guard is the shared
// path of rig-body-guard.cjs (the Claude PreToolUse hook and the Pi tool_call extension), so one table pins both harnesses. It reads
// the shell structure the rig rules already read: quoting, wrappers, nesting and stdin scripts cannot hide a broad kill, and text that
// only mentions one (echo, grep, a commit message, a comment) is not a kill.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "assets", "plugins", "openrig-core");
const require = createRequire(import.meta.url);
const guard = require(join(pluginRoot, "hooks", "scripts", "rig-body-guard.cjs")) as {
  check: (command: unknown) => { block: boolean; violations: Array<{ kind: string }>; reason: string };
  hookDecision: (raw: string) => { output: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null; note: string | null };
};
const piExtension = require(join(pluginRoot, "pi", "rig-body-guard.cjs")) as (pi: { on: (event: string, handler: (e: unknown) => Promise<unknown>) => void }) => void;

const T = "`";
interface Row { cmd: string; kind?: string; note: string }

/** Every row must be refused. `kind` is the violation kind the refusal names. */
const DENY: Row[] = [
  // the incident and the plain forms
  { kind: "pkill-f", note: "the 2026-11-17 17:28:56Z incident command", cmd: "pkill -f 'unittest discover -s Tests/ScriptTests'" },
  { kind: "pkill-f", note: "pkill -f", cmd: "pkill -f vitest" },
  { kind: "pkill-f", note: "--full", cmd: "pkill --full vitest" },
  { kind: "pkill-f", note: "-f in a cluster with a signal", cmd: "pkill -9 -f vitest" },
  { kind: "pkill-f", note: "-f inside a letter cluster", cmd: "pkill -ef node" },
  { kind: "pkill", note: "pkill with a name pattern", cmd: "pkill node" },
  { kind: "pkill", note: "pkill with a signal and a pattern", cmd: "pkill -SIGTERM python3" },
  { kind: "pkill", note: "pkill by owner", cmd: "pkill -u jima" },
  { kind: "pkill", note: "pkill by real uid, attached value", cmd: "pkill -U1000 vitest" },
  { kind: "pkill", note: "pkill by session", cmd: "pkill -s 0" },
  { kind: "killall", note: "killall", cmd: "killall node" },
  { kind: "killall", note: "killall with a signal", cmd: "killall -9 vitest" },
  { kind: "kill-group", note: "kill every process of the user", cmd: "kill -9 -1" },
  { kind: "kill-group", note: "a process group after --", cmd: "kill -- -4242" },
  { kind: "kill-group", note: "a signal, then -- and a process group", cmd: "kill -TERM -- -4242" },
  { kind: "kill-group", note: "a signal, then a negative pid", cmd: "kill -9 -4242" },
  { kind: "kill-group", note: "-s SIGNAL, then a negative pid", cmd: "kill -s KILL -4242" },
  { kind: "kill-group", note: "-n NUMBER, then a negative pid", cmd: "kill -n 9 -4242" },
  { kind: "kill-group", note: "pid 0: the caller's own process group", cmd: "kill 0" },
  { kind: "kill-group", note: "a signal and pid 0", cmd: "kill -15 0" },
  { kind: "kill-group", note: "a negative pid among plain ones", cmd: "kill 4242 -4243" },
  { kind: "kill-pattern", note: "kill of what pgrep -f matches", cmd: "kill $(pgrep -f vitest)" },
  { kind: "kill-pattern", note: "kill of what pgrep matches, backticks", cmd: `kill ${T}pgrep node${T}` },
  { kind: "kill-pattern", note: "kill of what pidof finds", cmd: "kill -9 $(pidof node)" },
  { kind: "kill-pattern", note: "pgrep -f piped into xargs kill", cmd: "pgrep -f vitest | xargs kill" },
  { kind: "kill-pattern", note: "pgrep piped into xargs -r kill -9", cmd: "pgrep -u jima node | xargs -r kill -9" },
  // o9o.108 review (verify-sec2): a target variable assigned in the same command reads as its value
  { kind: "kill-pattern", note: "pids assigned from pgrep -f, then killed", cmd: "pids=$(pgrep -f vitest); kill $pids" },
  { kind: "kill-pattern", note: "pids assigned from pidof, then killed", cmd: "pids=$(pidof node); kill $pids" },
  { kind: "kill-pattern", note: "pids assigned from pgrep in backticks", cmd: "pids=`pgrep -f x`; kill -9 $pids" },
  { kind: "kill-pattern", note: "pids exported from pgrep", cmd: "export pids=$(pgrep vitest); kill $pids" },
  { kind: "kill-group", note: "pid=-1 then kill -9 \"$pid\"", cmd: 'pid=-1; kill -9 "$pid"' },
  { kind: "kill-group", note: "pid=-4242 then kill \"$pid\"", cmd: 'pid=-4242; kill "$pid"' },
  { kind: "kill-group", note: "pid=0 then kill \"$pid\"", cmd: 'pid=0; kill "$pid"' },
  { kind: "kill-group", note: "a quoted list holding -1", cmd: 'pids="4242 -1"; kill $pids' },
  { kind: "kill-group", note: "the assignment inside sh -c", cmd: "sh -c 'pid=-1; kill -9 $pid'" },
  { kind: "kill-group", note: "the assignment inside eval", cmd: "eval 'p=0; kill ${p}'" },
  // quoting does not hide the program
  { kind: "pkill-f", note: "single-quoted name", cmd: "'pkill' -f vitest" },
  { kind: "pkill-f", note: "double-quoted name", cmd: "\"pkill\" -f vitest" },
  { kind: "pkill-f", note: "part-quoted name", cmd: "p'kill' -f vitest" },
  { kind: "pkill-f", note: "backslash-escaped name", cmd: "\\pkill -f vitest" },
  { kind: "pkill-f", note: "ANSI-C spelling of the name", cmd: "$'\\x70kill' -f vitest" },
  { kind: "pkill-f", note: "quoted option", cmd: "pkill '-f' vitest" },
  { kind: "kill-group", note: "quoted signal and target", cmd: "kill \"-9\" \"-1\"" },
  { kind: "kill-group", note: "quoted negative pid", cmd: "kill -9 '-4242'" },
  { kind: "killall", note: "the name from an assignment in the same command", cmd: "K=killall; $K node" },
  // wrappers the guard already reads
  { kind: "pkill-f", note: "absolute path", cmd: "/usr/bin/pkill -f vitest" },
  { kind: "pkill-f", note: "sudo", cmd: "sudo pkill -f vitest" },
  { kind: "pkill-f", note: "sudo -u", cmd: "sudo -u jima pkill -f vitest" },
  { kind: "pkill-f", note: "env with an assignment", cmd: "env LC_ALL=C pkill -f vitest" },
  { kind: "pkill-f", note: "nohup", cmd: "nohup pkill -f vitest" },
  { kind: "pkill-f", note: "timeout", cmd: "timeout 5 pkill -f vitest" },
  { kind: "killall", note: "nice -n", cmd: "nice -n 5 killall node" },
  { kind: "kill-group", note: "command builtin", cmd: "command kill -9 -1" },
  { kind: "kill-group", note: "builtin", cmd: "builtin kill 0" },
  { kind: "pkill-f", note: "exec", cmd: "exec pkill -f vitest" },
  { kind: "pkill-f", note: "xargs runs pkill", cmd: "echo x | xargs pkill -f" },
  { kind: "pkill-f", note: "find -exec runs pkill", cmd: "find . -name x -exec pkill -f vitest \\;" },
  { kind: "pkill-f", note: "docker exec runs pkill", cmd: "docker exec c1 pkill -f vitest" },
  // every shell form the guard reads
  { kind: "pkill-f", note: "after ;", cmd: "cd /tmp; pkill -f vitest" },
  { kind: "killall", note: "after &&", cmd: "true && killall node" },
  { kind: "kill-group", note: "after ||", cmd: "false || kill 0" },
  { kind: "pkill-f", note: "in a subshell", cmd: "(pkill -f vitest)" },
  { kind: "pkill-f", note: "in a command substitution", cmd: "echo $(pkill -f vitest)" },
  { kind: "pkill-f", note: "in a pipeline", cmd: "ps aux | pkill -f vitest" },
  { kind: "pkill-f", note: "bash -c", cmd: "bash -c 'pkill -f vitest'" },
  { kind: "killall", note: "sh -c", cmd: "sh -c \"killall node\"" },
  { kind: "kill-group", note: "su -c", cmd: "su -c 'kill -9 -1'" },
  { kind: "pkill-f", note: "eval", cmd: "eval 'pkill -f vitest'" },
  { kind: "pkill-f", note: "ssh with a quoted remote command", cmd: "ssh stu 'pkill -f vitest'" },
  { kind: "pkill-f", note: "ssh with a plain remote command", cmd: "ssh stu pkill -f vitest" },
  { kind: "pkill-f", note: "a quoted here-document fed to bash", cmd: "bash <<'EOF'\npkill -f vitest\nEOF" },
  { kind: "pkill-f", note: "echo piped into sh", cmd: "echo 'pkill -f vitest' | sh" },
  { kind: "pkill-f", note: "watch", cmd: "watch pkill -f vitest" },
  { kind: "pkill-f", note: "script -c", cmd: "script -qc 'pkill -f vitest' /dev/null" },
  { kind: "pkill-f", note: "env -S", cmd: "env -S 'pkill -f vitest'" },
  // the guard cannot read it, and it names a broad kill: refused, not allowed
  { kind: "unparseable-kill", note: "unterminated quote around a pkill", cmd: "pkill -f \"unittest" },
];

/** None of these may be refused by the kill rules (or by anything else in the guard). */
const ALLOW: Row[] = [
  { note: "kill by pid", cmd: "kill 4242" },
  { note: "a signal and a pid", cmd: "kill -9 4242" },
  { note: "a named signal and pids", cmd: "kill -TERM 4242 4243" },
  { note: "-s SIGNAL and a pid", cmd: "kill -s TERM 4242" },
  { note: "-- and a pid", cmd: "kill -- 4242" },
  { note: "a pid in a variable", cmd: "kill \"$pid\"" },
  { note: "a signal in a variable (the first -X is a signal)", cmd: "kill -$sig $pid" },
  { note: "a job spec", cmd: "kill %1" },
  { note: "list signals", cmd: "kill -l" },
  { note: "list signals with names", cmd: "kill -L" },
  { note: "kill -1 alone is the signal HUP with no target (a usage error)", cmd: "kill -1" },
  { note: "kill of a pid read from a file", cmd: "kill $(cat run.pid)" },
  { note: "bare pkill: a usage error that kills nothing", cmd: "pkill" },
  { note: "pkill help", cmd: "pkill --help" },
  { note: "pkill anchored to a pidfile", cmd: "pkill -F /run/x.pid" },
  { note: "pkill anchored to a literal parent pid", cmd: "pkill -P 4242" },
  { note: "pkill anchored to the shell's own pid", cmd: "pkill -P $$" },
  { note: "killall help", cmd: "killall --help" },
  { note: "killall list", cmd: "killall -l" },
  { note: "pgrep only looks", cmd: "pgrep -af vitest" },
  { note: "echo mentions pkill", cmd: "echo 'use pkill -f only with care'" },
  { note: "grep for pkill", cmd: "grep -rn 'pkill -f' docs/" },
  { note: "a commit message about killall", cmd: "git commit -m 'never killall node'" },
  { note: "a comment", cmd: "kill 4242 # not pkill -f vitest" },
  { note: "ps piped into grep for kill", cmd: "ps aux | grep 'kill -9 -1'" },
  { note: "a man page", cmd: "man killall" },
  { note: "printf with the words", cmd: "printf '%s\\n' 'kill 0'" },
  { note: "grep for killall in a file", cmd: "grep -n killall notes.md" },
  { note: "systemctl kill of a unit", cmd: "systemctl --user kill foo" },
  { note: "tmux kill-session", cmd: "tmux kill-session -t x" },
  { note: "which names the commands", cmd: "which pkill killall" },
  { note: "pgrep counted, not killed", cmd: "pgrep -f vitest | wc -l" },
  { note: "kill of pgrep anchored to this shell's children", cmd: "kill $(pgrep -P $$)" },
  { note: "kill of pgrep anchored to a pidfile", cmd: "kill $(pgrep -F run.pid)" },
  { note: "a signal then -- then a pid", cmd: "kill -9 -- 4242" },
  { note: "kill -l 0 names a signal, it sends nothing", cmd: "kill -l 0" },
  { note: "kill of an unresolved variable (carried-in pid)", cmd: "kill $pid" },
  { note: "kill -9 of an unresolved quoted variable", cmd: 'kill -9 "$pid"' },
  { note: "a variable assigned a plain pid", cmd: 'pid=4242; kill "$pid"' },
  { note: "a variable signal before a pid", cmd: "sig=-9; kill $sig 4242" },
  { note: "pids from pgrep anchored to this shell", cmd: "pids=$(pgrep -P $$); kill $pids" },
  { note: "pids read from a pidfile", cmd: "pids=$(cat run.pid); kill $pids" },
];

describe("o9o.108: the guard refuses a kill that is not by PID", () => {
  it.each(DENY.map((r) => [r.note, r] as const))("refuses: %s", (_note, row) => {
    const verdict = guard.check(row.cmd);
    expect(verdict.block, row.cmd).toBe(true);
    expect(verdict.violations[0]?.kind, row.cmd).toBe(row.kind);
  });

  it.each(ALLOW.map((r) => [r.note, r] as const))("allows: %s", (_note, row) => {
    expect(guard.check(row.cmd), row.cmd).toMatchObject({ block: false });
  });

  it("the refusal says nothing ran and teaches stopping by PID after checking it is yours", () => {
    const reason = guard.check("pkill -f 'unittest discover -s Tests/ScriptTests'").reason;
    expect(reason).toContain("BLOCKED this command before it ran. Nothing was executed.");
    expect(reason).toContain("same user");
    expect(reason).toMatch(/pgrep -af/);
    expect(reason).toMatch(/yours/);
    expect(reason).toMatch(/kill <pid>/);
  });

  it("each kind of refusal names its own reason", () => {
    const why = (cmd: string) => guard.check(cmd).reason;
    expect(why("pkill -f x")).toMatch(/full command line/);
    expect(why("killall node")).toMatch(/every process with that name/);
    expect(why("kill -9 -1")).toMatch(/process group|every process you own/);
    expect(why("kill $(pgrep -f x)")).toMatch(/pattern/);
  });
});

describe("o9o.108: both harnesses refuse it", () => {
  it("the Claude PreToolUse hook denies a broad kill with the same reason", () => {
    const raw = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f vitest" } });
    const decision = guard.hookDecision(raw);
    expect(decision.output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.output?.hookSpecificOutput?.permissionDecisionReason).toBe(guard.check("pkill -f vitest").reason);
  });

  it("the Claude hook allows a kill by PID", () => {
    expect(guard.hookDecision(JSON.stringify({ tool_name: "Bash", tool_input: { command: "kill -9 4242" } })).output).toBeNull();
  });

  it("the Pi extension blocks a broad kill on tool_call and lets a kill by PID through", async () => {
    let handler: ((e: unknown) => Promise<unknown>) | null = null;
    piExtension({ on: (event, h) => { if (event === "tool_call") handler = h; } });
    expect(handler).not.toBeNull();
    const blocked = await handler!({ toolName: "bash", input: { command: "killall node" } }) as { block?: boolean; reason?: string } | undefined;
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain("Nothing was executed");
    expect(await handler!({ toolName: "bash", input: { command: "kill 4242" } })).toBeUndefined();
  });
});
