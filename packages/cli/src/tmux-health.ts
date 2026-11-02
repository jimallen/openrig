// "Is the seat host healthy": hc is installed, it is an accepted version, and the running core speaks this build's
// protocol generation and is an accepted version too. Which versions are accepted is one rule, the daemon's (hc-version.ts):
// the tested minor line from the oldest accepted release up, with a warning when it is not the tested version. The file keeps its old name so its importers do not move; its subject is hc, not tmux.
//
// A health check must never START a core. `hc server status`, `hc --skill` and `hc schema` all start one when none
// runs (spike 1+2), with the caller's env. So this module runs only `hc --version` (measured safe) and reads the core's
// socket itself, which is what the daemon's HcClient does too.
import { createConnection } from "node:net";
import { HC_GENERATION, HC_OLDEST_ACCEPTED_VERSION, HC_TESTED_VERSION, judgeHcVersion, parseHcVersionOutput, resolveHcSocket } from "@openrig/daemon/hc";

// The tested version, the oldest accepted one and the protocol generation are the daemon's (hc-surface.ts); re-exported so importers keep one place to ask.
export { HC_GENERATION, HC_OLDEST_ACCEPTED_VERSION, HC_TESTED_VERSION };

const HELLO_TIMEOUT_MS = 3_000;

export interface HcProbeResult {
  installed: boolean;
  /** True when seats can be hosted now or once a core starts: installed, an accepted version, and no core that contradicts it. */
  available: boolean;
  /** The version found: the CLI's, or the core's when it is the core that disagrees. */
  version: string | null;
  detail: string | null;
  /** Set when the version is accepted but is not the tested one: the words name both versions. `available` is still true. */
  warning?: string;
  /** `pinned` is the install-only answer (hc is there and is an accepted version); `available` is the full answer. */
  code: "available" | "pinned" | "no_core" | "not_installed" | "version_mismatch" | "unsupported_generation" | "unhealthy";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a core answered to `hello`, or why nothing was learned. */
export type HcHelloOutcome =
  | { kind: "hello"; generation: number; version: string }
  | { kind: "no_core"; detail: string }
  | { kind: "refused"; refusal: string; detail: string }
  | { kind: "unreadable"; detail: string };

/** One `hello` over the core's socket. It never starts a core: a missing socket or a refused connection is `no_core`. */
export function readHcHello(socketPath: string = resolveHcSocket(), timeoutMs: number = HELLO_TIMEOUT_MS): Promise<HcHelloOutcome> {
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

/** `hc --version` prints `hc 0.1.16`. The token is kept whole (`hc 0.1.16-rc1` is `0.1.16-rc1`), so the rule calls it malformed. */
export function parseHcVersion(output: string): string | null {
  return parseHcVersionOutput(output);
}

function classifyInstalled(output: string): HcProbeResult {
  const version = parseHcVersion(output);
  if (version === null) {
    return { installed: true, available: false, version: null, detail: `unparseable hc version output: ${output.trim().slice(0, 80)}`, code: "unhealthy" };
  }
  const judged = judgeHcVersion(version);
  if (judged.verdict === "refused") {
    return { installed: true, available: false, version, detail: `${judged.reason}; hc is installed at ${version}`, code: "version_mismatch" };
  }
  return { installed: true, available: true, version, detail: null, code: "pinned", ...(judged.verdict === "untested" ? { warning: judged.warning } : {}) };
}

function notInstalled(err: unknown): HcProbeResult {
  return { installed: false, available: false, version: null, detail: errorMessage(err), code: "not_installed" };
}

/** Installed and an accepted version, by `hc --version` alone. Touches no core. */
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
      {
        const judged = judgeHcVersion(outcome.version);
        if (judged.verdict === "refused") {
          return {
            installed: true, available: false, version: outcome.version, code: "version_mismatch",
            detail: `the running core is refused: ${judged.reason}`,
          };
        }
        return {
          installed: true, available: true, version: outcome.version, detail: null, code: "available",
          ...(judged.verdict === "untested" ? { warning: judged.warning } : {}),
        };
      }
  }
}

/** Installed, an accepted version, and a core (when one runs) on this build's generation and an accepted version. */
export async function probeHcHostAsync(
  exec: (cmd: string) => Promise<string>,
  readHello: () => Promise<HcHelloOutcome> = () => readHcHello(),
): Promise<HcProbeResult> {
  const install = await probeHcInstallAsync(exec);
  if (install.code !== "pinned") return install;
  const core = classifyHcCore(await readHello());
  const result = core.version === null ? { ...core, version: install.version } : core;
  // Each is judged on its own, so an untested install under a tested core (or the reverse) still warns: the warnings of both are kept.
  const warnings = [...new Set([install.warning, core.warning].filter((w): w is string => w !== undefined))];
  return result.available && warnings.length > 0 ? { ...result, warning: warnings.join("; ") } : result;
}

export function buildHcHostFailure(code: HcProbeResult["code"], detail: string): { message: string; reason: string; fix: string } {
  const reason = "OpenRig runs agent seats in hc terminals and reads their state through the core's socket.";
  switch (code) {
    case "version_mismatch":
      return {
        message: "hc is not a version OpenRig accepts.",
        reason: `${reason} This build is tested with hc ${HC_TESTED_VERSION} and accepts that minor line from hc ${HC_OLDEST_ACCEPTED_VERSION} up. ${detail}`,
        fix: `Install hc ${HC_TESTED_VERSION} (see hc update --help), and if a core from another version is running, have the operator restart it (a seat does not; terminals stay alive).`,
      };
    case "unsupported_generation":
      return {
        message: "The running hc core speaks a protocol generation OpenRig does not.",
        reason: `${reason} ${detail}`,
        fix: `Use hc ${HC_TESTED_VERSION}. OpenRig refuses an unknown generation rather than guess at it.`,
      };
    default:
      return {
        message: "hc is installed, but it is not healthy.",
        reason: `${reason} The core is returning: ${detail}`,
        fix: "Check hc server status from your own terminal (it starts a core if none runs), then retry OpenRig. If this happened after a machine restore, treat it as attention required rather than a healthy running state.",
      };
  }
}
