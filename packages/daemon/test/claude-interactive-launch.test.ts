import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { sessionEnvLabels } from "../src/adapters/hc-identity.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const run = promisify(execFile);
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Fixture did not return to its shell prompt");
}

// The real adapters and an hc terminal deliver to an interactive Bash with an rc-defined
// command. Claude is an offline recorder, never a provider executable. These
// controls prove command resolution/arguments, not native readiness or history.
describe.skipIf(!findHc() || !fs.existsSync("/bin/bash"))("classic Claude interactive launch", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("checks assignment, subshell/export and sourced-file alias/function effects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shell-forms-"));
    const rc = path.join(root, "bashrc"), script = path.join(root, "launch");
    const effects: Record<string, string> = {};
    try {
      // `bash -ic` on Ubuntu prints a sudo hint on stdout unless HOME (= root) has .hushlogin.
      fs.writeFileSync(path.join(root, ".hushlogin"), "");
      for (const shape of ["alias", "function"]) {
        fs.writeFileSync(rc, shape === "alias" ? "alias claude='printenv PROBE'\n" : "claude() { printenv PROBE; }\n");
        fs.writeFileSync(script, "PROBE='from launch' claude\n");
        for (const [form, command] of Object.entries({
          assignments: "PROBE='from launch' claude",
          exportSubshell: "( export PROBE='from launch'; claude )",
          sourcedSubshell: `( . ${quote(script)} )`,
        })) {
          const result = await run("/bin/bash", ["--noprofile", "--rcfile", rc, "-ic", command], {
            env: { HOME: root, PATH: "/usr/bin:/bin" }, cwd: root, timeout: 5000,
          });
          effects[`${shape}/${form}`] = result.stdout.trim();
        }
      }
      console.log("CLAUDE_SHELL_FORMS", JSON.stringify(effects));
      expect(Object.values(effects)).toEqual(Array(6).fill("from launch"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  /** True once `f` holds, false if it still does not after 5 s. */
  async function settles(f: () => boolean): Promise<boolean> {
    for (let i = 0; i < 200; i++) { if (f()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
    return false;
  }

  async function foregroundReported(name: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const terminal = await scratch.client().call<{ foreground?: { name?: string } | null }>("terminal.get", { terminal: hcTerminalName(name) });
      if (terminal.foreground?.name) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`hc never reported a foreground process for ${name}`);
  }

  // Found by this conversion. HcInput.sendShellCommand reads the pane shell from `terminal.foreground`, which hc fills in about
  // 0.4 s after the terminal starts (measured on Sparky, hc 0.1.15: absent at 0, 26 and 52 ms, present at 365 ms, three runs). Before
  // that the launch is typed as `/bin/sh <script>` instead of sourced in the pane, so a `claude` that is an alias or a function of the
  // pane's rc is "not found" (exit 127) where tmux, which knew `pane_current_command` at once, sourced it. The 36 cells below wait
  // for the foreground to be reported, which is the only reason they pass. Delete `it.fails` when the decision stops depending on it
  // (for instance a fallback to the terminal's own argv[0]).
  it.fails("sources the launch in the pane shell even when sent before hc reports a foreground process (DEFECT: race on terminal.foreground)", async (ctx) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-early-"));
    const rc = path.join(root, "bashrc"), status = path.join(root, "status");
    fs.writeFileSync(rc, `alias claude='echo ALIAS-RAN > ${quote(path.join(root, "ran"))}'\nPS1='FIXTURE> '\nPROMPT_COMMAND='printf "%s\\n" "$?" > ${status}'\n`);
    const hc = new HcAdapter(scratch.client());
    try {
      await scratch.client().call("terminal.run", {
        argv: ["/bin/bash", "--noprofile", "--rcfile", rc, "-i"], env: { HOME: root }, name: hcTerminalName("early"), labels: { [SEAT_LABEL]: "early" },
        cwd: root, no_parent: true, no_notify: true, outlive_parent: true,
      });
      expect(await settles(() => fs.existsSync(status)), "the rc reached its first prompt").toBe(true);
      const before = await scratch.client().call<{ foreground?: unknown }>("terminal.get", { terminal: hcTerminalName("early") });
      if (before.foreground) ctx.skip();  // this host reported it first: the race was not entered
      expect(await hc.sendShellCommand("early", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
      expect(await settles(() => fs.existsSync(path.join(root, "ran"))), "the launch ran the pane's alias").toBe(true);
    } finally { await hc.killSession("early"); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("starts all 36 executable/alias/function, corrected/fallback/legacy, fresh/fork/resume/restore cells", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-"));
    // The scratch core (and the interactive shells in its terminals) is armed against an owner that dies; see helpers/hc-scratch.ts.
    const transport = new HcAdapter(scratch.client());
    const fake = path.join(root, "off-path-claude"), recorder = path.join(root, "record.cjs"), cli = path.join(root, "paired-rig");
    fs.writeFileSync(recorder, `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(process.env.MARKER, JSON.stringify({argv:process.argv.slice(2), node:process.env.OPENRIG_NODE_ID,
 home:process.env.OPENRIG_HOME, userHome:process.env.HOME, config:process.env.CLAUDE_CONFIG_DIR,
 token:process.env.OPENRIG_ACTIVITY_HOOK_TOKEN, path:process.env.PATH,
 rig:cp.spawnSync('rig', [], {encoding:'utf8'}).stdout?.trim()}));\n`);
    fs.writeFileSync(fake, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(cli, "#!/bin/sh\nprintf 'paired-rig'\n", { mode: 0o755 });
    const cells: Array<{ shape: string; route: string; kind: string; started: boolean; exit: number; issues: string[] }> = [];
    try {
      for (const shape of ["executable", "alias", "function"]) for (const route of ["corrected", "fallback", "legacy"]) {
        for (const kind of ["fresh", "fork", "launch-resume", "restore-resume"]) {
          const name = `${shape}-${route}-${kind}`, dir = path.join(root, name), bin = path.join(dir, "bin");
          fs.mkdirSync(bin, { recursive: true });
          if (shape === "executable") fs.symlinkSync(fake, path.join(bin, "claude"));
          const marker = path.join(dir, "started.json"), status = path.join(dir, "status"), rc = path.join(dir, "bashrc");
          fs.writeFileSync(rc, `export PATH=${quote(bin + ":/usr/bin:/bin")} MARKER=${quote(marker)} HOME=${quote(dir)}\n`
            + `export OPENRIG_NODE_ID='rc-node' OPENRIG_HOME='rc-home' CLAUDE_CONFIG_DIR='rc-config' OPENRIG_ACTIVITY_HOOK_TOKEN='fixture-token'\nPS1='FIXTURE> '\n`
            + (shape === "alias" ? `alias claude=${quote(fake)}\n` : shape === "function" ? `claude() { ${quote(fake)} "$@"; }\n` : "")
            + `PROMPT_COMMAND='printf "%s\\n" "$?" > ${status}'\n`);
          // The launch environment the seat recorded (hc: labels written at launch, read back by getSessionEnv).
          await scratch.client().call("terminal.run", {
            argv: ["/bin/bash", "--noprofile", "--rcfile", rc, "-i"], env: { HOME: root, TMPDIR: root }, name: hcTerminalName(name),
            labels: { [SEAT_LABEL]: name, ...sessionEnvLabels({ OPENRIG_SESSION_NAME: name, ...(route === "corrected" ? { OPENRIG_NODE_ID: name } : {}) }) },
            cwd: dir, no_parent: true, no_notify: true, outlive_parent: true,
          });
          await until(() => fs.existsSync(status)); fs.unlinkSync(status);
          // hc reports a terminal's foreground process on its next sweep (about 0.4 s after the start), and sendShellCommand decides to
          // source the launch in the pane shell from it; see the it.fails below for what a launch sent before that does.
          await foregroundReported(name);
          const helper = route === "legacy" ? undefined : new SeatLaunchEnvironment(transport, {
            OPENRIG_HOME: path.join(dir, "rig-home"), HOME: "must-not-override", CLAUDE_CONFIG_DIR: "must-not-override",
            OPENRIG_ACTIVITY_HOOK_TOKEN: "must-not-type",
          }, root, cli);
          const model = route === "corrected" ? "fixture-" + "x".repeat(4096) : "fixture";
          const token = "11111111-1111-4111-8111-111111111111";
          if (kind === "restore-resume") {
            const adapter = new ClaudeResumeAdapter(transport, { seatLaunchEnvironment: helper });
            // Only the subsequent native observation is stubbed: the recorder
            // cannot establish Claude identity or continuity.
            (adapter as any).verifyResume = async () => ({ ok: false, code: "not_assessed", message: "offline recorder" });
            await adapter.resume(name, "claude_id", token, dir, "floor", model, undefined, name);
          } else {
            const adapter = new ClaudeCodeAdapter({ tmux: transport, seatLaunchEnvironment: helper,
              fsOps: { readFile: () => { throw Error("no native files"); }, writeFile: () => {}, exists: () => false,
                mkdirp: () => {}, copyFile: () => {}, readdir: () => [], homedir: dir },
              sessionIdFactory: () => "22222222-2222-4222-8222-222222222222" });
            (adapter as any).verifyResumeLaunch = async () => ({ ok: false, error: "native identity not assessed" });
            await adapter.launchHarness({ nodeId: name, id: name, tmuxSession: name, cwd: dir, model,
              launchGeneration: "1", launchPosture: "floor" } as never, { name,
              ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } }
                : kind === "launch-resume" ? { resumeToken: token } : {}) });
          }
          await until(() => fs.existsSync(status));
          const started = fs.existsSync(marker), issues: string[] = [];
          if (started) {
            const got = JSON.parse(fs.readFileSync(marker, "utf8"));
            if (got.argv[got.argv.indexOf("--model") + 1] !== model) issues.push("model argument truncated");
            if (got.userHome !== dir || got.config !== "rc-config" || got.token !== "fixture-token") issues.push("user/provider environment changed");
            if (route === "corrected") {
              if (got.node !== name || got.home !== path.join(dir, "rig-home")) issues.push("metadata not corrected");
              if (got.rig !== "paired-rig") issues.push("paired rig not selected");
              if (!got.path.endsWith(bin + ":/usr/bin:/bin")) issues.push("user PATH replaced");
            } else if (got.node !== "rc-node" || got.home !== "rc-home") issues.push("fallback/legacy environment changed");
          }
          cells.push({ shape, route, kind, started, exit: Number(fs.readFileSync(status, "utf8").trim()), issues });
          expect(await transport.killSession(name)).toEqual({ ok: true });
        }
      }
      console.log("CLAUDE_INTERACTIVE_CELLS", JSON.stringify(cells));
      expect(cells).toHaveLength(36);
      expect(cells.filter(cell => !cell.started || cell.exit !== 0 || cell.issues.length)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
