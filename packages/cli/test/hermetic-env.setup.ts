// Shared Node-suite isolation runs before any product module captures its home.
import "../../../test/hermetic-env.setup.js";
import { afterAll, vi } from "vitest";

// workspaces-o9o.185: a test never reads the live host's processes. readSeatProcesses() with no options scans every
// /proc/<pid>/environ on this machine, so a doctor test that did not inject its own reader read every live seat's environment.
// Here, in every CLI test file, that whole-host scan throws and is counted, and the file fails at its end if any test reached it
// (a caller that swallowed the throw is still caught). A test that means to read /proc passes its own root or its own pids.
const LIVE_SCAN = Symbol.for("openrig.test.liveSeatProcessScans");
type ScanCounter = { [LIVE_SCAN]?: string[] };
vi.mock("../src/seat-process-environments.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/seat-process-environments.js")>();
  return {
    ...actual,
    readSeatProcesses: (...args: Parameters<typeof actual.readSeatProcesses>) => {
      const [options] = args;
      if (options?.procRoot === undefined && options?.pids === undefined) {
        const where = new Error("a test reached the live /proc seat-process scan").stack ?? "";
        ((globalThis as ScanCounter)[LIVE_SCAN] ??= []).push(where);
        throw new Error("workspaces-o9o.185: a test reached readSeatProcesses() with no options, which reads every live process's "
          + "environment on this host. Inject readSeatProcesses in the test's deps, or pass a procRoot or pids of the test's own.");
      }
      return actual.readSeatProcesses(...args);
    },
  };
});
afterAll(() => {
  const scans = (globalThis as ScanCounter)[LIVE_SCAN] ?? [];
  if (scans.length > 0) {
    throw new Error(`workspaces-o9o.185: ${scans.length} live /proc seat-process scan(s) in this file; the first:\n${scans[0]}`);
  }
});
