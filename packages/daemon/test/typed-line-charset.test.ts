import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { setDaemonTmuxServer, shellWord } from "../src/adapters/tmux-server.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// OF-75. The daemon types lines into panes and terminals, and records the resume tokens and session
// names those lines are built from. Production consequences pinned here:
//   - a session name or resume token outside [A-Za-z0-9._@-] never reaches a pane through the resume probe;
//   - a token an adapter reported, the sidecar held, or a restore resumed is not stored unless well-formed, because
//     the next restore and the next probe type it back into a pane;
//   - a claimed session cannot carry a name that is more than one shell word;
// The recipes are restated here (not imported): the typed-word set, the shell quoting.

const HOSTILE = [
  ["a shell separator", "tok;touch-x"],
  ["a space", "tok en"],
  ["a single quote", "tok'x"],
  ["a double quote", 'tok"x'],
  ["a command substitution", "$(touch-x)"],
  ["a backtick", "`touch-x`"],
  ["a newline", "tok\nx"],
  ["a pipe", "tok|x"],
  ["a glob", "tok*"],
  ["a slash", "tok/x"],
] as const;

describe("resume probe types only shell-inert words (OF-75)", () => {
  function probeWith(sessionName: string, token: string) {
    let typed = false;
    const tmux = {
      createSession: vi.fn(async () => ({ ok: true as const })),
      sendText: vi.fn(async () => { typed = true; return { ok: true as const }; }),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      // A shell until the line is typed, then claude: the probe reaches its verdict.
      getPaneCommand: vi.fn(async () => (typed ? "claude" : "zsh")),
      capturePaneContent: vi.fn(async () => (typed ? "" : "user@host % ")),
      killSession: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
    };
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry: {} as unknown as SessionRegistry, tmuxAdapter: tmux as unknown as TmuxAdapter, sleep: async () => {}, homeDir: "/tmp",
    }) as unknown as { defaultProbeClaudeResume(s: string, t: string, c: string): Promise<string> };
    return { tmux, result: refresher.defaultProbeClaudeResume(sessionName, token, "/tmp") };
  }

  it.each([
    ["a token of 201 characters", "seat@rig", "t".repeat(201)],
    ["a seat name of 201 characters", `${"s".repeat(199)}@r`, "tok-1"],
  ])("%s is inconclusive and nothing is created or typed (OF-108)", async (_label, name, token) => {
    const { tmux, result } = probeWith(name, token);
    expect(await result).toBe("inconclusive");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("control: a token and a seat name of exactly 200 characters are typed (OF-108)", async () => {
    const { tmux, result } = probeWith(`${"s".repeat(198)}@r`, "t".repeat(200));
    await result;
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(HOSTILE)("a token holding %s is inconclusive and nothing is created or typed", async (_label, token) => {
    const { tmux, result } = probeWith("seat@rig", token);
    expect(await result).toBe("inconclusive");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it.each(HOSTILE)("a seat name holding %s is inconclusive and nothing is created or typed", async (_label, name) => {
    const { tmux, result } = probeWith(name, "tok-1");
    expect(await result).toBe("inconclusive");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each(["dev-impl@my-rig", "r01-dev1.impl_2", "0f8fad5b-d9cb-469f-a165-70867728950e"])(
    "control: the typed-word set admits %s (the probe reaches the pane)", async (word) => {
      const { tmux, result } = probeWith(word.includes("@") || word.startsWith("r01") ? word : "seat@rig", word.includes("@") || word.startsWith("r01") ? "tok-1" : word);
      await result;
      expect(tmux.createSession).toHaveBeenCalledTimes(1);
      expect(tmux.sendText).toHaveBeenCalledTimes(1);
    });
});

describe("sidecar token fill stores only a well-formed token (OF-75)", () => {
  function fill(sessionId: unknown) {
    const sessionRegistry = { isForkClaimingHeldToken: vi.fn(() => false), updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPaneCommand: vi.fn(async () => "claude") } as unknown as TmuxAdapter,
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: sessionId } }) },
    });
    return { sessionRegistry, run: () => refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]) };
  }

  it.each(HOSTILE)("a sidecar session id holding %s is not written", async (_label, token) => {
    const { sessionRegistry, run } = fill(token);
    await run();
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("control: a well-formed sidecar session id is written trimmed, as scrape", async () => {
    const { sessionRegistry, run } = fill("  abc-123_x.y  ");
    await run();
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-c", "claude_id", "abc-123_x.y", "scrape");
  });
});

