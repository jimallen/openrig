// OF-40 review (N2, N3, F4, Q8): whether restore would run at all is restore's OWN reading of the rig's DB-running
// session rows against tmux (restore-running-sessions.ts classifyRunningSessions): EVERY row with raw status `running`,
// each probed by its own name; a live or unreadable row refuses the rig (rig_not_stopped), a dead one is stale. The
// check asks the same function, with the same tmux answers. These rows run the REAL RestoreOrchestrator and the REAL
// RestoreCheckService (built with the harness tmux, so it probes) over the same tmux double, shaped after the snapshot.
//
// Production consequence: before this, the check judged only each seat's newest inventory row, after an identity
// verdict may have relabelled it. A seat restore refuses the whole rig for was treated as one restore would run, so a
// seat-gate stop of the snapshot turned the recovery verdict into a generic "blocked" and hid the real reason (a live
// seat, or tmux unreadable), as Q1 to Q3 below show.
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator; server.ts mounts routes/restore-check.ts, which wires
// classifyRunningSessions into the check from the same module restore calls.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";

const SEAT = "dev.impl";

describe("restore-check and restore agree on whether the rig would run, over every DB-running row", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());
  const exists = (p: string) => fs.existsSync(p);
  const dropToken = (nodeId: string) => h.db.prepare("UPDATE sessions SET resume_token = NULL WHERE node_id = ?").run(nodeId);
  /** What tmux answers for each session name; anything not listed answers absent. */
  function tmuxSays(table: Record<string, "present" | "absent" | "throw">) {
    (h.tmux.hasSession as any).mockImplementation(async (name: string) => {
      const answer = table[name] ?? "absent";
      if (answer === "throw") throw new Error("tmux probe failed (injected)");
      return answer === "present";
    });
  }
  /** An applicable identity verdict that relabels the seat's running row `detached` in the inventory. */
  const sessionMissingVerdict = (s: { nodeId: string; sessionName: string }) => {
    const pane = (h.db.prepare("SELECT tmux_pane AS p FROM bindings WHERE node_id = ?").get(s.nodeId) as { p: string | null } | undefined)?.p ?? null;
    h.db.prepare("INSERT OR REPLACE INTO seat_identity_verdicts (node_id, verdict, evidence_source, reason, registered_pane, session_name, observed_at) VALUES (?, 'pane_missing', 'tmux_session', 'session_missing', ?, ?, ?)")
      .run(s.nodeId, pane, s.sessionName, new Date(Date.now() + 2000).toISOString());
  };

  type Seat = { rigId: string; nodeId: string; sessionName: string };
  interface Row {
    name: string;
    /** DB shaping BEFORE the capture, so the snapshot is the one a pre-down capture of this state writes. */
    pre?(s: Seat): void;
    /** tmux shaping AFTER the capture. */
    tmux(s: Seat): void | Promise<void>;
    withTmux?: boolean;
    /** Restore: the rig is refused (rig_not_stopped), or it runs and the seat ends in this status. */
    restore: "refused" | "awaiting-decision" | "resumed-or-attention";
    /** The check names restore's seat-gate stop (only when restore runs and stops the seat). */
    predictsGate: boolean;
    recovery?: "not_needed" | "blocked" | "unknown" | "actionable";
    /** Words recovery's reason must (or must not) carry. */
    reasonHas?: string;
    reasonLacks?: string;
    /** OF-47: recovery proposes no restore command (restore refuses this rig, so none would be accepted). */
    noRestoreCommand?: boolean;
    /** OF-47: the seat checks' own remediation (not only the recovery plan) offers "Restore or relaunch" (restore runs)
     *  or does not (restore refuses the rig). */
    seatRemediationOffersRestore?: boolean;
    checkStatus?: "red" | "yellow" | "green";
  }
  const ROWS: Row[] = [
    // Q1 / Q2: an applicable session_missing verdict relabels the running row, but restore reads the raw status.
    { name: "Q1 identity verdict session_missing on the DB-running row, tmux LIVE: restore refuses", pre: (s) => dropToken(s.nodeId), tmux: (s) => { sessionMissingVerdict(s); tmuxSays({ [s.sessionName]: "present" }); }, restore: "refused", predictsGate: false, recovery: "blocked", reasonLacks: "restore-input blockers", seatRemediationOffersRestore: false },
    { name: "Q2 identity verdict session_missing on the DB-running row, tmux probe THROWS: restore refuses, liveness unknown", pre: (s) => dropToken(s.nodeId), tmux: (s) => { sessionMissingVerdict(s); tmuxSays({ [s.sessionName]: "throw" }); }, restore: "refused", predictsGate: false, recovery: "unknown", seatRemediationOffersRestore: false },
    // Q3 (OF-47): an older row still running (and live) under a newer exited one: only the all-rows reading sees it.
    // Recovery must read the same classification, so it never advises `rig up --existing`, which restore refuses.
    { name: "Q3 older running row LIVE under a newer exited row: restore refuses, recovery advises no restore command", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", reasonHas: "rig_not_stopped", reasonLacks: "restore-input blockers", noRestoreCommand: true, seatRemediationOffersRestore: false },
    // T6 (OF-47): two rows running on one seat, the older one live, the newest dead. The seat's newest row reads dead
    // (so a per-seat reading advises a restore), but restore probes every running row and refuses on the live one.
    { name: "T6 two running rows on one seat, older LIVE, newest dead: restore refuses, recovery advises no restore command", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", reasonHas: "rig_not_stopped", noRestoreCommand: true, seatRemediationOffersRestore: false },
    // T6c (OF-47): as T6 but the newest row also reads running/ready, so the seat's own check calls it a stale DB state
    // (running/ready, tmux absent) and its remediation must not offer the restore that restore refuses.
    { name: "T6c two running rows on one seat, older LIVE, newest running/ready but dead: restore refuses, seat remediation offers no restore", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
      h.db.prepare("UPDATE sessions SET startup_status = 'ready' WHERE id = ?").run(newer.id);
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true, seatRemediationOffersRestore: false },
    // T6b (OF-47): as T6 but the older running row's tmux answer is unreadable: restore fails closed, so recovery is unknown.
    { name: "T6b two running rows on one seat, older row's tmux probe THROWS, newest dead: restore refuses, recovery unknown", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "throw" }), restore: "refused", predictsGate: false, recovery: "unknown", noRestoreCommand: true, seatRemediationOffersRestore: false },
    // N3: an unreadable DB-running seat means restore refuses (fail closed).
    { name: "Q6 DB running, tmux probe THROWS, no-token seat: restore refuses, recovery unknown", pre: (s) => dropToken(s.nodeId), tmux: (s) => tmuxSays({ [s.sessionName]: "throw" }), restore: "refused", predictsGate: false, recovery: "unknown" },
    { name: "Q7 DB running, tmux LIVE, no-token seat: restore refuses, nothing to recover", pre: (s) => dropToken(s.nodeId), tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "not_needed" },
    // Stale: a dead DB-running row does not stop restore, so its seat gates are the answer.
    { name: "Q5 DB running, tmux DEAD (stale), no-token seat: restore runs and stops the seat", pre: (s) => dropToken(s.nodeId), tmux: async (s) => { await h.tmux.killSession(s.sessionName); tmuxSays({}); }, restore: "awaiting-decision", predictsGate: true, recovery: "blocked", reasonHas: "Original session unresumable", checkStatus: "red" },
    // Controls: a token present means the seat resumes (restore goes on to a resume attempt, outside these gates).
    { name: "Q9 control: DB running, tmux LIVE, token present", tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "not_needed" },
    { name: "Q10 control: DB running, tmux DEAD, token present", tmux: async (s) => { await h.tmux.killSession(s.sessionName); tmuxSays({}); }, restore: "resumed-or-attention", predictsGate: false, recovery: "actionable", seatRemediationOffersRestore: true },
  ];

  it.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    row.pre?.(seat);
    const snapshotId = (h.snapshotCapture.captureSnapshot(seat.rigId, "auto-pre-down") as { id: string }).id;
    await row.tmux(seat);

    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    const out: any = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);

    const refused = !out.ok && out.code === "rig_not_stopped";
    const node = out.ok ? out.result.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT) : undefined;
    expect(refused ? "refused" : node?.status === "awaiting-decision" ? "awaiting-decision" : "resumed-or-attention", `the table's own expectation of restore: ${JSON.stringify(out.ok ? node : out.code)}`).toBe(row.restore);
    const predictedGate = pre.evidence.includes("Restore would not start");
    expect(predictedGate, pre.evidence).toBe(row.predictsGate);
    if (row.predictsGate) expect(pre.evidence).toContain(node.error);
    if (row.checkStatus) expect(pre.status, pre.evidence).toBe(row.checkStatus);
    if (row.recovery) expect(result.recovery.status, JSON.stringify(result.recovery)).toBe(row.recovery);
    const reasons = JSON.stringify([...result.recovery.blocked, ...result.recovery.unknown].map((r) => r.reason));
    if (row.reasonHas) expect(reasons).toContain(row.reasonHas);
    if (row.reasonLacks) expect(reasons).not.toContain(row.reasonLacks);
    if (row.seatRemediationOffersRestore !== undefined) {
      const seatRemediations = result.checks.filter((c) => c.check.startsWith("seat.") && c.status !== "green").map((c) => c.remediation);
      expect(seatRemediations.length, "the population of non-green seat checks the remediation claim is read from").toBeGreaterThan(0);
      expect(seatRemediations.some((r) => /Restore or relaunch/.test(r)), JSON.stringify(seatRemediations)).toBe(row.seatRemediationOffersRestore);
    }
    if (row.noRestoreCommand) expect(result.recovery.actions, "recovery must not propose a restore command restore refuses").toEqual([]);
  });

  // OF-47: the two ends of the classification dependency. Same seat as Q10 (token present, tmux dead), where restore runs
  // and recovery is actionable; only what the check is told about restore's running-row rule changes.
  describe("recovery when restore's running-row rule is not answerable", () => {
    async function recoveryWith(classify: unknown) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      h.snapshotCapture.captureSnapshot(seat.rigId, "auto-pre-down");
      await h.tmux.killSession(seat.sessionName);
      tmuxSays({});
      const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
      (service as unknown as { deps: { classifyRunningSessions: unknown } }).deps.classifyRunningSessions = classify;
      return service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
    }
    it("T7 the rule was asked and failed: recovery is unknown and proposes no restore command", async () => {
      const result = await recoveryWith(async () => { throw new Error("classification failed (injected)"); });
      expect(result.recovery.status, JSON.stringify(result.recovery)).toBe("unknown");
      expect(result.recovery.actions).toEqual([]);
    });
    it("T8 control: the rule was never asked (no classification wired): the seats' own liveness is all there is, recovery stays actionable", async () => {
      const result = await recoveryWith(undefined);
      expect(result.recovery.status, JSON.stringify(result.recovery)).toBe("actionable");
      expect(result.recovery.actions.map((a) => a.command)).toEqual(["rig up --existing team"]);
    });
  });
});
