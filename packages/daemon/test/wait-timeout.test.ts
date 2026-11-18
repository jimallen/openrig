// workspaces-o9o.174: a real-process test's wait that gives up must say how long it waited and how loaded the machine was, so a failure
// in a full gate carries its own evidence of whether load caused it (a two-suite measurement at load 35 reproduced none of the
// reported timeouts). Each shared wait helper keeps its own lead text byte for byte; only the evidence is appended.
import { describe, expect, it } from "vitest";
import { until as coreUntil } from "./hc-private-core.js";
import { waitUntil } from "./helpers/hc-private-core.js";
import { until as paneUntil } from "./helpers/pi-runner-pane.js";
import { waitFor } from "./helpers/pda-runner-rig.js";

const EVIDENCE = String.raw`after (\d+) ms \(1-minute load \d+\.\d{2} on \d+ cores\)`;

describe("workspaces-o9o.174: a shared test wait that times out reports the time it waited and the load", () => {
  it("test/hc-private-core until() reports the time it waited and the load", async () => {
    await expect(coreUntil(() => 0, (v) => v === 1, "the probe", 30)).rejects.toThrow(new RegExp(`^timed out waiting for the probe ${EVIDENCE}; last: 0$`));
  });

  it("helpers/hc-private-core waitUntil() reports the time it waited and the load", async () => {
    await expect(waitUntil(async () => 0, (v) => v === 1, "the probe", 30)).rejects.toThrow(new RegExp(`^timed out waiting for the probe ${EVIDENCE}$`));
  });

  it("helpers/pi-runner-pane until() reports the time it waited and the load", async () => {
    await expect(paneUntil(async () => 0, (v) => v === 1, "the probe", 30)).rejects.toThrow(new RegExp(`^timed out waiting for the probe ${EVIDENCE}; last: 0$`));
  });

  it("helpers/pda-runner-rig waitFor() reports the time it waited and the load", async () => {
    await expect(waitFor(() => false, "the probe", 30)).rejects.toThrow(new RegExp(`^timed out waiting for: the probe ${EVIDENCE}$`));
  });

  it("the time it reports is the time it waited: at least the bound, measured from the start of the wait", async () => {
    const err = await coreUntil(() => 0, (v) => v === 1, "the probe", 60).then(() => null, (e: Error) => e);
    const waited = Number(new RegExp(EVIDENCE).exec(err?.message ?? "")?.[1]);
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThan(5_000);
  });
});
