import { execFile, spawn } from "node:child_process";
import { DaemonClient } from "./client.js";
import { hcCoreListening } from "./hc-core-probe.js";

interface SharedTuiClient {
  readonly baseUrl?: string;
  get<T>(path: string): Promise<{ status: number; data: T }>;
}

/** Resolve the terminal on the selected instance, not a remembered terminal address. */
export async function sharedTuiTarget(client: SharedTuiClient = new DaemonClient()): Promise<string> {
  if (client.baseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
    throw new Error("Shared attachment uses the local hc core. Run rig tui --shared on the selected daemon's machine; standalone rig tui can use this remote connection.");
  }
  const rigs = await client.get<Array<{ rigId: string; rigName?: string; name?: string }>>("/api/ps");
  if (rigs.status >= 400) throw new Error(`Cannot read rigs (HTTP ${rigs.status}); run rig status.`);
  const kernels = rigs.data.filter((r) => (r.rigName ?? r.name) === "kernel");
  if (kernels.length > 1) throw new Error("Multiple kernels are registered. Inspect rig ps and reconcile the intended binding before shared attachment.");
  const kernel = kernels[0];
  if (!kernel) throw new Error("No kernel is registered on this instance. Run rig status; complete runtime authentication before starting the daemon. Standalone: rig tui.");
  const nodes = await client.get<Array<{
    logicalId: string; runtime: string | null;
    canonicalSessionName: string | null; tmuxAttachCommand: string | null;
  }>>(`/api/rigs/${encodeURIComponent(kernel.rigId)}/nodes`);
  if (nodes.status >= 400) throw new Error(`Cannot read kernel terminals (HTTP ${nodes.status}); run rig status.`);
  const terminal = nodes.data.find((n) => n.logicalId === "operator.human" && n.runtime === "terminal");
  if (!terminal?.canonicalSessionName || !terminal.tmuxAttachCommand) {
    throw new Error("The kernel has no bound shared terminal. Inspect rig ps --nodes --rig kernel; restore the existing terminal rather than launching another kernel. Standalone: rig tui.");
  }
  return terminal.canonicalSessionName;
}

/** The seat label every hc terminal carries (daemon/src/adapters/hc-host.ts `SEAT_LABEL`; the CLI does not import the daemon). */
const SEAT_LABEL = "openrig.seat";

export interface SharedAttachDeps {
  /** The hc executable. Default: `hc` on PATH. */
  hc?: string;
  /** Run `hc` and return what it printed. Default: execFile. */
  list?(args: string[]): Promise<{ code: number; stdout: string }>;
  /** Run `hc` on this terminal's own stdio and return its exit code. Default: spawn. */
  attach?(args: string[]): Promise<number>;
}

/**
 * The address of the live hc terminal that carries `seat` in its `openrig.seat` label. Looked up by label so this module
 * does not repeat the daemon's name recipe. Throws when none or several match: attaching a guess would put the person
 * on somebody else's terminal.
 */
export async function resolveSharedTerminal(seat: string, deps: SharedAttachDeps = {}): Promise<string> {
  const hc = deps.hc ?? "hc";
  const args = ["ls", "--json", "--label", `${SEAT_LABEL}=${seat}`];
  const result = await (deps.list ?? ((a) => runHc(hc, a)))(args);
  let terminals: Array<{ address?: unknown }>;
  try {
    const parsed = JSON.parse(result.stdout) as { terminals?: unknown };
    if (result.code !== 0 || !Array.isArray(parsed.terminals)) throw new Error("unexpected output");
    terminals = parsed.terminals as Array<{ address?: unknown }>;
  } catch {
    throw new Error("Cannot list hc terminals; run rig status, or hc server status.");
  }
  const addresses = terminals.map((t) => t.address).filter((a): a is string => typeof a === "string" && a.length > 0);
  if (addresses.length === 0) throw new Error(`No live hc terminal carries the label ${SEAT_LABEL}=${seat}. Inspect rig ps --nodes --rig kernel; restore the existing terminal rather than launching another kernel.`);
  if (addresses.length > 1) throw new Error(`${addresses.length} hc terminals carry the label ${SEAT_LABEL}=${seat} (${addresses.join(", ")}); attach one by hand with hc attach <address>.`);
  return addresses[0]!;
}

/**
 * Put this terminal on the kernel's shared terminal: `hc attach -- <address>`, detach with Ctrl-\.
 *
 * Size, measured on a private hc 0.1.15 core: a plain attach resizes the program to THIS terminal's size as soon as it
 * attaches (no key typed), and it goes back to its creation size (200x120) when the last viewer leaves. The person who
 * runs this wants to use the dashboard, so it is a plain attach and the dashboard takes the size of their window; a
 * second person attaching plain afterwards takes the size from the first. `--observe` would not resize but cannot type.
 *
 * The env is passed through unchanged: hc picks its core from HC_SESSION and HC_SOCKET, which this process shares with
 * the daemon's. Nothing is stripped (the tmux version deleted $TMUX so as not to retarget a client). Measured: attaching
 * a different terminal from inside an hc terminal works (exit 0); attaching the terminal one is in is refused by hc
 * itself (exit 1, "attached to itself"), which is right here and so is not worked around.
 */
export async function attachSharedTui(target: string, deps: SharedAttachDeps = {}): Promise<number> {
  const address = await resolveSharedTerminal(target, deps);
  const args = ["attach", "--", address];
  if (deps.attach) return deps.attach(args);
  const hc = deps.hc ?? "hc";
  return new Promise((resolve, reject) => {
    const child = spawn(hc, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** `hc ls` starts a core when none runs, in this caller's env (F6): with no listener it is not run, and reads as a failed list. */
async function runHc(hc: string, args: string[]): Promise<{ code: number; stdout: string }> {
  if (!(await hcCoreListening())) return { code: 1, stdout: "" };
  return new Promise((resolve) => {
    execFile(hc, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}
