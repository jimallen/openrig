// hc cutover: bindings move from a tmux pane id to a terminal address, and back. Rollback prefers this reverse to
// restoring the snapshot, because the snapshot loses every session id made since (design-hc-cutover section 10).
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  BINDING_TERMINAL_ADDRESS_MIGRATION_NAME,
  bindingTerminalAddressSchema,
  reverseBindingTerminalAddress,
} from "../src/db/migrations/121_binding_terminal_address.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

// Everything shipped before the hc cutover, plus the migration under test whether or not it is registered yet.
const BEFORE = ALL_MIGRATIONS.filter((m) => m.name !== BINDING_TERMINAL_ADDRESS_MIGRATION_NAME);
const WITH = [...BEFORE, bindingTerminalAddressSchema];

function freshDb(): Database.Database {
  const db = createDb();
  dbs.push(db);
  return db;
}

interface BindingSeed { id: string; node: string; session: string | null; pane: string | null; type: string; window?: string | null; cmux?: string | null; external?: string | null; updatedAt: string }

// Dates far from wall clock, so a rewritten updated_at cannot hide behind "now".
const SEEDS: BindingSeed[] = [
  { id: "b1", node: "n1", session: "dev-impl@rig-a", pane: "%12", type: "tmux", window: "0", updatedAt: "2001-02-03 04:05:06" },
  { id: "b2", node: "n2", session: "dev-qa@rig-a", pane: "%7", type: "tmux", updatedAt: "2002-03-04 05:06:07" },
  { id: "b3", node: "n3", session: "dev-ops@rig-a", pane: null, type: "tmux", updatedAt: "2003-04-05 06:07:08" },
  { id: "b4", node: "n4", session: "ext@rig-a", pane: null, type: "external_cli", external: "codex-ext-1", cmux: "ws-9", updatedAt: "2004-05-06 07:08:09" },
];

