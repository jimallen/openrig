// OF-161: is Claude running under this pane, whatever the pane's foreground name says? Fixtures are the shapes measured
// live (2026-10-28): pane_pid `-zsh` -> claude (ucomm `claude` on Linux, `claude.exe` on macOS; argv0 `claude`), whose
// children are codebase-memory-mcp, caffeinate and `node .../pyright-langserver`.
import { describe, expect, it } from "vitest";
import { claudePaneOccupancy, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const T0 = "Wed Oct 28 08:00:00 2026";
const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow =>
  ({ pid, ppid, pgid: ppid === 1 ? pid : 100, tpgid: 100, executableName, command, startedAt: T0 });
const PANE = row(100, 1, "zsh", "-zsh");
const CHILDREN = (parent: number): NativeProcessRow[] => [
  row(103, parent, "codebase-memory-m", "/Users/u/.local/bin/codebase-memory-mcp"),
  row(104, parent, "caffeinate", "caffeinate -i -t 3600"),
  row(105, parent, "node", "node /Users/u/.npm/_npx/abc/node_modules/.bin/pyright-langserver --stdio"),
];
const occupancy = (rows: NativeProcessRow[]) =>
  claudePaneOccupancy({ target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => rows });

describe("claudePaneOccupancy", () => {
  it.each(["claude", "claude.exe"])("the live tree (comm %s, argv0 claude, with its MCP/caffeinate/pyright children): present", async (comm) => {
    const claude = row(102, 100, comm, "claude --permission-mode auto --resume tok-1 --name seat@rig");
    expect(await occupancy([PANE, claude, ...CHILDREN(102)])).toBe("present");
  });

  it("the same tree without the claude row (its children left behind): absent", async () => {
    expect(await occupancy([PANE, ...CHILDREN(102)])).toBe("absent");
    expect(await occupancy([PANE, ...CHILDREN(1)])).toBe("absent");
  });

  // Each name test stands alone: a row only that one test accepts.
  it("recognised by ucomm alone (argv0 is a wrapper's)", async () => {
    expect(await occupancy([PANE, row(102, 100, "claude.exe", "/usr/bin/env FOO=1 launcher --x")])).toBe("present");
  });
  it("recognised by argv0 alone (ucomm is something else)", async () => {
    expect(await occupancy([PANE, row(102, 100, "bun", "claude --resume tok-1")])).toBe("present");
  });
  it("recognised by a versioned native binary label alone", async () => {
    expect(await occupancy([PANE, row(102, 100, "2.1.311", "/opt/x/2.1.311 --permission-mode auto")])).toBe("present");
  });
  it("an npm install (`node .../claude-code/cli.js`) is recognised by an argv path", async () => {
    expect(await occupancy([PANE, row(102, 100, "node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume tok-1")])).toBe("present");
  });
  it("a flag value far down the argv that mentions claude is not a Claude process", async () => {
    expect(await occupancy([PANE, row(102, 100, "node", "node /srv/tool.js --mode fast --config /home/u/.claude/settings.json")])).toBe("absent");
  });

  it("a Claude that is not under the pane is not this pane's", async () => {
    expect(await occupancy([PANE, row(900, 1, "claude", "claude --resume other")])).toBe("absent");
  });
  it.each([
    ["a listing without the pane's pid", [row(102, 100, "claude", "claude")]],
    ["an empty listing", []],
  ])("%s is unobservable", async (_name, rows) => {
    expect(await occupancy(rows)).toBe("unobservable");
  });
  it("a listing that throws, and a pane with no pid, are unobservable", async () => {
    expect(await claudePaneOccupancy({ target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => { throw new Error("ps"); } })).toBe("unobservable");
    expect(await claudePaneOccupancy({ target: "%1", tmux: { getPanePid: async () => null }, listProcesses: async () => [PANE] })).toBe("unobservable");
  });
});
