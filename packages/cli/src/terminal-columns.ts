import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The width of the terminal the person is typing in, or undefined when it cannot be read (never an invented width).
 *  The daemon lays a view out for this width (the default kernel view puts the dashboard beside the operator from 120
 *  columns), and the TUI's preview measured the same way, so its plan still matches at open. */
export async function measureHostingColumns(): Promise<number | undefined> {
  if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
  try {
    const size = await run("/bin/sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8", timeout: 1000 });
    const width = Number(size.stdout.trim().split(/\s+/)[1]);
    if (Number.isSafeInteger(width) && width > 0) return width;
  } catch { /* A detached shell tool may still have an ancestor that owns the person's terminal. */ }
  // An agent's shell tool has no terminal, but the agent process above it runs in the person's
  // terminal. Read the nearest ancestor's terminal size.
  try {
    let pid = process.ppid;
    for (let depth = 0; depth < 8 && pid > 1; depth++) {
      const [parent, tty] = (await run("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 })).stdout.trim().split(/\s+/);
      if (tty && /^[A-Za-z0-9/]+$/.test(tty) && tty !== "??" && tty !== "?") {
        const size = await run("/bin/sh", ["-c", `stty size < /dev/${tty}`], { encoding: "utf8", timeout: 1000 });
        const width = Number(size.stdout.trim().split(/\s+/)[1]);
        return Number.isSafeInteger(width) && width > 0 ? width : undefined;
      }
      pid = Number(parent);
    }
  } catch { /* Unknown is a narrow layout, never an invented wide measurement. */ }
  return undefined;
}
