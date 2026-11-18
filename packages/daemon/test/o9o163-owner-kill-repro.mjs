import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, "o9o163-owner-kill-worker.mts");
const observationMs = 2_000;
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function workerEnv() {
  const env = { ...process.env };
  for (const key of [
    "HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE",
    "OPENRIG_TEST_SCRATCH_ROOT", "OPENRIG_TEST_HC_SCRATCH_REGISTRY", "OPENRIG_TEST_HC_SCRATCH_REGISTRY_OWNER",
    "OPENRIG_TEST_FIXTURE_REGISTRY", "OPENRIG_TEST_FIXTURE_REGISTRY_OWNER",
  ]) delete env[key];
  return env;
}

function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const args = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    const env = readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(Boolean);
    let cwd = "";
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch {}
    return { pid, ppid: Number(fields[1]), startTicks: fields[19], comm, args, env, cwd };
  } catch {
    return null;
  }
}

// Kept synchronous and local to /proc; this reproduction never opens /proc/<pid>/fd.

function matchesPrivateCore(proc, meta) {
  if (!proc) return false;
  const session = `HC_SESSION=${meta.env.HC_SESSION}`;
  const all = [proc.cwd, ...proc.args, ...proc.env];
  return proc.env.includes(session) || all.some((value) => value.includes(meta.root));
}

function privateProcesses(meta) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const proc = procInfo(Number(entry));
    if (matchesPrivateCore(proc, meta)) found.push(proc);
  }
  return found;
}

function kind(proc) {
  if (proc.comm.includes("herdr-core") || proc.args.some((arg) => arg.endsWith("/herdr-core"))) return "herdr-core";
  if (proc.comm === "sleep" || proc.args.some((arg) => arg === "sleep")) return "child";
  if (proc.comm.startsWith("node") || proc.args.some((arg) => /(^|\/)node$/.test(arg))) return "node";
  return proc.comm;
}

function waitForMessage(messages, wanted, child, stderr, timeoutMs) {
  return new Promise((resolveMessage, rejectMessage) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const message = messages.find((item) => item.type === wanted);
      if (message) return resolveMessage(message);
      const error = messages.find((item) => item.type === "error");
      if (error) return rejectMessage(new Error(error.error));
      if (child.exitCode !== null || child.signalCode !== null) {
        return rejectMessage(new Error(`worker exited before ${wanted}; stderr=${stderr()}`));
      }
      if (Date.now() >= deadline) return rejectMessage(new Error(`timed out waiting for ${wanted}; stderr=${stderr()}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function signalVerified(meta, signal) {
  const current = new Map(privateProcesses(meta).map((proc) => [proc.pid, proc]));
  for (const [pid, expected] of current) {
    if (pid === process.pid) continue;
    const fresh = procInfo(pid);
    if (!matchesPrivateCore(fresh, meta) || fresh.startTicks !== expected.startTicks) continue;
    try { process.kill(pid, signal); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function cleanup(meta) {
  if (!meta) return;
  if (meta.hcPath) {
    spawnSync(meta.hcPath, ["server", "stop"], { env: meta.env, stdio: "ignore", timeout: 8_000 });
  }
  let remaining = await waitFor(() => {
    const processes = privateProcesses(meta);
    return processes.length === 0 ? processes : null;
  }, 4_000, "private core shutdown").catch(() => privateProcesses(meta));
  if (remaining.length) {
    signalVerified(meta, "SIGTERM");
    remaining = await waitFor(() => privateProcesses(meta).length === 0, 2_000, "private process TERM cleanup").catch(() => privateProcesses(meta));
  }
  if (remaining.length) {
    signalVerified(meta, "SIGKILL");
    remaining = await waitFor(() => privateProcesses(meta).length === 0, 2_000, "private process KILL cleanup").catch(() => privateProcesses(meta));
  }
  if (remaining.length) {
    throw new Error(`private processes remain after verified cleanup: ${remaining.map((p) => `${p.pid}:${p.comm}`).join(", ")}; root retained at ${meta.root}`);
  }
  rmSync(meta.root, { recursive: true, force: true });
  if (existsSync(meta.root)) throw new Error(`private root still exists after cleanup: ${meta.root}`);
}

async function reproduce(helper) {
  const child = spawn(process.execPath, ["--import", "tsx", workerPath, helper], {
    cwd: here,
    env: workerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const messages = [];
  let errorText = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errorText += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try { messages.push(JSON.parse(line)); }
    catch { errorText += `unparsed worker output: ${line}\n`; }
  });
  let meta;
  try {
    meta = await waitForMessage(messages, "root", child, () => errorText, 10_000);
    if (!meta.hcPath) throw new Error("helper did not resolve an hc executable");
    await waitForMessage(messages, "ready", child, () => errorText, 20_000);
    const childProc = await waitFor(
      () => privateProcesses(meta).find((proc) => kind(proc) === "child"),
      5_000,
      "the private terminal's sleep child",
    );
    const workerPid = meta.pid;
    child.kill("SIGKILL");
    const [exitCode, exitSignal] = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => rejectExit(new Error(`worker ${workerPid} did not exit after SIGKILL`)), 5_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit([code, signal]);
      });
    });
    if (exitSignal !== "SIGKILL") throw new Error(`worker ${workerPid} exited with ${exitSignal ?? exitCode}, expected SIGKILL`);
    await wait(observationMs);
    const survivors = privateProcesses(meta).map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      kind: kind(proc),
      comm: proc.comm,
      args: proc.args,
      cwd: proc.cwd,
    }));
    const counts = {};
    for (const proc of survivors) counts[kind(proc)] = (counts[kind(proc)] ?? 0) + 1;
    return {
      helper,
      root: meta.root,
      workerPid,
      workerSignal: exitSignal,
      waitAfterKillMs: observationMs,
      preKillChildPid: childProc.pid,
      survives: survivors.length > 0,
      counts,
      survivors,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    lines.close();
    if (meta) await cleanup(meta);
  }
}

const results = [];
for (const helper of ["test", "helpers"]) {
  results.push(await reproduce(helper));
}
for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdout.write(`SUMMARY ${JSON.stringify({
  helpers: results.length,
  workersKilled: results.filter((r) => r.workerSignal === "SIGKILL").length,
  coresWithSurvivors: results.filter((r) => r.survives).length,
  survivorProcesses: results.reduce((sum, r) => sum + Object.values(r.counts).reduce((n, count) => n + count, 0), 0),
  cleanupComplete: true,
})}\n`);
