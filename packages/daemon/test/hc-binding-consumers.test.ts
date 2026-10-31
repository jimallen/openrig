// hc cutover, package W13: every consumer of a seat's binding must treat a row bound to an hc terminal as it treats a
// tmux row, wherever the seat matters, and must never read the NULL `tmux_pane` of an hc row (migration 121) as a dead or
// missing seat. Each test below fails on the consequence the cutover would otherwise have, named in its title.
//
// Consumers that need a larger harness are pinned beside their existing suites (whoami-service, rig-teardown,
// transcript-routes, gateway-destination-routing); this file holds the ones a plain database can carry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { registeredPaneOf, registeredPaneSql, isTerminalAttachment } from "../src/domain/binding-pane.js";
import { deriveViewMembers } from "../src/domain/terminal/terminal-views-store.js";
import { composeView, type ComposeContext, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { inventoryCaptureOptions, ShadowCapture } from "../src/domain/shadow-capture.js";
import type { NodeInventoryEntry } from "../src/domain/types.js";
import { resumeRunningTranscriptCaptures } from "../src/domain/transcript-capture.js";
import { clearAllTranscriptRotationsForTest } from "../src/domain/transcript-rotation.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const databases: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  clearAllTranscriptRotationsForTest();
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fullDb(): Database.Database {
  const db = createFullTestDb();
  databases.push(db);
  return db;
}

/** A running seat in the repository and registry, bound the way the cutover binds it. */
function seedSeat(db: Database.Database, opts: {
  rig?: string;
  logicalId: string;
  runtime?: string;
  sessionName: string;
  attachmentType: "tmux" | "hc" | "external_cli";
  tmuxPane?: string;
  terminalAddress?: string;
}): { nodeId: string; sessionId: string } {
  const rigRepo = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const existing = db.prepare("SELECT id FROM rigs WHERE name = ?").get(opts.rig ?? "rig") as { id: string } | undefined;
  const rigId = existing?.id ?? rigRepo.createRig(opts.rig ?? "rig").id;
  const node = rigRepo.addNode(rigId, opts.logicalId, { runtime: opts.runtime ?? "claude-code" });
  const session = registry.registerSession(node.id, opts.sessionName);
  registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, {
    attachmentType: opts.attachmentType,
    tmuxSession: opts.sessionName,
    ...(opts.tmuxPane ? { tmuxPane: opts.tmuxPane } : {}),
    ...(opts.terminalAddress ? { terminalAddress: opts.terminalAddress } : {}),
  });
  return { nodeId: node.id, sessionId: session.id };
}

// -- the shared rule ---------------------------------------------------------------------------------------------------------

describe("registeredPaneOf and registeredPaneSql: an hc seat registers its terminal address, never a NULL tmux_pane", () => {
  it("reads the terminal address for hc, the pane id for tmux, and nothing for an hc row not yet launched", () => {
    expect(registeredPaneOf({ attachmentType: "hc", tmuxPane: null, terminalAddress: "t7" })).toBe("t7");
    expect(registeredPaneOf({ attachmentType: "tmux", tmuxPane: "%12", terminalAddress: null })).toBe("%12");
    expect(registeredPaneOf({ tmuxPane: "%3" })).toBe("%3");
    expect(registeredPaneOf(null)).toBeNull();
    // An hc row with no address registers no pane: a stale pane id must not stand in for it.
    expect(registeredPaneOf({ attachmentType: "hc", tmuxPane: "%9", terminalAddress: null })).toBeNull();
    // A tmux row's address column (stale, from a seat that was hc) is not its registration.
    expect(registeredPaneOf({ attachmentType: "tmux", tmuxPane: "%4", terminalAddress: "t1" })).toBe("%4");
  });

  it("the SQL form answers the same per row, and falls back to tmux_pane on a database that stops before migration 121", () => {
    const db = fullDb();
    seedSeat(db, { logicalId: "dev.a", sessionName: "a@rig", attachmentType: "hc", terminalAddress: "t7" });
    seedSeat(db, { logicalId: "dev.b", sessionName: "b@rig", attachmentType: "tmux", tmuxPane: "%2" });
    const rows = db.prepare(`SELECT b.tmux_session AS session, ${registeredPaneSql(db)} AS pane FROM bindings b ORDER BY b.tmux_session`).all();
    expect(rows).toEqual([{ session: "a@rig", pane: "t7" }, { session: "b@rig", pane: "%2" }]);

    const old = createDb();
    databases.push(old);
    migrate(old, ALL_MIGRATIONS.filter((m) => m.name < "121"));
    expect(registeredPaneSql(old)).toBe("b.tmux_pane");
  });

  it("isTerminalAttachment is true for tmux, hc and an unset type, false for an outbound-only external CLI", () => {
    expect([isTerminalAttachment("tmux"), isTerminalAttachment("hc"), isTerminalAttachment(null), isTerminalAttachment(undefined)])
      .toEqual([true, true, true, true]);
    expect(isTerminalAttachment("external_cli")).toBe(false);
  });
});

