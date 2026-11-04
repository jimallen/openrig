// A ChildProcess stand-in carrying only the members the code under test reads (pid, unref, ...).
// Partial<ChildProcess> -> ChildProcess is a legal assertion, so no `as unknown as` is needed.
import type { ChildProcess } from "node:child_process";

export function stubChildProcess(stubs: Partial<ChildProcess>): ChildProcess {
  return stubs as ChildProcess;
}
