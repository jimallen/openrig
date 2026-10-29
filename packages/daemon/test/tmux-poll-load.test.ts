// OF-176: the daemon's poll loops share one tmux window listing per tick, a seat whose session that listing lacks costs
// no per-seat read, and an idle pane costs no structural capture. A live 15-seat laptop daemon started ~21 tmux processes
// a second; 8 seats of an archived rig whose sessions no longer existed cost two thirds of them, read one by one every tick.
// Every row runs the real TmuxAdapter over a fake tmux that records each argv.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotLacks, TmuxAdapter, type SessionWindowSnapshot } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation } from "../src/domain/transcript-rotation.js";

interface Window { session: string; active: boolean; stamp: string; target?: string }

/** A fake tmux: `windows` answers list-windows -a, list-sessions names their sessions, a chain captures each listed pane. */
function fakeTmux(windows: Window[], opts: { failListing?: () => boolean; gate?: () => Promise<void> } = {}) {
  const calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv) => {
    calls.push(argv);
    if (argv[1] === "list-windows") {
      if (opts.gate) await opts.gate();
      if (opts.failListing?.()) throw new Error("lost server reply");
      return windows.map((w) => `${w.active ? 1 : 0}|${w.stamp}|${w.target ?? "@1%1"}|${w.session}`).join("\n") + "\n";
    }
    if (argv[1] === "list-sessions") return [...new Set(windows.map((w) => w.session))].join("\n") + "\n";
    let out = "";
    const cmds: string[][] = [[]];
    for (const a of argv.slice(1)) { if (a === ";") cmds.push([]); else cmds[cmds.length - 1]!.push(a); }
    for (const c of cmds) {
      const name = /^=(.*):$/.exec(c[c.indexOf("-t") + 1] ?? "")?.[1];
      if (name === undefined || !windows.some((w) => w.session === name)) throw new Error(`can't find session: ${name}`);
      out += c[0] === "display-message" ? `${c[c.length - 1]}\n` : `${name} text\n`;
    }
    return out;
  });
  const count = (sub: string) => calls.filter((a) => a[1] === sub).length;
  return { adapter, calls, count };
}

function dbWithRunningSeats(names: string[], runtime = "claude-code") {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const reg = new SessionRegistry(db);
  const rig = rigRepo.createRig("r");
  const nodeIds: Record<string, string> = {};
  names.forEach((n, i) => {
    const node = rigRepo.addNode(rig.id, `dev.${n}`, { runtime });
    const sess = reg.registerSession(node.id, `${n}@r`);
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: `${n}@r`, tmuxPane: `%${i + 1}`, attachmentType: "tmux" });
    nodeIds[n] = node.id;
  });
  return { db, nodeIds };
}

describe("the shared window snapshot (TmuxAdapter)", () => {
  it("callers in flight share one list-windows, a recent one is reused, an older one reads again", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const t = fakeTmux([{ session: "a@r", active: true, stamp: "100" }], { gate: () => gate });
    const both = Promise.all([t.adapter.readSessionWindowSnapshot(0), t.adapter.readSessionWindowSnapshot(0)]);
    open();
    const [one, two] = await both;
    expect(one).toBe(two);
    expect(t.count("list-windows"), "two readers in flight, one fork").toBe(1);
    await t.adapter.readSessionWindowSnapshot(60_000);
    expect(t.count("list-windows"), "a read under maxAge is reused").toBe(1);
    expect(t.adapter.peekSessionWindowSnapshot(60_000)).toBe(one);
    await t.adapter.readSessionWindowSnapshot(0);
    expect(t.count("list-windows"), "maxAge 0 reads again").toBe(2);
  });

  it("a failed read is not kept: the next reader reads again, and peek sees nothing", async () => {
    let fail = true;
    const t = fakeTmux([{ session: "a@r", active: true, stamp: "100" }], { failListing: () => fail });
    expect(await t.adapter.readSessionWindowSnapshot(60_000)).toBeNull();
    expect(t.adapter.peekSessionWindowSnapshot(60_000)).toBeNull();
    fail = false;
    expect((await t.adapter.readSessionWindowSnapshot(60_000))?.sessions.has("a@r")).toBe(true);
    expect(t.count("list-windows")).toBe(2);
  });

  it("names every session the listing shows; only a well-formed active-window stamp counts as activity", async () => {
    const t = fakeTmux([
      { session: "a@r", active: true, stamp: "100" },
      { session: "b@r", active: false, stamp: "200" },
      { session: "c@r", active: true, stamp: "" },
      { session: "with|bar@r", active: true, stamp: "300" },
    ]);
    const s = (await t.adapter.readSessionWindowSnapshot(0))!;
    expect([...s.sessions].sort()).toEqual(["a@r", "b@r", "c@r", "with|bar@r"]);
    expect([...s.activity].sort()).toEqual([["a@r", 100], ["with|bar@r", 300]]);
    expect(s.targets.get("a@r"), "the current window and its active pane").toBe("@1%1");
    expect(s.targets.has("b@r"), "only the current window's").toBe(false);
  });

  it("only a listing that names a session answers absence: an empty one never makes every seat look gone", () => {
    const snapshot = (names: string[]): SessionWindowSnapshot => ({ at: 0, sessions: new Set(names), activity: new Map(), targets: new Map() });
    expect(snapshotLacks(snapshot(["a@r"]), "gone@r")).toBe(true);
    expect(snapshotLacks(snapshot(["a@r"]), "a@r")).toBe(false);
    expect(snapshotLacks(snapshot([]), "gone@r")).toBe(false);
    expect(snapshotLacks(null, "gone@r")).toBe(false);
  });

  it("a batched capture keeps a fresh snapshot as its listing (no list-sessions), and without one lists on its own", async () => {
    const t = fakeTmux([{ session: "a@r", active: true, stamp: "100" }, { session: "b@r", active: true, stamp: "100" }]);
    await t.adapter.readSessionWindowSnapshot(0);
    const got = await t.adapter.capturePanesContent(["a@r", "gone@r", "b@r"], 20);
    expect(t.count("list-sessions"), "the shared snapshot was the listing").toBe(0);
    expect(got!.get("gone@r")).toMatchObject({ text: null, missing: true });
    expect(got!.get("a@r")?.text).toBe("a@r text\n");
    const cold = fakeTmux([{ session: "a@r", active: true, stamp: "100" }]);
    await cold.adapter.capturePanesContent(["a@r"], 20);
    expect(cold.count("list-sessions"), "no snapshot: its own listing, as before").toBe(1);
  });
});

