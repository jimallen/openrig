import { describe, expect, it, vi } from "vitest";
import { validatePreRestore, freshSeatReplaysSnapshotStartup } from "../src/domain/restore-preconditions.js";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";
import type { SnapshotData, RigServicesRecord, NodeStartupSnapshot } from "../src/domain/types.js";

function data(): SnapshotData {
  return {
    rig: { id: "rig-1", name: "test-rig", createdAt: "", updatedAt: "" },
    nodes: [{ id: "node-1", logicalId: "seat", cwd: "/project" }],
    sessions: [], edges: [], checkpoints: {},
    nodeStartupContext: { "node-1": {
      runtime: "claude-code", projectionEntries: [], startupActions: [],
      resolvedStartupFiles: [{ path: "notes.md", ownerRoot: "/owner", absolutePath: "/files/notes.md", required: true }],
    } },
  } as SnapshotData;
}

function services(): RigServicesRecord {
  return { rigId: "rig-1", kind: "compose", specJson: "{}", rigRoot: "/services", composeFile: "/services/compose.yaml", projectName: "test", latestReceiptJson: null, createdAt: "", updatedAt: "" };
}

function node(rigId = "rig-1", running = false): NodeInventoryEntry {
  return {
    nodeId: "node-1", logicalId: "seat", rigId, rigName: rigId,
    podId: null, canonicalSessionName: `seat@${rigId}`, nodeKind: "infrastructure", runtime: "terminal",
    sessionStatus: running ? "running" : "exited", startupStatus: "ready", tmuxAttachCommand: null, latestError: null,
  };
}

function deps(overrides: Partial<RestoreCheckDeps> = {}): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => [node()],
    getStartupContext: () => ({ status: "ok", runtime: "terminal", resolvedStartupFiles: [], projectionEntries: [] }),
    hasSnapshot: () => true,
    getRestoreInputs: () => ({ snapshot: { id: "chosen-snapshot", kind: "manual", data: data() }, servicesRecord: services() }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
    exists: () => true,
    readFile: () => JSON.stringify({ schemaVersion: 1, daemonBootstrap: { declared: true, mechanism: "service", evidence: "fixture" }, supportingInfra: [] }),
    ...overrides,
  };
}

const cases = [
  ["/owner", "startup_owner_root_missing", "Required startup file owner root is missing for seat: /owner", "Restore the agent/source root or capture a new snapshot with reachable startup context."],
  ["/services", "service_rig_root_missing", "Service rig root is missing: /services", "Restore the service rig root or update the services record before retrying restore."],
  ["/services/compose.yaml", "service_compose_file_missing", "Service compose file is missing: /services/compose.yaml", "Restore the compose file or update the services record before retrying restore."],
] as const;

describe("shared restore preconditions", () => {
  it.each(cases)("preserves the exact refusal for missing %s", (missing, code, message, remediation) => {
    const result = validatePreRestore(data(), { fsOps: { exists: (path) => path !== missing }, servicesRecord: services() });
    expect(result).toEqual({
      blockers: [{ code, severity: "critical", message, remediation, path: missing,
        ...(code === "startup_owner_root_missing"
          ? { nodeId: "node-1", logicalId: "seat", target: "notes.md" }
          : { target: code === "service_rig_root_missing" ? "services.rigRoot" : "services.composeFile" }),
      }], warnings: [],
    });
  });

  it("retains blocker order and optional-file warnings", () => {
    const snapshot = data();
    snapshot.nodeStartupContext!["node-1"]!.resolvedStartupFiles.push({ path: "optional.md", ownerRoot: "/optional", absolutePath: "/optional/file", required: false } as never);
    const result = validatePreRestore(snapshot, { fsOps: { exists: () => false }, servicesRecord: services() });
    expect(result.blockers.map((b) => b.code)).toEqual([
      "startup_owner_root_missing", "required_startup_file_missing", "service_rig_root_missing", "service_compose_file_missing",
    ]);
    expect(result.warnings).toEqual(["Restore pre-validation: optional startup file missing for seat: /optional/file"]);
  });

  it("does not validate replay-only files on native resume; explicit fresh does", () => {
    const snapshot = data();
    snapshot.sessions = [{ id: "session-1", nodeId: "node-1", status: "exited", resumeToken: "native-token", resumeType: "claude_id", restorePolicy: "resume_if_possible" }] as SnapshotData["sessions"];
    snapshot.activeSessionIdByNode = { "node-1": "session-1" };
    const opts = { fsOps: { exists: () => false }, servicesRecord: null };
    expect(validatePreRestore(snapshot, opts)).toEqual({ blockers: [], warnings: [] });
    expect(validatePreRestore(snapshot, { ...opts, freshLogicalIds: ["seat"] }).blockers.map((b) => b.code))
      .toEqual(["startup_owner_root_missing", "required_startup_file_missing"]);
  });

  it("preserves the absent-service and default-existence behavior", () => {
    expect(validatePreRestore(data(), {})).toEqual({ blockers: [], warnings: [] });
  });
});