function seed(db: Database.Database): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-a')").run();
  for (const s of SEEDS) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'rig-1', ?)").run(s.node, `logical-${s.node}`);
    db.prepare(
      `INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane, external_session_name, cmux_workspace, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.node, s.type, s.session, s.window ?? null, s.pane, s.external ?? null, s.cmux ?? null, s.updatedAt);
  }
  // Session ids made before the cutover: rollback must keep every one of them (a snapshot restore would not).
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, resume_type, resume_token) VALUES ('s1', 'n1', 'dev-impl@rig-a', 'running', 'claude_session_id', 'synthetic-token-1')").run();
  // Settled outbox rows keep the label of the path they really took.
  db.prepare("INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, delivery_state, delivery_path, ack_evidence) VALUES ('o1', 'a@r', 'b@r', 'hi', '2005-06-07T08:09:10Z', 'delivered', 'tmux', 'render_verified')").run();
}

interface BindingRow { id: string; attachment_type: string; tmux_session: string | null; tmux_window: string | null; tmux_pane: string | null; external_session_name: string | null; cmux_workspace: string | null; updated_at: string }
const bindings = (db: Database.Database): BindingRow[] =>
  db.prepare<[], BindingRow>("SELECT id, attachment_type, tmux_session, tmux_window, tmux_pane, external_session_name, cmux_workspace, updated_at FROM bindings ORDER BY id").all();

const columns = (db: Database.Database): string[] =>
  db.prepare<[], { name: string }>("PRAGMA table_info(bindings)").all().map((c) => c.name);

const migrationRecorded = (db: Database.Database): boolean =>
  db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(BINDING_TERMINAL_ADDRESS_MIGRATION_NAME) !== undefined;

const sessionRows = (db: Database.Database) => db.prepare("SELECT id, node_id, session_name, status, resume_token FROM sessions ORDER BY id").all();
const outboxRows = (db: Database.Database) => db.prepare("SELECT outbox_id, delivery_path, ack_evidence FROM outbox_entries ORDER BY outbox_id").all();

function seededBefore(): { db: Database.Database; original: BindingRow[] } {
  const db = freshDb();
  migrate(db, BEFORE);
  seed(db);
  return { db, original: bindings(db) };
}

describe("migration 121 forward: pane id to terminal address, tmux to hc", () => {
  it("moves tmux rows to hc, keeps their pane id aside, and leaves everything else as it was", () => {
    const { db, original } = seededBefore();
    expect(original.map((r) => r.attachment_type)).toEqual(["tmux", "tmux", "tmux", "external_cli"]);

    migrate(db, WITH);

    const after = bindings(db);
    expect(after.map((r) => [r.id, r.attachment_type, r.tmux_pane])).toEqual([
      ["b1", "hc", null], ["b2", "hc", null], ["b3", "hc", null], ["b4", "external_cli", null],
    ]);
    // Only attachment_type and tmux_pane differ: session name (the hc terminal name derives from it), window, cmux,
    // external name and updated_at are the originals.
    expect(after.map(({ attachment_type, tmux_pane, ...kept }) => kept)).toEqual(original.map(({ attachment_type, tmux_pane, ...kept }) => kept));
    expect(db.prepare("SELECT id, terminal_address, pre_hc_tmux_pane FROM bindings ORDER BY id").all()).toEqual([
      { id: "b1", terminal_address: null, pre_hc_tmux_pane: "%12" },
      { id: "b2", terminal_address: null, pre_hc_tmux_pane: "%7" },
      { id: "b3", terminal_address: null, pre_hc_tmux_pane: null },
      { id: "b4", terminal_address: null, pre_hc_tmux_pane: null },
    ]);
    expect(migrationRecorded(db)).toBe(true);
  });

  it("keeps every session id and the outbox delivery_path 'tmux' as data", () => {
    const { db } = seededBefore();
    const sessions = sessionRows(db);
    const outbox = outboxRows(db);
    migrate(db, WITH);
    expect(sessionRows(db)).toEqual(sessions);
    expect(sessions).toHaveLength(1);
    expect(outboxRows(db)).toEqual(outbox);
    expect(outbox).toEqual([{ outbox_id: "o1", delivery_path: "tmux", ack_evidence: "render_verified" }]);
  });

  it("is applied once: a second run changes nothing, even after a row is rebound", () => {
    const { db } = seededBefore();
    migrate(db, WITH);
    db.prepare("UPDATE bindings SET terminal_address = 't9' WHERE id = 'b1'").run();
    const snapshot = db.prepare("SELECT * FROM bindings ORDER BY id").all();
    migrate(db, WITH);
    expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(snapshot);
  });
});

describe("migration 121 reverse: terminal address back to pane id, hc back to tmux", () => {
  it("restores the exact original rows, drops both columns and forgets the migration", () => {
    const { db, original } = seededBefore();
    const columnsBefore = columns(db);
    migrate(db, WITH);

    expect(reverseBindingTerminalAddress(db)).toBe(true);

    expect(bindings(db)).toEqual(original);
    expect(columns(db)).toEqual(columnsBefore);
    expect(migrationRecorded(db)).toBe(false);
  });

  it("forward, reverse, forward again: the second forward equals the first", () => {
    const { db } = seededBefore();
    migrate(db, WITH);
    const firstForward = db.prepare("SELECT * FROM bindings ORDER BY id").all();

    expect(reverseBindingTerminalAddress(db)).toBe(true);
    migrate(db, WITH);

    expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(firstForward);
    expect(migrationRecorded(db)).toBe(true);
  });

  it("keeps the session ids made while on hc, which a snapshot restore would lose", () => {
    const { db } = seededBefore();
    migrate(db, WITH);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, resume_type, resume_token) VALUES ('s-made-on-hc', 'n2', 'dev-qa@rig-a', 'running', 'claude_session_id', 'synthetic-token-2')").run();
    reverseBindingTerminalAddress(db);
    expect(db.prepare("SELECT id, resume_token FROM sessions ORDER BY id").all()).toEqual([
      { id: "s-made-on-hc", resume_token: "synthetic-token-2" },
      { id: "s1", resume_token: "synthetic-token-1" },
    ]);
  });

  it("gives a seat relaunched under hc no pane (the old one is gone) and keeps its session name; a seat never relaunched gets its pane back", () => {
    const { db } = seededBefore();
    migrate(db, WITH);
    db.prepare("UPDATE bindings SET terminal_address = 't4' WHERE id = 'b1'").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n5', 'rig-1', 'logical-n5')").run();
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES ('b5', 'n5', 'hc', 'dev-new@rig-a', 't5')").run();

    reverseBindingTerminalAddress(db);

    expect(bindings(db).map((r) => [r.id, r.attachment_type, r.tmux_session, r.tmux_pane])).toEqual([
      ["b1", "tmux", "dev-impl@rig-a", null],
      ["b2", "tmux", "dev-qa@rig-a", "%7"],
      ["b3", "tmux", "dev-ops@rig-a", null],
      ["b4", "external_cli", "ext@rig-a", null],
      ["b5", "tmux", "dev-new@rig-a", null],
    ]);
  });

  it("changes nothing when the migration was never applied", () => {
    const { db, original } = seededBefore();
    expect(reverseBindingTerminalAddress(db)).toBe(false);
    expect(bindings(db)).toEqual(original);
    expect(columns(db)).not.toContain("terminal_address");
  });

  it("is all or nothing: a failure part way leaves the forward state, not a half-reversed one", () => {
    const { db } = seededBefore();
    migrate(db, WITH);
    const forward = db.prepare("SELECT * FROM bindings ORDER BY id").all();
    // An index on a column the reverse must drop makes DROP COLUMN fail, after the rows were already updated.
    db.exec("CREATE INDEX blocks_reverse ON bindings(terminal_address)");

    expect(() => reverseBindingTerminalAddress(db)).toThrow();

    expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(forward);
    expect(columns(db)).toContain("terminal_address");
    expect(migrationRecorded(db)).toBe(true);
  });
});
