// OF-167: the legacy (non-pod-aware) resume adapters poll the pane and used to return "resumed" on the FIRST read that
// showed the runtime up. `claude --resume <id>` / `codex resume <id>` are the pane's foreground for the first moments
// even when the session does not exist, so a runtime that printed "No conversation found" / "No saved session found"
// right after that read counted as resumed. These rows model that clock: the runtime is up until `exitsAtMs`, then the
// pane shows what an exited runtime leaves. The injected `sleep` is the only thing that advances the clock, so a check
// that never waits cannot see the exit. Process listings are injected; nothing reads the host's ps or tmux.
import { describe, expect, it, vi } from "vitest";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessLister, NativeProcessRow } from "../src/domain/native-process-lineage.js";

const T0 = "Wed Oct 28 08:00:00 2026";
const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow =>
  ({ pid, ppid, pgid: ppid === 1 ? pid : 100, tpgid: 101, executableName, command, startedAt: T0 });

// Claude (measured on the Mac): pane zsh -> claude.exe (argv0 `claude`).
const CLAUDE_PANE = row(100, 1, "zsh", "-zsh");
const CLAUDE_TREE = [CLAUDE_PANE, row(102, 100, "claude.exe", "claude --permission-mode acceptEdits --resume tok-1")];
// Codex (measured on Sparky): pane shell -> sh /tmp/openrig-tmux-send-....txt -> node .../codex -> codex.
const CODEX_PANE = row(100, 1, "bash", "-bash");
const CODEX_TREE = [CODEX_PANE,
  row(101, 100, "sh", "sh /tmp/openrig-tmux-send-4242-0b8c9d3e-1111-4222-8333-444455556666.txt"),
  row(102, 101, "node", "node /home/u/.nvm/versions/node/v22/bin/codex resume tok-1"),
  row(103, 102, "codex", "/home/u/lib/node_modules/@openai/codex/vendor/codex/codex resume tok-1")];

const CLAUDE_TUI = "Claude Code v2.1.220\n❯ \n? for shortcuts";
const CODEX_TUI = "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything";
const CLAUDE_MISSING = "No conversation found with session ID fe08b428-e2c5-49da-ad48-ea8d604e99c3\n$ ";
const CODEX_MISSING = "No saved session found with ID 019a-tok\n$ ";

interface Clock { elapsed: number; sleeps: number[]; sleep: (ms: number) => Promise<void> }
const clock = (): Clock => {
  const c: Clock = { elapsed: 0, sleeps: [], sleep: async (ms) => { c.sleeps.push(ms); c.elapsed += ms; } };
  return c;
};

/** The runtime is the foreground (`upCommand`, `upPane`) until `exitsAtMs`; afterwards the pane shows `afterPane` under `afterCommand`. */
function tmuxFor(c: Clock, o: { exitsAtMs: number; upCommand: string; upPane: string; afterCommand: string; afterPane: string; panePid?: number | null }): TmuxAdapter {
  const up = () => c.elapsed < o.exitsAtMs;
  return mockShellCommand(Object.assign(new TmuxAdapter(async () => ""), {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => up() ? o.upCommand : o.afterCommand),
    capturePaneContent: vi.fn(async () => up() ? o.upPane : o.afterPane),
    getPanePid: vi.fn(async () => o.panePid === undefined ? 100 : o.panePid),
  }));
}

