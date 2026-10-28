// OF-167: is Codex running under this pane, whatever the pane's foreground name says? The fixture is the shape measured on
// Sparky: the pane's shell -> `sh /tmp/openrig-tmux-send-<pid>-<uuid>.txt` -> `node .../codex` -> `codex`. The foreground
// name is therefore `sh` or `bash`, which proves nothing about Codex.
import { describe, expect, it } from "vitest";
import { claudePaneOccupancy, nativePaneOccupancy, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const T0 = "Wed Oct 28 08:00:00 2026";
const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow =>
  ({ pid, ppid, pgid: ppid === 1 ? pid : 100, tpgid: 101, executableName, command, startedAt: T0 });
const PANE = row(100, 1, "bash", "-bash");
const LAUNCHER = row(101, 100, "sh", "sh /tmp/openrig-tmux-send-4242-0b8c9d3e-1111-4222-8333-444455556666.txt");
const NODE = row(102, 101, "node", "node /home/u/.nvm/versions/node/v22.1.0/bin/codex resume 019a-tok --no-daemon");
const CODEX = row(103, 102, "codex", "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/codex/codex resume 019a-tok --no-daemon");
const occupancy = (rows: NativeProcessRow[], runtime: "codex" | "claude-code" = "codex") =>
  nativePaneOccupancy(runtime, { target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => rows });

describe("nativePaneOccupancy(codex)", () => {
  it("the measured tree (sh launcher -> node codex -> codex): present", async () => {
    expect(await occupancy([PANE, LAUNCHER, NODE, CODEX])).toBe("present");
  });
  it("the same tree after Codex exited (only the pane and its launcher left): absent", async () => {
    expect(await occupancy([PANE, LAUNCHER])).toBe("absent");
    expect(await occupancy([PANE])).toBe("absent");
  });

  // Each name test stands alone: a tree only that one test accepts.
  it("recognised by ucomm alone (argv names nothing)", async () => {
    expect(await occupancy([PANE, LAUNCHER, row(103, 101, "codex", "/opt/x/bin/runner --flag")])).toBe("present");
  });
  it("recognised by argv0 alone (ucomm is something else)", async () => {
    expect(await occupancy([PANE, LAUNCHER, row(103, 101, "bun", "codex resume tok")])).toBe("present");
  });
  it("the npm launcher (`node .../codex`) is recognised by an argv path alone", async () => {
    expect(await occupancy([PANE, LAUNCHER, NODE])).toBe("present");
  });
  it("a flag value far down the argv that mentions codex is not a Codex process", async () => {
    expect(await occupancy([PANE, LAUNCHER, row(102, 101, "node", "node /srv/tool.js --mode fast --config /home/u/.codex/config.toml")])).toBe("absent");
  });
  it("the launcher script's own name never counts (it outlives Codex only while the shell reaps it)", async () => {
    expect(await occupancy([PANE, LAUNCHER])).toBe("absent");
  });

  it("a Codex that is not under the pane is not this pane's", async () => {
    expect(await occupancy([PANE, LAUNCHER, row(900, 1, "codex", "codex resume other")])).toBe("absent");
  });
  it("the runtime decides what counts: a Codex tree is not a Claude, and a Claude is not a Codex", async () => {
    expect(await occupancy([PANE, LAUNCHER, NODE, CODEX], "claude-code")).toBe("absent");
    expect(await claudePaneOccupancy({ target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => [PANE, LAUNCHER, NODE, CODEX] })).toBe("absent");
    expect(await occupancy([PANE, row(102, 100, "claude", "claude --resume tok")], "codex")).toBe("absent");
    expect(await occupancy([PANE, row(102, 100, "claude", "claude --resume tok")], "claude-code")).toBe("present");
  });
  it.each([
    ["a listing without the pane's pid", [NODE, CODEX]],
    ["an empty listing", []],
  ])("%s is unobservable", async (_name, rows) => {
    expect(await occupancy(rows)).toBe("unobservable");
  });
  it("a listing that throws, and a pane with no pid, are unobservable", async () => {
    expect(await nativePaneOccupancy("codex", { target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => { throw new Error("ps"); } })).toBe("unobservable");
    expect(await nativePaneOccupancy("codex", { target: "%1", tmux: { getPanePid: async () => null }, listProcesses: async () => [PANE] })).toBe("unobservable");
  });
});
