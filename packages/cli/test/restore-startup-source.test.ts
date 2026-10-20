import { describe, expect, it } from "vitest";
import { describeRestoreStartupSource } from "../src/restore-startup-source.js";

// OF-32 stage 3: the one line `rig up` / `rig start` print for a seat a restore started fresh. Every source kind.
describe("describeRestoreStartupSource", () => {
  it.each([
    [{ kind: "spec", specSource: "/lib/t/rig.yaml", specPath: "/rel/b/rig.yaml", previousSpecVersion: "1.0.0", specVersion: "2.0.0" }, "startup files re-read from /lib/t/rig.yaml (now /rel/b/rig.yaml); agent 1.0.0 -> 2.0.0"],
    [{ kind: "spec", specSource: "/s/rig.yaml", specPath: "/s/rig.yaml", previousSpecVersion: "2.0.0", specVersion: "2.0.0" }, "startup files re-read from /s/rig.yaml; agent 2.0.0, unchanged"],
    [{ kind: "spec", specSource: "/s/rig.yaml", specPath: "/s/rig.yaml", previousSpecVersion: null, specVersion: "2.0.0" }, "startup files re-read from /s/rig.yaml; agent (none recorded) -> 2.0.0"],
    [{ kind: "stored", reason: "requested" }, "startup files replayed from the seat's last successful launch (--startup-from stored)"],
    [{ kind: "stored", reason: "not_in_spec" }, "startup files replayed from the seat's last successful launch (the rig's spec does not declare this seat)"],
    [{ kind: "stored", reason: "no_recorded_source" }, "startup files replayed from the seat's last successful launch (this rig records no spec source)"],
    [{ kind: "stored", reason: "not_fresh_listed" }, "startup files replayed from the seat's last successful launch (not listed with --fresh, so the spec was not re-read)"],
    [{ kind: "snapshot", reason: "no_saved_context" }, "startup files replayed from this snapshot (the seat has no saved startup files of its own)"],
    // OF-36: "cannot be used" (it may be JSON of the wrong shape or name another runtime); and a copy from another
    // snapshot than the restored one is named.
    [{ kind: "snapshot", reason: "saved_context_unreadable" }, "startup files replayed from this snapshot (the seat's saved startup files cannot be used)"],
    [{ kind: "snapshot", reason: "saved_context_unreadable", snapshotId: "01SNAP" }, "startup files replayed from snapshot 01SNAP, the newest whose copy can be used (the seat's saved startup files cannot be used)"],
    [{ kind: "snapshot", reason: "no_saved_context", snapshotId: "01SNAP" }, "startup files replayed from snapshot 01SNAP, the newest whose copy can be used (the seat has no saved startup files of its own)"],
  ] as const)("%j", (source, line) => {
    expect(describeRestoreStartupSource(source)).toBe(line);
  });
});

describe("OF-36 Q2 --startup-from snapshot:<id>", () => {
  it("names the requested snapshot", () => {
    expect(describeRestoreStartupSource({ kind: "snapshot", reason: "requested", snapshotId: "01SNAP" })).toBe("startup files replayed from snapshot 01SNAP (--startup-from snapshot:01SNAP)");
  });
  it("parses the accepted spellings, and the fresh-start command repeats the choice", async () => {
    const { parseStartupFromArg, freshSeatLaunchCommand } = await import("../src/fresh-seat-advice.js");
    expect(["spec", "stored", "snapshot:01ABC", "snapshot:", "snapshot:a b", "snapshot"].map(parseStartupFromArg)).toEqual(["spec", "stored", "snapshot:01ABC", null, null, null]);
    expect(freshSeatLaunchCommand("dev.impl", "team", "snapshot:01ABC")).toBe(`rig seat launch 'dev.impl@team' --fresh --startup-from snapshot:01ABC --reason "<why>"`);
  });
});
