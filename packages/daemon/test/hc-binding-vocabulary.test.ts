// hc cutover, W11: the daemon's vocabulary for a seat bound to an hc terminal. Until cutover both attachment types
// exist, so every row here pairs the hc behaviour with the tmux behaviour that must not move.
//
// What is real: SQLite (the full migration list, or the shared full fixture), the inventory projection, the context
// monitor's poll query, the binding writer. What is not claimed: any hc core, terminal or process. The terminal name
// recipe is restated here (sha256 of the seat, first 24 hex, `s-`) so a change to hc-seat.ts fails these rows.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hcAttachCommand, setDaemonTmuxServer, tmuxAttachCommand } from "../src/adapters/tmux-server.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { BINDING_TERMINAL_ADDRESS_MIGRATION_NAME } from "../src/db/migrations/121_binding_terminal_address.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { applicableVerdict, getNodeInventory } from "../src/domain/node-inventory.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { writeSeatBinding } from "../src/domain/seat-handover-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";
import type { SeatIdentityVerdict } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

const hcName = (seat: string): string => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

describe("hcAttachCommand", () => {
  afterEach(() => setDaemonTmuxServer([]));

  it("addresses the terminal by its hc name, ends options with --, and quotes nothing it need not", () => {
    // `verify-qa@eztrack` is refused as an hc name; the seat is addressed by the digest name instead.
    expect(hcAttachCommand("verify-qa@eztrack")).toBe(`hc attach -- ${hcName("verify-qa@eztrack")}`);
    expect(hcAttachCommand("verify-qa@eztrack")).toMatch(/^hc attach -- s-[0-9a-f]{24}$/);
  });

  it("is a different command for a different seat, and the same for the same seat", () => {
    expect(hcAttachCommand("a@r")).toBe(hcAttachCommand("a@r"));
    expect(hcAttachCommand("a@r")).not.toBe(hcAttachCommand("b@r"));
  });

  it("names no tmux server: the core is the default one, whatever server the daemon sits on", () => {
    setDaemonTmuxServer(["-L", "person"]);
    expect(hcAttachCommand("a@r")).toBe(`hc attach -- ${hcName("a@r")}`);
    expect(tmuxAttachCommand("a@r")).toBe("tmux -L person attach -t a@r"); // control: the tmux string still carries it
  });
});

describe("migration 121 is registered", () => {
  it("is in the canonical list, last, and a fully migrated database has the columns", () => {
    expect(ALL_MIGRATIONS.at(-1)?.name).toBe(BINDING_TERMINAL_ADDRESS_MIGRATION_NAME);
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const columns = db.prepare<[], { name: string }>("PRAGMA table_info(bindings)").all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["terminal_address", "pre_hc_tmux_pane"]));
    db.close();
  });

  it("the shared full test database has them too, so the inventory query reads on it", () => {
    const db = createFullTestDb();
    expect(db.prepare<[], { name: string }>("PRAGMA table_info(bindings)").all().map((c) => c.name)).toContain("terminal_address");
    db.close();
  });
});

describe("writeSeatBinding", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'rig-1', 'dev.a')").run();
  });
  afterEach(() => db.close());

  interface Row { attachment_type: string; tmux_session: string | null; tmux_window: string | null; tmux_pane: string | null; terminal_address: string | null; external_session_name: string | null }
  const row = (): Row | undefined =>
    db.prepare<[], Row>("SELECT attachment_type, tmux_session, tmux_window, tmux_pane, terminal_address, external_session_name FROM bindings WHERE node_id = 'n1'").get();

  it("inserts an hc row with its type and address and no pane (the column default is 'tmux')", () => {
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t7" });
    expect(row()).toEqual({ attachment_type: "hc", tmux_session: "dev-a@r", tmux_window: null, tmux_pane: null, terminal_address: "t7", external_session_name: null });
  });

  it("inserts a tmux row with its pane and no address", () => {
    writeSeatBinding(db, "n1", { attachmentType: "tmux", tmuxSession: "dev-a@r", tmuxWindow: "0", tmuxPane: "%12" });
    expect(row()).toEqual({ attachment_type: "tmux", tmux_session: "dev-a@r", tmux_window: "0", tmux_pane: "%12", terminal_address: null, external_session_name: null });
  });

  it("rewrites a tmux row to hc: the pane goes, the address arrives", () => {
    writeSeatBinding(db, "n1", { attachmentType: "tmux", tmuxSession: "dev-a@r", tmuxWindow: "0", tmuxPane: "%12" });
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t9" });
    expect(row()).toMatchObject({ attachment_type: "hc", tmux_window: null, tmux_pane: null, terminal_address: "t9" });
  });

  it("rewrites an hc row to tmux: the address goes, the pane arrives", () => {
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t7" });
    writeSeatBinding(db, "n1", { attachmentType: "tmux", tmuxSession: "dev-b@r", tmuxWindow: "1", tmuxPane: "%3" });
    expect(row()).toEqual({ attachment_type: "tmux", tmux_session: "dev-b@r", tmux_window: "1", tmux_pane: "%3", terminal_address: null, external_session_name: null });
  });

  it("an external_cli binding's session name is cleared by either write, as before", () => {
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, external_session_name) VALUES ('b1', 'n1', 'external_cli', 'ext-1')").run();
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t1" });
    expect(row()).toMatchObject({ attachment_type: "hc", external_session_name: null });
  });

  it("keeps one row per node across repeated writes", () => {
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t1" });
    writeSeatBinding(db, "n1", { attachmentType: "hc", tmuxSession: "dev-a@r", terminalAddress: "t2" });
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM bindings WHERE node_id = 'n1'").get()?.n).toBe(1);
    expect(row()?.terminal_address).toBe("t2");
  });
});

