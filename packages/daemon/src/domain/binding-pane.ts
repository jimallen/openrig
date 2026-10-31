import type Database from "better-sqlite3";
import type { BindingAttachmentType } from "./types.js";

/**
 * hc cutover: what a binding registers as its seat's pane. A seat bound to tmux registers a pane id (`%12`); a seat bound to hc
 * registers the address of its terminal (`t7`), which the hc host reports as the pane id of the one pane it has
 * (`HcIdentity.listPanes`). Migration 121 leaves `tmux_pane` NULL on an hc row, so a consumer that reads `tmux_pane` alone sees
 * "no pane registered" for a live seat: it must read the registered pane through this module instead.
 *
 * Both forms are here because the consumers read bindings two ways: a `Binding` object (`registeredPaneOf`) and a SQL join
 * (`registeredPaneSql`). `node-inventory.ts` keeps its own copy of the same rule for the columns it aliases.
 */

/** The binding fields the rule reads. A caller that holds no `attachmentType` is reading a tmux row. */
export interface RegisteredPaneFields {
  attachmentType?: BindingAttachmentType | string | null;
  tmuxPane: string | null;
  terminalAddress?: string | null;
}

/** The pane the binding registers, or null when it registers none (an hc row not yet launched has no address). */
export function registeredPaneOf(binding: RegisteredPaneFields | null | undefined): string | null {
  if (!binding) return null;
  return binding.attachmentType === "hc" ? binding.terminalAddress ?? null : binding.tmuxPane;
}

const hasColumnCache = new WeakMap<Database.Database, boolean>();

/** Fixtures that list their migrations by hand may stop before 121 (production always has it). Without the column an hc row cannot register a pane. */
export function hasTerminalAddress(db: Database.Database): boolean {
  let known = hasColumnCache.get(db);
  if (known === undefined) {
    known = db.prepare("PRAGMA table_info(bindings)").all()
      .some((row) => (row as { name?: string }).name === "terminal_address");
    // Only a positive answer is kept: a database that gains the column later (a migration run on the same handle) is asked again.
    if (known) hasColumnCache.set(db, known);
  }
  return known;
}

/**
 * The SQL expression for the registered pane of the `bindings` row aliased `alias` (default `b`): the terminal address for an
 * `hc` row, `tmux_pane` otherwise. The alias is interpolated, so it must be a literal identifier of the caller's own.
 */
export function registeredPaneSql(db: Database.Database, alias = "b"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`invalid SQL alias ${JSON.stringify(alias)}`);
  return hasTerminalAddress(db)
    ? `(CASE WHEN ${alias}.attachment_type = 'hc' THEN ${alias}.terminal_address ELSE ${alias}.tmux_pane END)`
    : `${alias}.tmux_pane`;
}

/** True for a binding whose seat lives in a terminal the host adapter can read and type into (not `external_cli`). */
export function isTerminalAttachment(attachmentType: string | null | undefined): boolean {
  return (attachmentType ?? "tmux") === "tmux" || attachmentType === "hc";
}
