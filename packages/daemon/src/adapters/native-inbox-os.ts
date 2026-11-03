// Native comms step 3: the operating-system side of ClaudeNativeInbox (domain/claude-native-inbox.ts), kept apart so the
// domain logic is tested with fakes and nothing in a test reaches a live seat, socket or process.
import { execFile } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { INJECT_FORMAT_LITERAL, type ProcessRow } from "../domain/claude-native-inbox.js";
import { NAME_ENVELOPE_PARSER_LITERAL } from "../domain/native-name-envelope.js";

const execFileAsync = promisify(execFile);

/** OF-181 N1: how long a write may take to flush. Under the CLI's own 5 s request timeout, so a hung receiver whose socket
 *  buffer a large message fills makes the daemon answer `partial` before the CLI gives up on the request. */
export const SOCKET_WRITE_TIMEOUT_MS = 3_000;

/** Writes newline-delimited JSON lines to a Unix socket and closes it. `none`: the connection failed, no byte left;
 *  `all`: every byte was flushed to the socket; `partial`: connected but the flush did not complete (it may or may not
 *  have landed). The inbox replies with nothing (measured), so nothing is read back. */
export function writeSocketLines(socketPath: string, lines: unknown[], timeoutMs = SOCKET_WRITE_TIMEOUT_MS): Promise<"none" | "all" | "partial"> {
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
        // ncomms-3c (found by the end-to-end run): the bytes are in the socket, so report `all` now. Waiting for the
        // peer to close held a send for the whole timeout when the receiver was hung (a frozen claude), past the CLI's
        // own 5 s request timeout. Half-close, and drop the socket if the peer never closes it.
        socket.end();
        finish("all");
        setTimeout(() => socket.destroy(), 2_000).unref();
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

/** The processes of a process group, while it is its terminal's foreground group: each one's OS name and argv[0]. Empty when it is not, which
 *  is what a bare prompt with an agent in the background looks like, and when `ps` cannot answer: nothing may be typed on doubt. */
export async function foregroundGroupPrograms(pgid: number): Promise<Array<{ name: string; argv0: string }>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-A", "-ww", "-o", "pgid=,tpgid=,comm=,args="], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }));
  } catch { return []; }
  return parseForegroundGroup(stdout, pgid);
}

/** `comm` is one word on Linux, and may be a full path with spaces on macOS: the split that matters is to `args`, whose first word is argv[0]. */
export function parseForegroundGroup(ps: string, pgid: number): Array<{ name: string; argv0: string }> {
  const out: Array<{ name: string; argv0: string }> = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) !== pgid || Number(m[2]) !== pgid) continue;
    const [name = "", argv0 = ""] = m[3]!.trim().split(/\s+/);
    out.push({ name, argv0: argv0 === "" ? name : argv0 });
  }
  return out;
}

/** Whether `path` contains `needle`, read in chunks with an overlap so a match across a chunk edge is found. False when
 *  the file cannot be read. A plain byte search: it does not depend on the file's format. */
/** Whether a process with this pid exists. EPERM means it does, under another user. */
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

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
export async function processStart(pid: number): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
    const t = Date.parse(stdout.trim());
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}

/** The launch probe of a claude binary: `<exec> --version`, the inject-format literal in the file, and whether the
 *  file was modified after the process started (an auto-update: the running version is then unknown). ncomms-3d: the
 *  sender-name envelope parser's literal (`nameEnvelope`). */
export async function probeClaudeBinary(execPath: string, pid: number): Promise<{ version: string | null; literal: boolean; replacedSinceStart: boolean; nameEnvelope: boolean }> {
  if (!existsSync(execPath)) return { version: null, literal: false, replacedSinceStart: false, nameEnvelope: false };
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(execPath, ["--version"], { timeout: 10_000 });
    version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch { version = null; }
  const literal = fileIncludes(execPath, INJECT_FORMAT_LITERAL, 16 * 1024 * 1024);
  const nameEnvelope = fileIncludes(execPath, NAME_ENVELOPE_PARSER_LITERAL, 16 * 1024 * 1024);
  const started = await processStart(pid);
  let replacedSinceStart = true; // unknown start time reads as unknown version
  try { if (started) replacedSinceStart = statSync(execPath).mtimeMs > started.getTime() + 1_000; } catch { replacedSinceStart = true; }
  return { version, literal, replacedSinceStart, nameEnvelope };
}

export function socketExists(path: string): boolean {
  try { return statSync(path).isSocket(); } catch { return false; }
}

/** ncomms-3c: the first `n` (name) line of `lsof -a -p <pid> -d txt -Fn`: on macOS the process's own executable (measured
 *  on claude 2.1.314: n/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe). */