describe("OF-167: ClaudeResumeAdapter believes 'resumed' only if Claude is still there after the settle window", () => {
  const resume = (c: Clock, tmux: TmuxAdapter, listProcesses: NativeProcessLister, opts: { settleMs?: number } = {}) =>
    new ClaudeResumeAdapter(tmux, { sleep: c.sleep, listProcesses, ...opts }).resume("seat", "claude_id", "tok-1", "/repo");

  it("Claude up at the first read, then prints 'No conversation found' and leaves: retry_fresh with the native reason, never resumed", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: CLAUDE_MISSING });
    const result = await resume(c, tmux, async () => [CLAUDE_PANE]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Claude resume failed: no conversation found for the requested session" });
  });

  it("Claude up at the first read, then falls back to its shell without a native message: retry_fresh, 'pane returned to shell'", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: "$ " });
    const result = await resume(c, tmux, async () => [CLAUDE_PANE]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Claude resume failed: pane returned to shell instead of entering Claude" });
  });

  it("the default settle window is 2500 ms, taken before the verdict", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "claude", afterPane: CLAUDE_TUI });
    expect(await resume(c, tmux, async () => CLAUDE_TREE)).toMatchObject({ ok: true });
    expect(c.sleeps).toEqual([2500]);
  });

  it("control: Claude still up after the window is resumed, with no warnings", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "claude", afterPane: CLAUDE_TUI });
    const result = await resume(c, tmux, async () => CLAUDE_TREE);
    expect(result).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "claude-code" }) });
  });

  // The phrase also appears in a healthy pane whose repainted history mentions it; the process tree decides.
  it.each(["claude", "zsh", "bash", "sh"])("a live Claude (foreground %s) whose repainted history contains the phrase is NOT failed", async (foreground) => {
    const c = clock();
    const history = `Claude Code v2.1.220\n> we saw: ${CLAUDE_MISSING}\n❯ \n? for shortcuts`;
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: foreground, afterPane: history });
    expect(await resume(c, tmux, async () => CLAUDE_TREE)).toMatchObject({ ok: true });
  });

  it.each([
    ["a listing that lacks the pane's pid", async () => [row(102, 100, "claude.exe", "claude --resume tok-1")]],
    ["a listing that cannot be read", async (): Promise<NativeProcessRow[]> => { throw new Error("ps unavailable"); }],
    ["an empty listing", async (): Promise<NativeProcessRow[]> => []],
  ])("%s is unreadable, not proof that Claude is gone: still resumed, with a warning", async (_name, listProcesses) => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: CLAUDE_MISSING });
    const result = await resume(c, tmux, listProcesses);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be read at the settle check");
  });

  // N1: the screen wins over the command in the probe, so an exited Claude's drawn TUI above a shell prompt reads as
  // "resumed". A shell-named foreground is therefore checked against the process tree whatever the text says.
  it("Claude exits for some other reason and leaves its TUI above a shell prompt: retry_fresh, not held", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: `${CLAUDE_TUI}\n$ ` });
    const result = await resume(c, tmux, async () => [CLAUDE_PANE]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Claude resume failed: pane returned to shell instead of entering Claude" });
  });

  it("a live Claude under a shell-named foreground (TUI on screen) is held, with no warning", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: CLAUDE_TUI });
    const result = await resume(c, tmux, async () => CLAUDE_TREE);
    expect(result).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "claude-code" }) });
  });

  it("a shell-named foreground whose listing cannot be read keeps the resume with a warning", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "zsh", afterPane: CLAUDE_TUI });
    const result = await resume(c, tmux, async (): Promise<NativeProcessRow[]> => { throw new Error("ps unavailable"); });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be read at the settle check");
  });

  // N5: two empty reads are an unreadable pane, not a pane with nothing wrong.
  it("both the pane command and the capture empty at the settle read: kept, with an unreadable warning", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "", afterPane: "" });
    const result = await resume(c, tmux, async () => CLAUDE_TREE);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be read at the settle check");
  });

  it("control: an empty capture alone (the command is readable) is not an unreadable pane", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "claude", afterPane: "" });
    expect(await resume(c, tmux, async () => CLAUDE_TREE)).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "claude-code" }) });
  });

  it("an unreadable pane (the settle read throws) is a warning, not a failure", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "claude", afterPane: CLAUDE_TUI });
    let reads = 0;
    const base = tmux.getPaneCommand;
    tmux.getPaneCommand = vi.fn(async (t: string) => { if (c.elapsed > 0 && ++reads > 0) throw new Error("tmux gone"); return base.call(tmux, t); });
    const result = await resume(c, tmux, async () => CLAUDE_TREE);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be re-checked after launch: tmux gone");
  });

  it("a provider prompt that appeared during the window is attention_required with the pane tail", async () => {
    const c = clock();
    const bypass = "WARNING: Claude Code running in Bypass Permissions mode.\n\n❯ No, exit\nYes, I accept\n\nEnter to confirm · Esc to cancel";
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "claude", upPane: CLAUDE_TUI, afterCommand: "claude", afterPane: bypass });
    const result = await resume(c, tmux, async () => CLAUDE_TREE);
    expect(result).toMatchObject({ ok: false, code: "attention_required", evidence: expect.stringContaining("Bypass Permissions") });
  });

  it("a resume the poll itself could not confirm is untouched by the settle (no settle sleep)", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 0, upCommand: "claude", upPane: "", afterCommand: "zsh", afterPane: CLAUDE_MISSING });
    const result = await resume(c, tmux, async () => [CLAUDE_PANE]);
    expect(result).toMatchObject({ ok: false, code: "retry_fresh" });
    expect(c.sleeps).not.toContain(2500);
  });
});

