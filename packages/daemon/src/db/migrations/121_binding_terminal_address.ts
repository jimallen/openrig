import type Database from "better-sqlite3";
import type { Migration } from "../migrate.js";

/**
 * hc cutover (design-hc-cutover-20261031 sections 8 and 10): a seat's binding moves from a tmux pane id to the
 * address of its hc terminal, and `attachment_type` from `tmux` to `hc`.
 *
 * Forward:
 *  - `terminal_address` is new and NULL for every migrated row. The core mints an address (`t7`) when it starts a
 *    terminal, and every seat is stopped and resumed at cutover, so no address exists to copy. The host fills it when
 *    it launches the seat, and a launch that binds a seat MUST set it (the reverse below reads NULL as "never
 *    relaunched under hc").
 *  - `pre_hc_tmux_pane` keeps the pane id the row had, so the reverse can put it back exactly. `tmux_pane` is then
 *    NULL: a pane id is meaningless once its tmux session is gone, and a stale `%12` must never read as live.
 *  - Only `attachment_type = 'tmux'` rows move. `external_cli` rows, `tmux_session` (the seat's canonical name, which
 *    the hc terminal name is derived from), `tmux_window`, `cmux_*` and `updated_at` are untouched.
 *  - The column DEFAULT stays 'tmux' (SQLite cannot change one without rebuilding the table): the hc code must write
 *    `attachment_type` on every insert.
 *
 * Reverse (`reverseBindingTerminalAddress`, `BINDING_TERMINAL_ADDRESS_REVERSE_SQL`): rollback runs it with the daemon
 * stopped, in place of restoring the snapshot, which would lose every session id made since. `migrate()` only moves
 * forward, so the reverse is its own function and the same SQL is printed in the rollback runbook for `sqlite3`. A row
 * that was never relaunched under hc gets its pane id back exactly. A row bound under hc (`terminal_address` set) gets
 * NULL: the old pane belongs to a seat that no longer exists. The reverse then drops both columns and forgets the
 * migration, so a later forward run applies it again.
 *
 * Deliberately not migrated: the outbox label `delivery_path = 'tmux'`. It records how a settled row WAS delivered, so
 * rewriting it would falsify history and could not be reversed (an hc value could not be told from a rewritten one).
 * The reader already tolerates any value (`RowColumnReader.oneOf` reads an unknown label as null, flagged in
 * `unreadable`, and never refuses the row). New rows get whatever label the hc delivery path chooses.
 */
export const BINDING_TERMINAL_ADDRESS_MIGRATION_NAME = "121_binding_terminal_address.sql";

export const bindingTerminalAddressSchema: Migration = {
  name: BINDING_TERMINAL_ADDRESS_MIGRATION_NAME,
  sql: `
    ALTER TABLE bindings ADD COLUMN terminal_address TEXT;
    ALTER TABLE bindings ADD COLUMN pre_hc_tmux_pane TEXT;
    UPDATE bindings
      SET pre_hc_tmux_pane = tmux_pane,
          tmux_pane = NULL,
          attachment_type = 'hc'
      WHERE attachment_type = 'tmux';
  `,
};

/** The reverse, as one script. Runs in a transaction (see `reverseBindingTerminalAddress`; by hand: `BEGIN; ...; COMMIT;`). */
export const BINDING_TERMINAL_ADDRESS_REVERSE_SQL = `
UPDATE bindings
  SET tmux_pane = CASE WHEN terminal_address IS NULL THEN pre_hc_tmux_pane ELSE NULL END,
      attachment_type = 'tmux'
  WHERE attachment_type = 'hc';
ALTER TABLE bindings DROP COLUMN terminal_address;
ALTER TABLE bindings DROP COLUMN pre_hc_tmux_pane;
DELETE FROM schema_migrations WHERE name = '${BINDING_TERMINAL_ADDRESS_MIGRATION_NAME}';
`;

/**
 * Undo the migration on a database no daemon has open. Returns false, changing nothing, when the migration is not
 * recorded as applied. All or nothing: any failure leaves the forward state exactly as it was.
 */
export function reverseBindingTerminalAddress(db: Database.Database): boolean {
  const applied = db
    .prepare("SELECT 1 AS found FROM schema_migrations WHERE name = ?")
    .get(BINDING_TERMINAL_ADDRESS_MIGRATION_NAME);
  if (applied === undefined) return false;
  db.transaction(() => {
    db.exec(BINDING_TERMINAL_ADDRESS_REVERSE_SQL);
  })();
  return true;
}
