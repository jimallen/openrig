import { Command } from "commander";
import { copyFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";
import { formatDaemonHostForUrl } from "../client.js";
import { DAEMON_STATE_POLICY, readOwnFile } from "@openrig/daemon/credential-file";
import { NO_HOME_DAEMON_URL, resolveHomeDaemon } from "../home-daemon-address.js";

// `rig crash-cart --json` — the daemon-DOWN recovery verdict emit (plan c015d9ed §C3, coupling ruling
// option A). Prints ONE JSON = the 3-state detector verdict + (on DOWN) the discovery — READ-ONLY, a
// public agent-readable surface (the 4 rails). A fail-closed refusal still prints STRUCTURED JSON
// (never exit-code-only). The `emit` is injected: the real wiring imports emitCrashCartState from the
// scoped @openrig/daemon/crash-cart subpath (reuse VERBATIM) — set up alongside this command.
//
// SCOPE FENCE (plan R10 / Boundaries): "no new CLI verb v1; bare `rig` is the cart." There are NO
// `restore-fleet` / `cancel-fleet` public verbs — the TUI drives the conductor through the daemon client
// directly against the R2-sanctioned daemon-side batch route. This command emits the read-only verdict only.

export type DaemonState = "up" | "down" | "unverified";

export interface CrashCartEmit {
  state: DaemonState;
  evidence?: { pidState: string; probeResult: string; failedSignal: string };
  discovery?: unknown;
  refusal?: string;
}

export interface CrashCartCommandDeps {
  /** Produce the verdict (the real wiring: emitCrashCartState with live probes + the C2 read). */
  emit: () => Promise<CrashCartEmit>;
  /** Emit one line (default: stdout). */
  write: (line: string) => void;
}

function openrigHome(): string {
  return process.env.OPENRIG_HOME ?? join(homedir(), ".openrig");
}

/** Read daemon.json returning the FULL record incl. `db` (loadCrashCartDiscovery needs the db path;
 *  the detector's readDaemonJson omits it). */
function readDaemonJsonWithDb(home: string): { pid: number; port: number; host?: string; db: string } | undefined {
  const p = join(home, "daemon.json");
  // workspaces-o9o.160: the record's pid decides whether the cart refuses and its db which database it copies, so it is read
  // under the credential rule. A record the rule refuses (a link, another user's file) is a refusal naming the fix, never used.
  const read = readOwnFile(p, DAEMON_STATE_POLICY);
  if (!read.ok && read.problem === "missing") return undefined;
  if (!read.ok) throw new Error(`Cannot read recorded daemon state at ${p}: ${read.message}`);
  try {
    const j = JSON.parse(read.content) as { pid?: unknown; port?: unknown; host?: unknown; db?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number" && typeof j.db === "string") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined, db: j.db };
    }
    throw new Error("daemon.json has no usable PID, port and database path");
  } catch (error) {
    throw new Error(`Cannot read recorded daemon state at ${p}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Only ENOENT means absent; permissions and dangling links must fail visibly. */
function existsOrThrow(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/**
 * The real verdict: LAZY-imports the narrow @openrig/daemon/crash-cart subpath at invocation (dep
 * rail 2 — rig startup + other verbs never load the daemon module) and composes the shipped detector
 * + C2 read VERBATIM (rail 2) with live probes + read-only IO. This is real-run glue over the tested
 * emit/detector/read cores.
 */
/**
 * workspaces-o9o.181: the daemon crash-cart probes, from the one resolver (OPENRIG_URL, this home's daemon.json, its
 * configured target). The detector is always given this address, so it never reaches its own 127.0.0.1:7433 default. A home
 * that names no daemon gets the no-daemon address, and the returned fetch never sends to it: its probe reads as refused.
 */
export function crashCartDaemonTarget(
  recorded: { host?: string; port: number } | undefined,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): { openrigUrl: string; fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response> } {
  const target = resolveHomeDaemon({
    recordedUrl: recorded ? `http://${formatDaemonHostForUrl(recorded.host ?? "127.0.0.1")}:${recorded.port}` : undefined,
  });
  const openrigUrl = target.kind === "none"
    ? NO_HOME_DAEMON_URL
    : target.kind === "configured" ? `http://${formatDaemonHostForUrl(target.host)}:${target.port}` : target.url;
  const guarded = (url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
    url.startsWith(NO_HOME_DAEMON_URL)
      ? Promise.reject(Object.assign(new Error(target.kind === "none" ? target.reason : "no daemon"), { code: "ECONNREFUSED" }))
      : fetchImpl(url, init);
  return { openrigUrl, fetch: guarded };
}

async function realEmit(): Promise<CrashCartEmit> {
  const cc = await import("@openrig/daemon/crash-cart");
  const home = openrigHome();
  // workspaces-o9o.181: the one resolver says which daemon this home means (OPENRIG_URL, its daemon.json, its configured
  // target); the detector is always given that address, so it never reaches its own 127.0.0.1:7433 default. A home that
  // names no daemon gets the no-daemon address, which is never fetched: its probe reads as refused, and nothing is sent.
  const { openrigUrl, fetch: guardedFetch } = crashCartDaemonTarget(cc.readDaemonJson(home), fetch);
  const probeClassified = (url: string) => cc.probeHealthz(url, { fetch: guardedFetch, timeoutMs: 700 });
  const detectDeps = {
    openrigHome: home,
    readDaemonJson: cc.readDaemonJson,
    isProcessAlive: cc.isProcessAlive,
    probeHealthz: probeClassified,
    openrigUrl,
  };
  return cc.emitCrashCartState({
    resolveState: () =>
      cc.resolveDaemonState({ ...detectDeps, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxProbes: 3, retryDelayMs: 400 }),
    assembleEvidence: async () => {
      const state = cc.readDaemonJson(home);
      const pidState = state
        ? cc.isProcessAlive(state.pid)
          ? `alive (pid ${state.pid})`
          : `dead (pid ${state.pid})`
        : "no daemon.json";
      // workspaces-o9o.181: always the resolved address (above); no fallback of its own.
      const url = `${openrigUrl.replace(/\/$/, "")}/healthz`;
      const probeResult = await probeClassified(url);
      return { pidState, probeResult, failedSignal: `healthz ${probeResult} at ${url}` };
    },
    loadDiscovery: async () => {
      const { discovery } = await cc.loadCrashCartDiscovery({
        openrigHome: home,
        readDaemonJson: readDaemonJsonWithDb,
        isProcessAlive: cc.isProcessAlive,
        probeHealthz: (url) => probeClassified(url).then((r) => r === "answered"),
        copyFile: copyFileSync,
        exists: existsOrThrow,
        configuredDbPath: new ConfigStore().resolve().db.path,
        makeScratchDir: () => mkdtempSync(join(tmpdir(), "crash-cart-")),
        removeScratchDir: (d) => rmSync(d, { recursive: true, force: true }),
        openDb: cc.openDaemonDbReadonly,
        openrigUrl,
      });
      return discovery;
    },
  });
}

export function crashCartCommand(deps?: Partial<CrashCartCommandDeps>): Command {
  const cmd = new Command("crash-cart").description(
    "Emit the daemon-down recovery verdict + discovery as JSON (read-only).",
  );
  cmd.option("--json", "emit JSON (the default machine-readable form)");
  cmd.action(async () => {
    const emit = deps?.emit ?? realEmit;
    const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
    const result = await emit();
    // Rail 3: the JSON is the truth (verdict + discovery, or a structured refusal). Always printed.
    write(JSON.stringify(result));
    // A non-zero exit is a HINT only (not-cleanly-up); the JSON remains the contract.
    process.exitCode = result.state === "up" ? 0 : 1;
  });

  return cmd;
}