describe("OF-167: CodexResumeAdapter believes 'resumed' only if Codex is still there after the settle window", () => {
  const resume = (c: Clock, tmux: TmuxAdapter, listProcesses: NativeProcessLister) =>
    new CodexResumeAdapter(tmux, { sleep: c.sleep, listProcesses }).resume("seat", "codex_id", "tok-1", "/repo");

  it("Codex up at the first read, then prints 'No saved session found' and leaves: retry_fresh, never resumed", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "bash", afterPane: CODEX_MISSING });
    const result = await resume(c, tmux, async () => [CODEX_PANE]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Codex resume failed: no saved session found for the requested token" });
  });

  it("Codex up at the first read, then falls back to its shell without a message: retry_fresh, 'pane returned to shell'", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "bash", afterPane: "$ " });
    const result = await resume(c, tmux, async () => [CODEX_PANE, CODEX_TREE[1]!]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Codex resume failed: pane returned to shell instead of entering Codex" });
  });

  it("the default settle window is 2500 ms", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "node", afterPane: CODEX_TUI });
    expect(await resume(c, tmux, async () => CODEX_TREE)).toMatchObject({ ok: true });
    expect(c.sleeps).toEqual([2500]);
  });

  // The measured shape: the foreground name is the launcher shell, never codex.
  it.each(["sh", "bash"])("the measured tree (foreground %s, sh launcher -> node codex -> codex) whose history mentions the phrase is NOT failed", async (foreground) => {
    const c = clock();
    const history = `OpenAI Codex (v0.0.0)\n> we saw: ${CODEX_MISSING}\n› Ask Codex to do anything`;
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: foreground, afterPane: history });
    expect(await resume(c, tmux, async () => CODEX_TREE)).toMatchObject({ ok: true });
  });

  it("control: Codex still up after the window is resumed, with no warnings", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "node", afterPane: CODEX_TUI });
    expect(await resume(c, tmux, async () => CODEX_TREE)).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "codex" }) });
  });

  it.each([
    ["a listing that lacks the pane's pid", async () => CODEX_TREE.slice(1)],
    ["a listing that cannot be read", async (): Promise<NativeProcessRow[]> => { throw new Error("ps unavailable"); }],
    ["an empty listing", async (): Promise<NativeProcessRow[]> => []],
  ])("%s is unreadable, not proof that Codex is gone: still resumed, with a warning", async (_name, listProcesses) => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "bash", afterPane: CODEX_MISSING });
    const result = await resume(c, tmux, listProcesses);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be read at the settle check");
  });

  it("Codex exits for some other reason and leaves its TUI above a shell prompt: retry_fresh, not held", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "bash", afterPane: `${CODEX_TUI}\n$ ` });
    const result = await resume(c, tmux, async () => [CODEX_PANE, CODEX_TREE[1]!]);
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Codex resume failed: pane returned to shell instead of entering Codex" });
  });

  it("a live Codex under a shell-named foreground (TUI on screen) is held, with no warning", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "sh", afterPane: CODEX_TUI });
    expect(await resume(c, tmux, async () => CODEX_TREE)).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "codex" }) });
  });

  it("both the pane command and the capture empty at the settle read: kept, with an unreadable warning", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "", afterPane: "" });
    const result = await resume(c, tmux, async () => CODEX_TREE);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join("\n")).toContain("could not be read at the settle check");
  });

  // codex_last carries no token; the settle does not depend on one.
  it("a `codex_last` resume (no token) that prints 'No saved session found' after the first read is retry_fresh too", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "bash", afterPane: CODEX_MISSING });
    const result = await new CodexResumeAdapter(tmux, { sleep: c.sleep, listProcesses: async () => [CODEX_PANE] }).resume("seat", "codex_last", null, "/repo");
    expect(result).toEqual({ ok: false, code: "retry_fresh", message: "Codex resume failed: no saved session found for the requested token" });
  });

  it("control: a `codex_last` resume whose Codex stays up is resumed after the window", async () => {
    const c = clock();
    const tmux = tmuxFor(c, { exitsAtMs: 60_000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "node", afterPane: CODEX_TUI });
    const result = await new CodexResumeAdapter(tmux, { sleep: c.sleep, listProcesses: async () => CODEX_TREE }).resume("seat", "codex_last", null, "/repo");
    expect(result).toMatchObject({ ok: true });
    expect(c.sleeps).toContain(2500);
  });

  it("a Codex auth refusal that appeared during the window is attention_required", async () => {
    const c = clock();
    const refusal = "Your access token could not be refreshed because your refresh token was already used.\nPlease log out and sign in again.";
    const tmux = tmuxFor(c, { exitsAtMs: 1000, upCommand: "node", upPane: CODEX_TUI, afterCommand: "node", afterPane: refusal });
    const result = await resume(c, tmux, async () => CODEX_TREE);
    expect(result).toMatchObject({ ok: false, code: "attention_required" });
  });
});
