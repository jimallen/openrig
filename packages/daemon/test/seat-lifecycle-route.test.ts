// S5 (OPR.0.5.4.7) — the three seat-lifecycle routes: HTTP status mapping per the
// PRD (400 required-input, 404 not-found, 409 state conflicts, 502 tmux-layer) and
// the pass-through of the service's named refusals (message + guidance + matches).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";

describe("POST /api/seat/{set-model,stop,clean}/:seatRef", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function seedSeat(logicalId = "dev.impl", model = "fable") {
    const rig = setup.rigRepo.findRigsByName("seat-rig")[0] ?? setup.rigRepo.createRig("seat-rig");
    const sessionName = `${logicalId.replace(".", "-")}@seat-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", model });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, session, sessionName };
  }

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Fix r1 (row 9baac99f): the service consumes the CLASSIFIED probeSession.
    // The shared test-app mock predates it; derive a positive-evidence probe
    // from the test's hasSession mock (present/absent — the blip class is
    // pinned against the REAL adapter in the service suite, not here).
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession!(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function post(path: string, seatRef: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/seat/${path}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([true, false])("default-path continue delegates the existing occupant operation (ok=%s)", async ok => {
    const result = { ok, code: "fixture", message: "Existing continuation result", warnings: ["Submission unverified"] };
    const spy = vi.spyOn(SeatLifecycleService.prototype, "continueFreshStartup").mockResolvedValue(result as never);
    const res = await post("continue", "dev@fixture");
    expect(res.status).toBe(ok ? 200 : 409);
    expect(await res.json()).toEqual(result);
    expect(spy).toHaveBeenCalledExactlyOnceWith("dev@fixture");
  });

  it("set-model 200: persists, echoes from/to/changed", async () => {
    const { sessionName } = seedSeat();
    const res = await post("set-model", sessionName, { model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from: "fable", to: "claude-fable-5", changed: true });
  });

  it("set-model 400 on missing model; 400 on missing reason", async () => {
    const { sessionName } = seedSeat();
    const noModel = await post("set-model", sessionName, { reason: "x" });
    expect(noModel.status).toBe(400);
    expect((await noModel.json() as { code: string }).code).toBe("missing_model");
    const noReason = await post("set-model", sessionName, { model: "claude-fable-5" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { code: string }).code).toBe("missing_reason");
  });

  it("404 seat_not_found; 409 seat_ambiguous with matches", async () => {
    seedSeat();
    const missing = await post("set-model", "ghost@seat-rig", { model: "m", reason: "x" });
    expect(missing.status).toBe(404);

    // Same logical id in a second rig → bare ref is ambiguous.
    const rigB = setup.rigRepo.createRig("seat-rig-b");
    setup.rigRepo.addNode(rigB.id, "dev.impl", { runtime: "claude-code" });
    const ambiguous = await post("set-model", "dev.impl", { model: "m", reason: "x" });
    expect(ambiguous.status).toBe(409);
    const body = await ambiguous.json() as { code: string; matches: unknown[] };
    expect(body.code).toBe("seat_ambiguous");
    expect(body.matches.length).toBe(2);
  });

  it("stop 200 on a live seat; 409 session_not_live on a dead one; 502 on probe failure", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession!.mockResolvedValue(true);
    tmux().killSession!.mockResolvedValue({ ok: true });
    const ok = await post("stop", sessionName, { reason: "wave boundary" });
    expect(ok.status).toBe(200);
    expect(tmux().killSession).toHaveBeenCalledWith(sessionName);

    const b = seedSeat("dev.other");
    tmux().hasSession!.mockResolvedValue(false);
    const dead = await post("stop", b.sessionName, { reason: "x" });
    expect(dead.status).toBe(409);
    expect((await dead.json() as { code: string }).code).toBe("session_not_live");

    tmux().hasSession!.mockRejectedValue(new Error("socket gone"));
    const probe = await post("stop", b.sessionName, { reason: "x" });
    expect(probe.status).toBe(502);
    expect((await probe.json() as { code: string }).code).toBe("tmux_probe_failed");
  });

  it("keeps ps and the TUI rig summary consistent after an intentional stop and a sibling crash", async () => {
    const stopped = seedSeat("dev.qa");
    const crashed = seedSeat("dev.impl");
    seedSeat("dev.lead");
    tmux().hasSession!.mockResolvedValue(true);
    tmux().killSession!.mockResolvedValue({ ok: true });
    expect((await post("stop", stopped.sessionName, { reason: "on-demand review" })).status).toBe(200);

    async function expectSurfaces(lifecycleState: string, runningCount: number) {
      const ps = await setup.app.request("/api/ps");
      expect(ps.status).toBe(200);
      expect(await ps.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ rigId: stopped.rig.id, lifecycleState, nodeCount: 3, runningCount, status: "partial" }),
      ]));
      const summary = await setup.app.request("/api/rigs/summary");
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stopped.rig.id, lifecycleState, restoreLifecycleState: "degraded", nodeCount: 3, hasLiveAgents: true }),
      ]));
    }

    await expectSurfaces("running", 2);
    setup.sessionRegistry.markDetached(crashed.session.id);
    setup.sessionRegistry.clearBinding(crashed.node.id);
    await expectSurfaces("degraded", 1);
  });

  it("clean 409 session_live on a live seat; 200 on a dead one; 409 nothing_to_clean when repeated", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession!.mockResolvedValue(true);
    const live = await post("clean", sessionName, { reason: "x" });
    expect(live.status).toBe(409);
    expect((await live.json() as { code: string }).code).toBe("session_live");

    tmux().hasSession!.mockResolvedValue(false);
    const ok = await post("clean", sessionName, { reason: "clean exit observed" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, actions: { sessionsExited: [sessionName], bindingCleared: true } });

    const again = await post("clean", sessionName, { reason: "x" });
    expect(again.status).toBe(409);
    expect((await again.json() as { code: string }).code).toBe("nothing_to_clean");
  });

  it("routes --plan to read-only planning without requiring a reason or entering execution", async () => {
    const result = { ok: true, planOnly: true, complete: false, launchable: null };
    const plan = vi.spyOn(SeatLifecycleService.prototype, "planFresh").mockResolvedValue(result as never);
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const res = await post("launch-plan", "dev@fixture", { fresh: true, stop: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(plan).toHaveBeenCalledExactlyOnceWith({ seatRef: "dev@fixture", fresh: true, stop: true });
    expect(launch).not.toHaveBeenCalled();
  });

  it("still requires --fresh for a plan", async () => {
    const res = await post("launch-plan", "dev@fixture", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, planOnly: true, code: "fresh_required" });
  });

  it("launch requires explicit fresh=true", async () => {
    const { sessionName } = seedSeat();
    const res = await post("launch", sessionName, { reason: "deliberate blank restart" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "fresh_required" });
  });

  it("#729: launch route forwards the explicit fresh/stop/reason contract and warnings", async () => {
    const launchFresh = vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockResolvedValue({
      ok: true,
      seat: { ref: "dev-impl@seat-rig", rigId: "rig-1", rigName: "seat-rig", logicalId: "dev.impl", podId: null, podNamespace: null, runtime: "codex" },
      status: "ready",
      sessionName: "dev-impl@seat-rig",
      sessionId: "sess-fresh",
      generation: "gen-fresh",
      model: "gpt-5.6-codex",
      startupPolicyHash: "policy-hash",
      supersededSessionIds: ["sess-old"],
      warnings: ["Startup submission unverified"],
    });

    const res = await post("launch", "dev-impl@seat-rig", {
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });

    expect(res.status).toBe(200);
    expect(launchFresh).toHaveBeenCalledWith({
      seatRef: "dev-impl@seat-rig",
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });
    expect(await res.json()).toMatchObject({ status: "ready", generation: "gen-fresh", warnings: ["Startup submission unverified"] });
  });

  // OF-32: the daemon's seat routes re-read through the pod instantiator, so a recorded source is used.
  it("the launch preview asks the pod instantiator to re-read a rig's recorded spec source", async () => {
    setup = createTestApp(db, { wireRuntimeAdapters: true });
    const seat = seedSeat();
    setup.rigRepo.setRigSpecSource(seat.rig.id, "/library/team/rig.yaml");
    const reread = vi.spyOn(PodRigInstantiator.prototype, "readSeatStartupFromSpec").mockResolvedValue({
      kind: "refused", code: "startup_source_unavailable", specSource: "/library/team/rig.yaml", message: "fixture: gone",
    });
    const res = await post("launch-plan", seat.sessionName, { fresh: true });
    expect(reread).toHaveBeenCalledWith(expect.objectContaining({ rigId: seat.rig.id, nodeId: seat.node.id }));
    expect(await res.json()).toMatchObject({ ok: false, code: "startup_source_unavailable" });
  });

  // OF-38: the HTTP launch routes serve the CLI (and raw HTTP callers), which can pass startupFrom, so a refused re-read
  // keeps the flag wording. Only the TUI's explicit-fresh action asks for the command form.
  it.each(["launch", "launch-plan"] as const)("OF-38: %s keeps the flag wording for a refused re-read", async (route) => {
    setup = createTestApp(db, { wireRuntimeAdapters: true });
    const seat = seedSeat();
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(seat.node.id);
    setup.rigRepo.setRigSpecSource(seat.rig.id, "/library/team/rig.yaml");
    vi.spyOn(PodRigInstantiator.prototype, "readSeatStartupFromSpec").mockResolvedValue({
      kind: "refused", code: "startup_source_unavailable", specSource: "/library/team/rig.yaml", message: "fixture: gone",
    });
    const res = await post(route, seat.sessionName, { fresh: true, reason: "r" });
    expect(await res.json()).toMatchObject({ ok: false, code: "startup_source_unavailable",
      guidance: "Restore or fix the spec at that path, or run again with --startup-from stored to replay the startup files saved at the seat's last successful launch." });
  });

  // OF-32: where a fresh launch takes its startup files from reaches the service; anything else is refused.
  it.each([["launch", "launchFresh"], ["launch-plan", "planFresh"]] as const)("%s forwards startupFrom and refuses an unknown value", async (route, method) => {
    const spy = vi.spyOn(SeatLifecycleService.prototype, method).mockResolvedValue({ ok: false, code: "fixture", message: "fixture" } as never);
    await post(route, "dev-impl@seat-rig", { fresh: true, reason: "r", startupFrom: "stored" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ startupFrom: "stored" }));
    spy.mockClear();
    const bad = await post(route, "dev-impl@seat-rig", { fresh: true, reason: "r", startupFrom: "latest" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, code: "invalid_startup_from" });
    expect(spy).not.toHaveBeenCalled();
  });
});
