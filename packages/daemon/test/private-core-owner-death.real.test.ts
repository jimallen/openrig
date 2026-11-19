// workspaces-o9o.163: the two private-core helpers (test/hc-private-core.ts and test/helpers/hc-private-core.ts) start a
// private hc core and stopped it only through stop() in an afterAll. A test worker that died abruptly (SIGKILL, a stopped run)
// left the core and its terminal programs running for good: verify-qa's census found 36 such processes on Sparky, and its
// repro (branch qa/o9o163-repro-verifyqa-1118) showed 2/2 helpers leaving herdr-core and a terminal child after the owner's
// SIGKILL. This is that repro as a test: a worker starts a core through one helper, runs a terminal program, is killed, and
// every process of that core must be gone within the watchdog's bound.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HC, PrivateCore as TestPrivateCore } from "./hc-private-core.js";
import { PrivateCore as HelperPrivateCore } from "./helpers/hc-private-core.js";
import { hasProcFs } from "./helpers/orphan-reaper.js";
import { waitBound, waitTimedOut } from "./helpers/wait-timeout.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, "fixtures", "private-core-owner-kill-worker.mts");

interface WorkerMeta { type: string; helper: string; pid: number; root: string; env: Record<string, string>; hcPath: string; error?: string }
interface Proc { pid: number; start: string; comm: string; args: string[] }

/** One process, read from /proc (stat, cmdline, environ, cwd link). Never its fd directory. */
function procOf(pid: number): (Proc & { env: string[]; cwd: string }) | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    let cwd = "";
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone or not ours */ }
    return {
      pid, start: fields[19] ?? "", comm: stat.slice(stat.indexOf("(") + 1, close),
      args: readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean),
      env: readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(Boolean),
      cwd,
    };
  } catch {
    return null;
  }
}

/** Every process of this core: its runtime dir in the environment, or its root in the arguments or the working folder. */
function coreProcesses(meta: WorkerMeta): Proc[] {
  const runtime = `XDG_RUNTIME_DIR=${meta.env.XDG_RUNTIME_DIR}`;
  const found: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const p = procOf(Number(name));
    if (p && (p.env.includes(runtime) || [p.cwd, ...p.args].some((v) => v.startsWith(meta.root)))) found.push({ pid: p.pid, start: p.start, comm: p.comm, args: p.args });
  }
  return found;
}

const sameProc = (p: Proc): boolean => procOf(p.pid)?.start === p.start;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops whatever a failed row left, only while it is still the process that was seen, then removes the root. */
async function sweep(meta: WorkerMeta): Promise<void> {
  spawnSync(meta.hcPath, ["server", "stop"], { env: meta.env, stdio: "ignore", timeout: 8_000 });
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const left = coreProcesses(meta);
    if (left.length === 0) break;
    for (const p of left) if (sameProc(p)) { try { process.kill(p.pid, signal); } catch { /* gone */ } }
    await sleep(2_000);
  }
  rmSync(meta.root, { recursive: true, force: true });
}

const workers: ChildProcess[] = [];
const metas: WorkerMeta[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
  for (const m of metas.splice(0)) await sweep(m);
});

async function startWorker(helper: "test" | "helpers"): Promise<{ worker: ChildProcess; meta: WorkerMeta }> {
  const env = { ...process.env };
  // The worker makes a core of its own: nothing of an enclosing seat's or run's hc names reaches it.
  for (const k of ["HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE"]) delete env[k];
  const worker = spawn(process.execPath, ["--import", "tsx", WORKER, helper], { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
  workers.push(worker);
  let stderr = "";
  worker.stderr!.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
  const messages: WorkerMeta[] = [];
  createInterface({ input: worker.stdout! }).on("line", (line) => { try { messages.push(JSON.parse(line) as WorkerMeta); } catch { stderr += line; } });
  const bound = waitBound(30_000);
  let meta: WorkerMeta | undefined;
  for (;;) {
    meta ??= messages.find((m) => m.type === "root");
    if (meta && !metas.includes(meta)) metas.push(meta);
    const failed = messages.find((m) => m.type === "error");
    if (failed) throw new Error(`worker failed: ${failed.error}; stderr: ${stderr}`);
    if (meta && messages.some((m) => m.type === "ready")) return { worker, meta };
    if (worker.exitCode !== null || bound.expired()) throw waitTimedOut(`worker not ready (exit ${worker.exitCode}); stderr: ${stderr}`, bound);
    await sleep(25);
  }
}

describe.skipIf(!HC || !hasProcFs())("a private core does not outlive the test worker that started it (o9o.163; Linux: reads /proc)", () => {
  it.each(["test", "helpers"] as const)("%s/hc-private-core.ts: the owner's SIGKILL takes the core and its terminal program with it", async (helper) => {
    const { worker, meta } = await startWorker(helper);
    const before = coreProcesses(meta);
    // Positive controls: there is a core, and a terminal program under it, to lose.
    expect(before.filter((p) => p.comm.includes("herdr-core") || p.args.some((a) => a.endsWith("/herdr-core"))).length, JSON.stringify(before)).toBeGreaterThan(0);
    expect(before.filter((p) => p.comm === "sleep").length, JSON.stringify(before)).toBe(1);
    worker.kill("SIGKILL");
    await new Promise((r) => worker.once("exit", r));
    expect(worker.signalCode).toBe("SIGKILL");
    // The watchdog checks its owner once a second, TERMs, waits 3 s, then KILLs.
    const deadline = Date.now() + 15_000;
    while (before.some(sameProc) && Date.now() < deadline) await sleep(100);
    expect(before.filter(sameProc).map((p) => `${p.pid}:${p.comm}`)).toEqual([]);
    expect(existsSync(meta.root)).toBe(true); // the owner died before stop(): the root is the row's sweep to remove
  }, 60_000);

  /** Watchdogs that guard this core: the reaper's shell, named by its label, holding the core's runtime-dir entry as an argument. */
  const watchdogs = (runtimeDir: string | undefined): number => spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout
    .split("\n").filter((l) => l.includes("reaper:hc-private-core") && l.includes(`XDG_RUNTIME_DIR=${runtimeDir}`)).length;

  it.each([
    ["test", () => new TestPrivateCore("o163s")],
    ["helpers", () => new HelperPrivateCore()],
  ] as const)("%s/hc-private-core.ts: stop() disarms the guard it armed (positive control: one is armed while the core runs)", (_name, make) => {
    const core = make();
    expect(watchdogs(core.env.XDG_RUNTIME_DIR), "nothing is armed before start").toBe(0);
    try {
      core.start();
      expect(watchdogs(core.env.XDG_RUNTIME_DIR)).toBe(1);
    } finally {
      core.stop();
    }
    expect(watchdogs(core.env.XDG_RUNTIME_DIR)).toBe(0);
    expect(existsSync(core.root)).toBe(false);
  }, 60_000);
});