describe("restore-check consumes the shared snapshot validation", () => {
  // OF-32 stage 3: the seat here has no saved startup context of its own, so (as restore does) its fresh start replays
  // the snapshot's copy and that copy is what is validated. A seat with a saved context is pinned in
  // "which fresh seats replay the snapshot's startup copy" below.
  const noSavedContext = { getStartupContext: () => ({ status: "missing" as const, evidence: "no saved startup context (fixture)" }) };
  it.each(cases)("reports %s as red with the original message, remediation and snapshot", (missing, code, message, remediation) => {
    const result = new RestoreCheckService(deps({ ...noSavedContext, exists: (path) => path !== missing })).check({ compact: true, noQueue: true, noHooks: true });
    expect(result.checks.find((c) => c.check === "rig.test-rig.restore-preconditions")).toEqual({
      check: "rig.test-rig.restore-preconditions", status: "red",
      evidence: `Snapshot chosen-snapshot: ${code}: ${message}`, remediation, remediationSafe: false,
    });
    expect(result.verdict).toBe("not_restorable");
    expect(result.recovery.status).toBe("blocked");
    expect(result.recovery.actions).toEqual([]);
    expect(result.recovery.blocked[0]?.reason).toContain(message);
  });

  it("uses yellow for warnings only and green for a completed empty result", () => {
    const snapshot = data();
    snapshot.nodeStartupContext!["node-1"]!.resolvedStartupFiles[0]!.required = false;
    const getRestoreInputs = () => ({ snapshot: { id: "optional", kind: "manual", data: snapshot }, servicesRecord: null });
    const warning = new RestoreCheckService(deps({ ...noSavedContext, getRestoreInputs, exists: (path) => path !== "/files/notes.md" })).check({});
    expect(warning.checks.find((c) => c.check.endsWith("restore-preconditions"))?.status).toBe("yellow");
    const green = new RestoreCheckService(deps({ getRestoreInputs })).check({});
    expect(green.checks.find((c) => c.check.endsWith("restore-preconditions"))?.status).toBe("green");
  });

  it.each(["no usable current-occupant snapshot", "snapshot read failed"])("isolates unavailable inputs: %s", (reason) => {
    const getRestoreInputs = vi.fn((rigId: string) => {
      if (rigId === "rig-1") {
        if (reason === "snapshot read failed") throw new Error(reason);
        return { unavailable: reason };
      }
      return { snapshot: { id: "other-snapshot", kind: "manual", data: data() }, servicesRecord: null };
    });
    const result = new RestoreCheckService(deps({
      listRigs: () => [{ rigId: "rig-1", name: "broken" }, { rigId: "rig-2", name: "healthy" }],
      getNodeInventory: (id) => [node(id)], getRestoreInputs,
    })).check({ noQueue: true, noHooks: true });
    expect(getRestoreInputs).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe("not_restorable");
    expect(result.rigs.find((r) => r.rigId === "rig-1")?.status).toBe("unknown");
    expect(result.rigs.find((r) => r.rigId === "rig-2")?.status).not.toBe("unknown");
    expect(result.recovery.unknown[0]?.reason).toContain(reason);
    expect(result.recovery.actions.map((a) => a.rigId)).toEqual(["rig-2"]);
    expect(result.checks.find((c) => c.check === "rig.healthy.restore-preconditions")?.status).toBe("green");
  });

  it("skips added reads only for all-ready recovery polls, never an explicit check", () => {
    const getRestoreInputs = vi.fn(deps().getRestoreInputs);
    const service = new RestoreCheckService(deps({ getRestoreInputs, getNodeInventory: () => [node("rig-1", true)] }));
    expect(service.check({ recoveryOnly: true }).recovery.status).toBe("not_needed");
    expect(getRestoreInputs).not.toHaveBeenCalled();
    service.check({});
    expect(getRestoreInputs).toHaveBeenCalledTimes(1);
  });

  it("validates mixed and empty rigs even in recovery-only mode", () => {
    for (const nodes of [[], [node("rig-1", true), node("rig-1", false)]]) {
      const getRestoreInputs = vi.fn(deps().getRestoreInputs);
      new RestoreCheckService(deps({ getRestoreInputs, getNodeInventory: () => nodes })).check({ recoveryOnly: true });
      expect(getRestoreInputs).toHaveBeenCalledTimes(1);
    }
  });
});

