// OF-33 N-3: classifySessionLiveness itself, over a probe double (hc cutover N4: it asks the classified probe, not hasSession).
import { describe, it, expect, vi } from "vitest";
import { classifySessionLiveness } from "../src/domain/session-liveness.js";
import type { SessionProbe, TmuxAdapter } from "../src/adapters/tmux.js";
import { probeSessionFromHasSession } from "./helpers/probe-from-has-session.js";

const tmuxOf = (hasSession: (name: string) => unknown) => ({ hasSession, probeSession: probeSessionFromHasSession } as unknown as Pick<TmuxAdapter, "probeSession" | "hostKind">);
/** A seat host of the given kind answering one probe. */
const hostOf = (hostKind: "tmux" | "hc", probe: () => SessionProbe | Promise<SessionProbe>) => ({ hostKind, probeSession: async () => probe() }) as Pick<TmuxAdapter, "probeSession" | "hostKind">;

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

  describe("a host that does not answer (hc cutover N4, OF-177)", () => {
    const unavailable: SessionProbe = { state: "transport_unavailable", cause: "core unreachable" };

    it("an unreachable hc core is unreadable, never dead: its seats may be running", async () => {
      await expect(classifySessionLiveness(hostOf("hc", () => unavailable), "dev-a@r")).resolves.toBe("unreadable");
    });
    it("tmux's own no-server answer stays dead, as restore has always read it", async () => {
      await expect(classifySessionLiveness(hostOf("tmux", () => unavailable), "dev-a@r")).resolves.toBe("dead");
    });
    it.each([["tmux"], ["hc"]] as const)("on %s: present is live and absent is dead", async (kind) => {
      await expect(classifySessionLiveness(hostOf(kind, () => ({ state: "present" })), "dev-a@r")).resolves.toBe("live");
      await expect(classifySessionLiveness(hostOf(kind, () => ({ state: "absent" })), "dev-a@r")).resolves.toBe("dead");
    });
    it("a probe that throws is unreadable on either host", async () => {
      await expect(classifySessionLiveness(hostOf("hc", () => { throw new Error("boom"); }), "dev-a@r")).resolves.toBe("unreadable");
    });
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
