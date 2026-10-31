import { afterEach, describe, expect, it, vi } from "vitest";
import { rsiCommand } from "../src/commands/rsi.js";

describe("rig rsi", () => {
  afterEach(() => { process.exitCode = undefined; });

  it("runs rig-here rsi and takes its exit code", async () => {
    const run = vi.fn(() => ({ status: 3, error: undefined }));
    await rsiCommand({ run }).parseAsync([], { from: "user" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("rig-here", ["rsi"]);
    expect(process.exitCode).toBe(3);
  });

  it("says so when rig-here can't run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: null, error: new Error("spawn rig-here ENOENT") }));
    await rsiCommand({ run }).parseAsync([], { from: "user" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("could not run rig-here"));
    expect(process.exitCode).toBe(1);
    error.mockRestore();
  });

  it("fails non-zero when rig-here is killed by a signal (no status)", async () => {
    const run = vi.fn(() => ({ status: null, error: undefined }));
    await rsiCommand({ run }).parseAsync([], { from: "user" });
    expect(process.exitCode).toBe(1);
  });
});
