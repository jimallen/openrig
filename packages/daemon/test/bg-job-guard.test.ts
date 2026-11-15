// The background-job guard (rig-body-guard.cjs checkBackground, run by the Claude PreToolUse hook only).
// A seat that starts a shell background job inside a foreground Bash call (`( swift test ...; echo rc=$? ) > log 2>&1 &`, `nohup x &`)
// is not woken when the job ends and sits idle (eztrack build-impl2, 2026-11-15, ~40 min between two transcript calls). The hook refuses
// those commands, unless the call itself is run_in_background: true, and names run_in_background and Monitor instead. Ambiguous parses allow.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeRigBodyGuardGroup } from "../src/adapters/claude-rig-body-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "assets", "plugins", "openrig-core");
const guardPath = join(pluginRoot, "hooks", "scripts", "rig-body-guard.cjs");
const require = createRequire(import.meta.url);
const guard = require(guardPath) as {
  check: (command: unknown) => { block: boolean };
  checkBackground: (command: unknown, options?: { budgetMs?: number }) => { block: boolean; kind: string | null; reason: string };
  hookDecision: (raw: string) => { output: { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } | null; note: string | null };
};
const piExtension = require(join(pluginRoot, "pi", "rig-body-guard.cjs")) as (pi: { on: (event: string, handler: (e: unknown) => Promise<unknown>) => void }) => void;

interface Row { id: string; cmd: string; deny: boolean; kind?: "ampersand" | "detach"; note: string }

const ROWS: Row[] = [
  // ---- the 2026-11-15 shapes
  { id: "R1", deny: true, kind: "ampersand", note: "the build-impl2 shape: a subshell redirected to a log, backgrounded",
    cmd: "( swift test --no-parallel; echo rc=$? ) > /tmp/swift-test.log 2>&1 &" },
  { id: "R2", deny: true, kind: "detach", note: "nohup with a redirect, backgrounded", cmd: "nohup swift build > /tmp/build.log 2>&1 &" },

  // ---- refused
  { id: "D1", deny: true, kind: "ampersand", note: "a plain trailing &", cmd: "sleep 30 &" },
  { id: "D2", deny: true, kind: "ampersand", note: "a & then another command, no wait", cmd: "sleep 30 &\necho started" },
  { id: "D3", deny: true, kind: "ampersand", note: "a & after an && chain", cmd: "cd pkg && npm test > /tmp/t.log 2>&1 &" },
  { id: "D4", deny: true, kind: "ampersand", note: "a brace group backgrounded", cmd: "{ make; echo done; } > /tmp/m.log 2>&1 &" },
  { id: "D5", deny: true, kind: "ampersand", note: "a loop body backgrounded with no wait after the loop", cmd: "for i in 1 2; do run $i & done" },
  { id: "D6", deny: true, kind: "ampersand", note: "a wait BEFORE the last & does not cover it", cmd: "a & wait; b &" },
  { id: "D7", deny: true, kind: "detach", note: "nohup without & (refused by rule: nohup as a command word)", cmd: "nohup x > /tmp/f" },
  { id: "D8", deny: true, kind: "detach", note: "disown after a &", cmd: "long-job & disown" },
  { id: "D9", deny: true, kind: "detach", note: "setsid as a command word", cmd: "setsid long-job > /tmp/f 2>&1" },
  { id: "D10", deny: true, kind: "detach", note: "nohup behind a wrapper (nice -n 19)", cmd: "nice -n 19 nohup swift test > /tmp/f 2>&1" },
  { id: "D11", deny: true, kind: "detach", note: "nohup by path, after an assignment", cmd: "FOO=1 /usr/bin/nohup x" },
  { id: "D12", deny: true, kind: "detach", note: "nohup with & and a later wait: still nohup", cmd: "nohup x & wait" },
  { id: "D13", deny: true, kind: "ampersand", note: "an unquoted & glued between words still backgrounds", cmd: "curl http://h/?a=1&b=2" },
  { id: "D14", deny: true, kind: "ampersand", note: "a & after a [[ ]] test", cmd: "[[ -f x ]] && build &" },

  // ---- allowed: not a background job
  { id: "A1", deny: false, note: "&&", cmd: "npm run build && npm test" },
  { id: "A2", deny: false, note: "2>&1 into a pipe", cmd: "npm test 2>&1 | tail -20" },
  { id: "A3", deny: false, note: "&> redirect", cmd: "npm test &> /tmp/t.log" },
  { id: "A4", deny: false, note: "cmd &>/dev/null redirect", cmd: "which swift &>/dev/null" },
  { id: "A5", deny: false, note: "&>> redirect", cmd: "npm test &>> /tmp/t.log" },
  { id: "A6", deny: false, note: ">& redirect", cmd: "npm test >& /tmp/t.log" },
  { id: "A7", deny: false, note: "<& and >&- fd operations", cmd: "exec 3>&-; read x <&3" },
  { id: "A8", deny: false, note: "|& pipe", cmd: "npm test |& tee /tmp/t.log" },
  { id: "A9", deny: false, note: "& in single quotes", cmd: "echo 'a & b'" },
  { id: "A10", deny: false, note: "& in double quotes", cmd: "git commit -m \"fix & test\" && git push" },
  { id: "A11", deny: false, note: "an escaped &", cmd: "echo a \\& b" },
  { id: "A12", deny: false, note: "& in a quoted here-document body", cmd: "cat > /tmp/s.sh <<'EOF'\nsleep 1 &\nEOF" },
  { id: "A13", deny: false, note: "& in an unquoted here-document body", cmd: "cat <<EOF > /tmp/s.sh\nsleep 1 &\nEOF\nchmod +x /tmp/s.sh" },
  { id: "A14", deny: false, note: "& in a comment", cmd: "ls # then run it &" },
  { id: "A15", deny: false, note: "a quoted URL with &", cmd: "curl 'http://h/?a=1&b=2'" },
  { id: "A16", deny: false, note: "nohup as an argument, not a command word", cmd: "grep -rn nohup scripts/ && echo setsid disown" },
  { id: "A17", deny: false, note: "bash case fall-through ;&", cmd: "case $x in a) echo a;& b) echo b;; esac" },

  // ---- allowed: the call blocks until the jobs finish
  { id: "W1", deny: false, note: "x & wait", cmd: "sleep 1 & wait" },
  { id: "W2", deny: false, note: "cmd1 & cmd2 & wait", cmd: "npm run a & npm run b & wait" },
  { id: "W3", deny: false, note: "a loop of jobs then wait", cmd: "for i in 1 2; do run $i & done; wait" },
  { id: "W4", deny: false, note: "wait on a pid", cmd: "long-job > /tmp/f 2>&1 &\npid=$!\nwait $pid; echo rc=$?" },

  // ---- allowed: ambiguous or out of reach (fail open)
  { id: "F1", deny: false, note: "(( arithmetic with & ))", cmd: "(( mask = flags & 4 )) && echo set" },
  { id: "F2", deny: false, note: "an unterminated quote: cannot lex", cmd: "echo \"oops & sleep 1 &" },
  { id: "F3", deny: false, note: "& inside a command substitution", cmd: "echo $(sleep 1 &)" },
  { id: "F4", deny: false, note: "& inside bash -c '...'", cmd: "bash -c 'sleep 1 &'" },
  { id: "F5", deny: false, note: "$(( )) arithmetic is a word", cmd: "echo $(( 6 & 3 ))" },
];