describe("SeatActivityService sweep", () => {
  it("a seat whose session the listing lacks gets no read of its own; a listed seat without a stamp still does", async () => {
    const { db } = dbWithRunningSeats(["live", "nostamp", "gone"]);
    const t = fakeTmux([{ session: "live@r", active: true, stamp: "100" }, { session: "nostamp@r", active: true, stamp: "" }]);
    const reads: string[] = [];
    const tmux = {
      readSessionWindowSnapshot: (maxAgeMs: number) => t.adapter.readSessionWindowSnapshot(maxAgeMs),
      readPaneLastActivity: async (pane: string) => { reads.push(pane); return null; },
    };
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
    await svc.pollAllRunningTmuxSeats(db);
    expect(reads).toEqual(["nostamp@r"]);
    expect(t.count("list-windows")).toBe(1);
  });

  it("an empty listing answers nothing: every seat is read on its own, as before", async () => {
    const { db } = dbWithRunningSeats(["a", "b"]);
    const t = fakeTmux([]);
    const reads: string[] = [];
    const tmux = {
      readSessionWindowSnapshot: (maxAgeMs: number) => t.adapter.readSessionWindowSnapshot(maxAgeMs),
      readPaneLastActivity: async (pane: string) => { reads.push(pane); return null; },
    };
    await new SeatActivityService({ tmux, defaultWindowSeconds: 3 }).pollAllRunningTmuxSeats(db);
    expect(reads.sort()).toEqual(["a@r", "b@r"]);
  });
});

