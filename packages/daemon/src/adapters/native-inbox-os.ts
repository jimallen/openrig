// Native comms step 3: the operating-system side of ClaudeNativeInbox (domain/claude-native-inbox.ts), kept apart so the
// domain logic is tested with fakes and nothing in a test reaches a live seat, socket or process.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { INJECT_FORMAT_LITERAL, type ProcessRow } from "../domain/claude-native-inbox.js";

const execFileAsync = promisify(execFile);

/** Writes newline-delimited JSON lines to a Unix socket and closes it. `none`: the connection failed, no byte left;
 *  `all`: every byte was flushed to the socket; `partial`: connected but the flush did not complete (it may or may not
 *  have landed). The inbox replies with nothing (measured), so nothing is read back. */
export function writeSocketLines(socketPath: string, lines: unknown[], timeoutMs = 5_000): Promise<"none" | "all" | "partial"> {
  return new Promise((resolve) => {
    let connected = false;
    let flushed = false;
    let done = false;
    const finish = (r: "none" | "all" | "partial") => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); finish(connected ? (flushed ? "all" : "partial") : "none"); }, timeoutMs);
    socket.on("connect", () => {
      connected = true;
      const payload = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      socket.write(payload, (err) => {
        if (err) { socket.destroy(); finish("partial"); return; }
        flushed = true;
        socket.end();
      });
    });
    socket.on("error", () => finish(connected ? (flushed ? "all" : "partial") : "none"));
    socket.on("close", () => finish(connected ? (flushed ? "all" : "partial") : "none"));
    socket.on("data", () => { /* the inbox replies with nothing; ignore anything */ });
  });
}

/** Every process's pid, parent pid and full argv, in one `ps` call. */
export async function listProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  const out: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! });
  }
  return out;
}

/** Whether `path` contains `needle`, read in chunks with an overlap so a match across a chunk edge is found. False when
 *  the file cannot be read. A plain byte search: it does not depend on the file's format. */
export function fileIncludes(path: string, needle: string, chunkBytes = 4 * 1024 * 1024): boolean {
  const target = Buffer.from(needle, "utf8");
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  try {
    const buf = Buffer.alloc(chunkBytes + target.length);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, carry, chunkBytes, pos);
      if (n <= 0) return false;
      const filled = carry + n;
      if (buf.subarray(0, filled).indexOf(target) !== -1) return true;
      carry = Math.min(target.length - 1, filled);
      buf.copy(buf, 0, filled - carry, filled);
      pos += n;
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The start time of a process (`ps -o lstart=`), or null. */
async function processStart(pid: number): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
    const t = Date.parse(stdout.trim());
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}

/** The launch probe of a claude binary: `<exec> --version`, the inject-format literal in the file, and whether the
 *  file was modified after the process started (an auto-update: the running version is then unknown). */
export async function probeClaudeBinary(execPath: string, pid: number): Promise<{ version: string | null; literal: boolean; replacedSinceStart: boolean }> {
  if (!existsSync(execPath)) return { version: null, literal: false, replacedSinceStart: false };
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(execPath, ["--version"], { timeout: 10_000 });
    version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch { version = null; }
  const literal = fileIncludes(execPath, INJECT_FORMAT_LITERAL, 16 * 1024 * 1024);
  const started = await processStart(pid);
  let replacedSinceStart = true; // unknown start time reads as unknown version
  try { if (started) replacedSinceStart = statSync(execPath).mtimeMs > started.getTime() + 1_000; } catch { replacedSinceStart = true; }
  return { version, literal, replacedSinceStart };
}

export function socketExists(path: string): boolean {
  try { return statSync(path).isSocket(); } catch { return false; }
}
