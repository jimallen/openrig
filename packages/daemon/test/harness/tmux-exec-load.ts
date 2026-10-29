// OF-176 harness: how many tmux / ps processes a scenario-local daemon starts per minute for N stub seats, and how soon
// it reports a seat's new pane output. Not a vitest file (run it with tsx); it needs the built CLI (packages/cli/dist).
//
//   npx tsx test/harness/tmux-exec-load.ts --seats 12 --zombies 4 --measure 60 [--tmux-dir /path/to/bin] [--trials 5]
//
// Everything runs in a hermetic scaffold: its own tmux server on an owned -S socket, its own daemon on an ephemeral port,
// its own OPENRIG_HOME; nothing reaches a live daemon, ~/.openrig or a shared tmux socket. A shim placed first on the
// daemon's PATH records every `tmux` and `ps` the daemon (or a shell it runs) starts, with a timestamp and its parent's
// parent, so execs from the seats' own processes are told apart. Zombies: seats whose tmux session is killed after
// start-up while their session rows stay "running" (the live laptop had 8 such rows, of an archived rig).
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { stringify as stringifyYaml } from "yaml";
import { prepareHermeticEnv } from "../helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon } from "../helpers/scenario-daemon.js";
import { stageTopologyRoot } from "../helpers/scenario-stage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback; };
const seats = Number(opt("seats", "12")), zombies = Number(opt("zombies", "0")), measureS = Number(opt("measure", "60"));
const trials = Number(opt("trials", "5")), tmuxDir = opt("tmux-dir", ""), settleS = Number(opt("settle", "25"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const basePath = (tmuxDir ? `${tmuxDir}:` : "") + (process.env.PATH ?? "");
const scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: basePath, TERM: "xterm-256color", SHELL: "/bin/bash" } });
const log = join(scaffold.root, "exec.log");
const shim = join(scaffold.root, "shim");
mkdirSync(shim, { recursive: true });
// $1 = the binary to exec after recording. The grandparent is read from /proc (Linux) so a `sh -c tmux …` is attributed.
const record = (bin: string) => `#!/bin/sh
gp=$(awk '{print $4}' /proc/$PPID/stat 2>/dev/null || echo 0)
printf '%s %s %s %s\\n' "$(date +%s.%N)" "$PPID" "$gp" "$(basename "$0") $*" >> '${log}'
exec ${bin} "$@"
`;
writeFileSync(join(shim, "tmux"), record(join(scaffold.root, "bin", "tmux")), { mode: 0o755 });
writeFileSync(join(shim, "ps"), record("/bin/ps"), { mode: 0o755 });
scaffold.env.PATH = `${shim}:${scaffold.env.PATH}`;
const tmux = (...a: string[]) => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, ...a], { env: scaffold.tmuxEnv, encoding: "utf8" });