// OF-32 stage 3: a seat a restore starts fresh is checked against the snapshot's copy only when that copy is what it
// replays. Every combination of the three inputs, and the validator's use of the answer.
describe("which fresh seats replay the snapshot's startup copy", () => {
  it.each([
    [false, false, false, true], [false, false, true, true], [false, true, false, true], [false, true, true, true],
    [true, false, false, true], [true, false, true, false], [true, true, false, false], [true, true, true, false],
  ] as const)("adapter %s, saved context %s, spec re-read %s -> replays the snapshot's copy: %s", (adapterAvailable, seatHasSavedContext, rigSpecReread, expected) => {
    expect(freshSeatReplaysSnapshotStartup({ adapterAvailable, seatHasSavedContext, rigSpecReread })).toBe(expected);
  });

  // The snapshot copy names /files/notes.md (missing); the seat's own saved context names /files/saved.md.
  const saved = { runtime: "claude-code", projectionEntries: [], startupActions: [],
    resolvedStartupFiles: [{ path: "saved.md", ownerRoot: "/owner", absolutePath: "/files/saved.md", required: true }] } as unknown as NodeStartupSnapshot;
  it.each([
    ["the snapshot's copy (undefined)", undefined, ["/files/notes.md"]],
    ["resolved at launch (a --fresh seat)", "resolved_at_launch", []],
    ["the seat's own saved context", { replay: saved }, ["/files/saved.md"]],
  ] as const)("a fresh seat whose source is %s is validated against exactly that", (_label, answer, missingPaths) => {
    const asked: string[] = [];
    const result = validatePreRestore(data(), {
      fsOps: { exists: (path) => path !== "/files/notes.md" && path !== "/files/saved.md" },
      freshSeatStartup: (seat) => { asked.push(seat.logicalId); return answer; },
    });
    expect(asked).toEqual(["seat"]);
    expect(result.blockers.filter((b) => b.code === "required_startup_file_missing").map((b) => b.path)).toEqual(missingPaths);
  });

  // OF-36: what the seat replays instead (the newest usable snapshot copy) carries a warning, and a seat with nothing
  // usable is refused with the blocker it was given, before any of its files are checked.
  it("a replacement copy's warning is reported, and a refusal is the blocker given (no file of the seat is checked)", () => {
    const warned = validatePreRestore(data(), {
      fsOps: { exists: (path) => path !== "/files/saved.md" },
      freshSeatStartup: () => ({ replay: saved, warning: "replays snapshot S1's copy (injected)" }),
    });
    expect(warned.warnings).toContain("replays snapshot S1's copy (injected)");
    expect(warned.blockers.map((b) => b.path)).toEqual(["/files/saved.md"]);

    const blocker = { code: "saved_startup_context_unusable", severity: "critical" as const, logicalId: "seat", message: "nothing usable (injected)", remediation: "repair (injected)" };
    const refused = validatePreRestore(data(), { fsOps: { exists: () => false }, freshSeatStartup: () => ({ refuse: blocker }) });
    expect(refused.blockers).toEqual([blocker]);
  });

  it("an exact resume is never asked: it consumes no replay, whatever the answer", () => {
    const resumed = { ...data(), sessions: [{ id: "s1", nodeId: "node-1", sessionName: "seat@test-rig", status: "running", resumeType: "claude_name", resumeToken: "tok", restorePolicy: "resume_if_possible" }],
      activeSessionIdByNode: { "node-1": "s1" } } as unknown as SnapshotData;
    const asked: string[] = [];
    const result = validatePreRestore(resumed, { fsOps: { exists: () => false }, freshSeatStartup: (seat) => { asked.push(seat.logicalId); return undefined; } });
    expect(asked).toEqual([]);
    expect(result.blockers.filter((b) => b.code === "required_startup_file_missing")).toHaveLength(0);
  });
});

