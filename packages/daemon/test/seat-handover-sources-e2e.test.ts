import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { waitUntil } from "./helpers/hc-private-core.js";

// OPR.0.5.5.5 — end-to-end money proof for the two NEW executable handover
// sources against a PRIVATE hc core (helpers/hc-scratch.ts: own HOME, HC_SESSION and
// XDG paths, a verified stop at the end; skips when hc is unavailable).
//
// FORK: the real cutover runs and the resolved native id ARRIVES at the launch
// surface (the marker adapter renders the forkSource it received into the real
// terminal) — proving fork execution is a native-fork launch, not a blank fresh
// launch relabeled. REBUILD: a real on-disk artifact chain is resolved and the
// priming packet is REALLY delivered (visible in the terminal), with the executed
// set recorded on the result.
//
// What hc changes (design-hc-cutover §3 gap 5): a respawn is kill, then run again under the same name and labels, so the
// terminal's ADDRESS changes and the binding follows the label; the tmux pin "SAME pane id" becomes "the same seat name, a
// live terminal, the binding on its address".

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HC = findHc();
let core: HcScratch | undefined;
const scratch = (): HcScratch => (core ??= startHcScratch());
const adapter = (): HcAdapter => new HcAdapter(scratch().client());

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  core?.cleanup();
});

const get = (terminal: string) => scratch().client().call<HcTerminal>("terminal.get", { terminal });
const typeLine = (seat: string, text: string) => scratch().client().call("terminal.send", { terminal: hcTerminalName(seat), text });
const read = async (terminal: string, lines = 400) => (await scratch().client().call<{ text: string }>("terminal.read", { terminal, lines })).text;

/** The seat's terminal on the private core, its shell armed to exit on TERM, the predecessor line really on screen. */
async function seedPane(seat: string): Promise<string> {
  const created = await adapter().createSession(seat, "/tmp");
  expect(created, "the seat's terminal is created").toEqual({ ok: true });
  const address = (await get(hcTerminalName(seat))).address;
  await typeLine(seat, "trap 'exit 0' TERM");
  // A just-created shell can swallow early input during init — poll until the predecessor sentinel has ACTUALLY rendered,
  // so the post-cutover assertion tests the cutover, not input timing.
  for (let attempt = 0; attempt < 10; attempt++) {
    await typeLine(seat, "echo predecessor_line_S05");
    await sleep(300);
    if ((await read(address)).includes("predecessor_line_S05")) break;
  }
  return address;
}

/** The terminal the seat's name answers with now, which must be live and carry the seat's canonical name. */
async function successorOf(seat: string): Promise<HcTerminal> {
  const terminal = await get(hcTerminalName(seat));
  expect(terminal.state, `${seat} answers with a live terminal`).toBe("live");
  expect(terminal.labels["openrig.seat"]).toBe(seat);
  return terminal;
}

