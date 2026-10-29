// OF-172: the DUAL-EXIT / fed-pipe rows of staging-docker-invoker.test.ts flaked under load. Cause (measured on Sparky
// at d324c380, the probe pinned to one core shared with a busy loop: 235 of 300 DUAL-EXIT runs and 223 of 300 fed-pipe
// runs failed, 1 of 300 fed-pipe runs on an idle host): the two sides' exits are reaped in one pass and the CONSUMER's
// close is handled first, so the invoker saw a producer that had already exited as "still producing", killed its
// (reaped) group and reported "killed early" instead of the producer's exit code.
//
// Here that ordering is made deterministic: the producer's `exit` and `close` events are delivered late (its stdout
// still ends on time, as on a loaded host), so every row below meets the consumer-first order on every run.
import * as childProcess from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const LATE_MARKER = "of172-late-exit";
const LATE_MS = 300;

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof childProcess>();
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = real.spawn(command, args, options);
    if (args.some((arg) => arg.includes(LATE_MARKER))) {
      const emit = child.emit.bind(child);
      child.emit = (event: string | symbol, ...rest: unknown[]): boolean => {
        if (event === "exit" || event === "close") {
          setTimeout(() => emit(event, ...rest), LATE_MS);
          return true;
        }
        return emit(event, ...rest);
      };
    }
    return child;
  };
  return { ...real, spawn };
});

const { makeRealStagingDocker } = await import("./helpers/staging-docker-invoker.js");
const docker = makeRealStagingDocker({ command: "sh", tarCommand: "sh" });

describe("makeRealStagingDocker: the result does not depend on which side's exit is handled first", () => {
  it("control: the delay reaches the producer (its exit is handled after the consumer has closed)", async () => {
    const order: string[] = [];
    const late = childProcess.spawn("sh", ["-c", `: ${LATE_MARKER}`], { stdio: "ignore" });
    const prompt = childProcess.spawn("sh", ["-c", ": prompt"], { stdio: "ignore" });
    await Promise.all([
      new Promise((resolve) => late.once("close", () => { order.push("late"); resolve(undefined); })),
      new Promise((resolve) => prompt.once("close", () => { order.push("prompt"); resolve(undefined); })),
    ]);
    expect(order).toEqual(["prompt", "late"]);
  });

  it("DUAL-EXIT: a producer that exited 3 fails the step with ITS code and names the tar side", async () => {
    const res = await docker(["-c", "cat"], ["-c", `exit 3 # ${LATE_MARKER}`]);
    expect(res.stderr).not.toMatch(/still producing/);
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/tar-side \(stdinFrom\) failed: exit 3/);
  });

  it("fed pipe leg: a producer that wrote everything and exited 0 is a success with the full payload", async () => {
    const res = await docker(["-c", "cat"], ["-c", `printf 'payload-bytes' # ${LATE_MARKER}`]);
    expect(res.stderr).not.toMatch(/still producing/);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("payload-bytes");
  });

  it("a producer still writing when the consumer exits is still killed and reported (the early-exit rule is kept)", async () => {
    const res = await docker(["-c", "exit 0"], ["-c", `dd if=/dev/zero bs=1024 count=2048 2>/dev/null # ${LATE_MARKER}`]);
    expect(res.code).not.toBe(0);
  });
});
