import { Command, Option } from "commander";
import { DaemonClient, DaemonConnectionError, DaemonTimeoutError, type DaemonResponse } from "../client.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hcCoreListening } from "../hc-core-probe.js";

/** Label that ties a watch terminal to the rig it watches. */
export const CHATROOM_LABEL = "openrig.chatroom";

/** hc names are 1 to 32 of a-z 0-9 - _ . A digest keeps `name_taken` as the atomic one-watch-per-rig refusal for any rig name. */
export function chatroomTerminalName(rig: string): string {
  return `cr-${createHash("sha256").update(rig).digest("hex").slice(0, 24)}`;
}

export interface HcRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when `hc` could not be started at all (not installed, not executable). */
  spawnError?: string;
}

/** The seams the dedicated-terminal watch uses: the `hc` CLI and the argv that re-runs this CLI. */
export interface ChatroomHcDeps {
  runHc(args: string[]): HcRunResult;
  /** Is an hc core already listening in this env? `hc run` starts one when none is, in the caller's env, so it is asked first (F6). */
  coreListening(): Promise<boolean>;
  /** Absolute argv that starts this same CLI, so the terminal does not depend on the core's PATH. */
  selfArgv(): string[];
}

export const realHcDeps: ChatroomHcDeps = {
  coreListening: () => hcCoreListening(),
  runHc(args) {
    // No shell: the rig name only ever travels as one argv element.
    const r = spawnSync("hc", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", spawnError: r.error?.message };
  },
  selfArgv: () => [process.execPath, process.argv[1] ?? "rig"],
};

/** `hc --json` reports a refusal as {"error":{"kind":...,"message":...}} on stderr; read stdout too. */
function hcErrorKind(r: HcRunResult): { kind?: string; message?: string } {
  for (const text of [r.stderr, r.stdout]) {
    try {
      const parsed = JSON.parse(text.trim()) as { error?: { kind?: string; message?: string } };
      if (parsed.error) return parsed.error;
    } catch { /* not JSON */ }
  }
  return {};
}

/**
 * The terminal does not inherit this process's env (hc gives a program the core's env), so the daemon address
 * this command already resolved is stated in the argv. A URL that carries credentials is left out of argv.
 */
function daemonUrlEnv(baseUrl: string): string[] {
  try {
    const u = new URL(baseUrl);
    if (u.username || u.password) return [];
  } catch {
    return [];
  }
  return [`OPENRIG_URL=${baseUrl}`];
}

interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
}

async function resolveRigId(client: DaemonClient, rigName: string): Promise<string> {
  const res = await client.get<RigSummary[]>("/api/rigs/summary");
  const matches = res.data.filter((r) => r.name === rigName);

  if (matches.length === 0) {
    throw new Error(`Rig '${rigName}' not found. List rigs with: rig ps`);
  }
  if (matches.length > 1) {
    throw new Error(`Rig '${rigName}' is ambiguous — ${matches.length} rigs share that name. Use a unique name or remove duplicates.`);
  }

  return matches[0]!.id;
}

// A poll that failed this way says nothing about the room: the daemon was slow to answer, refused the
// connection, or dropped it while restarting. `chatroom wait` retries it on its usual cadence until its own
// deadline. An HTTP error status or any other failure is real and ends the wait at once.
const TRANSIENT_CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]);

function isTransientPollError(err: unknown): boolean {
  if (err instanceof DaemonTimeoutError) return true;
  return err instanceof DaemonConnectionError && err.causeCode !== undefined && TRANSIENT_CONNECTION_CODES.has(err.causeCode);
}