const rigBin = resolve(HERE, "../../../cli/dist/bin-wrapper.js");
const daemon = await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 120_000 });
const daemonPid = (JSON.parse(readFileSync(join(scaffold.openrigHome, "daemon.json"), "utf8")) as { pid: number }).pid;
const result: Record<string, unknown> = { seats, zombies, measureS, tmux: execFileSync("tmux", ["-V"], { env: scaffold.tmuxEnv, encoding: "utf8" }).trim() };
try {
  // N stub seats in one pod, staged with the repository's own helper (own cwd per seat, inside the scaffold).
  const src = join(scaffold.root, "topo-src");
  cpSync(join(HERE, "..", "fixtures", "scenarios"), src, { recursive: true });
  const members = Array.from({ length: seats }, (_, i) => ({ id: `w${i}`, agent_ref: "local:agents/worker", profile: "default", runtime: "stub", cwd: "." }));
  writeFileSync(join(src, "load.yaml"), stringifyYaml({ version: "0.2", name: "load", culture_file: "culture.md", pods: [{ id: "dev", label: "Dev", members, edges: [] }] }));
  const staged = stageTopologyRoot(join(src, "load.yaml"), join(scaffold.root, "topology"));
  const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 600_000);
  if (up.code !== 0) throw new Error(`rig up failed: ${up.stderr || up.stdout}`);
  const summary = (await (await fetch(`${daemon.baseUrl}/api/rigs/summary`)).json()) as Array<{ id: string; name: string }>;
  const rigId = summary.find((r) => r.name === "load")?.id;
  if (!rigId) throw new Error(`rig "load" not found after up: ${JSON.stringify(summary)}`);
  const sessions = Array.from({ length: seats }, (_, i) => `dev-w${i}@load`);
  await sleep(settleS * 1000);
  for (const s of sessions.slice(seats - zombies)) tmux("kill-session", "-t", `=${s}`); // rows stay as they are
  await sleep(5_000);

  // Count the daemon's execs over the window: direct children, and children of a shell the daemon started.
  const lineCount = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  const from = lineCount();
  const t0 = Date.now() / 1000;
  await sleep(measureS * 1000);
  const t1 = Date.now() / 1000;
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(from);
  const shapes: Record<string, number> = {};
  let daemonExecs = 0, other = 0;
  for (const l of lines) {
    const [ts, ppid, gp, ...rest] = l.split(" ");
    if (Number(ts) < t0 || Number(ts) > t1) continue;
    if (Number(ppid) !== daemonPid && Number(gp) !== daemonPid) { other++; continue; }
    daemonExecs++;
    const argv = rest;
    const sub = argv[0] === "ps" ? "ps" : `tmux ${argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("=") && !a.startsWith("%") && !a.startsWith("__openrig")).slice(0, 1).join(" ")}${argv.includes(";") ? " (chained)" : ""}`;
    shapes[sub] = (shapes[sub] ?? 0) + 1;
  }
  const perMin = (n: number) => Math.round((n * 60) / (t1 - t0));
  result.daemonExecsPerMin = perMin(daemonExecs);
  result.otherExecsPerMin = perMin(other);
  // Whether the killed seats stayed "running" rows (zombies) over the window, read from this daemon's own database.
  const db = new Database(join(scaffold.stateDir, "scenario.db"), { readonly: true, fileMustExist: true });
  const running = db.prepare("SELECT session_name FROM sessions WHERE status = 'running'").all() as Array<{ session_name: string }>;
  db.close();
  result.zombieRowsRunning = sessions.slice(seats - zombies).filter((s) => running.some((r) => r.session_name === s)).length;
  result.shapesPerMin = Object.fromEntries(Object.entries(shapes).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, perMin(v)]));

  // Latency: an idle live seat gets a keystroke (echoed into its pane); how soon does the daemon report it?
  const live = sessions[0]!;
  const latencies: Array<{ lastActivityMs: number | null }> = [];
  for (let t = 0; t < trials; t++) {
    await sleep(6_000); // let the seat go idle
    const sentAtS = Math.floor(Date.now() / 1000);
    const sentAt = Date.now();
    tmux("send-keys", "-t", `=${live}:`, "-l", "x");
    let lastActivityMs: number | null = null;
    while (Date.now() - sentAt < 15_000) {
      const res = await fetch(`${daemon.baseUrl}/api/rigs/${encodeURIComponent(rigId)}/nodes`);
      const nodes = (await res.json()) as Array<{ canonicalSessionName?: string; lastActivityAt?: string | null }>;
      const entry = nodes.find((n) => n.canonicalSessionName === live);
      if (entry?.lastActivityAt && Date.parse(entry.lastActivityAt) / 1000 >= sentAtS) { lastActivityMs = Date.now() - sentAt; break; }
      await sleep(50);
    }
    latencies.push({ lastActivityMs });
  }
  result.activityLatencyMs = latencies.map((l) => l.lastActivityMs);
  await runRig(["down", "load", "--json", "--force"], daemon.readEnv, rigBin, 300_000).catch(() => undefined);
} finally {
  await daemon.stop();
}
appendFileSync(process.env.OF176_RESULTS ?? join(process.cwd(), "of176-results.jsonl"), JSON.stringify(result) + "\n");
console.log(JSON.stringify(result));