describe("checkBackground: refuse and allow table", () => {
  for (const row of ROWS) {
    it(`${row.id} ${row.deny ? "refuses" : "allows"}: ${row.note}`, () => {
      const r = guard.checkBackground(row.cmd);
      expect(r.block).toBe(row.deny);
      if (row.deny) expect(r.kind).toBe(row.kind);
      else expect(r.reason).toBe("");
    });
  }
  it("never throws on odd input", () => {
    for (const input of [undefined, null, 5, "", "&", "&&&&", "((((", "<<", "x <<EOF\n&"]) expect(() => guard.checkBackground(input)).not.toThrow();
  });
  it("a tiny work budget fails open, it does not refuse", () => {
    expect(guard.checkBackground(`${"echo a; ".repeat(5000)}sleep 1 &`, { budgetMs: -1 }).block).toBe(false);
  });
  it("the refusal is short and names run_in_background: true and Monitor", () => {
    for (const cmd of ["sleep 1 &", "nohup x"]) {
      const { reason } = guard.checkBackground(cmd);
      expect(reason).toContain("BLOCKED");
      expect(reason).toContain("run_in_background: true");
      expect(reason).toContain("Monitor");
      expect(reason.length).toBeLessThan(600);
    }
  });
  it("does not change check() (the rig-body verdict Pi and Claude share)", () => {
    expect(guard.check("sleep 1 &").block).toBe(false);
    expect(guard.check("nohup x").block).toBe(false);
  });
});

describe("hookDecision: run_in_background", () => {
  const event = (command: string, runInBackground?: unknown) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: runInBackground === undefined ? { command } : { command, run_in_background: runInBackground } });

  it("denies a background job in a foreground call", () => {
    for (const rib of [undefined, false, "true", 1]) {
      const d = guard.hookDecision(event("( swift test; echo rc=$? ) > /tmp/t.log 2>&1 &", rib));
      expect(d.output?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(d.output?.hookSpecificOutput.permissionDecisionReason).toContain("run_in_background: true");
    }
  });
  it("allows it when the call itself is run_in_background: true", () => {
    for (const cmd of ["( swift test; echo rc=$? ) > /tmp/t.log 2>&1 &", "nohup x > /tmp/f &", "x & disown"]) {
      expect(guard.hookDecision(event(cmd, true))).toEqual({ output: null, note: null });
    }
  });
  it("the rig-body refusal still wins when both apply", () => {
    const d = guard.hookDecision(event("rig send a@b \"x `y`\" &"));
    expect(d.output?.hookSpecificOutput.permissionDecisionReason).toContain("rig-body-guard BLOCKED");
  });
  it("the rig-body refusal still applies under run_in_background: true", () => {
    const d = guard.hookDecision(event("rig send a@b \"x `y`\"", true));
    expect(d.output?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("end to end: the launch hook command (sh wrapper, node, guard) on stdin", () => {
  const command = claudeRigBodyGuardGroup(guardPath).hooks[0]!.command;
  const run = (input: string) => spawnSync("/bin/sh", ["-c", command], { input, encoding: "utf8", timeout: 20_000 });
  const event = (cmd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd, ...extra } });

  it("refuses `nohup x > f &` with a deny decision, exit 0", () => {
    const r = run(event("nohup x > /tmp/f 2>&1 &"));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("bg-job-guard BLOCKED");
  });
  it("allows the same command with run_in_background: true, and `x & wait`", () => {
    for (const input of [event("nohup x > /tmp/f 2>&1 &", { run_in_background: true }), event("x & wait")]) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});

describe("Pi is out of scope", () => {
  it("the Pi extension does not refuse a background job", async () => {
    let handler: ((e: unknown) => Promise<unknown>) | undefined;
    piExtension({ on: (_event, h) => { handler = h; } });
    expect(await handler!({ toolName: "bash", input: { command: "sleep 30 &" } })).toBeUndefined();
  });
});
