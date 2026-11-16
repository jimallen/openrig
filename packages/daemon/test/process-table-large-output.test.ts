// workspaces-o9o.67: a busy host's process table outgrew the native process lister. Measured on Sparky
// (2026-11-16): `ps` printed 85,038 lines, 17.4 MB, over the 8 MiB maxBuffer of both full-table listers, so
// both failed outright and every liveness, identity and delivery check lost every row at once. These rows
// drive the REAL listers (real child process, real PATH lookup) against a hermetic `ps` that prints a table
// larger than the old buffer, and pin the named error and the warning for a table past the new bound.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lineage from "../src/domain/native-process-lineage.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";
import { foregroundGroupPrograms, listProcesses } from "../src/adapters/native-inbox-os.js";

const MIB = 1024 * 1024;
const STARTED = "Mon Nov 16 22:00:00 2026";
const LAST_PID = 999_999;

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** Rows of ~8 KB each until the table passes `bytes`; the last row is pid LAST_PID, so a lister that reads it read the
 *  whole table. `shape` picks the columns the lister asks for. */
function table(shape: "lineage" | "strict" | "inbox" | "foreground", bytes: number): { text: string; rows: number } {
  const pad = "x".repeat(8 * 1024);
  const header = shape === "lineage" ? "PID PPID PGID TPGID UCOMM STARTED COMMAND\n" : shape === "strict" ? "PID PPID STARTED COMMAND\n" : "";
  const row = (pid: number): string => {
    switch (shape) {
      case "lineage": return `${pid} 1 ${pid} -1 sleep ${STARTED} /bin/sleep ${pid} ${pad}\n`;
      case "strict": return `${pid} 1 ${STARTED} /bin/sleep ${pid} ${pad}\n`;
      case "inbox": return `${pid} 1 /bin/sleep ${pid} ${pad}\n`;
      case "foreground": return `${pid} -1 sleep /bin/sleep ${pid} ${pad}\n`;
    }
  };
  const parts = [header];
  let size = header.length;
  let pid = 1000;
  while (size <= bytes) { const r = row(pid++); parts.push(r); size += r.length; }
  parts.push(shape === "foreground" ? `${LAST_PID} ${LAST_PID} codex codex resume tok-1\n` : row(LAST_PID));
  return { text: parts.join(""), rows: pid - 1000 + 1 };
}

/** A `ps` on an otherwise empty PATH that prints `text` (and, with `thenSleep`, keeps running afterwards). */
function installPs(text: string, opts: { thenSleep?: boolean } = {}): { pidFile: string } {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o9o67-ps-"));
  const out = path.join(scratch, "table.txt");
  const pidFile = path.join(scratch, "ps.pid");
  fs.writeFileSync(out, text);
  fs.writeFileSync(path.join(scratch, "ps"), [
    "#!/bin/sh",
    `echo $$ > '${pidFile}'`,
    `/bin/cat '${out}'`,
    ...(opts.thenSleep ? ["exec /bin/sleep 30"] : []),
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  return { pidFile };
}

describe("o9o.67: a process table larger than the old buffer is read whole", () => {
  it("listNativeProcesses returns every row of a 17 MB table, not []", async () => {
    const { text, rows } = table("lineage", 17 * MIB);
    installPs(text);
    const listed = await lineage.listNativeProcesses();
    expect(listed).toHaveLength(rows);
    expect(listed.at(-1)?.pid).toBe(LAST_PID);
  });

  it("defaultListProcessesStrict returns every row of a 17 MB table instead of rejecting", async () => {
    const { text, rows } = table("strict", 17 * MIB);
    installPs(text);
    const listed = await defaultListProcessesStrict();
    expect(listed).toHaveLength(rows);
    expect(listed.at(-1)?.pid).toBe(LAST_PID);
  });

  it("the native inbox's listProcesses reads a table past its old 64 MiB buffer", async () => {
    const { text, rows } = table("inbox", 66 * MIB);
    installPs(text);
    const listed = await listProcesses();
    expect(listed).toHaveLength(rows);
    expect(listed.at(-1)?.pid).toBe(LAST_PID);
  });

  it("foregroundGroupPrograms finds the foreground group in the last row of a table past 64 MiB", async () => {
    const { text } = table("foreground", 66 * MIB);
    installPs(text);
    expect(await foregroundGroupPrograms(LAST_PID)).toEqual([{ name: "codex", argv0: "codex" }]);
  });
});

describe("o9o.67: a table past the bound fails with a named error, at once, and the daemon says so", () => {
  it("readProcessTable rejects with ProcessTableTooLargeError naming the bound, and stops ps instead of waiting for it", async () => {
    const { pidFile } = installPs(table("inbox", 2 * MIB).text, { thenSleep: true });
    const started = Date.now();
    const err = await lineage.readProcessTable(["-A"], { maxBytes: MIB }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(lineage.ProcessTableTooLargeError);
    expect((err as Error).message).toMatch(new RegExp(`more than ${MIB} bytes`));
    expect(Date.now() - started).toBeLessThan(10_000);
    const psPid = Number(fs.readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(psPid, 0)).toThrow(), { timeout: 5_000 });
  });

  it("a ps that exits non-zero still rejects the strict lister, naming the exit and what ps said", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o9o67-psfail-"));
    fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\necho 'PID PPID STARTED COMMAND'\necho 'ps: fixture failure' >&2\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", scratch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(defaultListProcessesStrict()).rejects.toThrow(/exited 1: ps: fixture failure/);
  });

  it("decodes a multibyte command split across stream chunks intact", async () => {
    const euro = "\u20ac".repeat(4096);
    const rows = Array.from({ length: 600 }, (_, i) => `${2000 + i} 1 ${STARTED} /bin/sleep ${euro}\n`);
    installPs(`PID PPID STARTED COMMAND\n${rows.join("")}`);
    const listed = await defaultListProcessesStrict();
    expect(listed).toHaveLength(600);
    expect(listed.every((row) => row.command === `/bin/sleep ${euro}`)).toBe(true);
  });

  it("the default bound is far above the measured 17.4 MB table", () => {
    expect(lineage.PROCESS_TABLE_MAX_BYTES).toBeGreaterThanOrEqual(128 * MIB);
  });

  it("listNativeProcesses warns once with the reason when the table cannot be read, and again when it can", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o9o67-nops-"));
    vi.stubEnv("PATH", scratch);

    expect(await lineage.listNativeProcesses()).toEqual([]);
    expect(await lineage.listNativeProcesses()).toEqual([]);
    const failures = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("could not read the process table"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ENOENT/);

    installPs(table("lineage", 1024).text);
    expect((await lineage.listNativeProcesses()).length).toBeGreaterThan(0);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("process table can be read again"))).toHaveLength(1);
  });
});