// -- the registry and repository carry the address ----------------------------------------------------------------------------

describe("session registry and rig repository carry terminal_address", () => {
  it("updateBinding writes attachment_type and terminal_address on insert and on update; a partial update keeps both", () => {
    const db = fullDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const node = rigRepo.addNode(rigRepo.createRig("rig").id, "dev.a", { runtime: "claude-code" });

    const inserted = registry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: "a@rig", terminalAddress: "t7" });
    expect(inserted).toMatchObject({ attachmentType: "hc", tmuxSession: "a@rig", terminalAddress: "t7", tmuxPane: null });

    const kept = registry.updateBinding(node.id, { tmuxWindow: "0" });
    expect(kept).toMatchObject({ attachmentType: "hc", terminalAddress: "t7" });

    const moved = registry.updateBinding(node.id, { terminalAddress: "t12" });
    expect(moved).toMatchObject({ attachmentType: "hc", terminalAddress: "t12" });
    expect(db.prepare("SELECT attachment_type, terminal_address, tmux_pane FROM bindings WHERE node_id = ?").get(node.id))
      .toEqual({ attachment_type: "hc", terminal_address: "t12", tmux_pane: null });

    // The repository's own mapper reads the same column.
    const bound = rigRepo.getRig(node.rigId)!.nodes.find((n) => n.id === node.id)!.binding;
    expect(bound).toMatchObject({ attachmentType: "hc", terminalAddress: "t12" });
  });

  it("a binding written without a type is still a tmux row with no address (the column default stays 'tmux')", () => {
    const db = fullDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const node = rigRepo.addNode(rigRepo.createRig("rig").id, "dev.a", { runtime: "claude-code" });
    expect(registry.updateBinding(node.id, { tmuxSession: "a@rig", tmuxPane: "%1" }))
      .toMatchObject({ attachmentType: "tmux", tmuxPane: "%1", terminalAddress: null });
  });

  it("updateBinding still works on a database that stops before migration 121 (no terminal_address column)", () => {
    const old = createDb();
    databases.push(old);
    migrate(old, ALL_MIGRATIONS.filter((m) => m.name < "121"));
    const rigRepo = new RigRepository(old);
    const registry = new SessionRegistry(old);
    const node = rigRepo.addNode(rigRepo.createRig("rig").id, "dev.a", { runtime: "claude-code" });
    expect(registry.updateBinding(node.id, { tmuxSession: "a@rig", tmuxPane: "%1" })).toMatchObject({ tmuxPane: "%1", terminalAddress: null });
    expect(registry.updateBinding(node.id, { tmuxPane: "%2" })).toMatchObject({ tmuxPane: "%2" });
  });
});

// -- viewers ------------------------------------------------------------------------------------------------------------------

/** The terminal name hc is given for a seat, restated here (sha-256 of the canonical name, first 24 hex digits, `s-` prefix)
 *  so that this pin does not import the thing it pins. */
