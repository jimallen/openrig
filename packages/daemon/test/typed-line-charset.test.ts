import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { NodeCmuxService } from "../src/domain/node-cmux-service.js";
import { CmuxLayoutService } from "../src/domain/cmux-layout-service.js";
import { setDaemonTmuxServer } from "../src/adapters/tmux-server.js";
import { stageCmuxLine } from "../src/adapters/cmux-typed-line.js";
import type { TmuxFileOps, TmuxAdapter } from "../src/adapters/tmux.js";

// OF-75 and OF-67. The daemon types lines into panes and terminals, and records the resume tokens and session
// names those lines are built from. Production consequences pinned here:
//   - a session name or resume token outside [A-Za-z0-9._@-] never reaches a pane through the resume probe;
//   - a token an adapter reported, the sidecar held, or a restore resumed is not stored unless well-formed, because
//     the next restore and the next probe type it back into a pane;
//   - a claimed session cannot carry a name that is more than one shell word;
//   - cmux surfaces get staged scripts for any line that is not one widget-safe line, and quoted names.
// The recipes are restated here (not imported): the typed-word set, the staged-script shape, the shell quoting.

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
});

describe("cmux surface lines are staged or quoted (OF-67)", () => {
  // Staged scripts are run for real under /bin/sh with fake `rig` and `tmux` on PATH that record their argv, so
  // "cannot inject" is observed as what executed, not as a string comparison.
  let sandbox: string;
  beforeEach(() => {
    sandbox = fs.mkdtempSync(nodePath.join(os.tmpdir(), "of67-run-"));
    fs.mkdirSync(nodePath.join(sandbox, "bin"));
    for (const tool of ["rig", "tmux"]) {
      const path = nodePath.join(sandbox, "bin", tool);
      fs.writeFileSync(path, `#!/bin/sh\n{ printf '%s\\0' ${tool} "$@"; printf '\\001'; } >> "${sandbox}/calls.log"\n`, { mode: 0o755 });
    }
  });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });
  function runStaged(script: string): string[][] {
    const file = nodePath.join(sandbox, "script.sh");
    fs.writeFileSync(file, script);
    execFileSync("/bin/sh", [file], { env: { PATH: `${nodePath.join(sandbox, "bin")}:/usr/bin:/bin` }, cwd: sandbox, stdio: "pipe" });
    const log = fs.existsSync(nodePath.join(sandbox, "calls.log")) ? fs.readFileSync(nodePath.join(sandbox, "calls.log"), "utf8") : "";
    return log.split("\u0001").filter((l) => l.length > 0).map((l) => l.split("\0").slice(0, -1));
  }

  function fileOps(opts: { writeFails?: boolean } = {}) {
    const files = new Map<string, string>();
    const unlinked: string[] = [];
    let n = 0;
    const ops: TmuxFileOps = {
      tmpName: () => `/tmp/of67-${n++}.txt`,
      bufferName: () => `buf${n++}`,
      writeFile: vi.fn(async (path: string, content: string) => {
        if (opts.writeFails) throw new Error("EACCES: permission denied");
        files.set(path, content);
      }),
      unlink: vi.fn(async (path: string) => { unlinked.push(path); }),
    };
    return { ops, files, unlinked };
  }
  const STAGED = /^\/bin\/sh \/tmp\/of67-\d+\.txt\n$/;

  describe("stageCmuxLine", () => {
    it("types a single widget-safe line as it stands and writes no file", async () => {
      const f = fileOps();
      const staged = await stageCmuxLine("tmux attach -t dev-impl@rig-1", f.ops);
      expect(staged.line).toBe("tmux attach -t dev-impl@rig-1");
      expect(f.files.size).toBe(0);
    });

    it.each([
      ["a single quote", "tmux attach -t 'a b'"],
      ["a double quote", 'echo "x"'],
      ["a bracket", "echo [x]"],
      ["a parenthesis", "echo (x)"],
      ["a brace", "echo {x}"],
      ["a backtick", "echo `x`"],
    ])("stages a line holding %s: only `/bin/sh <path>` is typed, the line stays in the script", async (_label, line) => {
      const f = fileOps();
      const staged = await stageCmuxLine(line, f.ops);
      expect(`${staged.line}\n`).toMatch(STAGED);
      expect(f.files.get(staged.line.slice("/bin/sh ".length))).toBe(`/bin/rm -f -- ${staged.line.slice("/bin/sh ".length)}\n${line}\n`);
    });

    it.each(["echo a\nrm -rf x", "echo a\rrm -rf x"])("stages a line holding a line break (it would run as two commands)", async (line) => {
      const f = fileOps();
      const staged = await stageCmuxLine(line, f.ops);
      expect(`${staged.line}\n`).toMatch(STAGED);
      expect(staged.line).not.toMatch(/[\r\n]/);
    });

    it("stages a line over the 512-byte terminal bound", async () => {
      const f = fileOps();
      const staged = await stageCmuxLine(`echo ${"a".repeat(600)}`, f.ops);
      expect(`${staged.line}\n`).toMatch(STAGED);
    });

    it("writes the script private (0600) and exclusive, so a planted file at the path is never followed", async () => {
      const f = fileOps();
      await stageCmuxLine("echo 'x'", f.ops);
      expect(f.ops.writeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/of67-/), expect.any(String), { mode: 0o600, flag: "wx" });
    });

    it("returns an error result, and does not throw, when the script cannot be written", async () => {
      const f = fileOps({ writeFails: true });
      const staged = await stageCmuxLine("echo 'x'", f.ops);
      expect(staged.ok).toBe(false);
      if (!staged.ok) expect(staged.message).toContain("EACCES");
      // a line that needs no script is unaffected by an unwritable tmpdir
      expect((await stageCmuxLine("echo x", f.ops)).ok).toBe(true);
    });

    it("discard removes the staged script, and does nothing for an unstaged line", async () => {
      const f = fileOps();
      const staged = await stageCmuxLine("echo 'x'", f.ops);
      await staged.discard();
      expect(f.unlinked).toEqual([staged.line.slice("/bin/sh ".length)]);
      const plain = await stageCmuxLine("echo x", f.ops);
      await plain.discard();
      expect(f.unlinked).toHaveLength(1);
    });
  });

  describe("node open-in-cmux", () => {
    function open(binding: Record<string, unknown>, sendOk = true, writeFails = false) {
      const sent: string[] = [];
      const adapter = {
        currentWorkspace: async () => ({ ok: true as const, data: "ws-1" }),
        createTerminalSurface: async () => ({ ok: true as const, data: "surface-1" }),
        sendText: async (_s: string, text: string) => { sent.push(text); return sendOk ? { ok: true as const, data: undefined } : { ok: false as const, code: "request_failed", message: "x" }; },
        focusSurface: async () => ({ ok: true as const, data: undefined }),
      };
      const rigRepo = { getRig: () => ({ nodes: [{ id: "n1", logicalId: "dev.impl", binding }] }) };
      const f = fileOps({ writeFails });
      const service = new NodeCmuxService(rigRepo as never, { updateBinding: vi.fn() } as never, adapter as never, undefined, f.ops);
      return { sent, f, run: () => service.openOrFocusNodeSurface("rig", "dev.impl") };
    }
    afterEach(() => { setDaemonTmuxServer([]); });

    it("types the attach line for a canonical session as it stands", async () => {
      const { sent, run } = open({ attachmentType: "tmux", tmuxSession: "dev-impl@rig-1" });
      expect((await run()).ok).toBe(true);
      expect(sent).toEqual(["tmux attach -t dev-impl@rig-1\n"]);
    });

    it("stages the attach line when the daemon's tmux server flags carry a quote-needing path, and keeps the flags", async () => {
      setDaemonTmuxServer(["-S", "/tmp/my sock/tmux.sock"]);
      const { sent, f, run } = open({ attachmentType: "tmux", tmuxSession: "dev-impl@rig-1" });
      expect((await run()).ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(STAGED);
      const script = [...f.files.values()][0]!;
      expect(script.split("\n")[1]).toBe("tmux -S '/tmp/my sock/tmux.sock' attach -t dev-impl@rig-1");
    });

    it("a session name that is more than one shell word reaches tmux as one argument and executes nothing", async () => {
      const sentinel = nodePath.join(sandbox, "owned");
      const name = `x; touch ${sentinel}`;
      const { sent, f, run } = open({ attachmentType: "tmux", tmuxSession: name });
      expect((await run()).ok).toBe(true);
      expect(sent[0]).toMatch(STAGED);
      const calls = runStaged([...f.files.values()][0]!);
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(calls).toEqual([["tmux", "attach", "-t", name]]);
    });

    it.each([
      ["attach line", { attachmentType: "tmux", tmuxSession: "x; y" }],
      ["helper console", { attachmentType: "external_cli", externalSessionName: "ext-1" }],
    ])("an unwritable script fails the open with stage_failed and types nothing (%s)", async (_label, binding) => {
      const { sent, run } = open(binding, true, true);
      const result = await run();
      expect(result.ok).toBe(false);
      expect(result.code).toBe("stage_failed");
      expect(sent).toEqual([]);
    });

    it("removes the staged attach script when the surface refuses the line", async () => {
      const { f, run } = open({ attachmentType: "tmux", tmuxSession: "x; y" }, false);
      expect((await run()).ok).toBe(false);
      expect(f.unlinked).toHaveLength(1);
    });

    it("removes the staged helper script when the surface refuses the line", async () => {
      const { f, run } = open({ attachmentType: "external_cli", externalSessionName: "ext-1" }, false);
      expect((await run()).ok).toBe(false);
      expect(f.unlinked).toHaveLength(1);
    });

    it("helper console: run for real, a hostile name is one argument to rig and executes nothing", async () => {
      const sentinel = nodePath.join(sandbox, "owned");
      const name = `ext\nrm -rf x; touch ${sentinel}; $(touch ${sentinel}) 'q'`;
      const { sent, f, run } = open({ attachmentType: "external_cli", externalSessionName: name });
      expect((await run()).ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(STAGED);
      const calls = runStaged([...f.files.values()][0]!);
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(calls).toEqual([["rig", "capture", name], ["rig", "transcript", name, "--tail", "100"]]);
    });

    it("helper console for a plain name keeps the capture and transcript commands and prints the send hint", async () => {
      const { f, run } = open({ attachmentType: "external_cli", externalSessionName: "ext-1" });
      await run();
      const script = [...f.files.values()][0]!;
      expect(script).toContain("\nrig capture ext-1\nrig transcript ext-1 --tail 100\n");
      expect(script).toContain(`printf '%s\\n' 'rig send ext-1 "..." --verify'\n`);
    });
  });

  describe("buildWorkspacePanes", () => {
    function build(commands: string[], sendOk = true, writeFails = false) {
      const sent: string[] = [];
      let surface = 0;
      const adapter = {
        createWorkspace: async () => ({ ok: true as const, data: "ws" }),
        listSurfaces: async () => ({ ok: true as const, data: [{ id: "s0", title: "", type: "terminal" }] }),
        splitSurface: async () => ({ ok: true as const, data: `s${++surface}` }),
        sendText: async (_s: string, text: string) => { sent.push(text); return sendOk ? { ok: true as const, data: undefined } : { ok: false as const, code: "request_failed", message: "x" }; },
        equalizeLayout: async () => ({ ok: true as const, data: { equalized: true } }),
        focusSurface: async () => ({ ok: true as const, data: undefined }),
      };
      const f = fileOps({ writeFails });
      const service = new CmuxLayoutService(adapter as never, { sleep: async () => {}, fileOps: f.ops });
      return { sent, f, run: () => service.buildWorkspacePanes("ws", undefined, commands) };
    }

    it("types a safe command as it stands and stages one holding quotes, keeping its text verbatim in the script", async () => {
      const { sent, f, run } = build(["tmux attach -t a@r", "ssh 'user@host' tmux attach -r -t 'b@r'"]);
      expect((await run()).ok).toBe(true);
      expect(sent[0]).toBe("tmux attach -t a@r\n");
      expect(sent[1]).toMatch(STAGED);
      expect([...f.files.values()]).toEqual([`/bin/rm -f -- /tmp/of67-0.txt\nssh 'user@host' tmux attach -r -t 'b@r'\n`]);
    });

    it("stages a caller-composed command holding a line break", async () => {
      const { sent, run } = build(["echo a\nrm -rf x"]);
      expect((await run()).ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(STAGED);
    });

    it("an unwritable script fails the build with stage_failed and types nothing for that pane", async () => {
      const { sent, run } = build(["echo 'x'"], true, true);
      const result = await run();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("stage_failed");
      expect(sent).toEqual([]);
    });

    it("removes the staged script of a pane the surface refused", async () => {
      const { f, run } = build(["echo 'x'"], false);
      expect((await run()).ok).toBe(false);
      expect(f.unlinked).toEqual(["/tmp/of67-0.txt"]);
    });
  });
});