// OF-57: pre-restore validation asks whether a seat consumes replay of the one function restore, the plan and `rig launch`
// ask (restore-seat-gates.ts decideSeatLaunchOutcome), instead of keeping its own copy of the rules. Production
// consequence of the copy: a seat restore stops at a gate (or skips) reads none of its startup files, yet a missing file
// of such a seat refused the WHOLE rig ("required_startup_file_missing") before any other seat was restored. Each row is
// one seat state; the expectation is restated here from the gate rules, not computed from the module under test.
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator, whose restore() calls validatePreRestore.
describe("pre-restore validation checks the startup files only of a seat restore will start fresh (OF-57)", () => {
  const missing = { fsOps: { exists: () => false } };
  const row = (id: string, over: Record<string, unknown>) => ({ id, nodeId: "node-1", sessionName: "seat@test-rig", status: "exited", resumeType: null, resumeToken: null, restorePolicy: "resume_if_possible", ...over });
  const withSessions = (sessions: unknown[], activeOccupantsByNode?: unknown) =>
    ({ ...data(), sessions, ...(activeOccupantsByNode ? { activeOccupantsByNode } : {}) }) as unknown as SnapshotData;
  const fileBlockers = (result: ReturnType<typeof validatePreRestore>) => result.blockers.filter((b) => b.code === "required_startup_file_missing").length;
  const gateInputs = (over: { live?: { runtime: string | null } | null; continuityStatus?: string | null } = {}) =>
    () => ({ live: "live" in over ? over.live! : { runtime: "claude-code" }, continuityStatus: over.continuityStatus ?? null, rigName: "test-rig" });

  // The snapshot alone decides these gates (no seatGateInputs given).
  it.each([
    ["no session at all: starts fresh, its files are read", withSessions([]), undefined, 1],
    ["an earlier occupant left a token and no one was running: restore stops it for a decision", withSessions([row("s1", { resumeType: "claude_id", resumeToken: "old" })], { "node-1": { kind: "absent" } }), undefined, 0],
    ["...but listed with --fresh it starts fresh and its files are read", withSessions([row("s1", { resumeType: "claude_id", resumeToken: "old" })], { "node-1": { kind: "absent" } }), ["seat"], 1],
    ["an earlier occupant with a relaunch-fresh policy starts fresh", withSessions([row("s1", { resumeType: "claude_id", resumeToken: "old", restorePolicy: "relaunch_fresh" })], { "node-1": { kind: "absent" } }), undefined, 1],
    ["a resumable seat with no token: restore stops it for a decision", withSessions([row("s1", { status: "running" })], { "node-1": { kind: "resolved", sessionId: "s1" } }), undefined, 0],
    ["a token but no resume source: starts fresh", withSessions([row("s1", { status: "running", resumeToken: "tok" })], { "node-1": { kind: "resolved", sessionId: "s1" } }), undefined, 1],
    ["an exact resume reads no replay file", withSessions([row("s1", { status: "running", resumeType: "claude_id", resumeToken: "tok" })], { "node-1": { kind: "resolved", sessionId: "s1" } }), undefined, 0],
    ["an ambiguous occupant: restore stops it", withSessions([row("s1", { status: "running" }), row("s2", { status: "running" })], { "node-1": { kind: "ambiguous", candidateIds: ["s1", "s2"] } }), undefined, 0],
  ] as const)("from the snapshot alone, %s", (_label, snapshot, freshLogicalIds, expectedFileBlockers) => {
    const result = validatePreRestore(snapshot, { ...missing, ...(freshLogicalIds ? { freshLogicalIds: [...freshLogicalIds] } : {}) });
    expect(fileBlockers(result)).toBe(expectedFileBlockers);
  });

  // The gates that need the live rig: given by the caller (restore reads them where restoreNodeUnisolated does).
  it.each([
    ["the live seat matches: starts fresh, its files are read", { live: { runtime: "claude-code" } }, undefined, 1],
    ["the seat was removed and not grown back: restore reports it failed and reads nothing", { live: null }, undefined, 0],
    ["the seat's runtime is no longer the one its startup was saved under: restore stops it", { live: { runtime: "codex" } }, undefined, 0],
    ["the seat's continuity is 'restoring': restore skips it", { continuityStatus: "restoring" }, undefined, 0],
    ["...also when it is listed with --fresh", { continuityStatus: "restoring" }, ["seat"], 0],
    ["a degraded continuity state does not stop it", { continuityStatus: "degraded" }, undefined, 1],
  ] as const)("with the live seat given, %s", (_label, inputs, freshLogicalIds, expectedFileBlockers) => {
    const result = validatePreRestore(data(), { ...missing, seatGateInputs: gateInputs(inputs), ...(freshLogicalIds ? { freshLogicalIds: [...freshLogicalIds] } : {}) });
    expect(fileBlockers(result)).toBe(expectedFileBlockers);
  });

  // Not only the blockers: the warnings about optional files and projection entries are about files the seat would be given.
  it("a seat restore stops or skips gets no warning about its optional files or projection entries, and a seat it starts fresh does", () => {
    const snapshot = data();
    snapshot.nodeStartupContext!["node-1"]!.resolvedStartupFiles.push({ path: "optional.md", ownerRoot: "/optional", absolutePath: "/optional/file", required: false } as never);
    snapshot.nodeStartupContext!["node-1"]!.projectionEntries.push({ sourcePath: "/proj/src", absolutePath: "/proj/entry" } as never);
    const warningsFor = (inputs: Parameters<typeof gateInputs>[0]) => validatePreRestore(snapshot, { ...missing, seatGateInputs: gateInputs(inputs) }).warnings;
    expect(warningsFor({})).toHaveLength(3); // the optional file, the projection's source root and its entry
    expect(warningsFor({ live: null })).toEqual([]);
    expect(warningsFor({ live: { runtime: "codex" } })).toEqual([]);
    expect(warningsFor({ continuityStatus: "restoring" })).toEqual([]);
  });

  it("a seat restore stops is not offered to the fresh-source decision, and a seat it starts fresh is", () => {
    const asked: string[] = [];
    validatePreRestore(data(), { ...missing, seatGateInputs: gateInputs({ live: null }), freshSeatStartup: (seat) => { asked.push(seat.logicalId); return undefined; } });
    expect(asked).toEqual([]);
    validatePreRestore(data(), { ...missing, seatGateInputs: gateInputs(), freshSeatStartup: (seat) => { asked.push(seat.logicalId); return undefined; } });
    expect(asked).toEqual(["seat"]);
  });
});