describe("applicableVerdict for an hc seat", () => {
  // Dates far from wall clock: the verdict is observed after the session was created.
  const verdictFor = (registeredPane: string | null): SeatIdentityVerdict => ({
    nodeId: "n1", verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing",
    evidence: { registeredPane, observedPid: null, observedCommand: null, matchedLayer: null },
    sessionName: "dev-a@r", observedAt: "2031-01-01T00:00:00.000Z",
  });
  const rowOf = (extra: Record<string, string | null>) => ({
    session_id: null, session_name: "dev-a@r", session_created_at: "2030-01-01 00:00:00", handover_at: null, binding_tmux_pane: null as string | null, ...extra,
  });

  it("applies a verdict registered against the terminal address", () => {
    const v = verdictFor("t7");
    expect(applicableVerdict(v, rowOf({ binding_attachment_type: "hc", binding_terminal_address: "t7" }))).toBe(v);
  });

  it("does not apply a verdict registered against another address, a stale pane id, or nothing", () => {
    const hcRow = rowOf({ binding_attachment_type: "hc", binding_terminal_address: "t7" });
    expect(applicableVerdict(verdictFor("t8"), hcRow)).toBeNull();
    expect(applicableVerdict(verdictFor("%12"), hcRow)).toBeNull();
    // The trap: the hc row's tmux_pane is NULL, and a verdict registered against NULL must not stand in for the address.
    expect(applicableVerdict(verdictFor(null), hcRow)).toBeNull();
  });

  it("an hc row with no address yet applies no verdict that names one", () => {
    expect(applicableVerdict(verdictFor("t7"), rowOf({ binding_attachment_type: "hc", binding_terminal_address: null }))).toBeNull();
  });

  it("a tmux row still matches by pane, and ignores an address", () => {
    const v = verdictFor("%12");
    expect(applicableVerdict(v, rowOf({ binding_tmux_pane: "%12", binding_attachment_type: "tmux", binding_terminal_address: "t7" }))).toBe(v);
    expect(applicableVerdict(verdictFor("t7"), rowOf({ binding_tmux_pane: "%12", binding_attachment_type: "tmux", binding_terminal_address: "t7" }))).toBeNull();
  });

  it("a caller that selects neither column reads the row as tmux", () => {
    const v = verdictFor("%12");
    expect(applicableVerdict(v, rowOf({ binding_tmux_pane: "%12" }))).toBe(v);
  });
});

describe("node inventory for an hc seat", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'dev.a', 'claude-code', '/project')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('s1', 'n1', 'dev-a@r', 'running', 'ready', '2030-01-01 00:00:00')").run();
  });
  afterEach(() => { setDaemonTmuxServer([]); db.close(); });

  const bind = (type: string, address: string | null, pane: string | null) =>
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane, terminal_address) VALUES ('b1', 'n1', ?, 'dev-a@r', ?, ?)").run(type, pane, address);
  const entry = () => getNodeInventory(db, "rig-1").find((e) => e.logicalId === "dev.a")!;
  const missingVerdict = (registeredPane: string | null) =>
    db.prepare(`INSERT INTO seat_identity_verdicts (node_id, verdict, evidence_source, reason, registered_pane, session_name, observed_at)
                VALUES ('n1', 'pane_missing', 'tmux_session', 'session_missing', ?, 'dev-a@r', '2031-01-01T00:00:00.000Z')`).run(registeredPane);

  it("offers the hc attach command, not a tmux one, and reports the type", () => {
    bind("hc", "t7", null);
    expect(entry().attachmentType).toBe("hc");
    expect(entry().tmuxAttachCommand).toBe(`hc attach -- ${hcName("dev-a@r")}`);
  });

  it("keeps the tmux command for a tmux row, and none for an external_cli row", () => {
    bind("tmux", null, "%1");
    expect(entry().tmuxAttachCommand).toBe("tmux attach -t dev-a@r");
    db.prepare("DELETE FROM bindings").run();
    bind("external_cli", null, null);
    expect(entry().tmuxAttachCommand).toBeNull();
  });

  it("projects a session_missing verdict registered against the address as detached", () => {
    bind("hc", "t7", null);
    missingVerdict("t7");
    expect(entry().sessionStatus).toBe("detached");
  });

  it("leaves the seat running when the verdict was registered against NULL or another address", () => {
    bind("hc", "t7", null);
    missingVerdict(null);
    expect(entry().sessionStatus).toBe("running");
    db.prepare("DELETE FROM seat_identity_verdicts").run();
    missingVerdict("t8");
    expect(entry().sessionStatus).toBe("running");
  });

  it("a tmux row projects detached by pane exactly as before (control)", () => {
    bind("tmux", null, "%1");
    missingVerdict("%1");
    expect(entry().sessionStatus).toBe("detached");
  });
});

