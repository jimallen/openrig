import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { tmuxAttachCommand } from "../src/adapters/tmux-server.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";

// Every command line OpenRig types into a pane shell is TYPED: a keystroke-rewriting line-editor
// widget (zsh-autopair inserts the closer for each opener) sees it. A launch whose typed line is
// rewritten ends in a parse error and the harness never starts (OF-64: `( . file )` became
// `( . file ) )`). These rows pin the production consequence for each path that types a command:
// what reaches the pane is only `. <path>` or `/bin/sh <path>` with a path of plain characters.
//
// The recipe is restated here on purpose (not imported from the module it pins): the characters an
// autopair widget rewrites, and the typed shape.
const WIDGET_CHARS = ["(", ")", "[", "]", "{", "}", '"', "'", "`"];
const TYPED_SHAPE = /^(\. |\/bin\/sh )\/[A-Za-z0-9_./-]+$/;

function harness(paneShell = "zsh") {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  let n = 0;
  const fileOps: TmuxFileOps = {
    tmpName: () => `/tmp/of65-${n++}.txt`,
    bufferName: () => `buf${n++}`,
    writeFile: vi.fn(async (path, content) => { writes.push({ path, content }); }),
    unlink: vi.fn(async () => {}),
  };
  const exec = vi.fn(async (command: string) => {
    commands.push(command);
    if (command.includes("#{pane_current_command}")) return paneShell;
    if (command.includes("capture-pane")) return "user@host % ";
    return "";
  });
  const tmux = new TmuxAdapter(exec, fileOps);
  /** The text each load-buffer put in front of the pane shell: the typed bytes. */
  const typed = (): string[] => commands.flatMap(command => {
    const m = /load-buffer -b '[^']*' '([^']*)'/.exec(command);
    return m ? [writes.find(w => w.path === m[1])!.content] : [];
  });
  const sendKeysArgs = (): string[] => commands.flatMap(command => {
    const m = /send-keys -t '[^']*' (.*)$/.exec(command);
    return m ? [m[1]!] : [];
  });
  const scriptFor = (typedLine: string): string => {
    const path = typedLine.split(" ").at(-1)!;
    // A sourced script holds the command in a second file the subshell sources.
    return (writes.find(w => w.path === `${path}.cmd`) ?? writes.find(w => w.path === path)!).content;
  };
  return { tmux, typed, sendKeysArgs, scriptFor, commands };
}

function expectOnlySafeTyping(h: ReturnType<typeof harness>, shape = TYPED_SHAPE) {
  const typed = h.typed();
  expect(typed.length).toBeGreaterThan(0);
  for (const line of typed) {
    expect(line).toMatch(shape);
    for (const c of WIDGET_CHARS) expect(line).not.toContain(c);
  }
  // No key chord carries text: exactly one Enter per typed line, and nothing else, is sent as a key.
  expect(h.sendKeysArgs()).toEqual(typed.map(() => "'Enter'"));
}

const binding = (over: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b", nodeId: "n", tmuxSession: "seat@rig", tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null,
  updatedAt: "", cwd: "/work", ...over,
} as NodeBinding);

