// OF-255. The laptop's eztrack rig: two seats were relaunched with `rig seat launch --fresh`, the host shut down,
// and `rig up eztrack --existing` then refused ("restore snapshots name an older occupant", then "Active-occupant
// ambiguity: 0 candidate session rows") for exactly those two seats. This file replays that sequence end to end through
// the real routes: fresh relaunch -> host shutdown (startup reconcile detaches the rows it finds dead) -> the operator's
// `rig down` -> `rig up --existing`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { deriveRehydrateOccupantsByNode } from "../src/domain/active-occupant.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";

type Seat = "cos" | "arch" | "screen";

describe("rig up --existing after seats were relaunched fresh and the host shut down (OF-255)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let tmuxAdapter: ReturnType<typeof createTestApp>["tmuxAdapter"];

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
    tmuxAdapter = setup.tmuxAdapter;
  });
  afterEach(() => { db.close(); });

  /** One seat with an earlier occupant (exited) and a live occupant carrying `liveToken`. `fresh` records the
   *  deliberate `rig seat launch --fresh` effect (its seat.fresh_launched event) exactly as the launch writes it. */
  function seedSeat(rigId: string, name: Seat, fresh: boolean) {
    const node = rigRepo.addNode(rigId, name, { runtime: "claude-code" });
    const earlier = sessionRegistry.registerSession(node.id, `${name}@eztrack`);
    sessionRegistry.updateResumeToken(earlier.id, "claude_name", `${name}-earlier-native`, "hook");
    sessionRegistry.updateStatus(earlier.id, "running");
    if (fresh) {
      // As a real `rig seat launch --fresh` leaves it: the replaced row is superseded, not exited.
      sessionRegistry.markSuperseded(earlier.id);
    }
    const live = fresh ? sessionRegistry.registerSession(node.id, `${name}@eztrack`, "fresh") : earlier;
    if (fresh) {
      sessionRegistry.updateStatus(live.id, "running");
      sessionRegistry.updateResumeToken(live.id, "claude_name", `${name}-fresh-native`, "hook");
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rigId, JSON.stringify({
        nodeId: node.id, sessionId: live.id, newGeneration: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
      }));
    }
    return { node, live };
  }

  /** Every text restore typed into a seat: the resume commands it launched. */
  const sentTexts = () => vi.mocked(tmuxAdapter.sendText).mock.calls.map((call) => String(call[1]));

  async function post(path: string, body: unknown) {
    return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  // Which rows the host shutdown leaves "running": the live rig's reconcile detaches a row whose seat it finds dead,
  // but keeps one whose seat label a restored (empty) shell still carries. Both shapes were on the laptop.
  async function rebootThenRigDown(afterReboot: Record<Seat, "running" | "detached">) {
    const rig = rigRepo.createRig("eztrack-of255");
    const seats = { cos: seedSeat(rig.id, "cos", false), arch: seedSeat(rig.id, "arch", true), screen: seedSeat(rig.id, "screen", true) };
    // Periodic snapshots taken before the reboot name every occupant (they are not the ones the operator was refused on).
    snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
    for (const name of ["cos", "arch", "screen"] as const) {
      if (afterReboot[name] === "detached") sessionRegistry.markDetached(seats[name].live.id);
    }
    const down = await post("/api/down", { rigId: rig.id, force: true });
    expect(down.status).toBe(200);
    expect((await down.json()).errors).toEqual([]);
    for (const row of sessionRegistry.getSessionsForRig(rig.id)) expect(row.status === "exited" || row.status === "superseded").toBe(true);
    return rig;
  }

  // The harness tmux fake cannot observe a resumed Claude pane, so a restored seat reads attention_required here with
  // that one reason; what must not appear is a refusal, a seat left awaiting a decision, or a failed seat.
  const OBSERVATION = "Claude resume observation unavailable";
  const outcome = (body: { nodes?: Array<{ logicalId: string; status: string; error?: string }> }) =>
    [...(body.nodes ?? [])].sort((a, b) => a.logicalId.localeCompare(b.logicalId)).map((n) => [n.logicalId, n.status, (n.error ?? OBSERVATION).startsWith(OBSERVATION)]);

  it.each([
    ["every row found dead is detached (no seat is live, so rig down takes no snapshot: green at base)", { cos: "detached", arch: "detached", screen: "detached" }],
    ["the restored-shell rows stay running, the others detach", { cos: "running", arch: "running", screen: "detached" }],
    ["only the fresh-relaunched seats are detached", { cos: "running", arch: "detached", screen: "detached" }],
  ] as const)("brings the rig back with rig up --existing, no hand-picked snapshot: %s", async (_label, afterReboot) => {
    const rig = await rebootThenRigDown(afterReboot);
    const up = await post("/api/up", { sourceRef: rig.name });
    const body = await up.json() as { status?: string; error?: string; snapshotKind?: string; nodes?: Array<{ logicalId: string; status: string; error?: string }> };
    expect({ status: up.status, error: body.error, nodes: outcome(body) }).toEqual({
      status: 200,
      error: undefined,
      nodes: [["arch", "attention_required", true], ["cos", "attention_required", true], ["screen", "attention_required", true]],
    });
    // The conversations resumed are each seat's CURRENT occupant: the fresh one, never the one it replaced.
    const sent = sentTexts();
    expect(sent.some((text) => text.includes("arch-fresh-native"))).toBe(true);
    expect(sent.some((text) => text.includes("screen-fresh-native"))).toBe(true);
    expect(sent.some((text) => text.includes("arch-earlier-native") || text.includes("screen-earlier-native"))).toBe(false);
  });

  // F1 (review of 9ed3c0fe9): a seat relaunched fresh and then STOPPED on purpose must neither block the rig nor be brought back.
  it.each([
    ["stopped with rig seat stop", true],
    ["ended without the stop mark", false],
  ] as const)("a fresh-relaunched seat that was then %s stays stopped and does not block the rig", async (_label, deliberate) => {
    const rig = rigRepo.createRig("eztrack-of255-stopped");
    const cos = seedSeat(rig.id, "cos", false);
    const arch = seedSeat(rig.id, "arch", true);
    const screen = seedSeat(rig.id, "screen", true);
    snapshotCapture.captureSnapshot(rig.id, "auto-periodic"); // names the screen successor running: it must not be the way back
    if (deliberate) sessionRegistry.markIntentionallyStopped(screen.live.id); else sessionRegistry.updateStatus(screen.live.id, "exited");
    sessionRegistry.markDetached(arch.live.id);
    expect(sessionRegistry.getSessionsForRig(rig.id).find((row) => row.id === cos.live.id)?.status).toBe("running");
    const down = await post("/api/down", { rigId: rig.id, force: true });
    expect(down.status).toBe(200);
    const up = await post("/api/up", { sourceRef: rig.name });
    const body = await up.json() as { error?: string; nodes?: Array<{ logicalId: string; status: string }> };
    expect({ status: up.status, error: body.error }).toEqual({ status: 200, error: undefined });
    const screenOutcome = body.nodes?.find((n) => n.logicalId === "screen")?.status;
    expect(screenOutcome).toBe("awaiting-decision");
    const sent = sentTexts();
    expect(sent.some((text) => text.includes("arch-fresh-native"))).toBe(true);
    expect(sent.some((text) => text.includes("screen-fresh-native"))).toBe(false);
  });

  // F2: what Jim accepted is seats a reboot left detached; a deliberate stop NEWER than the detached row wins.
  it("a seat the operator stopped after its row was left detached stays stopped", async () => {
    const rig = rigRepo.createRig("eztrack-of255-stop-after");
    const cos = seedSeat(rig.id, "cos", false);
    const arch = seedSeat(rig.id, "arch", false);
    snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
    sessionRegistry.markDetached(arch.live.id);
    const later = sessionRegistry.registerSession(arch.node.id, "arch@eztrack");
    sessionRegistry.markIntentionallyStopped(later.id);
    expect(sessionRegistry.getSessionsForRig(rig.id).find((row) => row.id === cos.live.id)?.status).toBe("running");
    const down = await post("/api/down", { rigId: rig.id, force: true });
    expect(down.status).toBe(200);
    const up = await post("/api/up", { sourceRef: rig.name });
    const body = await up.json() as { error?: string; nodes?: Array<{ logicalId: string; status: string }> };
    expect({ status: up.status, error: body.error }).toEqual({ status: 200, error: undefined });
    expect(body.nodes?.find((n) => n.logicalId === "arch")?.status).toBe("awaiting-decision");
    expect(sentTexts().some((text) => text.includes("arch-earlier-native"))).toBe(false);
  });

  it("`rig restore-check` forecasts the same restore: no older-occupant refusal, no active-occupant ambiguity", async () => {
    const rig = await rebootThenRigDown({ cos: "running", arch: "running", screen: "detached" });
    const body = await (await app.request(`/api/restore-check?rig=${rig.name}&noQueue=true&noHooks=true`)).json() as { checks: Array<{ check: string; evidence?: string }> };
    const text = JSON.stringify(body.checks.filter((c) => c.check.startsWith(`rig.${rig.name}.`)));
    expect(text).not.toContain("older occupant");
    expect(text).not.toContain("Active-occupant ambiguity");
  });

  it("gets `rig up --existing --fresh <seat>` past the rig-level gate too", async () => {
    const rig = await rebootThenRigDown({ cos: "running", arch: "running", screen: "detached" });
    const up = await post("/api/up", { sourceRef: rig.name, freshLogicalIds: ["screen"] });
    const body = await up.json() as { error?: string; nodes?: Array<{ logicalId: string; status: string; error?: string }> };
    expect({ status: up.status, error: body.error }).toEqual({ status: 200, error: undefined });
    const screen = body.nodes?.find((n) => n.logicalId === "screen");
    expect(screen?.status).not.toBe("awaiting-decision");
    expect(screen?.status).not.toBe("failed");
    // arch was not listed: it still resumes its fresh occupant.
    const sent = sentTexts();
    expect(sent.some((text) => text.includes("arch-fresh-native"))).toBe(true);
    expect(sent.some((text) => text.includes("screen-fresh-native"))).toBe(false);
  });

  // The cause, one level down: what a snapshot of a part-detached rig records as each seat's occupant.
  describe("the occupant a snapshot records for a seat whose row the host loss detached", () => {
    function seatWith(rigName: string, statuses: Array<"running" | "detached" | "exited">) {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
      const rows = statuses.map((status) => {
        const row = sessionRegistry.registerSession(node.id, "seat@" + rigName);
        sessionRegistry.updateResumeToken(row.id, "claude_name", `native-${row.id}`, "hook");
        sessionRegistry.updateStatus(row.id, status);
        return row;
      });
      return { rig, node, rows };
    }
    const occupantIn = (rigId: string, kind: string, nodeId: string) =>
      snapshotCapture.captureSnapshot(rigId, kind).data.activeOccupantsByNode?.[nodeId];

    it("names a detached occupant when the rig is being stopped", () => {
      const { rig, node, rows } = seatWith("detached-only", ["detached"]);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: rows[0]!.id });
    });

    it("names the running row, not an older detached one", () => {
      const { rig, node, rows } = seatWith("running-over-detached", ["detached", "running"]);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: rows[1]!.id });
    });

    it("records that occupant in both relation maps a snapshot carries, so a reader of either agrees", () => {
      const { rig, node, rows } = seatWith("both-maps", ["detached"]);
      const data = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down").data;
      expect(data.activeSessionIdByNode?.[node.id]).toBe(rows[0]!.id);
      expect(data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "resolved", sessionId: rows[0]!.id });
    });

    it("names a seat with only ended rows as having no occupant: a stopped seat is not brought back", () => {
      const { rig, node } = seatWith("exited-only", ["exited", "exited"]);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "absent" });
    });

    it("keeps a deliberate fresh successor, not the occupant it replaced, when both rows are detached", () => {
      const { rig, node, rows } = seatWith("fresh-detached", ["detached"]);
      const successor = sessionRegistry.registerSession(node.id, "seat@fresh-detached", "fresh");
      sessionRegistry.markDetached(successor.id);
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({
        nodeId: node.id, sessionId: successor.id, newGeneration: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
      }));
      expect(rows[0]!.id).not.toBe(successor.id);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: successor.id });
    });

    // F5: idle and unknown are live statuses (teardown and the live-session readers count them with running). The old
    // running-only rule recorded such a seat as having no occupant and left it awaiting a decision, which is wrong for a
    // seat that is up; the new rule names it. Confirmed right, and pinned.
    it.each(["idle", "unknown"])("names a %s row as the occupant: it is a live seat, not a missing one", (status) => {
      const { rig, node, rows } = seatWith(`live-${status}`, ["running"]);
      sessionRegistry.updateStatus(rows[0]!.id, status);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: rows[0]!.id });
    });

    // F1: the fresh successor of record was stopped. Known state "no live occupant", never an ambiguity with no candidates.
    function freshSuccessorThen(rigName: string, end: (id: string) => void) {
      const { rig, node, rows } = seatWith(rigName, ["detached"]);
      sessionRegistry.markSuperseded(rows[0]!.id);
      const successor = sessionRegistry.registerSession(node.id, `seat@${rigName}`, "fresh");
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({
        nodeId: node.id, sessionId: successor.id, newGeneration: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
      }));
      end(successor.id);
      return { rig, node, successor };
    }

    it.each(["auto-pre-down", "auto-rehydrate"])("records a stopped fresh successor as no live occupant, not an ambiguity (%s)", (kind) => {
      const { rig, node } = freshSuccessorThen(`stopped-successor-${kind}`, (id) => sessionRegistry.markIntentionallyStopped(id));
      const data = snapshotCapture.captureSnapshot(rig.id, kind).data;
      expect(data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "absent" });
      expect(data.activeSessionIdByNode?.[node.id]).toBeNull();
    });

    it("keeps a stopped fresh successor with a live row behind it loud: that contradiction is not guessed", () => {
      // The registry fences a relation by generation, so a live row behind a stopped successor does not arise through it;
      // the rule is asked directly.
      const rows = [
        { id: "01A", nodeId: "n", status: "exited", intentionallyStopped: true },
        { id: "01B", nodeId: "n", status: "running" },
      ];
      expect(deriveRehydrateOccupantsByNode(rows, ["n"], { n: "01A" }).n).toEqual({ kind: "ambiguous", candidateIds: ["01B"] });
    });

    it("still refuses a relation that names a superseded row: only an ended occupant of record reads as stopped", () => {
      const rows = [{ id: "01A", nodeId: "n", status: "superseded" }];
      expect(deriveRehydrateOccupantsByNode(rows, ["n"], { n: "01A" }).n).toEqual({ kind: "ambiguous", candidateIds: [] });
    });

    it("still refuses a relation that names no row of the seat at all", () => {
      const { rig, node } = freshSuccessorThen("dangling-successor", () => undefined);
      db.prepare("UPDATE events SET payload = json_set(payload, '$.sessionId', 'missing') WHERE type = 'seat.fresh_launched'").run();
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toMatchObject({ kind: "ambiguous" });
    });

    // F2: the key is the stop mark (exited + intentionally_stopped), set by markIntentionallyStopped (rig seat stop, rig down).
    it("leaves a seat stopped after its row was left detached with no occupant", () => {
      const { rig, node } = seatWith("stopped-after-detached", ["detached"]);
      const later = sessionRegistry.registerSession(node.id, "seat@stopped-after-detached");
      sessionRegistry.markIntentionallyStopped(later.id);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "absent" });
    });

    it("keeps a detached row that only a plain observed exit (no stop mark) came after", () => {
      const { rig, node, rows } = seatWith("exit-after-detached", ["detached", "exited"]);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: rows[0]!.id });
    });

    it("keeps a detached row that an OLDER deliberate stop precedes", () => {
      const { rig, node } = seatWith("stop-before-detached", ["exited"]);
      const stopped = sessionRegistry.getSessionsForRig(rig.id)[0]!;
      sessionRegistry.markIntentionallyStopped(stopped.id);
      const detached = sessionRegistry.registerSession(node.id, "seat@stop-before-detached");
      sessionRegistry.markDetached(detached.id);
      expect(occupantIn(rig.id, "auto-pre-down", node.id)).toEqual({ kind: "resolved", sessionId: detached.id });
    });

    it("agrees across the three readers: capture, the match check and the live preview all see the stopped-after seat as having no occupant", () => {
      const { rig, node } = seatWith("three-readers", ["detached"]);
      const later = sessionRegistry.registerSession(node.id, "seat@three-readers");
      sessionRegistry.markIntentionallyStopped(later.id);
      const current = rigRepo.getRig(rig.id)!;
      const snapshot = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      // match: current state (the stop wins over the older detached row) holds no occupant either, so the snapshot matches.
      expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(true);
      // preview of the no-snapshot restore: the would-capture derivation, over the live rows.
      const preview = buildRestorePlanPreview(current, null, collectPreviewSessionRows(db, current, null), undefined, Date.now(), readFreshOccupantRelations(db, rig.id));
      expect(preview.nodes[0]!.intendedAction).not.toBe("resume-original");
    });

    // Scope pin: only the snapshot taken as a rig is stopped reads lost occupants. The routine snapshots keep the
    // running-only rule, so this change does not alter what they record.
    it.each(["manual", "auto-periodic"])("leaves a %s snapshot on the running-only rule", (kind) => {
      const { rig, node } = seatWith(`scope-${kind}`, ["detached"]);
      expect(occupantIn(rig.id, kind, node.id)).toEqual({ kind: "absent" });
    });
  });

  // R1/R2 (round-2 review): the match check is the safety-critical part. One direct row per way a STALE snapshot could be
  // accepted. `S` is the seat's fresh successor, stopped; the snapshot below was captured while it was stopped.
  describe("snapshotMatchesCurrentOccupants refuses every stale snapshot the new rules could admit", () => {
    const match = (rigId: string, snapshot: Parameters<typeof snapshotMatchesCurrentOccupants>[2]) =>
      snapshotMatchesCurrentOccupants(db, rigRepo.getRig(rigId)!, snapshot);
    const withSessions = (snapshot: ReturnType<SnapshotCapture["captureSnapshot"]>, edit: (rows: Array<{ id: string; status: string }>) => unknown[]) =>
      ({ ...snapshot, data: { ...snapshot.data, sessions: edit(snapshot.data.sessions as Array<{ id: string; status: string }>) } }) as typeof snapshot;

    function stoppedSuccessor(name: string) {
      const rig = rigRepo.createRig(name);
      const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
      const older = sessionRegistry.registerSession(node.id, `seat@${name}`);
      sessionRegistry.updateResumeToken(older.id, "claude_name", "older-native", "hook");
      sessionRegistry.markSuperseded(older.id);
      const successor = sessionRegistry.registerSession(node.id, `seat@${name}`, "fresh");
      sessionRegistry.updateResumeToken(successor.id, "claude_name", "fresh-native", "hook");
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({
        nodeId: node.id, sessionId: successor.id, newGeneration: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
      }));
      sessionRegistry.markIntentionallyStopped(successor.id);
      const snapshot = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      expect(snapshot.data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "absent" });
      return { rig, node, successor, snapshot };
    }

    it("matches an absent snapshot that carries the stopped successor as exited (the one accepted shape)", () => {
      const { rig, snapshot } = stoppedSuccessor("m-ok");
      expect(match(rig.id, snapshot)).toBe(true);
    });

    it("refuses an absent snapshot that does not carry the stopped successor at all", () => {
      const { rig, successor, snapshot } = stoppedSuccessor("m-missing");
      expect(match(rig.id, withSessions(snapshot, (rows) => rows.filter((row) => row.id !== successor.id)))).toBe(false);
    });

    it("refuses an absent snapshot that carries the stopped successor as detached (it saw it left, not stopped)", () => {
      const { rig, successor, snapshot } = stoppedSuccessor("m-detached");
      expect(match(rig.id, withSessions(snapshot, (rows) => rows.map((row) => (row.id === successor.id ? { ...row, status: "detached" } : row))))).toBe(false);
    });

    it("refuses when the successor is no longer exited now, though the snapshot saw it exited (it was resumed in place)", () => {
      const { rig, successor, snapshot } = stoppedSuccessor("m-revived");
      sessionRegistry.markDetached(successor.id);
      expect(match(rig.id, snapshot)).toBe(false);
    });

    it("refuses when a live row is newer than the stopped successor, even one written without a new tenure generation (R2)", () => {
      const { rig, node, snapshot } = stoppedSuccessor("m-newer-live");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, 'seat@m-newer-live', 'running')").run("Z".repeat(26), node.id);
      expect(match(rig.id, snapshot)).toBe(false);
    });

    // The stop override: a deliberate stop NEWER than a detached row of the SAME seat hides that row; nothing else does.
    function olderConversationThenDetached(name: string) {
      const rig = rigRepo.createRig(name);
      const seat = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
      const other = rigRepo.addNode(rig.id, "other", { runtime: "claude-code" });
      const w = sessionRegistry.registerSession(seat.id, `seat@${name}`);
      sessionRegistry.updateResumeToken(w.id, "claude_name", "w-native", "hook");
      sessionRegistry.updateStatus(w.id, "running");
      const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual"); // names W, the older conversation
      sessionRegistry.updateStatus(w.id, "exited");
      const x = sessionRegistry.registerSession(seat.id, `seat@${name}`);
      sessionRegistry.updateResumeToken(x.id, "claude_name", "x-native", "hook");
      sessionRegistry.markDetached(x.id);
      return { rig, seat, other, w, x, snapshot };
    }

    it("a stop on ANOTHER seat does not hide this seat's detached row: a snapshot naming the older conversation is refused", () => {
      const { rig, other, snapshot } = olderConversationThenDetached("m-other-seat");
      const stopped = sessionRegistry.registerSession(other.id, "other@m-other-seat");
      sessionRegistry.markIntentionallyStopped(stopped.id);
      expect(match(rig.id, snapshot)).toBe(false);
    });

    it("an unmarked exit newer than the detached row does not hide it: the snapshot naming the older conversation is refused", () => {
      const { rig, seat, snapshot } = olderConversationThenDetached("m-unmarked");
      const crashed = sessionRegistry.registerSession(seat.id, "seat@m-unmarked");
      sessionRegistry.updateStatus(crashed.id, "exited");
      expect(match(rig.id, snapshot)).toBe(false);
    });

    it("a deliberate stop of the same seat newer than the detached row does hide it (the seat is stopped, nothing to compare)", () => {
      const { rig, seat, snapshot } = olderConversationThenDetached("m-marked");
      const stopped = sessionRegistry.registerSession(seat.id, "seat@m-marked");
      sessionRegistry.markIntentionallyStopped(stopped.id);
      expect(match(rig.id, snapshot)).toBe(true);
    });
  });

  // N8: restore-check forecasts the fallback capture, so it reads the stop marks the capture reads. Two detached rows behind a
  // later deliberate stop are a stopped seat; unmarked they would read as an ambiguity.
  it("`rig restore-check` reads the stop marks: two detached rows behind a later deliberate stop are not an ambiguity", async () => {
    const rig = rigRepo.createRig("eztrack-of255-n8");
    const node = rigRepo.addNode(rig.id, "seat", { runtime: "terminal" });
    for (const _ of [1, 2]) sessionRegistry.markDetached(sessionRegistry.registerSession(node.id, "seat@n8").id);
    sessionRegistry.markIntentionallyStopped(sessionRegistry.registerSession(node.id, "seat@n8").id);
    // One detached row remains a persisted session, so current-state recovery is eligible and the forecast runs.
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'terminal')").run(node.id);
    const body = await (await app.request(`/api/restore-check?rig=${rig.name}&noQueue=true&noHooks=true`)).json() as { checks: Array<{ check: string; evidence?: string }> };
    const preconditions = body.checks.find((c) => c.check === `rig.${rig.name}.restore-preconditions`);
    expect(preconditions).toBeDefined();
    expect(JSON.stringify(preconditions)).not.toContain("Active-occupant ambiguity");
  });
});

