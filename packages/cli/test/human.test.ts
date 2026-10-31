import { afterEach, describe, expect, it, vi } from "vitest";
import { humanCommand } from "../src/commands/human.js";

describe("rig human", () => {
  afterEach(() => { process.exitCode = undefined; });

  it("runs rig-here kernel and takes its exit code", async () => {
    const run = vi.fn(() => ({ status: 3, error: undefined }));
    await humanCommand({ run }).parseAsync([], { from: "user" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("rig-here", ["kernel"]);
    expect(process.exitCode).toBe(3);
  });

  it("says so when rig-here can't run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: null, error: new Error("spawn rig-here ENOENT") }));
    await humanCommand({ run }).parseAsync([], { from: "user" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("could not run rig-here"));
    expect(process.exitCode).toBe(1);
    error.mockRestore();
  });
});
