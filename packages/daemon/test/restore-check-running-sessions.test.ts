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
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";

const SEAT = "dev.impl";

describe("restore-check and restore agree on whether the rig would run, over every DB-running row", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
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

  /** Another rig "other" with a running seat that carries this tmux name (optionally an archived rig). */
  function namesake(sessionName: string, archived: boolean, rigName = "other") {
    const other = h.rigRepo.createRig(rigName);
    const node = h.rigRepo.addNode(other.id, "dev.other", { runtime: "claude-code", cwd: "/" });
    const row = h.sessionRegistry.registerSession(node.id, sessionName);
    h.sessionRegistry.updateStatus(row.id, "running");
    if (archived) h.db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), other.id);
  }
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
    /** OF-47: words the recovery reasons must carry / must not carry, from the seat (the live session's name, the command). */
    adviceHas?: (s: Seat) => string[];
    adviceLacks?: (s: Seat) => string[];
    checkStatus?: "red" | "yellow" | "green";
  }
  /** The advice for a live older running row, restated independently of the code: the session by name, the commands that
   *  end it (OF-54: rig down ends an older live row, rig seat stop ends one seat's; OF-66: no hand-run tmux kill is offered,
   *  because the rig commands cover every row), and never the pre-OF-54 claim that they act on the newest row only. */
  const liveAdvice = (s: Seat) => [
    `live: ${s.sessionName};`,
    `rig down team ends ${s.sessionName} (and stops the rest of the rig), as does rig seat stop <seat> for just that seat's live sessions. `,
    "rig capture -- " + s.sessionName,
  ];
  const liveAdviceLacks = () => ["do not end it", "newest session row only", "tmux ls", "tmux kill-session", "end it yourself"];
  const ROWS: Row[] = [
    // Q1 / Q2: an applicable session_missing verdict relabels the running row, but restore reads the raw status.
    { name: "Q1 identity verdict session_missing on the DB-running row, tmux LIVE: restore refuses", pre: (s) => dropToken(s.nodeId), tmux: (s) => { sessionMissingVerdict(s); tmuxSays({ [s.sessionName]: "present" }); }, restore: "refused", predictsGate: false, recovery: "blocked", reasonLacks: "restore-input blockers" },
    { name: "Q2 identity verdict session_missing on the DB-running row, tmux probe THROWS: restore refuses, liveness unknown", pre: (s) => dropToken(s.nodeId), tmux: (s) => { sessionMissingVerdict(s); tmuxSays({ [s.sessionName]: "throw" }); }, restore: "refused", predictsGate: false, recovery: "unknown", seatRemediationOffersRestore: false },
    // Q3 (OF-47): an older row still running (and live) under a newer exited one: only the all-rows reading sees it.
    // Recovery must read the same classification, so it never advises `rig up --existing`, which restore refuses.
    { name: "Q3 older running row LIVE under a newer exited row: restore refuses, recovery advises no restore command", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", reasonHas: "rig_not_stopped", reasonLacks: "restore-input blockers", noRestoreCommand: true, seatRemediationOffersRestore: false, adviceHas: liveAdvice,
      // OF-144: this older row was launched, so no adopted-session sentence is added.
      adviceLacks: () => [...liveAdviceLacks(), "adopted", "rig unclaim"] },
    // OF-144: the same shape with the older live row ADOPTED. The route tells the check which refusing rows were adopted, and the
    // advice releases this one by its own session id (rig unclaim needs one; releasing an older row leaves the occupant alone).
    { name: "Q3a older running row LIVE and ADOPTED under a newer exited row: the advice names rig unclaim <its id>", pre: (s) => {
      dropToken(s.nodeId);
      h.db.prepare("UPDATE sessions SET origin = 'claimed' WHERE node_id = ? AND session_name = ?").run(s.nodeId, s.sessionName);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true,
      adviceHas: (s) => [...liveAdvice(s), `${s.sessionName} was adopted (not launched by OpenRig): rig down ends its row but leaves its tmux session running, and rig seat stop refuses it; release it with rig unclaim ${(h.db.prepare("SELECT id FROM sessions WHERE node_id = ? AND session_name = ?").get(s.nodeId, s.sessionName) as { id: string }).id}. `],
      adviceLacks: () => [...liveAdviceLacks(), "rig unclaim <session-id>", "release it with rig unclaim. "] },
    // N1 (OF-47 safety): the tmux probe is global by NAME. Another rig's live seat holds the very name this rig's older running
    // row carries; killing the session would end that other seat. The advice names the owner and gives no kill command.
    { name: "N1 older running row's live name is held by another rig's seat: advice names the owner, no kill command", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
      namesake(s.sessionName, false);
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true,
      // The whole held clause, as one sentence: a half-replaced or duplicated clause must fail this.
      adviceHas: (s) => [`${s.sessionName} is held by dev.other@other, another rig's seat: do not kill it from here, it would end that seat; rig down team ends only this rig's older running row for it, without touching that session, which is what lets restore run. Probing stops`],
      adviceLacks: (s) => ["tmux kill-session", "end it yourself", "needs manual attention", "no command here frees it", `rig down team ends ${s.sessionName}`, "(and stops the rest of the rig), as does rig seat stop", "a seat of this rig", "older running row for it rig down", "that seat included"] },
    // N3: the holder is a seat of THIS rig (its own older row carries the name). rig down stops that seat too, so
    // "without touching that session" would be false; the advice says only what the rows end.
    { name: "N3 older running row's live name is held by a seat of the SAME rig: no 'without touching' promise", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
      const peer = h.rigRepo.addNode(s.rigId, "dev.peer", { runtime: "claude-code", cwd: "/" });
      h.db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(peer.id);
      h.sessionRegistry.updateStatus(h.sessionRegistry.registerSession(peer.id, s.sessionName).id, "running");
      h.sessionRegistry.updateStatus(h.sessionRegistry.registerSession(peer.id, "dev-peer-newer@team").id, "exited");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true,
      adviceHas: (s) => [`${s.sessionName} is held by dev.peer@team, a seat of this rig: do not kill it from here, it would end that seat; rig down team ends this rig's running rows for it, which is what lets restore run; it may leave the tmux session itself running (a name another seat still claims is not killed), so check it afterwards (rig capture -- ${s.sessionName}) and end it yourself if it is no longer wanted. Probing stops`],
      adviceLacks: (s) => ["tmux kill-session", "without touching that session", `rig down team ends ${s.sessionName}`, "(and stops the rest of the rig), as does rig seat stop", "another rig's seat", "that seat included", "stops the rest of the rig"] },
    // N4/N5: "a seat of this rig" is decided by rig ID, not by the rig's name. Rig names are not unique, so a DIFFERENT rig that is
    // also called "team" (N4), or whose name merely contains it (N5), is still another rig: down leaves its session alone.
    ...(["team", "team-b"] as const).map((otherName, i) => ({
      name: `N${4 + i} older running row's live name is held by a DIFFERENT rig named "${otherName}": still another rig's seat`,
      pre: (s: Seat) => {
        dropToken(s.nodeId);
        const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
        h.sessionRegistry.updateStatus(newer.id, "exited");
        namesake(s.sessionName, false, otherName);
      },
      tmux: (s: Seat) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused" as const, predictsGate: false, recovery: "blocked" as const, noRestoreCommand: true,
      // OF-76: `rig down team` halts as ambiguous while two active rigs carry the name, so a shared name is given by the rig's id.
      adviceHas: (s: Seat) => [`${s.sessionName} is held by dev.other@${otherName}, another rig's seat: do not kill it from here, it would end that seat; rig down ${otherName === "team" ? s.rigId : "team"} ends only this rig's older running row for it, without touching that session, which is what lets restore run. Probing stops`],
      adviceLacks: (s: Seat) => ["a seat of this rig", "may leave the tmux session itself running", "tmux kill-session", ...(otherName === "team" ? ["rig down team "] : [`rig down ${s.rigId}`])],
    })),
    // N2 control: the namesake sits in an ARCHIVED rig (teardown ignores those owners too), so rig down is still the advice.
    { name: "N2 control: the same name in an ARCHIVED rig does not hold it, rig down is still the advice", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
      namesake(s.sessionName, true);
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true,
      adviceHas: (s) => [`rig down team ends ${s.sessionName} (and stops the rest of the rig)`], adviceLacks: () => ["is held by", "tmux kill-session"] },
    // N7 (OF-116 V7): the holder is a RELEASED session (`rig unclaim` marks an adopted session detached and clears its binding
    // while its tmux session lives on as the person's own). Teardown will not kill that name (countReleased), so the advice
    // must name the holder and give no kill command, exactly as for a running namesake (N1).
    { name: "N7 older running row's live name is held by another rig's RELEASED (detached claimed) session: advice names the holder, no kill command", pre: (s) => {
      dropToken(s.nodeId);
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "exited");
      const other = h.rigRepo.createRig("other");
      const node = h.rigRepo.addNode(other.id, "dev.other", { runtime: "claude-code", cwd: "/" });
      const released = h.sessionRegistry.registerSession(node.id, s.sessionName);
      h.db.prepare("UPDATE sessions SET status = 'detached', origin = 'claimed' WHERE id = ?").run(released.id);
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true,
      adviceHas: (s) => [`${s.sessionName} is held by dev.other@other, another rig's seat: do not kill it from here, it would end that seat; rig down team ends only this rig's older running row for it, without touching that session, which is what lets restore run. Probing stops`],
      adviceLacks: (s) => ["tmux kill-session", "end it yourself", `rig down team ends ${s.sessionName}`, "(and stops the rest of the rig), as does rig seat stop"] },
    // T6 (OF-47): two rows running on one seat, the older one live, the newest dead. The seat's newest row reads dead
    // (so a per-seat reading advises a restore), but restore probes every running row and refuses on the live one.
    { name: "T6 two running rows on one seat, older LIVE, newest dead: restore refuses, recovery advises no restore command", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", reasonHas: "rig_not_stopped", noRestoreCommand: true, seatRemediationOffersRestore: false, adviceHas: liveAdvice, adviceLacks: liveAdviceLacks },
    // T6c (OF-47): as T6 but the newest row also reads running/ready, so the seat's own check calls it a stale DB state
    // (running/ready, tmux absent) and its remediation must not offer the restore that restore refuses.
    { name: "T6c two running rows on one seat, older LIVE, newest running/ready but dead: restore refuses, seat remediation offers no restore", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
      h.db.prepare("UPDATE sessions SET startup_status = 'ready' WHERE id = ?").run(newer.id);
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "present" }), restore: "refused", predictsGate: false, recovery: "blocked", noRestoreCommand: true, seatRemediationOffersRestore: false, adviceHas: liveAdvice, adviceLacks: liveAdviceLacks },
    // T6b (OF-47): as T6 but the older running row's tmux answer is unreadable: restore fails closed, so recovery is unknown.
    { name: "T6b two running rows on one seat, older row's tmux probe THROWS, newest dead: restore refuses, recovery unknown", pre: (s) => {
      const newer = h.sessionRegistry.registerSession(s.nodeId, "dev-impl-newer@team");
      h.sessionRegistry.updateStatus(newer.id, "running");
    }, tmux: (s) => tmuxSays({ [s.sessionName]: "throw" }), restore: "refused", predictsGate: false, recovery: "unknown", noRestoreCommand: true, seatRemediationOffersRestore: false, adviceHas: (s) => [`could not be read for ${s.sessionName},`], adviceLacks: () => ["could not be answered", "tmux kill-session"] },
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
    for (const word of row.adviceHas?.(seat) ?? []) expect(reasons, `the advice names ${word}`).toContain(word);
    for (const word of row.adviceLacks?.(seat) ?? []) expect(reasons, `the advice must not carry ${word}`).not.toContain(word);
    if (row.seatRemediationOffersRestore !== undefined) {
      const seatRemediations = result.checks.filter((c) => c.check.startsWith("seat.") && c.status !== "green").map((c) => c.remediation);
      expect(seatRemediations.length, "the population of non-green seat checks the remediation claim is read from").toBeGreaterThan(0);
      expect(seatRemediations.some((r) => /rig up --existing team \(resumes its conversation\)/.test(r)), JSON.stringify(seatRemediations)).toBe(row.seatRemediationOffersRestore);
    }
    if (row.noRestoreCommand) expect(result.recovery.actions, "recovery must not propose a restore command restore refuses").toEqual([]);
  });

  // OF-47 end to end: the advice for a live older running row names the rig commands (OF-66: no hand-run tmux kill), and once
  // the session is gone restore must not answer rig_not_stopped. The session's end is mirrored into the tmux double restore reads.
  describe("following the advice for an older live running row lets restore run", () => {
    const SHAPES = ROWS.filter((r) => /^(Q3|T6) /.test(r.name));
    it("the population: both shapes the bead names", () => expect(SHAPES.map((r) => r.name.split(" ")[0])).toEqual(["Q3", "T6"]));
    it.each(SHAPES.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      row.pre?.(seat);
      const snapshotId = (h.snapshotCapture.captureSnapshot(seat.rigId, "auto-pre-down") as { id: string }).id;
      await row.tmux(seat);
      const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
      const before = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
      const reason = before.recovery.blocked.map((r) => r.reason).join(" ");
      expect(reason, "the advice names the rig commands that end the row").toContain(`rig down team ends ${seat.sessionName}`);
      expect(reason, "OF-66: the advice offers no hand-run tmux kill").not.toContain("tmux kill-session");
      // T6's seat has a dead newest row too: the advice says up front that rig up --existing then fails it (measured below).
      expect(reason.includes("Active-occupant ambiguity"), "the ambiguity warning is part of the advice").toBe(true);
      // The session ends (restore sees the row stale) ...
      await h.tmux.killSession(seat.sessionName);
      tmuxSays({});
      // ... and restore no longer refuses. The restore is the one rig up --existing runs: the pre-down snapshot when it still
      // names the current occupants, else a capture of the current state (routes/up.ts).
      const rig = h.rigRepo.getRig(seat.rigId)!;
      const pre = h.snapshotRepo.getSnapshot(snapshotId)!;
      const restoreFrom = snapshotMatchesCurrentOccupants(h.db, rig, pre) ? snapshotId : (h.snapshotCapture.captureSnapshot(seat.rigId, "auto-rehydrate") as { id: string }).id;
      const out: any = await h.restore.restore(restoreFrom, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      expect(out.ok ? "ran" : out.code, JSON.stringify(out.ok ? "" : out.message)).not.toBe("rig_not_stopped");
      const node = out.result.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT);
      // The real outcome, per shape: Q3's seat has no resume token (awaiting-decision at its own gate); T6's snapshot holds
      // two running rows for the seat, so restore FAILS it as an active-occupant ambiguity.
      expect(node.status, JSON.stringify(node)).toBe(row.name.startsWith("T6 ") ? "failed" : "awaiting-decision");
      if (row.name.startsWith("T6 ")) expect(node.error).toContain("Active-occupant ambiguity: 2 candidate session rows");
      const after = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
      // The check, asked again once nothing is live, predicts exactly that stop (restore's own text) and advises no restore.
      const afterReasons = JSON.stringify(after.recovery.blocked.map((r) => r.reason));
      expect(after.recovery.status, JSON.stringify(after.recovery)).toBe("blocked");
      expect(after.recovery.actions).toEqual([]);
      expect(afterReasons, "the check predicts the stop restore reports").toContain(JSON.stringify(node.error.split(" — ")[0]).slice(1, -1));
      expect(afterReasons, "the live-row advice is gone once the row is not live").not.toContain("rig down team ends");
    });
    // OF-54: the real teardown used to act only on each seat's newest row, so for these shapes it ended nothing live and
    // restore kept refusing (this row pinned that). It now ends the older live row too.
    it.each(SHAPES.map((row) => [row.name, row] as const))("%s: rig down ends the older live row, so restore no longer refuses rig_not_stopped", async (_name, row) => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      row.pre?.(seat);
      const snapshotId = (h.snapshotCapture.captureSnapshot(seat.rigId, "auto-pre-down") as { id: string }).id;
      await row.tmux(seat);
      const down = await new RigTeardownOrchestrator({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db) }).teardown(seat.rigId);
      // The tmux double reads a fixed table, so teardown's kill is mirrored into it (as the advice test does after its kill).
      expect(down, "teardown killed the one live older session and reported no error").toMatchObject({ sessionsKilled: 1, errors: [] });
      expect(h.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'running'").get(), "no DB-running row is left").toEqual({ c: 0 });
      tmuxSays({});
      const out: any = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      expect(out.ok ? "ran" : out.code, JSON.stringify(out.ok ? "" : out.message)).not.toBe("rig_not_stopped");
      // OF-116 F7: what rig up --existing really does after the real down, from the snapshot the real teardown took (routes/up.ts
      // selection). rig down now ends a seat's older duplicate live row BEFORE it takes that snapshot, so a T6 seat's snapshot
      // records ONE running occupant (its newer row) and restore no longer fails the seat as an active-occupant ambiguity: both
      // shapes reach the seat's own no-token gate, which asks for a decision (rig seat launch --fresh).
      const rig = h.rigRepo.getRig(seat.rigId)!;
      const downSnap = h.snapshotRepo.getSnapshot(down.snapshotId!)!;
      const from = snapshotMatchesCurrentOccupants(h.db, rig, downSnap) ? down.snapshotId! : (h.snapshotCapture.captureSnapshot(seat.rigId, "auto-rehydrate") as { id: string }).id;
      const up: any = await h.restore.restore(from, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      const upNode = up.result.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT);
      expect(upNode.status, JSON.stringify(upNode)).toBe("awaiting-decision");
      expect(upNode.error, "the seat is no longer an active-occupant ambiguity").not.toContain("Active-occupant ambiguity");
      expect(upNode.error).toContain("Original session unresumable");
    });
  });

  // OF-47: the two ends of the classification dependency. Same seat as Q10 (token present, tmux dead), where restore runs
  // and recovery is actionable; only what the check is told about restore's running-row rule changes.
  describe("recovery when restore's running-row rule is not answerable", () => {
    async function recoveryWith(classify: unknown, before?: () => void) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      before?.();
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
      const reasons = JSON.stringify(result.recovery.unknown.map((r) => r.reason));
      expect(reasons).toContain("could not be answered");
      expect(reasons).not.toContain("could not be read for");
    });
    // OF-144: the adopted-session sentence follows what the classification says about the refusing row. The row is the seat's
    // own (its session killed above, so only the classification calls it live).
    const liveRow = (adopted: "unsaid" | "this row" | "none") => async () => {
      const row = h.db.prepare("SELECT id, session_name FROM sessions").get() as { id: string; session_name: string };
      return { live: [row.id], stale: [], unknown: [], sessionNames: { [row.id]: row.session_name },
        ...(adopted === "unsaid" ? {} : { adoptedSessionIds: adopted === "this row" ? [row.id] : [] }) };
    };
    const rowId = () => (h.db.prepare("SELECT id FROM sessions").get() as { id: string }).id;
    it("T9 the classification does not say which rows were adopted: the advice keeps the general sentence, with a placeholder, not a bare command", async () => {
      const result = await recoveryWith(liveRow("unsaid"));
      const reasons = JSON.stringify(result.recovery.blocked.map((r) => r.reason));
      expect(reasons).toContain("An adopted session is the exception: rig down ends its row but leaves the tmux session running, and rig seat stop refuses it; release it with rig unclaim <session-id>. ");
    });
    it("T10 it says the row was adopted: the advice names that row's id", async () => {
      const result = await recoveryWith(liveRow("this row"));
      const reasons = JSON.stringify(result.recovery.blocked.map((r) => r.reason));
      expect(reasons).toContain(`dev-impl@team was adopted (not launched by OpenRig): rig down ends its row but leaves its tmux session running, and rig seat stop refuses it; release it with rig unclaim ${rowId()}. `);
      expect(reasons).not.toContain("<session-id>");
    });
    it("T11 control: it says no row was adopted: no adopted-session sentence", async () => {
      const result = await recoveryWith(liveRow("none"));
      const reasons = JSON.stringify(result.recovery.blocked.map((r) => r.reason));
      expect(reasons, "the population: the running-row advice is there").toContain("rig down team ends dev-impl@team");
      expect(reasons).not.toContain("adopted");
      expect(reasons).not.toContain("rig unclaim");
    });
    // OF-152: an archived rig whose id is this rig's name. An id wins (archived included), so `rig up --existing team` would reach
    // the archived rig and be refused (rig_archived); the advice gives this rig's id. The real route wiring is under test.
    it("T12 an archived rig's id equals this rig's name: the advised restore names this rig by its id", async () => {
      const result = await recoveryWith(undefined, () => {
        const old = h.rigRepo.createRig("old");
        h.rigRepo.archiveRig(old.id);
        h.db.prepare("UPDATE rigs SET id = 'team' WHERE id = ?").run(old.id);
      });
      const rigId = (h.db.prepare("SELECT id FROM rigs WHERE name = 'team'").get() as { id: string }).id;
      expect(result.recovery.actions.map((a) => a.command)).toEqual([`rig up --existing ${rigId}`]);
    });
    it("T8 control: the rule was never asked (no classification wired): the seats' own liveness is all there is, recovery stays actionable", async () => {
      const result = await recoveryWith(undefined);
      expect(result.recovery.status, JSON.stringify(result.recovery)).toBe("actionable");
      expect(result.recovery.actions.map((a) => a.command)).toEqual(["rig up --existing team"]);
    });
  });
});
