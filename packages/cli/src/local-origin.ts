import Database from "better-sqlite3";
import { join } from "node:path";
import { DAEMON_STATE_POLICY, readOwnFile } from "@openrig/daemon/credential-file";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";
import { validateHostRegistry } from "./host-registry.js";

/** Read the boot-minted identity without requiring the local daemon or minting a replacement. */
export function readLocalOrigin(): string | undefined {
  let db: Database.Database | undefined;
  try {
    const configured = new ConfigStore().resolveWithSource("db.path");
    let dbPath = configured.value as string;
    // An explicit configured DB wins. Otherwise retain the last launch's --db selection.
    if (configured.source === "default") {
      // workspaces-o9o.160: the launch record chooses the database the origin is read from, and the origin goes out on every
      // direct-endpoint request, so daemon.json is read under the credential rule. A record the rule refuses (a link, another
      // user's file) gives no origin at all; only a missing one falls back to the configured default.
      const read = readOwnFile(join(getOpenRigHome(), "daemon.json"), DAEMON_STATE_POLICY);
      if (!read.ok && read.problem !== "missing") return undefined;
      if (read.ok) {
        try {
          const state = JSON.parse(read.content) as { db?: unknown };
          if (typeof state.db === "string" && state.db.length > 0) dbPath = state.db;
        } catch { /* An unparseable launch record: use the configured default, never search other homes. */ }
      }
    }
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
    const row = db.prepare("SELECT host_id FROM self_host_identity WHERE singleton = 1").get() as { host_id?: unknown } | undefined;
    const id = row?.host_id;
    if (typeof id !== "string" || id === "localhost") return undefined;
    const valid = validateHostRegistry({ hosts: [{ id, transport: "ssh", target: "identity-validation" }] }, "<local-origin>");
    return valid.ok ? id : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