describe("the codex thread id read from a live process is stored only when well-formed (OF-108)", () => {
  // The id comes from Codex's own logs database, and the next restore types it back into a pane
  // (`codex resume '<id>'`), so the census write is held to the same format as every other observed token.
  function census(threadId: string) {
    const sessionRegistry = { isForkClaimingHeldToken: vi.fn(() => false), updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPanePid: vi.fn(async () => 100) } as unknown as TmuxAdapter,
      listProcesses: async () => [{ pid: 100, ppid: 1, command: "-zsh" }, { pid: 200, ppid: 100, command: "codex --no-alt-screen" }],
      readCodexThreadIdByPid: async () => threadId,
      sleep: async () => {},
    });
    return { sessionRegistry, run: () => refresher.refresh([
      { sessionId: "sess-x", sessionName: "seat@rig", runtime: "codex", resumeType: null, resumeToken: null },
    ]) };
  }

  it.each(HOSTILE)("a thread id holding %s is not written", async (_label, id) => {
    const { sessionRegistry, run } = census(id);
    await run();
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("a thread id past 200 characters is not written", async () => {
    const { sessionRegistry, run } = census("a".repeat(201));
    await run();
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("control: a well-formed thread id is written trimmed, as scrape", async () => {
    const { sessionRegistry, run } = census("  019a-bc12_x.y  ");
    await run();
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-x", "codex_id", "019a-bc12_x.y", "scrape");
  });
});

describe("a claimed session name is one shell word (OF-75)", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let nodeId: string;
  beforeEach(() => {
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    const repo = new RigRepository(db);
    nodeId = repo.addNode(repo.createRig("rig").id, "impl", { runtime: "claude-code" }).id;
  });
  afterEach(() => { db.close(); });
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

  it.each([
    ["a space", "my session"],
    ["a shell separator", "seat;touch-x@rig"],
    ["a quote", "seat'x@rig"],
    ["a command substitution", "$(touch-x)@rig"],
    ["a newline", "seat\nx@rig"],
    ["a colon", "bad:seat@rig"],
    ["nothing", ""],
  ])("refuses a name holding %s and records no session", (_label, name) => {
    expect(() => registry.registerClaimedSession(nodeId, name)).toThrow(/Invalid claimed session name/);
    expect(rows()).toBe(0);
  });

  it.each(["dev-impl@my-rig", "adopted-session", "r01-dev1-impl", "a.b_c-d@e"])("control: admits %s", (name) => {
    expect(registry.registerClaimedSession(nodeId, name).sessionName).toBe(name);
    expect(rows()).toBe(1);
  });

  // OF-108: the cap is restated here (200), not imported.
  it("admits a name of exactly 200 characters", () => {
    const name = `${"a".repeat(198)}@r`;
    expect(name).toHaveLength(200);
    expect(registry.registerClaimedSession(nodeId, name).sessionName).toBe(name);
  });

  it("refuses a name of 201 characters, records no session, and does not echo the whole name", () => {
    const name = `${"a".repeat(199)}@r`;
    expect(name).toHaveLength(201);
    let message = "";
    try { registry.registerClaimedSession(nodeId, name); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/Invalid claimed session name/);
    expect(message.length).toBeLessThan(200);
    expect(rows()).toBe(0);
  });

  it("truncates the echo of a long hostile name too", () => {
    const name = "a;".repeat(400);
    let message = "";
    try { registry.registerClaimedSession(nodeId, name); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/Invalid claimed session name/);
    expect(message.length).toBeLessThan(200);
  });
});

describe("the claude launch line quotes the seat name (OF-108)", () => {
  // A claude seat's launch line is parsed by the pane shell. The name is a session name (validated where a seat is
  // launched), but the adapter is the last place before the shell, so it quotes whatever it is given.
  const SEAT = "exec-cos@eztrack";
  async function sentOf(name: string, extra: { resumeToken?: string; forkSource?: { kind: "native_id"; value: string } } = {}): Promise<string> {
    const sendText = vi.fn(async (_target: string, _text: string) => ({ ok: true as const }));
    const tmux = mockShellCommand({
      sendText, hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => ""),
      createSession: vi.fn(async () => ({ ok: true as const })), killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
      getPanePid: vi.fn(async () => null), sendKeys: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter);
    const fsOps = { readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as unknown as ClaudeAdapterFsOps;
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sess-1" });
    const binding = { id: "b1", nodeId: "n1", tmuxSession: SEAT, tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: "/project" } as never;
    await adapter.launchHarness(binding, { name, ...extra });
    const calls = sendText.mock.calls;
    return calls[calls.length - 1]![1];
  }
  const HOSTILE_NAME = "x; touch /tmp/owned";

  it("fresh launch: a name that is more than one word is one quoted word after --name", async () => {
    expect(await sentOf(HOSTILE_NAME)).toMatch(/ --session-id sess-1 --name='x; touch \/tmp\/owned'$/);
  });
  it("resume launch: the same", async () => {
    expect(await sentOf(HOSTILE_NAME, { resumeToken: "tok-1" })).toMatch(/ --resume 'tok-1' --name='x; touch \/tmp\/owned'$/);
  });
  it("fork launch: the same", async () => {
    expect(await sentOf(HOSTILE_NAME, { forkSource: { kind: "native_id", value: "parent-1" } })).toMatch(/ --fork-session --session-id sess-1 --name='x; touch \/tmp\/owned'$/);
  });
  it("control: a canonical name stays bare, as the neighbouring launch pins expect", async () => {
    expect(await sentOf(SEAT)).toMatch(/ --session-id sess-1 --name=exec-cos@eztrack$/);
  });
  it("a name that starts with = is quoted (zsh would rewrite =ls to /bin/ls)", async () => {
    expect(await sentOf("=ls")).toMatch(/ --name='=ls'$/);
  });
});

describe("shellWord is a shell word for zsh and sh (OF-114)", () => {
  it("quotes a value that starts with =, and keeps = inside a word", () => {
    expect(shellWord("=ls")).toBe("'=ls'");
    expect(shellWord("a=b")).toBe("a=b");
    expect(shellWord("dev-impl@rig-1")).toBe("dev-impl@rig-1");
    expect(shellWord("a b")).toBe("'a b'");
  });

  const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((z) => fs.existsSync(z));
  it.skipIf(!zsh)("run for real under zsh: a name starting with = reaches the command as itself, not as a path", () => {
    // `zsh -fc 'echo =ls'` prints the path of ls (EQUALS expansion); the quoted word prints =ls.
    const out = execFileSync(zsh!, ["-fc", `printf '%s\\n' ${shellWord("=ls")}`], { encoding: "utf8" });
    expect(out).toBe("=ls\n");
    // Positive control: the unquoted form is rewritten, so the row above can fail.
    const unquoted = execFileSync(zsh!, ["-fc", "printf '%s\\n' =ls"], { encoding: "utf8" });
    expect(unquoted).not.toBe("=ls\n");
  });
});
