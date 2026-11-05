// OF-230 — the file adapter of the domain's BootInstantStore port (domain/process-start-clock.ts): one small JSON record in the
// daemon's state directory, { bootId, bootMs }. A record of another boot id reads as none; a missing, torn or foreign file
// reads as none (the caller measures). Written through a sibling file and an atomic rename, so a daemon killed mid-write
// leaves the old record or the new one, never half of one.
import fs from "node:fs";
import path from "node:path";
import type { BootInstantStore } from "../domain/process-start-clock.js";

/** The record's file name inside the daemon's state directory. */
export const BOOT_INSTANT_FILE = "boot-instant.json";

export class FileBootInstantStore implements BootInstantStore {
  constructor(private readonly file: string) {}

  async read(bootId: string): Promise<number | null> {
    let record: unknown;
    try { record = JSON.parse(await fs.promises.readFile(this.file, "utf8")); } catch { return null; }
    if (typeof record !== "object" || record === null) return null;
    const { bootId: kept, bootMs } = record as { bootId?: unknown; bootMs?: unknown };
    return kept === bootId && typeof bootMs === "number" && Number.isFinite(bootMs) ? bootMs : null;
  }

  async write(bootId: string, bootMs: number): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const staging = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(staging, JSON.stringify({ bootId, bootMs }), { mode: 0o600 });
      await fs.promises.rename(staging, this.file);
    } catch (error) {
      await fs.promises.rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
