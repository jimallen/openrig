import { ACTIVITY_ENDPOINT_POLICY, readCredentialFile } from "@openrig/daemon/credential-file";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { shellWord } from "@openrig/daemon/command-text";
import { connectionErrorCode, formatDaemonHostForUrl, requestProvablyNotSent } from "../client.js";

export interface StartupProofDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface StartupProofSubmitResult {
  ok: true;
  oriented: "verified";
  nodeId: string;
  challengeId: string;
}

/**
 * workspaces-o9o.169: the startup proof is a write (the daemon records the seat as oriented), sent by raw fetch. When its
 * reply is lost the outcome is UNKNOWN and `recheck` names the exact re-read; only a failure that proves nothing was sent
 * (requestProvablyNotSent) says "was not sent".
 */
export class StartupProofTransportError extends Error {
  constructor(message: string, readonly outcome: "not-sent" | "unknown", readonly recheck: string) {
    super(message);
    this.name = "StartupProofTransportError";
  }
}

interface Endpoint {
  baseUrl: string;
  token: string;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function resolveStartupProofEndpoint(deps: StartupProofDeps = {}): Endpoint | null {
  const env = deps.env ?? process.env;
  const home = first(env["OPENRIG_HOME"], env["RIGGED_HOME"]) ?? path.join(os.homedir(), ".openrig");
  let baseUrl = first(env["OPENRIG_URL"], env["RIGGED_URL"]);
  let token = first(env["OPENRIG_ACTIVITY_HOOK_TOKEN"], env["RIGGED_ACTIVITY_HOOK_TOKEN"]);

  if (!baseUrl || !token) {
    try {
      // workspaces-o9o.151: under the daemon's credential rule; a refused file gives nothing, like an absent one.
      const read = readCredentialFile(path.join(home, "activity-endpoint.json"), ACTIVITY_ENDPOINT_POLICY);
      const endpoint = (read.ok ? JSON.parse(read.content) : {}) as Record<string, unknown>;
      baseUrl ??= first(endpoint["baseUrl"]);
      token ??= first(endpoint["token"]);
    } catch {
      // File discovery is best-effort; env and host/port fallback may still work.
    }
  }

  if (!baseUrl) {
    const port = first(env["OPENRIG_PORT"], env["RIGGED_PORT"]);
    if (port) baseUrl = `http://${formatDaemonHostForUrl(first(env["OPENRIG_HOST"], env["RIGGED_HOST"]) ?? "127.0.0.1")}:${port}`;
  }

  return baseUrl && token ? { baseUrl, token } : null;
}

export async function submitStartupProof(
  input: { challengeId: string; answer: string },
  deps: StartupProofDeps = {},
): Promise<StartupProofSubmitResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = resolveStartupProofEndpoint(deps);
  if (!endpoint) {
    throw new Error("OpenRig startup proof endpoint is unavailable");
  }

  const session = first(env["OPENRIG_SESSION_NAME"], env["RIGGED_SESSION_NAME"]);
  const recheck = session
    ? `rig ps --nodes --session ${shellWord(session)} --json --fields canonicalSessionName,oriented`
    : "rig ps --nodes -A --json --fields canonicalSessionName,oriented";
  const transportFailure = (err: unknown, notSent: boolean): StartupProofTransportError => {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = connectionErrorCode(err);
    const detail = `${msg}${cause && !msg.includes(cause) ? ` (${cause})` : ""}`;
    return notSent
      ? new StartupProofTransportError(`startup_proof was not sent to ${endpoint.baseUrl}: ${detail}`, "not-sent", recheck)
      : new StartupProofTransportError(`startup_proof outcome is UNKNOWN: the request may have reached ${endpoint.baseUrl}, and no reply came back: ${detail}`, "unknown", recheck);
  };
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        eventFamily: "startup_proof",
        sessionName: first(env["OPENRIG_SESSION_NAME"], env["RIGGED_SESSION_NAME"]),
        nodeId: first(env["OPENRIG_NODE_ID"], env["RIGGED_NODE_ID"]),
        runtime: first(env["OPENRIG_RUNTIME"], env["RIGGED_RUNTIME"]),
        challengeId: input.challengeId,
        answer: input.answer,
      }),
    });
  } catch (err) {
    throw transportFailure(err, requestProvablyNotSent(err));
  }
  try {
    text = await res.text();
  } catch (err) {
    // The daemon answered, so the request arrived; only the reply was lost.
    throw transportFailure(err, false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!res.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : text;
    throw new Error(`startup_proof rejected: ${res.status} ${message}`);
  }
  return parsed as StartupProofSubmitResult;
}

export function startupProofCommand(depsOverride?: StartupProofDeps): Command {
  const cmd = new Command("startup-proof")
    .description("Submit and inspect startup orientation proof");

  cmd.command("submit")
    .description("Submit this seat's startup proof through the authenticated OpenRig activity hook")
    .requiredOption("--challenge-id <id>", "Startup challenge id from the startup prompt")
    .requiredOption("--answer <answer>", "Expected answer from the startup prompt")
    .option("--json", "Print raw JSON response")
    .action(async (opts: { challengeId: string; answer: string; json?: boolean }) => {
      try {
        const result = await submitStartupProof({ challengeId: opts.challengeId, answer: opts.answer }, depsOverride);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`startup_proof: ${result.oriented}`);
          console.log(`node_id: ${result.nodeId}`);
          console.log(`challenge_id: ${result.challengeId}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        if (err instanceof StartupProofTransportError) {
          console.error(err.outcome === "unknown"
            ? `  Re-read with '${err.recheck}' before submitting again: the daemon may already have recorded it.`
            : "  Check the daemon with 'rig daemon status', then submit again.");
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