describe("seat-handover source execution e2e (private hc core)", () => {
  it.runIf(HC !== null)(
    "FORK end-to-end: the resolved native id reaches the real launch in the seat's new terminal; continuity records forked",
    async () => {
      const SEAT = "dev-impl@fork-e2e-rig";
      const address = await seedPane(SEAT);

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("fork-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: address });
      // The incumbent's native conversation id — what fork must resolve + carry.
      sessionRegistry.updateResumeToken(session.id, "codex_id", "native-e2e-abc123", "scrape");

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          // Render the RECEIVED fork source into the real terminal — the pin below
          // reads it back from capture, proving the id crossed the whole path.
          const stamp = opts?.forkSource ? `FORKED_FROM_${opts.forkSource.value}` : "NO_FORK_SOURCE";
          await typeLine(binding.tmuxSession, `printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`);
          await sleep(150);
          return { ok: true, resumeToken: "post-fork-tok", resumeType: "codex_id" };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: adapter(), runtimeAdapters: { codex: marker as any },
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "context-wall", source: `fork:${SEAT}`, operator: "orch@e2e" });
      await sleep(400);
      const successor = await successorOf(SEAT);
      const cap = await read(successor.address);

      expect(result.ok, "fork handover executes").toBe(true);
      expect(successor.address, "a respawn mints a new address; the seat is the same name").not.toBe(address);
      expect(cap, "the resolved native id reached the launch surface").toContain("FORKED_FROM_native-e2e-abc123");
      // Scrollback preservation (deep-history money proof) is owned by
      // seat-handover-cutover-e2e — fork rides the SAME respawn path; this file
      // pins what S05 adds: the native id arriving at the launch in the seat.
      expect(result.result.currentStatus.continuityOutcome).toBe("forked");
      expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT });
      db.close();
    },
    60_000,
  );

  it.runIf(HC !== null)(
    "REBUILD end-to-end: a real on-disk chain primes the successor through real delivery; the executed set is recorded; continuity records rebuilt",
    async () => {
      const SEAT = "dev-impl@rebuild-e2e-rig";
      const address = await seedPane(SEAT);

      // Real durable chain on disk: RECAP.md present, LEARNED.md deliberately
      // ABSENT so the gap leg is proven end-to-end too.
      const seatDir = mkdtempSync(join(tmpdir(), "s05-rebuild-e2e-"));
      tempDirs.push(seatDir);
      writeFileSync(join(seatDir, "RECAP.md"), "# RECAP\nS05 e2e recap body\n");
      const recapAddress = join(seatDir, "RECAP.md");
      const learnedAddress = join(seatDir, "LEARNED.md"); // not written — a real gap

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("rebuild-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: address });

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          const stamp = opts?.forkSource || opts?.resumeToken ? "UNEXPECTED_NON_FRESH" : "FRESH_REBUILD_TARGET";
          await typeLine(binding.tmuxSession, `printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`);
          await sleep(150);
          return { ok: true };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: adapter(), runtimeAdapters: { codex: marker as any },
        // Production-shaped resolver: DECLARES addresses; the service existence-
        // filters them against the REAL filesystem (default existsSync).
        rebuildPrimingResolver: () => ({
          artifacts: [
            { address: recapAddress, label: "authored seat recap (highest trust)" },
            { address: learnedAddress, label: "seat lineage lessons" },
          ],
        }),
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "degraded-incumbent", source: "rebuild", operator: "orch@e2e" });
      await sleep(500);
      const cap = await read((await successorOf(SEAT)).address);

      expect(result.ok, "rebuild handover executes").toBe(true);
      expect(cap, "successor launched fresh (no fork/resume)").toContain("FRESH_REBUILD_TARGET");
      // The priming packet REALLY landed in the terminal and points at the artifact.
      expect(cap, "priming packet delivered end-to-end").toContain("Seat rebuild handover");
      expect(cap, "resolved artifact address delivered").toContain(recapAddress);
      expect(result.result.currentStatus.continuityOutcome).toBe("rebuilt");
      expect(result.result.sourceOutcome).toMatchObject({
        mode: "rebuild",
        primedArtifacts: [expect.objectContaining({ address: recapAddress })],
        gaps: [learnedAddress],
      });
      db.close();
    },
    60_000,
  );

  // A fork whose own conversation id isn't captured at launch is pending metadata, not a failed launch. The
  // ready successor commits with no resume token and the id PENDING; the existing late capture may fill it with
  // the fork's own id, never its parent's; and launch, readiness and attention failures stay failures.
  async function forkSeat(seat: string, launch: { ok: boolean; error?: string; token?: string }, ready: { ready: boolean; code?: string; reason?: string },
    opts: { forkFrom?: { seat: string; token: string } } = {}) {
    const address = await seedPane(seat);
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig(seat.split("@")[1]!);
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
    const session = sessionRegistry.registerSession(node.id, seat);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: address });
    sessionRegistry.updateResumeToken(session.id, "codex_id", "parent-thread-0001", "scrape");
    if (opts.forkFrom) {
      // A fork source on another seat: the parent (that seat's conversation) differs from this seat's retiree.
      const other = rigRepo.addNode(rig.id, "dev.other", { runtime: "codex", cwd: "/tmp" });
      const otherSession = sessionRegistry.registerSession(other.id, opts.forkFrom.seat);
      sessionRegistry.updateStatus(otherSession.id, "running");
      sessionRegistry.updateResumeToken(otherSession.id, "codex_id", opts.forkFrom.token, "scrape");
    }
    const generationBefore = sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;
    const forkSources: unknown[] = [];
    const marker = {
      runtime: "codex",
      async launchHarness(binding: any, launchOpts: any) {
        forkSources.push(launchOpts?.forkSource);
        await typeLine(binding.tmuxSession, "printf '\\n=== FORK RUNNING, ID NOT YET CAPTURED ===\\n'; stty -echo 2>/dev/null; cat");
        await sleep(150);
        // The adapter's capture missed: success carries no resumeToken (launch.ok) or the launch failed.
        return launch.ok ? { ok: true, ...(launch.token ? { resumeToken: launch.token, resumeType: "codex_id" } : {}) } : { ok: false, error: launch.error ?? "launch failed" };
      },
      async checkReady() { return ready; },
    };
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: adapter(), runtimeAdapters: { codex: marker as any },
      readinessTimeoutMs: 1500, sleep,
    });
    const result: any = await service.handover({ seatRef: seat, reason: "context-wall", source: `fork:${opts.forkFrom?.seat ?? seat}`, operator: "orch@e2e" });
    const rows = () => db.prepare("SELECT id, status, resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? ORDER BY rowid")
      .all(node.id) as Array<{ id: string; status: string; resume_type: string | null; resume_token: string | null; resume_provenance: string | null }>;
    return { db, address, node, session, sessionRegistry, result, rows, generationBefore, forkSources };
  }

  it.runIf(HC !== null)(
    "FORK, id capture missed: the ready successor commits with the id PENDING, supersedes the old row, binds the live terminal",
    async () => {
      const SEAT = "dev-impl@fork-pending-rig";
      const w = await forkSeat(SEAT, { ok: true }, { ready: true });
      expect(w.result.ok, JSON.stringify(w.result)).toBe(true);
      expect(w.result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT, forkId: "pending" });
      expect(w.result.result.sourceOutcome.limit).toContain("exact resumption of this conversation isn't established");
      expect(w.result.result.sourceOutcome.limit).toContain("rig ps --nodes --json");
      const [old, current] = w.rows();
      expect(old).toMatchObject({ id: w.session.id, status: "superseded", resume_token: "parent-thread-0001" });
      expect(current!.status).not.toBe("superseded");
      expect(current, "the parent's token is never copied onto the fork").toMatchObject({ resume_token: null, resume_type: null });
      const generationAfter = w.sessionRegistry.currentOccupantTenure(w.node.id)?.generationUuid ?? null;
      expect(generationAfter).not.toBeNull();
      expect(generationAfter).not.toBe(w.generationBefore);
      const live = await successorOf(SEAT);
      expect(w.sessionRegistry.getBindingForNode(w.node.id), "bound to the seat's live terminal").toMatchObject({ attachmentType: "hc", terminalAddress: live.address });
      expect(w.result.result.currentStatus.continuityOutcome).toBe("forked");
      expect(w.forkSources[0], "the handover asks for a pending id on a miss").toMatchObject({ kind: "native_id", value: "parent-thread-0001", pendingIdAllowed: true });

      // The existing late capture (snapshot refresh, fill-null) on the fork's terminal.
      const shellPid = live.pid!;
      let nativeAnswer: string | undefined;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry: w.sessionRegistry, tmuxAdapter: adapter(),
        listProcesses: () => [{ pid: 999_001, ppid: shellPid, command: "codex fork parent-thread-0001" }],
        readCodexThreadIdByPid: () => nativeAnswer, sleep: async () => {},
      });
      const refresh = () => refresher.refresh([{ sessionId: current!.id, sessionName: SEAT, runtime: "codex", resumeType: null, resumeToken: null }], { fillNullOnly: true });
      nativeAnswer = undefined;
      await refresh();
      expect(w.rows()[1], "never resolved: stays pending").toMatchObject({ resume_token: null });
      nativeAnswer = "parent-thread-0001";
      await refresh();
      expect(w.rows()[1], "the parent's id is never adopted").toMatchObject({ resume_token: null });
      nativeAnswer = "fork-own-thread-0002";
      await refresh();
      expect(w.rows()[1], "the fork's own id, delayed, reaches the new row").toMatchObject({ resume_type: "codex_id", resume_token: "fork-own-thread-0002", resume_provenance: "scrape" });
      w.db.close();
    },
    60_000,
  );

  it.runIf(HC !== null)(
    "FORK, id capture missed: launch failure, readiness timeout and an attention gate stay failures, with nothing committed",
    async () => {
      const cases: Array<[string, { ok: boolean; error?: string }, { ready: boolean; code?: string; reason?: string }]> = [
        ["dev-impl@fork-launchfail-rig", { ok: false, error: "Failed to send launch command: injected" }, { ready: true }],
        ["dev-impl@fork-notready-rig", { ok: true }, { ready: false, reason: "still booting" }],
        ["dev-impl@fork-attention-rig", { ok: true }, { ready: false, code: "login_required", reason: "sign in" }],
      ];
      for (const [seat, launch, ready] of cases) {
        const w = await forkSeat(seat, launch, ready);
        expect(w.result.ok, `${seat}: ${JSON.stringify(w.result)}`).toBe(false);
        // The failure is the induced one: a seat that cannot be respawned fails the same way and would pass this row for the wrong reason.
        expect(JSON.stringify(w.result), `${seat}: the failure is not the respawn's`).not.toMatch(/respawn/i);
        const rows = w.rows();
        expect(rows, `${seat}: no successor row committed`).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: w.session.id, resume_token: "parent-thread-0001" });
        w.db.close();
      }
    },
    90_000,
  );

  it.runIf(HC !== null)(
    "FORK: a launch-time capture that answers the parent's or the retiree's id stays PENDING; only the fork's own id is captured",
    async () => {
      // Fork of the seat's own conversation: the parent and the retiree are the same id.
      const own = await forkSeat("dev-impl@fork-parentid-rig", { ok: true, token: "parent-thread-0001" }, { ready: true });
      expect(own.result.ok, JSON.stringify(own.result)).toBe(true);
      expect(own.result.result.sourceOutcome).toMatchObject({ forkId: "pending" });
      expect(own.rows()[1], "never the parent's id").toMatchObject({ resume_token: null });
      own.db.close();
      // Fork of another seat's conversation: parent (other-parent-0009) and retiree (parent-thread-0001) differ.
      const forkFrom = { seat: "dev-other@fork-cross-rig", token: "other-parent-0009" };
      for (const [answer, forkId, recorded] of [
        ["other-parent-0009", "pending", null],
        ["parent-thread-0001", "pending", null],
        ["fork-own-0003", "captured", "fork-own-0003"],
      ] as const) {
        const w = await forkSeat(`dev-impl@fork-cross-${forkId}-${answer.slice(0, 5)}-rig`, { ok: true, token: answer }, { ready: true }, { forkFrom });
        expect(w.result.ok, JSON.stringify(w.result)).toBe(true);
        expect(w.result.result.sourceOutcome, answer).toMatchObject({ mode: "fork", forkedFrom: forkFrom.seat, forkId });
        const current = w.rows().find((row) => row.id !== w.session.id)!;
        expect(current, answer).toMatchObject({ resume_token: recorded });
        w.db.close();
      }
    },
    120_000,
  );
});
