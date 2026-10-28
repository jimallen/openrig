// OF-168 (a3): every place that offers or replays a snapshot copy of a seat's startup files passes over a snapshot whose saved data is
// not JSON (newestUsableSnapshotCopy). Restore's fallback warning names those snapshots (own-startup-replay.ts); the other callers
// offer "start it from snapshot <id>" and must not read as if that were the newest snapshot of the rig. Each row damages ONE input
// (a newer snapshot whose data is not JSON) of ONE caller, beside a control with nothing damaged.
//
// Callers (instrument: `grep -rn "newestUsableSnapshotCopy(" packages/daemon/src` at base e38e10c3, minus the definition = 5 call sites):
//   own-startup-replay.ts seatStartupForRestore (restore's own fallback; a3-unreadable-census.test.ts)
//   restore-orchestrator.ts ~1222 (re-offer after the chosen copy was removed)      -> row "restore re-offer"
//   fresh-seat-restore-decision.ts listedRefusalRemedy (restore-check's remedy)       -> row "listed remedy"
//   seat-startup-source.ts readSnapshotStartupCopy (refusal of --startup-from)       -> row "named snapshot refusal"
//   seat-startup-source.ts resolveFreshSeatStartup -> malformedContextGuidance        -> row "malformed stored context"
//
// Deployed entrypoints: startup.ts constructs RestoreOrchestrator and the seat startup source; routes/up.ts, routes/restore-check.ts
// and the seat launch route reach these functions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { listedRefusalRemedy } from "../src/domain/fresh-seat-restore-decision.js";
import { readSnapshotStartupCopy, resolveFreshSeatStartup } from "../src/domain/seat-startup-source.js";

const SEAT = "dev.impl";
const NOTE = "Newer snapshot snap-bad-new could not be read (saved data is not JSON) and was passed over; repair or remove it.";
let h: RestoreHarness;
afterEach(() => h.cleanup());

const exists = (p: string) => fs.existsSync(p);
const setCol = (nodeId: string, col: string, value: string) => h.db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(value, nodeId);
const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
const capture = (rigId: string, kind = "manual") => h.snapshotCapture.captureSnapshot(rigId, kind).id;
/** A snapshot newer than every other one whose data is not JSON (a truncated save). */
const damagedNewer = (rigId: string) => h.db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES ('snap-bad-new', ?, 'auto-periodic', 'active', '{not json', datetime('now', '+1 day'))").run(rigId);

describe("a named snapshot that cannot be used: the refusal offers the newest usable one and names the unreadable newer ones", () => {
  it("named snapshot refusal: readSnapshotStartupCopy", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    const s0 = capture(seat.rigId);
    damagedNewer(seat.rigId);

    const refused = readSnapshotStartupCopy(h.db, { rigId: seat.rigId, logicalId: SEAT, runtime: "claude-code", cwd: h.workdir }, "no-such-snapshot");

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.guidance).toContain(`--startup-from snapshot:${s0}.`);
    expect(refused.guidance).toContain(NOTE);
  });

  it("control: nothing unreadable, nothing named", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    capture(seat.rigId);

    const refused = readSnapshotStartupCopy(h.db, { rigId: seat.rigId, logicalId: SEAT, runtime: "claude-code", cwd: h.workdir }, "no-such-snapshot");

    expect(!refused.ok && refused.guidance).not.toContain("could not be read");
  });
});

describe("listed remedy: listedRefusalRemedy (restore-check)", () => {
  async function remedyFor(withDamaged: boolean) {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const s0 = await h.down(seat.rigId);
    if (withDamaged) damagedNewer(seat.rigId);
    const snapshot = h.snapshotRepo.getSnapshot(s0)!.data;
    return { s0, remedy: listedRefusalRemedy(
      { db: h.db, rigRepo: h.rigRepo, runtimeAdapters: { "claude-code": h.adapter } },
      { rigId: seat.rigId, logicalId: SEAT, snapshot, freshLogicalIds: [SEAT], startupFrom: "stored", exists },
    ) };
  }

  it("names the unreadable newer snapshot beside the route it offers", async () => {
    const { s0, remedy } = await remedyFor(true);

    expect(remedy).toContain(`--startup-from snapshot:${s0}`);
    expect(remedy).toContain(NOTE);
  });

  it("control: nothing unreadable, nothing named", async () => {
    const { s0, remedy } = await remedyFor(false);

    expect(remedy).toContain(`--startup-from snapshot:${s0}`);
    expect(remedy).not.toContain("could not be read");
  });
});

describe("malformed stored context: resolveFreshSeatStartup guidance", () => {
  async function guidanceFor(withDamaged: boolean) {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    const s0 = capture(seat.rigId);
    setCol(seat.nodeId, "resolved_files_json", "{}");
    if (withDamaged) damagedNewer(seat.rigId);
    const result = await resolveFreshSeatStartup(
      { db: h.db, rigRepo: h.rigRepo, specReader: null, runtimeAdapters: { "claude-code": h.adapter } },
      { rigId: seat.rigId, nodeId: seat.nodeId, logicalId: SEAT, runtime: "claude-code", cwd: h.workdir, sessionName: seat.sessionName, startupFrom: "stored", refusalGuidance: "" },
    );
    return { s0, result };
  }

  it("names the unreadable newer snapshot beside the snapshot route", async () => {
    const { s0, result } = await guidanceFor(true);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.guidance).toContain(`--startup-from snapshot:${s0}`);
    expect(result.guidance).toContain(NOTE);
  });

  it("control: nothing unreadable, nothing named", async () => {
    const { s0, result } = await guidanceFor(false);

    expect(!result.ok && result.guidance).toContain(`--startup-from snapshot:${s0}`);
    expect(!result.ok && result.guidance).not.toContain("could not be read");
  });
});

describe("restore re-offer: the chosen periodic copy is pruned before the launch (restore-orchestrator)", () => {
  /** The A13/A14 shape of restore-own-row-review-fixes.test.ts: a periodic tick lands between pre-validation and the launch. */
  const pruneAtPreRestore = () => {
    const orig = h.snapshotCapture.captureSnapshot.bind(h.snapshotCapture);
    vi.spyOn(h.snapshotCapture, "captureSnapshot").mockImplementation((rigId, kind, opts) => {
      if (kind === "pre_restore") {
        orig(rigId, "auto-periodic");
        h.snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", 1);
      }
      return orig(rigId, kind, opts);
    });
  };
  async function refusalFor(withDamaged: boolean) {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const sOld = await h.down(seat.rigId);
    h.db.prepare("UPDATE snapshots SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(sOld);
    const s0 = capture(seat.rigId, "auto-periodic");
    setCol(seat.nodeId, "resolved_files_json", "{}");
    const s1 = capture(seat.rigId, "auto-pre-down");
    if (withDamaged) h.db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES ('snap-bad-new', ?, 'auto-periodic', 'active', '{not json', datetime('now', '+1 hour'))").run(seat.rigId);
    pruneAtPreRestore();
    const out = await h.restore.restore(s1, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
    return { s0, sOld, text: node?.error ?? "", ok: out.ok };
  }

  it("names the unreadable newer snapshot beside the copy it re-offers", async () => {
    const { sOld, text } = await refusalFor(true);

    expect(text).toContain("was removed before the seat's launch");
    expect(text).toContain(`--startup-from snapshot:${sOld}`);
    expect(text).toContain(NOTE);
  });

  it("control: nothing unreadable, nothing named", async () => {
    const { sOld, text } = await refusalFor(false);

    expect(text).toContain(`--startup-from snapshot:${sOld}`);
    expect(text).not.toContain("could not be read");
  });
});