function hcName(seat: string): string {
  return `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;
}

const NO_HOSTS: ComposeContext = { resolveHost: () => null };

describe("viewers: an hc seat is tiled and attached by its hc terminal name", () => {
  it("the restated name recipe matches a known vector (so the composer rows below pin a real digest)", () => {
    expect(hcName("verify-qa@eztrack")).toBe("s-8dcaa741f527981272b0866c");
  });

  it("deriveViewMembers keeps an hc seat and still drops an external CLI and a nameless row", () => {
    const members = deriveViewMembers([
      { canonicalSessionName: "a@r", attachmentType: "hc", logicalId: "pod.a", runtime: "codex" },
      { canonicalSessionName: "b@r", attachmentType: "tmux", logicalId: "pod.b" },
      { canonicalSessionName: "c@r", attachmentType: "external_cli", logicalId: "pod.c" },
      { canonicalSessionName: null, attachmentType: "hc" },
    ]);
    expect(members.map((m) => m.seat)).toEqual(["a@r", "b@r"]);
    expect(members[0]).toMatchObject({ seat: "a@r", tmuxSession: "a@r", runtime: "codex", alive: true });
  });

  const SEAT = "verify-qa@eztrack";
  const member = (over: Partial<ViewMemberInput>): ViewMemberInput =>
    ({ seat: SEAT, label: "qa", tmuxSession: SEAT, host: null, readOnly: false, alive: true, ...over });

  it("composeView attaches a local seat to hcTerminalName(seat), not to the canonical name hc refuses", () => {
    const v = composeView("v", [member({})], NO_HOSTS);
    expect(v.opened[0]!.paneCommand).toBe(`hc attach -- '${hcName(SEAT)}'`);
    expect(v.opened[0]!.paneCommand).not.toContain("@");
  });

  it("composeView attaches a read-only seat as an observer of hcTerminalName(seat)", () => {
    const v = composeView("v", [member({ readOnly: true })], NO_HOSTS);
    expect(v.opened[0]!.paneCommand).toBe(`hc attach --observe -- '${hcName(SEAT)}'`);
  });

  it("composeView attaches a seat on an ssh host through that host's hc machine, by hcTerminalName(seat)", () => {
    const v = composeView("v", [member({ host: "vm1" })], { resolveHost: () => ({ id: "vm1", transport: "ssh", target: "x" }) });
    expect(v.opened[0]!.paneCommand).toBe(`hc attach -- 'vm1/${hcName(SEAT)}'`);
  });

  it("the terminal name derives from the session name the host knows (tmuxSession), the same name the liveness probe is asked about", () => {
    const v = composeView("v", [{ seat: "label-only", label: "x", tmuxSession: "real@rig", host: null, readOnly: false, alive: true }], NO_HOSTS);
    expect(v.opened[0]!.paneCommand).toBe(`hc attach -- '${hcName("real@rig")}'`);
  });
});

// -- polling loops ------------------------------------------------------------------------------------------------------------

describe("polling loops sample a running hc seat as they sample a tmux one", () => {
  it("SeatActivityService reads the pane activity of an hc seat, and still not of an external CLI", async () => {
    const db = fullDb();
    seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    seedSeat(db, { logicalId: "dev.tm", sessionName: "tm@rig", attachmentType: "tmux", tmuxPane: "%1" });
    seedSeat(db, { logicalId: "dev.ex", sessionName: "ex@rig", attachmentType: "external_cli" });
    const read = vi.fn(async (_target: string) => 1_700_000_000);
    const svc = new SeatActivityService({ tmux: { readPaneLastActivity: read }, defaultWindowSeconds: 3, now: () => new Date("2026-01-01T00:00:00Z") });

    await svc.pollAllRunningTmuxSeats(db);

    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(["hc@rig", "tm@rig"]);
  });

  it("SeatStructuralActivityService captures the pane of an hc seat", async () => {
    const db = fullDb();
    seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    seedSeat(db, { logicalId: "dev.ex", sessionName: "ex@rig", attachmentType: "external_cli" });
    const capture = vi.fn(async (_target: string, _lines?: number) => "❯ ");
    const svc = new SeatStructuralActivityService({ capturePaneContent: capture });

    await svc.pollAllRunningTmuxSeats(db);

    expect(capture.mock.calls.map((c) => c[0])).toEqual(["hc@rig"]);
  });

  it("resumeRunningTranscriptCaptures re-attaches capture for a running hc seat after a daemon restart", async () => {
    const db = fullDb();
    seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    seedSeat(db, { logicalId: "dev.ex", sessionName: "ex@rig", attachmentType: "external_cli" });
    const root = mkdtempSync(join(tmpdir(), "hc-transcripts-"));
    dirs.push(root);
    const capture = vi.fn(async () => "recent work\n");

    const resumed = await resumeRunningTranscriptCaptures(db, { capturePaneContent: capture } as unknown as TmuxAdapter, new TranscriptStore({ transcriptsRoot: root, enabled: true }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumed).toBe(1);
    expect(capture).toHaveBeenCalledWith("hc@rig", 1000);
  });
});

// -- identity -----------------------------------------------------------------------------------------------------------------

describe("identity: an hc seat's registered pane is its terminal address", () => {
  const NOW = () => new Date("2026-07-02T12:00:00.000Z");
  function tmuxFor(address: string, command: string) {
    return {
      listSessions: vi.fn(async () => [{ name: "hc@rig", windows: 1, created: "0", attached: false }]),
      getPanePid: vi.fn(async (pane: string) => (pane === address ? 10 : null)),
      getPaneCommand: vi.fn(async (pane: string) => (pane === address ? command : null)),
    };
  }

  it("the reconciler verifies a running hc seat against its terminal address, not as a seat with no pane registered", async () => {
    const db = fullDb();
    const { nodeId } = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    expect(db.prepare("SELECT tmux_pane FROM bindings WHERE node_id = ?").get(nodeId)).toEqual({ tmux_pane: null });

    await new SeatIdentityReconciler({ db, tmux: tmuxFor("t7", "claude"), now: NOW }).reconcileAll();

    expect(new SeatIdentityStore(db).getForNode(nodeId)).toMatchObject({
      verdict: "verified", sessionName: "hc@rig", evidence: { registeredPane: "t7", observedPid: 10, observedCommand: "claude" },
    });
  });

  it("the reconciler reports an hc seat whose terminal is gone as pane_missing, against that address", async () => {
    const db = fullDb();
    const { nodeId } = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    const tmux = { ...tmuxFor("t7", "claude"), getPanePid: vi.fn(async () => null) };

    await new SeatIdentityReconciler({ db, tmux, now: NOW }).reconcileAll();

    expect(new SeatIdentityStore(db).getForNode(nodeId)).toMatchObject({ verdict: "pane_missing", evidence: { registeredPane: "t7" } });
  });

  const tmuxAt = (id: string) => ({
    listPanes: vi.fn(async () => [{ id, index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 10),
    getPaneCommand: vi.fn(async () => "claude"),
  });

  it("rebinding after a relaunch writes the new terminal address of an hc seat, never into tmux_pane", async () => {
    const db = fullDb();
    const registry = new SessionRegistry(db);
    const hc = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });

    const result = await rebindAndVerifyPaneIdentity({ db, tmux: tmuxAt("t9"), sessionRegistry: registry, nodeId: hc.nodeId, sessionName: "hc@rig", runtime: "claude-code", now: NOW });

    expect(result.ok).toBe(true);
    expect(registry.getBindingForNode(hc.nodeId)).toMatchObject({ attachmentType: "hc", terminalAddress: "t9", tmuxPane: null });
    expect(new SeatIdentityStore(db).getForNode(hc.nodeId)).toMatchObject({ verdict: "verified", evidence: { registeredPane: "t9" } });
  });

  it("rebinding after a relaunch still writes a tmux seat's pane id into tmux_pane", async () => {
    const db = fullDb();
    const registry = new SessionRegistry(db);
    const tm = seedSeat(db, { logicalId: "dev.tm", sessionName: "tm@rig", attachmentType: "tmux", tmuxPane: "%1" });

    const result = await rebindAndVerifyPaneIdentity({ db, tmux: tmuxAt("%5"), sessionRegistry: registry, nodeId: tm.nodeId, sessionName: "tm@rig", runtime: "claude-code", now: NOW });

    expect(result.ok).toBe(true);
    expect(registry.getBindingForNode(tm.nodeId)).toMatchObject({ attachmentType: "tmux", tmuxPane: "%5", terminalAddress: null });
  });

  it("a rebind that finds the terminal gone records the missing seat against the registered address, not a NULL pane", async () => {
    const db = fullDb();
    const registry = new SessionRegistry(db);
    const hc = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });

    const result = await rebindAndVerifyPaneIdentity({ db, tmux: { ...tmuxAt("t9"), listPanes: vi.fn(async () => []) }, sessionRegistry: registry, nodeId: hc.nodeId, sessionName: "hc@rig", runtime: "claude-code", now: NOW });

    expect(result.ok).toBe(false);
    expect(new SeatIdentityStore(db).getForNode(hc.nodeId)).toMatchObject({ verdict: "pane_missing", reason: "session_missing", evidence: { registeredPane: "t7" } });
  });

  it("a delivery to an hc seat is fenced on its terminal address: a relaunch under a new address is a different target", () => {
    const db = fullDb();
    const { nodeId } = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    const before = resolveGuardTarget(db, "hc@rig");
    expect(before).toMatchObject({ nodeId, session: "hc@rig", pane: "t7" });

    new SessionRegistry(db).updateBinding(nodeId, { terminalAddress: "t8" });

    expect(resolveGuardTarget(db, "hc@rig")).toMatchObject({ pane: "t8" });
    // A name that is the address resolves the seat, as a pane id resolves a tmux seat.
    expect(resolveGuardTarget(db, "t8")).toMatchObject({ nodeId, pane: "t8" });
  });
});

describe("shadow capture labels an observation with the seat's registered pane", () => {
  it("an hc seat is labelled with its terminal address, a tmux seat with its pane id", () => {
    const db = fullDb();
    const hc = seedSeat(db, { logicalId: "dev.hc", sessionName: "hc@rig", attachmentType: "hc", terminalAddress: "t7" });
    const tm = seedSeat(db, { logicalId: "dev.tm", sessionName: "tm@rig", attachmentType: "tmux", tmuxPane: "%2" });
    const capture = new ShadowCapture({ destination: "/nonexistent/shadow", maxRecords: 1, maxBytes: 1024, capacity: 4, maxQueuedBytes: 1024, maxObservationBytes: 1024 });
    const label = inventoryCaptureOptions(db, capture).observationBinding!;
    // Only the two fields the labeller reads are set; the rest of an inventory entry is not its business.
    const entry = (nodeId: string, canonicalSessionName: string) => ({ nodeId, canonicalSessionName }) as NodeInventoryEntry;

    expect(label(entry(hc.nodeId, "hc@rig"))).toMatchObject({ nodeId: hc.nodeId, pane: "t7" });
    expect(label(entry(tm.nodeId, "tm@rig"))).toMatchObject({ nodeId: tm.nodeId, pane: "%2" });
  });
});
