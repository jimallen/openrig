import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { healthDetailLines } from "../src/health/health-model.js";
import type { FleetSnapshot } from "../src/types.js";

// The daemon's evidence union and the TUI's copy are separate types, so a new daemon evidence
// type compiles in the TUI whether or not the TUI renders it. This test is the drift check.
function snapshotWithTelemetryFinding(): FleetSnapshot {
  const snap = demoSnapshot();
  Object.assign(snap, {
    health: {
      availability: "loaded", evaluatedAt: "2031-03-04T05:06:07.000Z", total: 1, truncated: false,
      records: [{
        schema: "openrig.health/v0alpha1", id: "health-rsi", detector: "rsi.archived-rig-live-session", category: "process",
        scope: { type: "rig", rigId: "rig-dead" }, severity: "info", confidence: "high", status: "active",
        startedAt: "2030-01-02T03:04:05.000Z", lastObservedAt: "2031-03-04T05:06:07.000Z",
        window: { source: "telemetry-span", startedAt: "2030-01-02T03:04:05.000Z", endedAt: "2031-03-04T05:06:07.000Z", limit: 1, retentionSeconds: 99999999 },
        freshness: { state: "fresh", evaluatedAt: "2031-03-04T05:06:07.000Z", newestSourceAt: "2031-03-04T05:06:07.000Z", maxAgeSeconds: 600, ageSeconds: 0 },
        summary: "Archived rig still has live sessions.",
        evidence: [{
          type: "telemetry-span", sourceOrder: 0, observedAt: "2030-02-03T04:05:06.000Z",
          detectorId: "rsi.archived-rig-live-session", class: "live-session-on-archived-rig",
          fingerprint: "rsi.archived-rig-live-session/rig:rig-dead", count: 8, controlTotal: 4, population: 61,
          firstSeq: 4117, lastSeq: 4290, firstSeen: "2030-01-02T03:04:05.000Z", lastSeen: "2030-02-03T04:05:06.000Z",
        }],
        threshold: "t", explanation: "e", suggestedInspection: "i", indeterminateReason: null,
      }],
    },
  });
  return snap;
}

describe("telemetry-span evidence in the TUI health detail", () => {
  it("renders the values the telemetry-span case produces, not just the type label", () => {
    const text = healthDetailLines(snapshotWithTelemetryFinding(), "health-rsi", 400)
      .map((line) => line.text).join("\n");

    // `value(evidence, ...)` output that only the telemetry-span case emits. The type label
    // "telemetry-span" is printed for every evidence type and would prove nothing.
    expect(text).toContain("rsi.archived-rig-live-session · live-session-on-archived-rig · 8 found · control 4 · population 61");
    expect(text).toContain("rows 4117–4290");
    expect(text).toContain("fingerprint rsi.archived-rig-live-session/rig:rig-dead");
  });
});
