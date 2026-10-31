import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { attachSharedTui, resolveSharedTerminal, sharedTuiTarget } from "../src/shared-tui.js";
import { tuiCommand } from "../src/commands/tui.js";
import { probeFrontDoor } from "../src/front-door.js";

function client(rigs: unknown, nodes: unknown, status = 200) {
  return { get: vi.fn(async <T>(path: string) => ({ status, data: (path === "/api/ps" ? rigs : nodes) as T })) };
}
const kernel = [{ rigId: "selected-instance-kernel", rigName: "kernel" }];
const terminal = { podId: "database-pod-id", logicalId: "operator.human", runtime: "terminal", canonicalSessionName: "actual-terminal", tmuxAttachCommand: "hc attach -- actual-terminal" };

describe("shared kernel TUI", () => {
  it("permits the actual builtin terminal identity without inventing harness diagnostics", async () => {
    const result = await probeFrontDoor({ env: { OPENRIG_NODE_ID: "terminal-id" }, client: {
      get: async () => ({ status: 200, data: { identity: { runtime: "terminal", agentRef: "builtin:terminal" }, permissionDrift: { enforcement: { state: "unknown" } } } }),
    } });
    expect(result).toEqual({ state: "ready" });
  });
  it("uses the selected daemon's binding, without creating a session", async () => {
    const c = client(kernel, [terminal]);
    expect(await sharedTuiTarget(c)).toBe("actual-terminal");
    expect(c.get.mock.calls.map(([p]) => p)).toEqual(["/api/ps", "/api/rigs/selected-instance-kernel/nodes"]);
  });
  it("distinguishes no kernel, no terminal, and a failed read", async () => {
    await expect(sharedTuiTarget(client([], []))).rejects.toThrow("No kernel");
    await expect(sharedTuiTarget(client(kernel, [{ ...terminal, runtime: "codex" }]))).rejects.toThrow("no bound shared terminal");
    await expect(sharedTuiTarget(client(kernel, [], 503))).rejects.toThrow("HTTP 503");
    await expect(sharedTuiTarget(client([...kernel, ...kernel], [terminal]))).rejects.toThrow("Multiple kernels");
  });
  it("does not attach a local namesake for a remote daemon", async () => {
    const c = { ...client(kernel, [terminal]), baseUrl: "http://other-machine:7433" };
    await expect(sharedTuiTarget(c)).rejects.toThrow("local hc core");
    expect(c.get).not.toHaveBeenCalled();
  });
  it("joins the existing terminal instead of launching another TUI", async () => {
    const attachShared = vi.fn(async () => 0);
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    const cli = new Command().addCommand(tuiCommand({ stdoutIsTTY: true, stdinIsTTY: true, sharedTarget: async () => "actual-terminal", attachShared, launchTui, exit, err: () => {} }));
    await cli.parseAsync(["node", "rig", "tui", "--shared"]);
    expect(attachShared).toHaveBeenCalledWith("actual-terminal");
    expect(launchTui).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("tells the person how to detach from hc, not from tmux", async () => {
    const lines: string[] = [];
    const cli = new Command().addCommand(tuiCommand({ stdoutIsTTY: true, stdinIsTTY: true, sharedTarget: async () => "t", attachShared: async () => 0, exit: () => {}, err: (l) => lines.push(l) }));
    await cli.parseAsync(["node", "rig", "tui", "--shared"]);
    const text = lines.join("\n");
    expect(text).toContain("Ctrl-\\ detaches");
    expect(text).not.toContain("Ctrl-b");
    expect(cli.commands[0]!.options.find((o) => o.long === "--shared")!.description).toContain("detach with Ctrl-\\");
  });
  it("a piped shared request never attaches or resolves a target", async () => {
    const sharedTarget = vi.fn();
    const exit = vi.fn();
    const cli = new Command().addCommand(tuiCommand({ stdoutIsTTY: true, stdinIsTTY: false, sharedTarget, exit, err: () => {} }));
    await cli.parseAsync(["node", "rig", "tui", "--shared"]);
    expect(sharedTarget).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  describe("attaching the shared terminal", () => {
    const listing = (...addresses: string[]) => ({ code: 0, stdout: JSON.stringify({ machines: [], terminals: addresses.map((address) => ({ address })) }) });

    it("looks the terminal up by its seat label, then attaches plain, after `--`", async () => {
      const list = vi.fn(async (_args: string[]) => listing("t7"));
      const attach = vi.fn(async (_args: string[]) => 0);
      expect(await attachSharedTui("operator-human@kernel", { list, attach })).toBe(0);
      expect(list.mock.calls[0]![0]).toEqual(["ls", "--json", "--label", "openrig.seat=operator-human@kernel"]);
      expect(attach.mock.calls).toEqual([[["attach", "--", "t7"]]]);
    });

    it("hands back the exit code of the attach", async () => {
      expect(await attachSharedTui("k", { list: async () => listing("t1"), attach: async () => 11 })).toBe(11);
    });

    it("attaches nothing when no live terminal, or several, carry the label", async () => {
      const attach = vi.fn(async () => 0);
      await expect(attachSharedTui("k", { list: async () => listing(), attach })).rejects.toThrow("No live hc terminal carries the label openrig.seat=k");
      await expect(attachSharedTui("k", { list: async () => listing("t1", "t2"), attach })).rejects.toThrow("2 hc terminals carry the label");
      expect(attach).not.toHaveBeenCalled();
    });

    it("says hc could not be read, for a failed or malformed listing", async () => {
      await expect(resolveSharedTerminal("k", { list: async () => ({ code: 1, stdout: "" }) })).rejects.toThrow("Cannot list hc terminals");
      await expect(resolveSharedTerminal("k", { list: async () => ({ code: 0, stdout: "not json" }) })).rejects.toThrow("Cannot list hc terminals");
      await expect(resolveSharedTerminal("k", { list: async () => ({ code: 0, stdout: "{}" }) })).rejects.toThrow("Cannot list hc terminals");
    });
  });
});