export function parseLsofTxtPath(output: string): string | null {
  const line = output.split("\n").find((l) => l.startsWith("n"));
  const path = line?.slice(1).trim();
  return path && path.startsWith("/") ? path : null;
}

/** ncomms-3c: a /proc/<pid>/exe target as an executable path; " (deleted)" means the file was replaced or removed after the
 *  process started, so the running version is unknown: null. */
export function linuxExecFromProcLink(target: string): string | null {
  return target.endsWith(" (deleted)") ? null : target;
}

/** OF-212: where `lsof` is. On macOS it is /usr/sbin/lsof, and the daemon's own PATH has no /usr/sbin (measured 2026-11-03: the release's
 *  `env -i` restart gave it /opt/homebrew/..., /usr/local/bin, /usr/bin, /bin), so by name it was never found and every registration
 *  since that restart failed `exec_path_unresolved`. The absolute path is used where the file exists; the bare name otherwise (Linux
 *  does not use lsof here: it reads /proc). */
export function lsofCommand(platform: string = process.platform, exists: (path: string) => boolean = existsSync): string {
  return platform === "darwin" && exists("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
}

/** ncomms-3c: the executable a running process was started from. Linux: /proc/<pid>/exe (a " (deleted)" target means the
 *  file was replaced or removed since: null). macOS: the txt entry lsof reports. Null when it cannot be found or does
 *  not exist as a file now (a replaced binary on macOS shows a bare name, measured). */
export async function resolveClaudeExecPath(pid: number): Promise<string | null> {
  let path: string | null = null;
  if (process.platform === "linux") {
    try {
      path = linuxExecFromProcLink(readlinkSync(`/proc/${pid}/exe`));
    } catch { path = null; }
  } else {
    try {
      const { stdout } = await execFileAsync(lsofCommand(), ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: 10_000 });
      path = parseLsofTxtPath(stdout);
    } catch { path = null; }
  }
  return execPathIfFile(path);
}

/** ncomms-3c: a candidate executable path only if it is a file now (a replaced binary on macOS shows as `/claude`,
 *  measured, which does not exist). */
export function execPathIfFile(path: string | null): string | null {
  try { return path && statSync(path).isFile() ? path : null; } catch { return null; }
}

/** OF-212: `claude` as the daemon's PATH names it, symlinks resolved, when that is a file. Relative PATH entries are skipped. The name a Claude seat is started
 *  by (argv[0] is the bare `claude`, measured), so the candidate for a process whose own path the OS cannot give. */
export function claudeOnPath(pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // a relative entry would resolve against the daemon's cwd
    try { return execPathIfFile(realpathSync(join(dir, "claude"))) ?? null; } catch { /* next directory */ }
  }
  return null;
}

/** How much of a transcript's end is read for the running version: a few hundred lines, never the whole file. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** OF-212: the version the process itself wrote into its transcript: the `version` of every stamped record written on or after
 *  `since`, read from the file's tail, and only when they all agree. Claude Code stamps every record with the version of the
 *  process that wrote it (measured: 2.1.314 → 2.1.316 → 2.1.317 across resumes of one transcript), so a record newer than the
 *  process's start names the version it runs, whatever happened to its binary file since. Records carry a session id but no pid, so
 *  a second process writing the same session cannot be told apart; two versions in the window name nothing (review F4).
 *  The path is reported by the SessionStart relay, so it is read with care (review F2, F3): it must be (after following links) a regular file
 *  owned by `uid` (the daemon's), checked before it is opened, and it is opened non-blocking, so a FIFO or a directory cannot hold
 *  the daemon. The seat's Claude projects directory is NOT checked: a seat may run under its own CLAUDE_CONFIG_DIR (rig-claude uses
 *  ~/.rig/claude) and the daemon does not know which. Null when nothing is vouched, or on any error. */
export function transcriptRunningVersion(transcriptPath: string | null, since: Date, uid: number | undefined = process.getuid?.()): string | null {
  if (!transcriptPath) return null;
  let fd: number | null = null;
  try {
    const before = statSync(transcriptPath); // follows a symlink: the file it names is what is judged
    if (!before.isFile() || (uid !== undefined && before.uid !== uid)) return null;
    fd = openSync(transcriptPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return null;
    const length = Math.min(st.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, st.size - length);
    const lines = buf.toString("utf8").split("\n");
    if (st.size > length) lines.shift(); // the first line of a tail is cut
    const versions = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
      let record: { version?: unknown; timestamp?: unknown };
      try { record = JSON.parse(lines[i]!) as typeof record; } catch { continue; }
      if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version) || typeof record.timestamp !== "string") continue;
      const at = Date.parse(record.timestamp);
      if (!Number.isFinite(at)) continue;
      if (at < since.getTime()) break; // records are in time order: nothing of this process further up
      versions.add(record.version);
    }
    return versions.size === 1 ? [...versions][0]! : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
