// "Is the seat host healthy": hc is installed, it is the pinned version, and the running core speaks this build's
// protocol generation. The file keeps its old name so its importers do not move; its subject is hc, not tmux.
//
// A health check must never START a core. `hc server status`, `hc --skill` and `hc schema` all start one when none
// runs (spike 1+2), with the caller's env. So this module runs only `hc --version` (measured safe) and reads the core's
// socket itself, which is what the daemon's HcClient does too.
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The hc release OpenRig is built and tested against. A core upgrade is a tested release step, so this is an exact pin. */
export const HC_PINNED_VERSION = "0.1.15";
/** The protocol generation this build speaks; a core on any other refuses `hello` and OpenRig must stop there. Mirrors
 *  the daemon's HC_GENERATION (daemon/src/adapters/hc-client.ts), which the CLI package cannot import. */
export const HC_GENERATION = 1;

const HELLO_TIMEOUT_MS = 3_000;

export interface HcProbeResult {
  installed: boolean;
  /** True when seats can be hosted now or once a core starts: installed, pinned, and no core that contradicts it. */
  available: boolean;
  /** The version found: the CLI's, or the core's when it is the core that disagrees. */
  version: string | null;
  detail: string | null;
  /** `pinned` is the install-only answer (hc is there and is the pinned version); `available` is the full answer. */
  code: "available" | "pinned" | "no_core" | "not_installed" | "version_mismatch" | "unsupported_generation" | "unhealthy";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The core's socket, as hc itself finds it. The same rule as the daemon's resolveHcSocket (HC_SOCKET, the runtime
 *  dir, then the state dir). */
export function resolveHcSocketPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env["HC_SOCKET"]) return env["HC_SOCKET"];
  const session = env["HC_SESSION"] || "default";
  if (env["XDG_RUNTIME_DIR"]) return join(env["XDG_RUNTIME_DIR"], "herdr-core", `${session}.sock`);
  const state = env["XDG_STATE_HOME"] || join(home, ".local", "state");
  return join(state, "herdr-core", session, `${session}.sock`);
}

/** What a core answered to `hello`, or why nothing was learned. */
export type HcHelloOutcome =
  | { kind: "hello"; generation: number; version: string }
  | { kind: "no_core"; detail: string }
  | { kind: "refused"; refusal: string; detail: string }
  | { kind: "unreadable"; detail: string };

