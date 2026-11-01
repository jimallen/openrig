import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * Create a SQLite database connection.
 * Defaults to in-memory for tests. Pass a file path for persistence.
 */
export function createDb(filePath?: string): Database.Database {
  const db = new Database(filePath ?? ":memory:");

  // It holds message bodies, and a dialog answer can be a credential. The WAL and shm files take this mode from the database file.
  if (filePath && filePath !== ":memory:") fs.chmodSync(filePath, 0o600);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}