export function chatroomCommand(depsOverride?: StatusDeps, hcDeps: ChatroomHcDeps = realHcDeps): Command {
  const cmd = new Command("chatroom").description("Chat room for rig communication");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient | null> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // chatroom send <rig> "message" [--sender <name>]
  cmd
    .command("send")
    .argument("<rig>", "Rig name")
    .argument("<message>", "Message to send")
    .option("--sender <name>", "(deprecated, ignored) the sender is derived from the seat env (X-OpenRig-Session); P21 made the chat route derive it from the transport header")
    .action(async (rig: string, message: string, _opts: { sender?: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      // P21: no body sender — the daemon derives it from the transport header (X-OpenRig-Session,
      // stamped by DaemonClient from the seat env). A hardcoded 'cli' differing from the header would be
      // SUPERSEDED by it (transport:v1), not persisted (P18: the 409 mismatch is retired).
      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/send`,
        { body: message },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `Failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      // P21: echo the DERIVED seat identity (the env the daemon stamps as X-OpenRig-Session), not the
      // deprecated --sender flag — so the local confirmation matches what the chat route actually records.
      console.log(`[${readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME") ?? "you"}] ${message}`);
    });

  // chatroom history <rig> [--topic <name>] [--limit N] [--json]
  cmd
    .command("history")
    .argument("<rig>", "Rig name")
    .option("--topic <name>", "Filter by topic")
    .option("--after <id>", "Messages after this message ID")
    .option("--since <timestamp>", "Messages since this timestamp")
    .option("--sender <name>", "Messages from this sender")
    .option("--limit <n>", "Limit results", "50")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { topic?: string; after?: string; since?: string; sender?: string; limit?: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const params = new URLSearchParams();
      if (opts.topic) params.set("topic", opts.topic);
      if (opts.after) params.set("after", opts.after);
      if (opts.since) params.set("since", opts.since);
      if (opts.sender) params.set("sender", opts.sender);
      if (opts.limit) params.set("limit", opts.limit);

      const qs = params.toString();
      const res = await client.get<Array<Record<string, unknown>>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/history${qs ? `?${qs}` : ""}`,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error((res.data as { error?: string })?.error ?? `Failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const messages = res.data;
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log("No messages.");
        return;
      }

      for (const msg of messages) {
        const kind = msg["kind"] as string;
        if (kind === "topic") {
          console.log(`--- topic: ${msg["topic"]} ---`);
        } else {
          console.log(`[${msg["sender"]}] ${msg["body"]}`);
        }
      }
    });

  // chatroom watch <rig> [--terminal]   (--tmux: hidden alias of --terminal, kept for scripts and the shipped skill text)
  cmd
    .command("watch")
    .argument("<rig>", "Rig name")
    .option("--terminal", "Run watch in a dedicated hc terminal that outlives this command")
    .addOption(new Option("--tmux", "Alias of --terminal").hideHelp())
    .action(async (rig: string, opts: { terminal?: boolean; tmux?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      if (opts.terminal || opts.tmux) {
        // `hc run` starts a core when none runs, in THIS caller's env, and a core born there hands that env (an operator
        // token the CLI holds, say) to every terminal on it afterwards. This path needs a core the daemon started: no listener, no run.
        if (!(await hcDeps.coreListening())) {
          console.error(`No hc core is running. A watch terminal does not start one from this shell, because a core started here would hold this shell's environment.`);
          process.exitCode = 1;
          return;
        }
        const name = chatroomTerminalName(rig);
        const program = ["/usr/bin/env", ...daemonUrlEnv(client.baseUrl), ...hcDeps.selfArgv(), "chatroom", "watch", rig];
        const result = hcDeps.runHc([
          "run", "--json", "--bg", "--no-parent", "--no-notify", "--outlive-parent",
          "--name", name, "--label", `${CHATROOM_LABEL}=${rig}`, "--", ...program,
        ]);
        if (result.spawnError || result.status !== 0) {
          const err = hcErrorKind(result);
          if (err.kind === "name_taken") {
            console.error(`A watch for '${rig}' is already running in terminal '${name}'. Attach with: hc attach ${name}`);
          } else if (result.spawnError) {
            console.error(`Failed to start hc: ${result.spawnError}`);
          } else {
            console.error(`Failed to start the watch terminal for '${rig}': ${err.message ?? `hc exited with ${result.status}`}`);
          }
          process.exitCode = 1;
          return;
        }
        console.log(`Started watch in hc terminal: ${name}`);
        console.log(`Attach with: hc attach ${name}`);
        return;
      }

      // Direct SSE watch
      const url = `${client.baseUrl}/api/rigs/${encodeURIComponent(rigId)}/chat/watch`;
      try {
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok || !res.body) {
          console.error(`Watch failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              try {
                const msg = JSON.parse(data) as { sender: string; body: string; kind: string; topic?: string; createdAt: string };
                if (msg.kind === "topic") {
                  console.log(`--- topic: ${msg.topic} ---`);
                } else {
                  console.log(`[${msg.sender}] ${msg.body}`);
                }
              } catch {
                // Skip malformed data lines
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(`Watch error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }
    });

  // chatroom topic <rig> <topic-name> [--body "text"]
  cmd
    .command("topic")
    .argument("<rig>", "Rig name")
    .argument("<topic-name>", "Topic name")
    .option("--body <text>", "Optional body text")
    .option("--sender <name>", "(deprecated, ignored) the sender is derived from the seat env (X-OpenRig-Session); the chat topic route derives it from the transport header")
    .action(async (rig: string, topicName: string, opts: { body?: string; sender?: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      // P21: no body sender — the daemon derives it from the transport header (see chat/send).
      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/topic`,
        { topic: topicName, body: opts.body },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `Failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`--- topic: ${topicName} ---`);
    });

  // chatroom wait <rig>
  cmd
    .command("wait")
    .argument("<rig>", "Rig name")
    .option("--after <id>", "Only messages after this ID")
    .option("--topic <name>", "Filter by topic")
    .option("--sender <name>", "Filter by sender")
    .option("--timeout <seconds>", "Timeout in seconds", "120")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { after?: string; topic?: string; sender?: string; timeout: string; json?: boolean }) => {
      // A NaN timeout would never expire and would poll with a ~1ms sleep.
      // Preserve numeric forms and legacy numeric prefixes (e.g. 30s) without truncating fractions.
      const numericTimeout = Number(opts.timeout);
      const timeoutSeconds = Number.isNaN(numericTimeout) ? Number.parseFloat(opts.timeout) : numericTimeout;
      if (opts.timeout.trim() === "" || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        console.error(`--timeout must be a non-negative number of seconds; got '${opts.timeout}'`);
        process.exitCode = 1;
        return;
      }

      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const timeoutMs = timeoutSeconds * 1000;
      const pollIntervalMs = 3000;

      // Bootstrap cursor: use --after if provided, otherwise generate a ULID at start time
      // as a practical time-based baseline. Messages with IDs after this point are considered new.
      let cursor = opts.after ?? "";
      if (!cursor) {
        const { monotonicFactory } = await import("ulid");
        cursor = monotonicFactory()();
      }

      // Build filter params
      const filterParams = new URLSearchParams();
      if (opts.topic) filterParams.set("topic", opts.topic);
      if (opts.sender) filterParams.set("sender", opts.sender);

      const start = Date.now();
      // The message of the last poll, when it failed transiently; null once a poll succeeds.
      let lastPollError: string | null = null;
      while (true) {
        // Check timeout BEFORE polling
        if (Date.now() - start >= timeoutMs) break;

        const params = new URLSearchParams(filterParams);
        if (cursor) params.set("after", cursor);

        const controller = new AbortController();
        const remainingForRequest = timeoutMs - (Date.now() - start);
        if (remainingForRequest <= 0) break;
        // Keep the command's deadline through headers and body consumption.
        // The client's own request timeout still bounds an unresponsive daemon.
        const timer = setTimeout(() => controller.abort(), Math.min(remainingForRequest, 2_147_483_647));
        let res: DaemonResponse<Array<Record<string, unknown>>> | null = null;
        try {
          res = await client.get<Array<Record<string, unknown>>>(
            `/api/rigs/${encodeURIComponent(rigId)}/chat/history?${params}`,
            { signal: controller.signal },
          );
          lastPollError = null;
        } catch (err) {
          if (controller.signal.aborted) break;
          if (!isTransientPollError(err)) throw err;
          // Announce the first failure of a run, then keep polling quietly.
          if (lastPollError === null) console.error(`A poll failed (${(err as Error).message}); retrying until the --timeout deadline.`);
          lastPollError = (err as Error).message;
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted || Date.now() - start >= timeoutMs) break;

        if (res && res.status >= 400) {
          console.error((res.data as { error?: string })?.error ?? `Failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }

        if (res?.data && res.data.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(res.data));
          } else {
            for (const msg of res.data) {
              console.log(`[${msg["sender"]}] ${msg["body"]}`);
            }
          }
          return;
        }

        // Sleep with remaining timeout awareness
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
      }

      console.error(`Timed out after ${opts.timeout} seconds — no new messages matching filters.`);
      if (lastPollError !== null) {
        console.error(`The last poll failed (${lastPollError}), so new messages may have arrived without being seen.`);
      }
      process.exitCode = 1;
    });

  // chatroom clear <rig>
  cmd
    .command("clear")
    .argument("<rig>", "Rig name")
    .action(async (rig: string) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const res = await client.post<{ ok: boolean; deleted: number }>(`/api/rigs/${encodeURIComponent(rigId)}/chat/clear`, {});

      if (res.status >= 400) {
        console.error(`Clear failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Cleared ${res.data.deleted} messages from ${rig} chatroom.`);
    });

  return cmd;
}
