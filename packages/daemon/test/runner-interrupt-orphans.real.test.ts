// workspaces-21r: a daemon gate run left 15 processes behind on Sparky (2 herdr-core serve, 2 hold, 9 stub.py, 2
// pi-runner), from hc-delivery.real.test.ts and delivery-review.real.test.ts, reparented to systemd --user. Both files start a
// private core through test/hc-private-core.ts in beforeAll and stop it in afterAll. o9o.163 covers a test WORKER killed
// outright (private-core-owner-death.real.test.ts); this covers the RUN being interrupted: vitest's own test timeout, and
// SIGTERM or SIGINT to the vitest process itself (a tool stopping a run, Ctrl-C). Each row starts a real vitest run of
// fixtures/runner-interrupt/core-hang.fixture.ts, records every process that run made, interrupts it, and requires every
// one of them gone. Linux only: it reads /proc (stat, cmdline, environ; never the fd directory).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HC } from "./hc-private-core.js";
import { hasProcFs } from "./helpers/orphan-reaper.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixtures", "runner-interrupt");
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

interface Proc { pid: number; start: string; comm: string; args: string }

function procOf(pid: number): (Proc & { ppid: number; env: string[] }) | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid, ppid: Number(fields[1]), start: fields[19] ?? "", comm: stat.slice(stat.indexOf("(") + 1, close),
      args: readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean).join(" "),
      env: readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0"),
    };
  } catch {
    return null;
  }
}

const allProcs = () => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map((n) => procOf(Number(n))).filter((p) => p !== null);

/** The run's processes: the runner and every descendant of it, and every process carrying the core's runtime dir. */
function runProcesses(runner: number, runtimeDir: string): Proc[] {
  const procs = allProcs();
  const entry = `XDG_RUNTIME_DIR=${runtimeDir}`;
  const mine = new Set<number>([runner]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!mine.has(p.pid) && (mine.has(p.ppid) || p.env.includes(entry))) { mine.add(p.pid); grew = true; }
  }
  return procs.filter((p) => mine.has(p.pid) && p.pid !== process.pid).map(({ pid, start, comm, args }) => ({ pid, start, comm, args }));
}

const sameProc = (p: Proc): boolean => procOf(p.pid)?.start === p.start;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (ps: Proc[]) => ps.map((p) => `${p.pid}:${p.comm}:${p.args.slice(0, 80)}`);

interface Row { runner: ChildProcess; recorded: Proc[]; worker?: number; root?: string; coreEnv?: NodeJS.ProcessEnv; scratch: string }
const rows: Row[] = [];

/** Stops what a failed row left: only a recorded process still carrying its recorded start time. Never a pattern. */
afterEach(async () => {
  for (const row of rows.splice(0)) {
    if (row.coreEnv) spawnSync(HC, ["server", "stop"], { env: row.coreEnv, stdio: "ignore", timeout: 8_000 });
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const left = row.recorded.filter(sameProc);
      if (left.length === 0) break;
      for (const p of left) { try { process.kill(p.pid, signal); } catch { /* gone */ } }
      await sleep(2_000);
    }
    if (row.root) rmSync(row.root, { recursive: true, force: true });
    rmSync(row.scratch, { recursive: true, force: true });
  }
});

type Meta = { type: "root"; root: string; runtimeDir: string; env: NodeJS.ProcessEnv; worker: number } | { type: "ready"; core: number; holder: number };
const readMeta = (file: string): Meta[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Meta) : []);

async function startRun(testTimeoutMs: number): Promise<Row> {
  const scratch = mkdtempSync(join(tmpdir(), "ri21r-"));
  const metaFile = join(scratch, "meta.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, RI_META: metaFile, RI_TEST_TIMEOUT_MS: String(testTimeoutMs) };
  for (const k of ["HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE"]) delete env[k];
  const runner = spawn(process.execPath, [VITEST, "run", "--config", join(FIXTURE_DIR, "vitest.config.mts")], { cwd: FIXTURE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  runner.stdout!.setEncoding("utf8").on("data", (c: string) => { out += c; });
  runner.stderr!.setEncoding("utf8").on("data", (c: string) => { out += c; });
  const row: Row = { runner, recorded: [], scratch };
  rows.push(row);
  const until = Date.now() + 60_000;
  for (;;) {
    const meta = readMeta(metaFile);
    const root = meta.find((m) => m.type === "root");
    if (root && root.type === "root") { row.root = root.root; row.coreEnv = root.env; row.worker = root.worker; }
    if (root && root.type === "root" && meta.some((m) => m.type === "ready")) {
      row.recorded = runProcesses(runner.pid!, root.runtimeDir);
      return row;
    }
    if (runner.exitCode !== null || Date.now() > until) throw new Error(`the inner run never got ready (exit ${runner.exitCode}): ${out.slice(-2000)}`);
    await sleep(50);
  }
}

describe.skipIf(!HC || !hasProcFs())("an interrupted vitest run leaves none of its private core's processes behind (workspaces-21r; Linux: reads /proc)", () => {
  it.each([
    ["vitest's own test timeout", 4_000, null],
    ["SIGTERM to the vitest process", 600_000, "SIGTERM"],
    ["SIGINT to the vitest process", 600_000, "SIGINT"],
    ["SIGKILL to the vitest process (no teardown can run)", 600_000, "SIGKILL"],
  ] as const)("%s", async (_name, testTimeoutMs, signal) => {
    const { runner, recorded, worker } = await startRun(testTimeoutMs);
    // Positive controls: the run has its worker, a core and its holder, and both terminal programs to lose.
    expect(recorded.map((p) => p.pid), JSON.stringify(show(recorded))).toContain(worker);
    expect(recorded.filter((p) => p.comm === "herdr-core").length, JSON.stringify(show(recorded))).toBeGreaterThanOrEqual(2);
    expect(recorded.filter((p) => p.comm === "sleep").length, JSON.stringify(show(recorded))).toBe(2);
    if (signal) runner.kill(signal);
    const ended = runner.exitCode !== null || runner.signalCode !== null
      || await Promise.race([new Promise<boolean>((r) => runner.once("exit", () => r(true))), sleep(60_000).then(() => false)]);
    expect(ended, "the vitest process ends").toBe(true);
    // A reaper notices its owner within 1 s, TERMs, and KILLs 3 s later; 20 s is that bound with room for a loaded host.
    const deadline = Date.now() + 20_000;
    while (recorded.some(sameProc) && Date.now() < deadline) await sleep(100);
    expect(show(recorded.filter(sameProc))).toEqual([]);
  }, 150_000);
});