describe("typed command lines are safe from keystroke-rewriting widgets (OF-65)", () => {
  describe("sendShellCommand stageIfLong (pi / omp runner commands)", () => {
    const piCommand = `node '/opt/rig/pi-runner.js' --cwd '/work dir' --model 'm (x)' --session '[tok]'`;

    it("stages a short quoted runner command so only `/bin/sh <path>` is typed", async () => {
      const h = harness();
      expect(Buffer.byteLength(piCommand)).toBeLessThanOrEqual(512);
      expect(await h.tmux.sendShellCommand("seat@rig", piCommand, undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
      expectOnlySafeTyping(h);
      expect(h.scriptFor(h.typed()[0]!)).toContain(`exec ${piCommand}\n`);
    });

    it.each(WIDGET_CHARS)("stages a short command holding only %s", async char => {
      const h = harness();
      const command = `runner a${char}b`;
      expect(await h.tmux.sendShellCommand("seat@rig", command, undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
      expectOnlySafeTyping(h);
    });

    it("control: a short command with no widget character is still typed as it stands", async () => {
      const h = harness();
      const command = "node /opt/rig/pi-runner.js --cwd /work --model m";
      expect(await h.tmux.sendShellCommand("seat@rig", command, undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
      expect(h.typed()).toEqual([command]);
    });
  });

  describe("claude-code fallback without a seat launch environment", () => {
    const adapter = (h: ReturnType<typeof harness>) => new ClaudeCodeAdapter({
      tmux: h.tmux, listProcesses: async () => [], sleep: async () => {}, sessionIdFactory: () => "11111111-1111-4111-8111-111111111111",
    } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);

    it.each([
      ["fresh launch", { name: "seat" }],
      ["resume", { name: "seat", resumeToken: "tok'en" }],
      ["fork", { name: "seat", forkSource: { kind: "native_id", value: "parent'id" } }],
    ])("%s types only the staged-script source line", async (_label, opts) => {
      const h = harness();
      await adapter(h).launchHarness(binding(), opts as never);
      expectOnlySafeTyping(h, /^\. \/tmp\/of65-\d+\.txt$/);
      expect(h.scriptFor(h.typed()[0]!)).toContain("claude ");
    });
  });

  describe("claude-resume fallback without a seat launch environment", () => {
    it("types only the staged-script source line", async () => {
      const h = harness();
      await new ClaudeResumeAdapter(h.tmux, { sleep: async () => {} }).resume("seat@rig", "claude_id", "tok'en (1)", "/work").catch(() => undefined);
      expectOnlySafeTyping(h, /^\. \/tmp\/of65-\d+\.txt$/);
      expect(h.scriptFor(h.typed()[0]!)).toContain("--resume 'tok'\"'\"'en (1)'");
    });
  });

  describe("stub runner launch", () => {
    it("types only `/bin/sh <path>`, the runner command stays in the script", async () => {
      const h = harness();
      const stub = new StubRuntimeAdapter({
        tmux: h.tmux, runtime: "stub", runnerEntryPath: "/opt/rig/stub (runner).js", sleep: async () => {},
        fsOps: { exists: () => true, readFile: () => { throw new Error("no sidecar"); }, writeFile: () => {}, mkdirp: () => {} },
      });
      await stub.launchHarness(binding({ cwd: "/work [x]" }), { name: "seat" });
      expectOnlySafeTyping(h, /^\/bin\/sh \/tmp\/of65-\d+\.txt$/);
      // The staged script replaces its shell with the runner, as the Pi runner's does.
      expect(h.scriptFor(h.typed()[0]!)).toContain("exec node '/opt/rig/stub (runner).js'");
    });
  });

  describe("resume-metadata refresher claude probe", () => {
    it("types only the staged-script source line into the probe session", async () => {
      const h = harness();
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry: {} as unknown as SessionRegistry, tmuxAdapter: h.tmux, sleep: async () => {}, homeDir: "/tmp",
      });
      await (refresher as unknown as { defaultProbeClaudeResume(s: string, t: string, c: string): Promise<string> })
        .defaultProbeClaudeResume("seat@rig", "tok-1", "/tmp");
      expectOnlySafeTyping(h, /^\. \/tmp\/of65-\d+\.txt$/);
      expect(h.scriptFor(h.typed()[0]!)).toContain("claude --resume 'tok-1' --name 'seat@rig'");
    });
  });

  describe("cmux attach line (typed through the cmux transport, not staged)", () => {
    it("holds no widget character for a canonical session name on the default tmux server", () => {
      const line = tmuxAttachCommand("dev-impl@rig-1");
      expect(line).toBe("tmux attach -t dev-impl@rig-1");
      for (const c of WIDGET_CHARS) expect(line).not.toContain(c);
    });
  });
});
