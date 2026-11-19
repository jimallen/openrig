// workspaces-o9o.185: no CLI test reads the live host's processes. test/hermetic-env.setup.ts makes readSeatProcesses() with no
// options (every /proc/<pid>/environ on this machine) throw in every test file and fails the file that reached it. These rows pin
// that tripwire, and the reader's own root and pid options that a test uses instead.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSeatProcesses } from "../src/seat-process-environments.js";

const LIVE_SCAN = Symbol.for("openrig.test.liveSeatProcessScans");
type ScanCounter = { [LIVE_SCAN]?: string[] };

describe("workspaces-o9o.185: a test never scans the live host's processes", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
  const procTree = (entries: Record<string, string | null>): string => {
    root = mkdtempSync(path.join(tmpdir(), "o9o185-proc-"));
    for (const [name, environ] of Object.entries(entries)) {
      mkdirSync(path.join(root, name));
      if (environ !== null) writeFileSync(path.join(root, name, "environ"), environ);
    }
    return root;
  };
  const env = (...pairs: string[]) => `${pairs.join("\0")}\0`;

  it("the whole-host scan throws in a test, names the fix, and is counted against the file", () => {
    const counter = globalThis as ScanCounter;
    const before = counter[LIVE_SCAN]?.length ?? 0;
    expect(() => readSeatProcesses()).toThrow(/workspaces-o9o\.185: a test reached readSeatProcesses\(\) with no options/);
    expect(counter[LIVE_SCAN]?.length).toBe(before + 1);
    counter[LIVE_SCAN]!.pop();  // this row reached it on purpose; the file's own end-of-file check must not count it
  });

  it("a fixture root is read: only numbered entries with OPENRIG_SESSION_NAME, PATH in order, OPENRIG_HOME and the command line", () => {
    const procRoot = procTree({
      "101": env("OPENRIG_SESSION_NAME=a@r", "OPENRIG_HOME=/h", "PATH=/x/bin:/usr/bin"),
      "102": env("PATH=/usr/bin"),                 // not a seat
      "103": null,                                 // gone, or another user's: no readable environ
      "self": env("OPENRIG_SESSION_NAME=s@r"),     // not a pid
    });
    // workspaces-o9o.173: the command line is read from the same root (an argv the fixture wrote, NUL-separated and NUL-ended).
    writeFileSync(path.join(procRoot, "101", "cmdline"), "claude\0--settings\0{}\0");
    expect(readSeatProcesses({ procRoot })).toEqual([{ pid: 101, session: "a@r", home: "/h", path: ["/x/bin", "/usr/bin"], argv: ["claude", "--settings", "{}"] }]);
  });

  it("pids reads only the processes named, not the rest of the root", () => {
    const procRoot = procTree({ "201": env("OPENRIG_SESSION_NAME=a@r"), "202": env("OPENRIG_SESSION_NAME=b@r") });
    expect(readSeatProcesses({ procRoot, pids: [202] })).toEqual([{ pid: 202, session: "b@r", home: null, path: [], argv: [] }]);  // no cmdline in the fixture: argv is empty (o9o.173)
  });
});