describe("SeatStructuralActivityService sweep: idle panes cost no capture", () => {
  /** A sweep at `clockMs` with the window stamps given (epoch seconds), returning the sessions captured in it. */
  function harness(names: string[]) {
    const { db } = dbWithRunningSeats(names);
    let clock = 1_000_500;
    /** How long a capture takes: the batch's own capturedAt is stamped when tmux returns, this much later. */
    let captureMs = 0;
    const stamps = new Map<string, number>();
    const targets = new Map<string, string>();
    const windows = () => [...stamps].map(([session, s]) => ({ session, active: true, stamp: String(s) }));
    const captured: string[][] = [];
    const tmux = {
      readSessionWindowSnapshot: async (): Promise<SessionWindowSnapshot> => ({
        at: clock, sessions: new Set(windows().map((w) => w.session)), activity: new Map(windows().map((w) => [w.session, Number(w.stamp)])),
        targets: new Map(windows().map((w) => [w.session, targets.get(w.session) ?? "@1%1"])),
      }),
      capturePanesContent: async (names: string[]) => {
        captured.push(names);
        clock += captureMs; // the read happened at the old clock; tmux returns later
        return new Map(names.map((n) => [n, { text: `${n} out\n❯ `, capturedAt: new Date(clock) }]));
      },
      capturePaneContent: async (): Promise<string | null> => { throw new Error("no per-seat capture expected"); },
    };
    const svc = new SeatStructuralActivityService(tmux, () => new Date(clock));
    return {
      svc, stamps, captured, targets,
      slowCapture: (ms: number) => { captureMs = ms; },
      sweep: async (atMs: number) => { clock = atMs; captured.length = 0; await svc.pollAllRunningTmuxSeats(db); return captured.flat(); },
      at: (ms: number) => { clock = ms; },
    };
  }

  it("no output since the last capture: no capture, and the observation is re-observed (still fresh past the stale window)", async () => {
    const h = harness(["a"]);
    h.stamps.set("a@r", 999); // output before the capture at 1000.5 s
    expect(await h.sweep(1_000_500)).toEqual(["a@r"]);
    expect(await h.sweep(1_003_000)).toEqual([]);
    expect(await h.sweep(1_005_000)).toEqual([]);
    h.at(1_007_000); // 6.5 s after the capture, 2 s after the last re-observation
    expect(h.svc.getStructuralActivity("a@r")?.observedAt).toBe(new Date(1_005_000).toISOString());
  });

  it("output in a later second than the capture's: captured again", async () => {
    const h = harness(["a"]);
    h.stamps.set("a@r", 999);
    await h.sweep(1_000_500);
    h.stamps.set("a@r", 1001);
    expect(await h.sweep(1_002_000)).toEqual(["a@r"]);
  });

  it("output in the capture's own second (the stamp's resolution): captured again", async () => {
    const h = harness(["a"]);
    h.stamps.set("a@r", 999);
    await h.sweep(1_000_500);
    h.stamps.set("a@r", 1000);
    expect(await h.sweep(1_002_000)).toEqual(["a@r"]);
  });

  it("output between the pane read and tmux's return, across a second boundary: captured again (review F1)", async () => {
    const h = harness(["a"]);
    h.stamps.set("a@r", 999);
    h.slowCapture(30);
    // Issued at 1000.98 s: the pane is read then, tmux returns at 1001.01 s (the batch's capturedAt).
    expect(await h.sweep(1_000_980)).toEqual(["a@r"]);
    h.slowCapture(0);
    h.stamps.set("a@r", 1000); // output at 1000.99 s, after the read: the cached text predates it
    expect(await h.sweep(1_002_000)).toEqual(["a@r"]);
  });

  it("another window or pane is current (a select-window or select-pane writes no output): captured again (review F3)", async () => {
    const h = harness(["a", "b"]);
    h.stamps.set("a@r", 999);
    h.stamps.set("b@r", 999);
    await h.sweep(1_000_500);
    h.targets.set("a@r", "@2%2"); // a@r now shows another window
    h.targets.set("b@r", "@1%5"); // b@r: same window, another pane
    expect((await h.sweep(1_002_000)).sort()).toEqual(["a@r", "b@r"]);
    expect(await h.sweep(1_003_000), "same target again, no output: skipped").toEqual([]);
  });

  it("a seat whose session the listing lacks: not captured, and its cached observation is dropped", async () => {
    const h = harness(["a", "b"]);
    h.stamps.set("a@r", 999);
    h.stamps.set("b@r", 999);
    await h.sweep(1_000_500);
    h.stamps.delete("b@r");
    expect(await h.sweep(1_001_500)).toEqual([]);
    expect(h.svc.getStructuralActivity("b@r")).toBeNull();
    expect(h.svc.getStructuralActivity("a@r")).not.toBeNull();
  });
});

describe("SeatIdentityReconciler sweep", () => {
  it("a seat whose session tmux does not list gets no per-pane read; its verdict is session_missing, as that read gave", async () => {
    const { db, nodeIds } = dbWithRunningSeats(["live", "gone"], "terminal");
    const pidReads: string[] = [];
    const tmux = {
      listSessions: async () => [{ name: "live@r", windows: 1, created: "", attached: false }],
      readAllPaneProcesses: async () => new Map([["%1", { pid: 4242, command: "bash" }]]),
      getPanePid: async (pane: string): Promise<number | null> => { pidReads.push(pane); return null; },
      getPaneCommand: async (): Promise<string | null> => null,
    };
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(pidReads).toEqual([]);
    expect(new SeatIdentityStore(db).getForNode(nodeIds.gone!)).toMatchObject({ verdict: "pane_missing", reason: "session_missing" });
  });
});

describe("transcript rotation's activity hint (review F2)", () => {
  afterEach(() => clearAllTranscriptRotationsForTest());

  it("an empty listing answers nothing: the session is still captured, never recorded as gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of176-hint-"));
    try {
      const file = path.join(dir, "a@r");
      const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv) => {
        if (argv[1] === "list-windows") return "\n"; // a server with no session it would name
        if (argv[1] === "capture-pane") return "a@r text\n";
        throw new Error(`unexpected tmux ${argv[1]}`);
      });
      startTranscriptRotation(adapter, "a@r", file, { lines: 20, pollIntervalMs: 500 });
      for (let i = 0; i < 60 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe("a@r text\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
