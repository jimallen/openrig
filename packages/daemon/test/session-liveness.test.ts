// OF-33 N-3: classifySessionLiveness itself, over a hasSession double.
import { describe, it, expect, vi } from "vitest";
import { classifySessionLiveness } from "../src/domain/session-liveness.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const tmuxOf = (hasSession: (name: string) => unknown) => ({ hasSession } as unknown as Pick<TmuxAdapter, "hasSession">);

describe("classifySessionLiveness", () => {
  it.each([
    ["true", async () => true, "live"],
    ["false", async () => false, "dead"],
    ["a rejected promise", async () => { throw new Error("tmux failed (injected)"); }, "unreadable"],
    // hasSession can throw BEFORE it returns a promise (a double, a bad adapter): that is still a probe
    // that failed to answer, never a rejection handed to the caller.
    ["a synchronous throw", () => { throw new Error("sync tmux failure (injected)"); }, "unreadable"],
  ] as const)("hasSession answering %s is %s", async (_label, hasSession, expected) => {
    await expect(classifySessionLiveness(tmuxOf(hasSession), "dev-a@r")).resolves.toBe(expected);
  });

  it("a synchronous throw leaves no deadline timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await classifySessionLiveness(tmuxOf(() => { throw new Error("sync tmux failure (injected)"); }), "dev-a@r");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
