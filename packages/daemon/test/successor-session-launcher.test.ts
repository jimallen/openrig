import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { hostCodexWithTrustedHook, secondDaemonPolicyFor, type HostCodexFixture } from "./helpers/codex-shared-config-fixture.js";
import type { CodexConfigWritePolicy } from "../src/domain/codex-config-write-policy.js";

describe("SuccessorSessionLauncher", () => {
  let db: Database.Database;
  let discoveryRepo: DiscoveryRepository;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  // Per-seat codex homes need a WRITABLE openrig home in tests (was "/home",
  // unwritable, which silently skipped seeding).
  let seatHomes: string;

  beforeEach(() => {
    seatHomes = fs.mkdtempSync(path.join(os.tmpdir(), "ssl-openrig-home-"));
    db = createFullTestDb();
    discoveryRepo = new DiscoveryRepository(db);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    // KI-14: default = healthy pane; the respawned pane comes up as a blank shell.
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    // Cutover: default = retiree exits gracefully (dead right after SIGTERM), so no forced fallback.
    isPaneDead = vi.fn(async () => true);
    // A live successor is launched via the runtime adapter (launchHarness + readiness), not left as a
    // bare shell. Default mock: launches ready with a scraped resume token.
    launchHarness = vi.fn(async () => ({ ok: true, resumeToken: "codex-thread-xyz", resumeType: "codex_id" }));
    checkReady = vi.fn(async () => ({ ready: true }));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(seatHomes, { recursive: true, force: true });
  });

  function fakeAdapter(runtime: string): RuntimeAdapter {
    return { runtime, launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function launcher(
    tmuxOptionDefaults?: TmuxOptionDefaultsApplier,
    sharedCodexHome = "/daemon-codex",
    overrides: Partial<ConstructorParameters<typeof SuccessorSessionLauncher>[2]> = {},
  ): SuccessorSessionLauncher {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    return new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_HOME: seatHomes, HOME: "/daemon-home", CODEX_HOME: sharedCodexHome },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      seatCwdFault: () => null, // "/w" is a fake path: the folder check is a fake, never the disk
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
      tmuxOptionDefaults,
      ...overrides,
    });
  }

  it("MONEY PROOF (0.5.2-07): the successor's launch binding carries the SPEC-pinned model, not the runtime default", async () => {
    // Boot cheap → hand over → the successor LAUNCH must carry the spec's model. The adapter emits
    // -m/--model from binding.model (51-07 A1); this pins that the handover FEEDS it the spec model.
    // Absent = the founder-designed topology silently drifts from its spec at every handover.
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", model: "gpt-5.4-cheap" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const binding = launchHarness.mock.calls[0]![0] as { model?: string };
    expect(binding.model).toBe("gpt-5.4-cheap");
  });

  // OF-115: a profile withheld for carrying a seat identity, and a per-seat home that could not be made, are told in the
  // handover result, as a fresh launch tells them. (Before, the first was a console line and the second was silent.)
  it("tells the handover result which codex profile was withheld, by name and variable, never by value", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "ssl-shared-codex-"));
    try {
      fs.writeFileSync(path.join(shared, "of115.config.toml"), '[shell_environment_policy.set]\nOPENRIG_SESSION_NAME = "other-seat-value@rig"\n');
      const res = await launcher(undefined, shared).createSuccessor({
        node: { id: "node-1", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-impl@rig",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      const told = (res.warnings ?? []).filter((w) => w.includes("of115.config.toml"));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("OPENRIG_SESSION_NAME");
      expect(told[0]).not.toContain("other-seat-value");
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  // OF-183: the successor's CODEX_HOME symlinks the host-wide config.toml, so a handover used to mirror hook trust into it.
  describe("OF-183 the shared Codex config.toml on a codex handover", () => {
    let fx: HostCodexFixture;
    beforeEach(() => { fx = hostCodexWithTrustedHook("ssl-of183-"); });
    afterEach(() => { fx.cleanup(); });

    const handOver = async (policy?: CodexConfigWritePolicy) => {
      const res = await launcher(undefined, fx.codexHome, {
        sessionEnv: { OPENRIG_HOME: fx.scratchOpenrigHome, HOME: "/daemon-home", CODEX_HOME: fx.codexHome },
        ...(policy ? { codexConfigWritePolicy: policy } : {}),
      }).createSuccessor({ node: { id: "node-1", runtime: "codex", cwd: "/w" }, departingSessionName: "dev-impl@rig" });
      expect(res.ok).toBe(true);
    };

    it("a handover by a daemon that is not the host's installed one leaves the shared config.toml byte-identical", async () => {
      const before = fs.readFileSync(fx.config);
      await handOver(secondDaemonPolicyFor(fx));
      expect(fs.readFileSync(fx.config).equals(before)).toBe(true);
    });

    it("CONTROL: with no restriction the same handover mirrors the seat's hook trust into the shared file", async () => {
      const before = fs.readFileSync(fx.config);
      await handOver();
      expect(fs.readFileSync(fx.config).equals(before)).toBe(false);
    });
  });

  it("tells the handover result when the per-seat codex home could not be made, and still hands over", async () => {
    fs.writeFileSync(path.join(seatHomes, "codex-seats"), "not a directory");
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect((res.warnings ?? []).filter((w) => w.includes("codex per-seat CODEX_HOME seeding failed"))).toHaveLength(1);
  });

  it("a healthy codex handover carries no seat-home warning", async () => {
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.warnings).toBeUndefined();
  });

  it("the successor carries the resolved kernel operational default", async () => {
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", kernelAuthority: true, launchPosture: "full_bypass" },
      departingSessionName: "dev-impl@kernel",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness.mock.calls[0]![0]).toMatchObject({ kernelAuthority: true, launchPosture: "full_bypass" });
  });

  it("the successor keeps the saved non-interruptive rig choice", async () => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", nonInterruptive: true, launchPosture: "full_bypass" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness.mock.calls[0]![0]).toMatchObject({ nonInterruptive: true, launchPosture: "full_bypass" });
  });

  it("#75: the successor's launch binding carries the configured effort", async () => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", effort: "high" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const binding = launchHarness.mock.calls[0]![0] as { effort?: string };
    expect(binding.effort).toBe("high");
  });

  it.each([[true], [undefined]])("the successor's launch binding carries the seat's remote_control declaration (%s)", async (remoteControl) => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", ...(remoteControl ? { remoteControl } : {}) },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    const binding = launchHarness.mock.calls[0]![0] as Record<string, unknown>;
    if (remoteControl) expect(binding.remoteControl).toBe(true);
    else expect("remoteControl" in binding).toBe(false);
  });

  it("CUTOVER: terminates the retiree then respawns (no -k) into the DEPARTING pane (preserved name, same pane id)", async () => {
    // A SEAT = one durable tmux session; the successor takes over the retiree's EXACT pane so native
    // scrollback survives. The retiree is terminated IN PLACE first (remain-on-exit → graceful SIGTERM),
    // then respawn-pane WITHOUT -k reuses the dead pane (respawn -k would CLEAR scrollback). No fresh
    // new-session, no -h shuffle: the canonical session name is preserved and the pane id is unchanged.
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);

    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // No fresh session — the retiree's pane is reused in place.
    expect(createSession).not.toHaveBeenCalled();
    // The DEPARTING session's pane is resolved (to take it over), then respawned in place.
    expect(listPanes).toHaveBeenCalledWith("dev-impl@rig");
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const [paneTarget, command, opts] = respawnPane.mock.calls[0]!;
    expect(paneTarget).toBe("%42");
    // KI-14: EXPLICIT blank shell — an undefined command re-runs the pane's creation command,
    // which on adopted panes is a full `codex … resume <old-token>` invocation.
    expect(command).toBe("/bin/zsh");
    expect(opts).toMatchObject({ cwd: "/w" });
    // Identity env carries the PRESERVED canonical session name (never a -h successor name) + the
    // daemon session env (self-identify + activity report like a launched seat).
    expect(opts.env).toMatchObject({
      OPENRIG_NODE_ID: "node-1",
      OPENRIG_SESSION_NAME: "dev-impl@rig",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_HOME: seatHomes,
      HOME: "/daemon-home",
      // per-seat codex home OVERRIDES the sessionEnv projection (the fix for
      // shared app-server env freezing — the successor keeps the canonical
      // name, so the seat home keys on it too)
      CODEX_HOME: path.join(seatHomes, "codex-seats", "dev-impl@rig"),
    });

    // Retiree terminated IN PLACE before the respawn: remain-on-exit set, then GRACEFUL SIGTERM; the
    // pane went dead on the first probe, so NO forced KILL. respawn happens only after the pane is dead.
    expect(setRemainOnExit).toHaveBeenCalledWith("%42", true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).not.toHaveBeenCalledWith("%42", "KILL");
    expect(setRemainOnExit.mock.invocationCallOrder[0]!).toBeLessThan(signalPaneProcess.mock.invocationCallOrder[0]!);
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(signalPaneProcess.mock.invocationCallOrder[0]!);

    // launchHarness drives the harness into the SAME preserved session/pane; readiness ran; the
    // launch resume token is captured + returned (persisted at commit by the composer, never here).
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const [binding, launchOpts] = launchHarness.mock.calls[0]!;
    expect(binding).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", cwd: "/w" });
    expect(launchOpts).toMatchObject({ name: "dev-impl@rig" });
    expect(checkReady).toHaveBeenCalled();
    expect(res.resumeToken).toBe("codex-thread-xyz");
    expect(res.resumeType).toBe("codex_id");
    expect(res.tmuxSession).toBe("dev-impl@rig");
    expect(res.tmuxPane).toBe("%42");
    // Order: resolve departing pane → terminate → respawn in place → launch the harness into it.
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(listPanes.mock.invocationCallOrder[0]!);
    expect(launchHarness.mock.invocationCallOrder[0]!).toBeGreaterThan(respawnPane.mock.invocationCallOrder[0]!);

    // Recorded as an ACTIVE, UNMANAGED discovery candidate on the PRESERVED name (commit rebinds to it);
    // no binding/session rows are created here — the commit is the sole rebind.
    const row = discoveryRepo.getDiscoveredSession(res.discoveredId);
    expect(row).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", status: "active", claimedNodeId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("carries the supplied generation exactly and never lets ambient session env override it", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    const subject = new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_OCCUPANT_GENERATION: "stale-ambient-generation" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      seatCwdFault: () => null, // "/w" is a fake path: the folder check is a fake, never the disk
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
    });

    const result = await subject.createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
      occupantGeneration: "reserved-generation",
    });

    expect(result.ok).toBe(true);
    expect(respawnPane.mock.calls[0]![2]!.env.OPENRIG_OCCUPANT_GENERATION).toBe("reserved-generation");
  });

  it("CUTOVER forced fallback: retiree survives graceful SIGTERM → bounded SIGKILL, then respawns", async () => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    // The pane stays live through the graceful window; only the forced KILL makes it dead.
    let killed = false;
    signalPaneProcess.mockImplementation(async (_p: string, sig: string) => { if (sig === "KILL") killed = true; return { ok: true }; });
    isPaneDead.mockImplementation(async () => killed);

    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "dev-impl@rig" });

    expect(res.ok).toBe(true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "KILL"); // graceful failed → forced fallback
    expect(respawnPane).toHaveBeenCalledTimes(1); // respawn only after the pane died (post-KILL)
    expect(launchHarness).toHaveBeenCalledTimes(1);
  });

  it("retiree NEVER exits (survives TERM and KILL) → structured retiree_not_terminated, NO respawn (never clobber a live retiree)", async () => {
    isPaneDead.mockResolvedValue(false); // never becomes dead
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "retiree_not_terminated" });
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "KILL");
    // The pane never died → we NEVER respawn (respawn over a live retiree would fail/clobber) and never launch.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("preserves structured tmux failures when process/pane truth cannot prove cutover", async () => {
    setRemainOnExit.mockResolvedValue({ ok: false, code: "option_failed", message: "remain rejected" });
    signalPaneProcess.mockImplementation(async (_pane: string, signal: string) => ({
      ok: false,
      code: "signal_failed",
      message: `${signal} rejected`,
    }));
    isPaneDead.mockResolvedValue(false);

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
    });

    expect(result).toMatchObject({ ok: false, code: "retiree_not_terminated", replacementStarted: false });
    expect((result as { message: string }).message).toContain("remain-on-exit: remain rejected");
    expect((result as { message: string }).message).toContain("TERM: TERM rejected");
    expect((result as { message: string }).message).toContain("KILL: KILL rejected");
  });

  it("marks physical replacement before respawn when remain-on-exit fails but TERM removes the pane", async () => {
    const replacementStarted = vi.fn();
    setRemainOnExit.mockResolvedValue({ ok: false, code: "unknown", message: "option rejected" });
    signalPaneProcess.mockResolvedValue({ ok: true });
    isPaneDead.mockResolvedValue(true); // production adapter: a known-missing pane proves the retiree is gone
    respawnPane.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find pane" });

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
      onReplacementStarted: replacementStarted,
    });

    expect(result).toMatchObject({ ok: false, replacementStarted: true });
    expect(replacementStarted).toHaveBeenCalledTimes(1);
    expect(replacementStarted.mock.invocationCallOrder[0]!).toBeLessThan(respawnPane.mock.invocationCallOrder[0]!);
  });

  it("UNWIND INVARIANT: a failed successor launch NEVER kills the retiree's preserved session — it stays re-wakeable from its session file", async () => {
    // The new safety invariant (cutover): the retiree exits in place; its provider session file is the
    // durable wake target. So when the successor's launch/readiness FAILS after the respawn, unwind must
    // NOT killSession the preserved seat (that would destroy the recoverable state) — it returns a
    // structured start_agent failure and leaves the re-wakeable shell in the pane.
    launchHarness.mockResolvedValue({ ok: false, error: "codex binary not found" });

    const res = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_launch_failed" });
    expect((res as { message: string }).message).toContain("codex binary not found");
    // The preserved seat's session is NEVER killed on unwind (retiree state stays recoverable).
    expect(killSession).not.toHaveBeenCalled();
    // No discovery candidate was committed for a failed successor.
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness timeout → structured start_agent failure, preserved seat NOT killed, no candidate", async () => {
    checkReady.mockResolvedValue({ ready: false, reason: "harness not interactive" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_not_ready" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  describe("readiness deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(0);
    });

    afterEach(() => vi.useRealTimers());

    function timedLauncher(timeoutMs?: number, readinessSettings?: Pick<SettingsStore, "resolveOne">): SuccessorSessionLauncher {
      const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
      return new SuccessorSessionLauncher(tmux, discoveryRepo, {
        runtimeAdapters: { codex: fakeAdapter("codex") },
        readinessTimeoutMs: timeoutMs ?? (readinessSettings ? undefined : 30_000),
        readinessSettings,
        seatCwdFault: () => null,
        sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });
    }

    it("uses the configured window for successor readiness", async () => {
      checkReady.mockImplementation(async () => ({ ready: Date.now() >= 40_000 }));
      const readinessSettings = {
        resolveOne: () => ({ value: 45, source: "file", defaultValue: 30 }),
      } as unknown as Pick<SettingsStore, "resolveOne">;

      const res = await timedLauncher(undefined, readinessSettings).createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r",
      });

      expect(res.ok).toBe(true);
      expect(Date.now()).toBe(45_000);
    });

    it("falls back to the 30-second window with a warning when the settings read throws", async () => {
      checkReady.mockImplementation(async () => ({ ready: Date.now() >= 20_000 }));
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const readinessSettings = {
        resolveOne: () => { throw new Error("config.json is not valid JSON"); },
      } as unknown as Pick<SettingsStore, "resolveOne">;

      try {
        const res = await timedLauncher(undefined, readinessSettings).createSuccessor({
          node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r",
        });

        expect(res.ok).toBe(true);
        expect(Date.now()).toBe(30_000);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("falling back to 30s default"));
      } finally {
        stderr.mockRestore();
      }
    });

    it("accepts a successor ready after 20 seconds within the 30-second allowance", async () => {
      checkReady.mockImplementation(async () => ({ ready: Date.now() >= 20_000 }));

      const res = await timedLauncher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });

      expect(res.ok).toBe(true);
      expect(Date.now()).toBe(30_000);
      expect(discoveryRepo.listDiscovered()).toHaveLength(1);
      expect(killSession).not.toHaveBeenCalled();
    });

    it("waits the full allowance and reports the deadline probe's reason when never ready", async () => {
      const probeTimes: number[] = [];
      checkReady.mockImplementation(async () => {
        probeTimes.push(Date.now());
        return { ready: false, reason: Date.now() < 30_000 ? "starting" : "still starting at deadline" };
      });

      const res = await timedLauncher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });

      expect(Date.now()).toBe(30_000);
      expect(probeTimes).toEqual([0, 1000, 3000, 7000, 15_000, 30_000]);
      expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_not_ready", message: "Successor did not become a ready agent: readiness timeout after 30s: still starting at deadline" });
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
      expect(killSession).not.toHaveBeenCalled();
    });

    it("uses the remaining time when the allowance is shorter than the initial delay", async () => {
      const probeTimes: number[] = [];
      checkReady.mockImplementation(async () => {
        probeTimes.push(Date.now());
        return { ready: Date.now() >= 250 };
      });

      const res = await timedLauncher(500).createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });

      expect(res.ok).toBe(true);
      expect(Date.now()).toBe(500);
      expect(probeTimes).toEqual([0, 500]);
    });

    it("preserves an attention blocker first observed at the deadline", async () => {
      checkReady.mockImplementation(async () => Date.now() < 30_000
        ? { ready: false, reason: "starting" }
        : { ready: false, code: "trust_gate", reason: "trust prompt" });

      const res = await timedLauncher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });

      expect(Date.now()).toBe(30_000);
      expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_attention_required", message: "Successor did not become a ready agent: trust prompt" });
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
      expect(killSession).not.toHaveBeenCalled();
    });
  });

  it("checkReady THROWS (adapter/socket error) → structured start_agent failure, preserved seat NOT killed, no candidate", async () => {
    // A THROWN readiness probe must not reject createSuccessor with an unstructured error, and — under
    // the cutover invariant — must not kill the preserved seat either.
    checkReady.mockRejectedValue(new Error("tmux socket closed"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_readiness_failed" });
    expect((res as { message: string }).message).toContain("tmux socket closed");
    expect(checkReady).toHaveBeenCalledTimes(1);
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness reports attention_required (auth/trust gate) → structured failure, preserved seat NOT killed", async () => {
    checkReady.mockResolvedValue({ ready: false, code: "trust_gate", reason: "trust prompt" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_attention_required" });
    expect(checkReady).toHaveBeenCalledTimes(1);
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("no runtime adapter for the seat's runtime → structured failure, preserved seat NOT killed", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    const noAdapter = new SuccessorSessionLauncher(tmux, discoveryRepo, { newId: () => "01ABCDEFG", runtimeAdapters: {}, exitPollMs: 1, exitTimeoutMs: 5, seatCwdFault: () => null });
    const res = await noAdapter.createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_runtime_unsupported" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("respawn-pane failure → structured create_successor failure (no kill, no candidate)", async () => {
    // If the in-place respawn itself fails, there is no successor; return a structured create_successor
    // error and do NOT kill the pane — the seat stays re-wakeable from its session file.
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "no_server" });
    expect((res as { message: string }).message).toContain("no server running");
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("no resolvable departing pane → structured resolve_pane failure BEFORE any respawn (seat untouched)", async () => {
    listPanes.mockResolvedValue([]);
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_unresolved" });
    // Nothing was respawned/killed — the live retiree is wholly untouched.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("listPanes THROWS → STRUCTURED resolve_pane failure (no rejection), no respawn, seat untouched", async () => {
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_probe_failed" });
    expect((res as { message: string }).message).toContain("socket permission denied");
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("cleanup marks the candidate vanished WITHOUT killing the preserved session", async () => {
    // Cutover cleanup unwinds a downstream failure (delivery/verify) — but the successor occupies the
    // retiree's preserved pane, so cleanup must NEVER killSession (that destroys the recoverable seat).
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    if (!res.ok) throw new Error("expected ok");
    await launcher().cleanup(res.tmuxSession, res.discoveredId);
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.getDiscoveredSession(res.discoveredId)?.status).toBe("vanished");
  });

  describe("KI-14 (5.3 wave-1): fresh must produce a VERIFIED blank shell, never the pane's baked-in command", () => {
    // The live defect (2026-08-22 reinstall wave, four Codex seats): tmux `respawn-pane` WITHOUT a
    // command re-runs the pane's CREATION (or last-respawn) command — and adopted/hand-recovered
    // panes carry `codex … resume <old-token>` as that command, so a "fresh" respawn boots the OLD
    // context while every downstream label reports fresh. These mocks model the real tmux
    // semantics: respawn with no command → the pane re-runs its baked-in codex resume (foreground
    // "node", the codex wrapper); respawn with an explicit shell → the pane is that shell.
    let paneStartCommandRerun: string;
    beforeEach(() => {
      paneStartCommandRerun = "node"; // the baked-in `codex … resume <old>` wrapper
      getDefaultShell.mockResolvedValue("/bin/zsh");
      getPaneCommand.mockImplementation(async () => {
        const call = respawnPane.mock.calls[respawnPane.mock.calls.length - 1];
        const explicit = call?.[1] as string | undefined;
        if (explicit && explicit.length > 0) return explicit.split("/").pop() ?? explicit;
        return paneStartCommandRerun; // tmux re-ran the pane's original command
      });
    });

    it("respawns with an EXPLICIT default shell — never `undefined`, which re-runs the pane's creation command", async () => {
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      // The whole defect: `undefined` here delegates the successor's identity to pane history.
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/zsh");
      // And the launch only proceeded because the pane was VERIFIED to be a shell.
      expect(getPaneCommand).toHaveBeenCalled();
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("a pane that still boots a NON-shell after respawn → structured successor_pane_not_blank; launchHarness NEVER runs; seat preserved", async () => {
      // Hostile/poisoned pane: whatever we respawn, the foreground comes up as the old codex wrapper
      // (e.g. tmux default-command poisoning, or a respawn the server ignored). The fresh contract is
      // a VERIFIED blank slate or a LOUD refusal — never a launch into a resumed context that then
      // gets stamped complete.
      getPaneCommand.mockResolvedValue("node");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res).toMatchObject({ ok: false, code: "successor_pane_not_blank", step: "create_successor", replacementStarted: true });
      expect((res as { message: string }).message).toContain("node");
      // The old context must never be driven as if it were the fresh successor.
      expect(launchHarness).not.toHaveBeenCalled();
      // Unwind invariant: never kill the preserved seat; no candidate registered.
      expect(killSession).not.toHaveBeenCalled();
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
    });

    it("r2 B1 regression: a configured NON-listed default shell (tcsh) is a VALID blank — never a false successor_pane_not_blank after the retiree is gone", async () => {
      // r2's behavioral proof (tmux 3.6a): default-shell /bin/tcsh → pane_current_command "tcsh".
      // The verifier must accept the basename of the shell the launcher ITSELF selected — a
      // hard-coded set rejecting the configured shell refuses a valid blank pane AFTER the
      // destructive cutover already happened.
      getDefaultShell.mockResolvedValue("/bin/tcsh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/tcsh");
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("r2-B1: an arbitrary configured default shell is accepted when the pane comes up as exactly that shell", async () => {
      // The generalization r2 asked for: the launcher chose the respawn command, so the pane
      // reporting that command's basename IS the verified blank slate — for any configured shell,
      // not only the enumerated common set. (Mock semantics: getPaneCommand echoes the basename of
      // the explicit respawn command.)
      getDefaultShell.mockResolvedValue("/opt/oddshells/bin/osh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("r2-B1: a login-shell '-' prefix on pane_current_command still reads as the blank shell", async () => {
      getPaneCommand.mockResolvedValue("-zsh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("getDefaultShell unavailable → falls back to /bin/sh rather than an undefined respawn", async () => {
      getDefaultShell.mockResolvedValue(null);
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/sh");
    });
  });

  // OF-124: respawn-pane starts in $HOME when the folder it is handed is gone, so a handover would put the successor in the
  // wrong place with no error. The handover must refuse before the live retiree is touched.
  describe("a seat whose folder is gone (OF-124)", () => {
    function launcherWith(seatCwdFault?: (cwd: string) => { kind: "missing" } | { kind: "not_directory"; what: string } | null): SuccessorSessionLauncher {
      const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
      return new SuccessorSessionLauncher(tmux, discoveryRepo, {
        sessionEnv: { OPENRIG_HOME: seatHomes }, newId: () => "01ABCDEFG", runtimeAdapters: { codex: fakeAdapter("codex") },
        readinessTimeoutMs: 50, sleep: async () => {}, exitPollMs: 1, exitTimeoutMs: 5,
        ...(seatCwdFault ? { seatCwdFault } : {}),
      });
    }
    const nothingTouched = () => {
      expect(listPanes).not.toHaveBeenCalled();
      expect(setRemainOnExit).not.toHaveBeenCalled();
      expect(signalPaneProcess).not.toHaveBeenCalled();
      expect(respawnPane).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
      expect(launchHarness).not.toHaveBeenCalled();
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
    };

    it("a missing folder is refused as seat_cwd_unusable before the retiree is probed, stopped or respawned", async () => {
      const res = await launcherWith(() => ({ kind: "missing" })).createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/gone" }, departingSessionName: "dev-impl@rig" });
      expect(res).toEqual({
        ok: false, code: "seat_cwd_unusable", step: "resolve_pane", replacementStarted: false,
        message: "dev-impl@rig was not handed over: its cwd '/gone' does not exist, and a seat launched there would silently start in $HOME. Create the folder /gone, then retry the handover. Nothing was stopped.",
      });
      nothingTouched();
    });

    it("a folder that is a file is told what is wrong, not to create it", async () => {
      const res = await launcherWith(() => ({ kind: "not_directory", what: "is not a directory" })).createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/a-file" }, departingSessionName: "dev-impl@rig" });
      expect(res).toMatchObject({ ok: false, code: "seat_cwd_unusable", replacementStarted: false });
      expect((res as { message: string }).message).toContain("Fix /a-file: it is not a directory");
      expect((res as { message: string }).message).not.toContain("Create the folder");
      nothingTouched();
    });

    it("the folder is judged where the successor would be respawned, and a seat with no recorded cwd has nothing to judge", async () => {
      const judged: string[] = [];
      const probe = (cwd: string) => { judged.push(cwd); return null; };
      expect((await launcherWith(probe).createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" })).ok).toBe(true);
      expect(judged).toEqual(["/w"]);
      expect(respawnPane.mock.calls[0]![2]!.cwd).toBe("/w");
      judged.length = 0;
      expect((await launcherWith(probe).createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "b@r" })).ok).toBe(true);
      expect(judged).toEqual([]);
    });

    it("by default the real disk decides: an existing directory hands over, a deleted one is refused", async () => {
      const here = fs.mkdtempSync(path.join(os.tmpdir(), "ssl-seat-cwd-"));
      try {
        expect((await launcherWith().createSuccessor({ node: { id: "n", runtime: "codex", cwd: here }, departingSessionName: "a@r" })).ok).toBe(true);
        respawnPane.mockClear(); listPanes.mockClear();
        fs.rmSync(here, { recursive: true });
        const res = await launcherWith().createSuccessor({ node: { id: "n", runtime: "codex", cwd: here }, departingSessionName: "a@r" });
        expect(res).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
        expect(respawnPane).not.toHaveBeenCalled();
        expect(listPanes).not.toHaveBeenCalled();
      } finally { fs.rmSync(here, { recursive: true, force: true }); }
    });
  });
});