/** One `hello` over the core's socket. It never starts a core: a missing socket or a refused connection is `no_core`. */
export function readHcHello(socketPath: string = resolveHcSocketPath(), timeoutMs: number = HELLO_TIMEOUT_MS): Promise<HcHelloOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = createConnection(socketPath);
    const done = (outcome: HcHelloOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => done({ kind: "unreadable", detail: `no reply to hello in ${timeoutMs} ms` }), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: HC_GENERATION, framed: false } })}\n`);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "ENOTDIR") {
        done({ kind: "no_core", detail: `no hc core at ${socketPath} (${err.code})` });
      } else {
        done({ kind: "unreadable", detail: `hc core socket ${socketPath}: ${err.message}` });
      }
    });
    socket.on("close", () => done({ kind: "unreadable", detail: "the core closed the connection before it answered hello" }));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: { result?: { generation?: unknown; version?: unknown }; error?: { message?: unknown; data?: { kind?: unknown } } };
      try {
        reply = JSON.parse(buffer.slice(0, end));
      } catch {
        done({ kind: "unreadable", detail: "the core sent a hello reply that is not JSON" });
        return;
      }
      if (reply.error) {
        const refusal = typeof reply.error.data?.kind === "string" ? reply.error.data.kind : "unknown";
        done({ kind: "refused", refusal, detail: typeof reply.error.message === "string" ? reply.error.message : refusal });
      } else if (typeof reply.result?.generation === "number" && typeof reply.result.version === "string") {
        done({ kind: "hello", generation: reply.result.generation, version: reply.result.version });
      } else {
        done({ kind: "unreadable", detail: "the core's hello reply had no generation and version" });
      }
    });
  });
}

/** `hc --version` prints `hc 0.1.15`. */
export function parseHcVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

function classifyInstalled(output: string): HcProbeResult {
  const version = parseHcVersion(output);
  if (version === null) {
    return { installed: true, available: false, version: null, detail: `unparseable hc version output: ${output.trim().slice(0, 80)}`, code: "unhealthy" };
  }
  if (version !== HC_PINNED_VERSION) {
    return { installed: true, available: false, version, detail: `hc ${version} is installed; OpenRig is pinned to hc ${HC_PINNED_VERSION}`, code: "version_mismatch" };
  }
  return { installed: true, available: true, version, detail: null, code: "pinned" };
}

function notInstalled(err: unknown): HcProbeResult {
  return { installed: false, available: false, version: null, detail: errorMessage(err), code: "not_installed" };
}

/** Installed and the pinned version, by `hc --version` alone. Touches no core. */
export function probeHcInstall(exec: (cmd: string) => string): HcProbeResult {
  let output: string;
  try {
    output = exec("hc --version");
  } catch (err) {
    return notInstalled(err);
  }
  return classifyInstalled(output);
}

export async function probeHcInstallAsync(exec: (cmd: string) => Promise<string>): Promise<HcProbeResult> {
  let output: string;
  try {
    output = await exec("hc --version");
  } catch (err) {
    return notInstalled(err);
  }
  return classifyInstalled(output);
}

/** The core's side of health, given what `hello` returned. No core is not a failure: nothing here starts one. */
export function classifyHcCore(outcome: HcHelloOutcome): HcProbeResult {
  switch (outcome.kind) {
    case "no_core":
      return { installed: true, available: true, version: null, detail: outcome.detail, code: "no_core" };
    case "refused":
      return {
        installed: true, available: false, version: null, detail: outcome.detail,
        code: outcome.refusal === "unsupported_generation" ? "unsupported_generation" : "unhealthy",
      };
    case "unreadable":
      return { installed: true, available: false, version: null, detail: outcome.detail, code: "unhealthy" };
    case "hello":
      if (outcome.generation !== HC_GENERATION) {
        return {
          installed: true, available: false, version: outcome.version, code: "unsupported_generation",
          detail: `core speaks generation ${outcome.generation}, this build ${HC_GENERATION}`,
        };
      }
      if (outcome.version !== HC_PINNED_VERSION) {
        return {
          installed: true, available: false, version: outcome.version, code: "version_mismatch",
          detail: `the running core is hc ${outcome.version}; OpenRig is pinned to hc ${HC_PINNED_VERSION}`,
        };
      }
      return { installed: true, available: true, version: outcome.version, detail: null, code: "available" };
  }
}

/** Installed, pinned, and a core (when one runs) on this build's generation and version. */
export async function probeHcHostAsync(
  exec: (cmd: string) => Promise<string>,
  readHello: () => Promise<HcHelloOutcome> = () => readHcHello(),
): Promise<HcProbeResult> {
  const install = await probeHcInstallAsync(exec);
  if (install.code !== "pinned") return install;
  const core = classifyHcCore(await readHello());
  return core.version === null ? { ...core, version: install.version } : core;
}

export function buildHcHostFailure(code: HcProbeResult["code"], detail: string): { message: string; reason: string; fix: string } {
  const reason = "OpenRig runs agent seats in hc terminals and reads their state through the core's socket.";
  switch (code) {
    case "version_mismatch":
      return {
        message: "hc is not the pinned version.",
        reason: `${reason} Only hc ${HC_PINNED_VERSION} is tested with this build. ${detail}`,
        fix: `Install hc ${HC_PINNED_VERSION} (see hc update --help), and if a core from another version is running, restart it with hc server restart (terminals stay alive).`,
      };
    case "unsupported_generation":
      return {
        message: "The running hc core speaks a protocol generation OpenRig does not.",
        reason: `${reason} ${detail}`,
        fix: `Use hc ${HC_PINNED_VERSION}. OpenRig refuses an unknown generation rather than guess at it.`,
      };
    default:
      return {
        message: "hc is installed, but it is not healthy.",
        reason: `${reason} The core is returning: ${detail}`,
        fix: "Check hc server status from your own terminal (it starts a core if none runs), then retry OpenRig. If this happened after a machine restore, treat it as attention required rather than a healthy running state.",
      };
  }
}
