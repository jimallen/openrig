// workspaces-o9o.174 part 3 (CoS ruling): a test wait's bound scales with the machine's measured load, bound x clamp(load1/cores, 1, 4).
// An idle machine keeps today's bound; a real hang still fails within 4x; the timeout message prints the scale and both numbers.
// Every row injects the load reading (and the clock where it matters), never the real load.
import { describe, expect, it } from "vitest";
import { loadScale, waitBound, waitTimedOut, type LoadReading } from "./helpers/wait-timeout.js";

const reading = (load1: number, cores = 20) => (): LoadReading => ({ load1, cores });

describe("workspaces-o9o.174 part 3: a test wait's bound scales with the measured load", () => {
  it("the scale is load1/cores, clamped to [1, 4]", () => {
    expect(loadScale({ load1: 0.5, cores: 20 })).toBe(1);
    expect(loadScale({ load1: 20, cores: 20 })).toBe(1);
    expect(loadScale({ load1: 30, cores: 20 })).toBe(1.5);
    expect(loadScale({ load1: 61, cores: 20 })).toBe(3.05);
    expect(loadScale({ load1: 200, cores: 20 })).toBe(4);
    expect(loadScale({ load1: 5, cores: 0 })).toBe(1);   // no core count: no scaling, never a division by zero
  });

  it("an idle machine keeps the bound; a loaded one stretches it, up to 4x", () => {
    const now = () => 1_000;
    expect(waitBound(8000, reading(3), now)).toMatchObject({ baseMs: 8000, ms: 8000, scale: 1, deadline: 9_000 });
    expect(waitBound(8000, reading(43), now)).toMatchObject({ baseMs: 8000, ms: 17_200, scale: 2.15, deadline: 18_200 });
    expect(waitBound(8000, reading(400), now)).toMatchObject({ ms: 32_000, scale: 4, deadline: 33_000 });
  });

  it("expired() compares the clock with the scaled deadline; attempts() scales a counted loop", () => {
    let t = 0;
    const bound = waitBound(100, reading(50), () => t);
    expect(bound.ms).toBe(250);
    t = 250; expect(bound.expired()).toBe(false);
    t = 251; expect(bound.expired()).toBe(true);
    expect(bound.attempts(400)).toBe(1000);
    expect(waitBound(100, reading(1), () => 0).attempts(400)).toBe(400);
    expect(waitBound(100, reading(21), () => 0).attempts(10)).toBe(11);   // 10 x 1.05 rounds up: a scaled budget never shrinks below n x scale
  });

  it("the timeout message keeps the lead and prints the waited time, both bounds, the scale and both numbers", () => {
    const bound = waitBound(20_000, reading(24.48), () => 0);
    const err = waitTimedOut("timed out waiting for the probe", bound, "0", { now: () => 30_500, read: reading(26.1) });
    expect(err.message).toBe("timed out waiting for the probe after 30500 ms (bound 20000 ms x 1.22 = 24480 ms; 1-minute load 24.48 on 20 "
      + "cores at the start, 26.10 at the end); last: 0");
  });
});