describe("node inventory on a database that stops before migration 121", () => {
  // A fixture that lists its migrations by hand (inventory-event-indexes.test.ts does) has no terminal_address column.
  it("still projects, reading every row as tmux", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== BINDING_TERMINAL_ADDRESS_MIGRATION_NAME));
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('n1', 'rig-1', 'dev.a', 'claude-code')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', 'n1', 'dev-a@r', 'running')").run();
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES ('b1', 'n1', 'dev-a@r', '%1')").run();
    const entry = getNodeInventory(db, "rig-1").find((e) => e.logicalId === "dev.a");
    expect(entry?.attachmentType).toBe("tmux");
    expect(entry?.tmuxAttachCommand).toBe("tmux attach -t dev-a@r");
    db.close();
  });
});

describe("ContextMonitor polls hc seats", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let monitor: ContextMonitor;
  let checkReady: ReturnType<typeof vi.fn>;
  let dir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    dir = join(tmpdir(), `hc-w11-context-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, "state", "context-usage"), { recursive: true });
    mkdirSync(join(dir, "codex-home", ".codex"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: dir, codexHomeDir: join(dir, "codex-home") });
    checkReady = vi.fn(async (): Promise<ReadinessResult> => ({ ready: false, reason: "not_ready", code: "awaiting_runtime" }));
    monitor = new ContextMonitor(db, store, { ensureContextCollector: vi.fn(), checkReady });
  });
  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const SIDECAR = {
    context_window: { context_window_size: 200000, used_percentage: 41, remaining_percentage: 59, total_input_tokens: 82000, total_output_tokens: 1000, current_usage: "41% used" },
    session_id: "sess-hc", transcript_path: "/tmp/hc.log", sampled_at: new Date().toISOString(),
  };

  function seed(attachmentType: "tmux" | "hc" | "external_cli", sessionName: string, startup: "ready" | "failed" = "ready") {
    const rig = rigRepo.createRig(`rig-${sessionName}`);
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = 'running', startup_status = ? WHERE id = ?").run(startup, session.id);
    sessionRegistry.updateBinding(node.id, attachmentType === "external_cli"
      ? { attachmentType, externalSessionName: sessionName }
      : { attachmentType, tmuxSession: sessionName });
    writeFileSync(join(dir, "state", "context-usage", `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`), JSON.stringify({ ...SIDECAR, session_name: sessionName }));
    return node;
  }

  it("persists context usage for an hc-bound Claude seat", async () => {
    const node = seed("hc", "hc-seat@r");
    await monitor.pollOnce();
    const usage = store.getForNode(node.id, "hc-seat@r");
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(41);
  });

  it("still polls a tmux seat, and still skips an external_cli seat (controls)", async () => {
    const tmux = seed("tmux", "tmux-seat@r");
    const external = seed("external_cli", "ext-seat@r");
    await monitor.pollOnce();
    expect(store.getForNode(tmux.id, "tmux-seat@r").availability).toBe("known");
    expect(store.getForNode(external.id, "ext-seat@r").availability).toBe("unknown");
  });

  it("hands the readiness check the seat's own attachment type", async () => {
    seed("hc", "hc-seat@r", "failed");
    seed("tmux", "tmux-seat@r", "failed");
    await monitor.pollOnce();
    expect(checkReady).toHaveBeenCalledWith(expect.objectContaining({ tmuxSession: "hc-seat@r", attachmentType: "hc" }));
    expect(checkReady).toHaveBeenCalledWith(expect.objectContaining({ tmuxSession: "tmux-seat@r", attachmentType: "tmux" }));
  });
});
