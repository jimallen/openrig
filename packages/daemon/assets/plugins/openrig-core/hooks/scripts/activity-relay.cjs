#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// OpenRig activity-relay hook script.
// Reads a hook event payload from stdin, normalizes it, and POSTs to the
// OpenRig daemon's /api/activity/hooks endpoint for real-time UI seat-status.
// Best-effort only: 1.5s timeout, errors swallowed, never blocks the agent loop.
// The one exception is the seat gate below, which runs first and needs no daemon.
//
// Required environment (injected by the OpenRig daemon when launching the agent):
//   OPENRIG_SESSION_NAME or RIGGED_SESSION_NAME  - tmux session id
//   OPENRIG_NODE_ID      or RIGGED_NODE_ID       - node id in the rig topology
//   OPENRIG_RUNTIME      or RIGGED_RUNTIME       - "claude-code" | "codex" | etc.
//   OPENRIG_URL          or RIGGED_URL           - daemon base URL
//   OPENRIG_ACTIVITY_HOOK_TOKEN or RIGGED_ACTIVITY_HOOK_TOKEN - bearer auth

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildOpenRigPayload(providerPayload, env = process.env, now = () => new Date()) {
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  const hookEvent = firstString(
    providerPayload.hookEvent,
    providerPayload.hookEventName,
    providerPayload.hook_event_name,
    providerPayload.event,
    providerPayload.eventName
  );

  if ((!sessionName && !nodeId) || !runtime || !hookEvent) return null;
  // Native comms step 2 (review F1): a subagent's tool call says nothing about the main turn, which may be waiting on a
  // prompt while the subagent works (measured on Claude Code 2.1.314: subagent PreToolUse/PostToolUse carry agent_id and
  // agent_type; the main agent's carry neither). Its PostToolUse must not tell the daemon the seat moved on.
  if ((hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure") && firstString(providerPayload.agent_id)) return null;

  const subtype = firstString(
    providerPayload.subtype,
    providerPayload.notification_type,
    providerPayload.notificationType,
    providerPayload.tool_name,
    providerPayload.toolName,
    providerPayload.source,
    providerPayload.matcher
  );

  return {
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    subtype,
    occurredAt: now().toISOString(),
  };
}

// OPR.0.4.3.28 B1+B3 — resolve the ingest base URL + token without depending on
// the operator seeding OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN into the shell:
//   1. env OPENRIG_URL / token (unchanged fast path).
//   2. B1: synthesize the base URL from OPENRIG_HOST + OPENRIG_PORT (both present
//      in a launched seat's env) when the URL is absent.
//   3. B3: file-discovery — read {baseUrl, token} from
//      OPENRIG_HOME/activity-endpoint.json (default ~/.openrig) for reconcile /
//      restored seats whose frozen process env lacks the activity vars. The
//      daemon writes this file at startup. Identity (session/node/runtime) still
//      comes from env, which previously-launched-then-reconciled seats inherit
//      from the tmux session env.
function resolveEndpoint(env = process.env) {
  let baseUrl = firstString(env.OPENRIG_URL, env.RIGGED_URL);
  let token = firstString(env.OPENRIG_ACTIVITY_HOOK_TOKEN, env.RIGGED_ACTIVITY_HOOK_TOKEN);

  if (!baseUrl) {
    const port = firstString(env.OPENRIG_PORT, env.RIGGED_PORT);
    if (port) {
      const host = firstString(env.OPENRIG_HOST, env.RIGGED_HOST) || "127.0.0.1";
      baseUrl = `http://${host}:${port}`;
    }
  }

  if (!baseUrl || !token) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const home = firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0) baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string" && parsed.token.length > 0) token = parsed.token;
    } catch {
      // absent/malformed — the caller no-ops safely below.
    }
  }

  return { baseUrl, token };
}

async function postHookPayload(payload, env = process.env) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token || !payload || typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(new URL("/api/activity/hooks", baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Provider hooks must not block the agent loop if OpenRig is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

// Native comms step 3: posts to a native route and returns the parsed JSON reply, or null on any failure (the daemon
// unreachable, a timeout, a non-JSON reply). A null reply never blocks the agent.
async function postNativeJson(route, payload, env = process.env, timeoutMs = 1500) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token || !payload || typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(route, baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function hookEventOf(providerPayload) {
  return firstString(providerPayload.hookEvent, providerPayload.hookEventName, providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName);
}

// Native comms step 3, SessionStart of a Claude seat: the seat's inbox socket, transcript and claude pid, from what
// Claude Code puts in the hook's environment and payload (measured on 2.1.314, Linux and macOS: CLAUDE_CODE_MESSAGING_SOCKET
// and CLAUDE_PID are there; CLAUDE_CODE_EXECPATH is NOT, so the daemon finds the binary from the pid: ncomms-3c). The
// messaging token is never read or sent: it restricts nothing.
function buildNativeEndpointPayload(providerPayload, env = process.env) {
  if (hookEventOf(providerPayload) !== "SessionStart") return null;
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const socketPath = firstString(env.CLAUDE_CODE_MESSAGING_SOCKET);
  if (runtime !== "claude-code" || !socketPath) return null;
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  if (!sessionName && !nodeId) return null;
  const pid = Number(firstString(env.CLAUDE_PID));
  return {
    sessionName, nodeId, runtime,
    generation: firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION),
    socketPath,
    transcriptPath: firstString(providerPayload.transcript_path),
    claudePid: Number.isInteger(pid) && pid > 0 ? pid : null,
    execPath: firstString(env.CLAUDE_CODE_EXECPATH),
  };
}

// OF-180 N6: a person who pastes a delivered message with its marker into a prompt is blocked like a late duplicate (the
// two cannot be told apart from the hook payload). The reason is shown to them, so it says how to send the text anyway.
const NATIVE_DUPLICATE_BLOCK_REASON =
  "OpenRig: this message was already delivered; duplicate suppressed. If you pasted it on purpose, delete the [openrig-msg ...] line and send it again.";

const MARKER_LINE = /^\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\]$/;
const WRAPPER_CLOSE = /^<\/(?:cross-session-message|pasted_content(?: id="[^"]*")?)>$/;

// A prompt's markers: its trailing lines only, read through a closing wrapper (adapters/seat-gate-marker.ts `trailingMarkers`, same rule).
// A marker quoted anywhere else is that message's text, and confirms and blocks nothing.
function trailingMarkers(prompt) {
  const lines = prompt.split("\n").map((line) => line.replace(/\r$/, ""));
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || WRAPPER_CLOSE.test(lines[end - 1].trim()))) end -= 1;
  const markers = [];
  while (end > 0) {
    const match = MARKER_LINE.exec(lines[end - 1].trim());
    if (!match) break;
    markers.unshift({ id: match[1], nonce: match[2] });
    end -= 1;
  }
  return markers;
}

// Native comms step 3, UserPromptSubmit of a Claude seat: the markers of native messages in the prompt.
function buildNativeAckPayload(providerPayload, env = process.env) {
  if (hookEventOf(providerPayload) !== "UserPromptSubmit") return null;
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  if (runtime !== "claude-code" || typeof providerPayload.prompt !== "string") return null;
  const markers = trailingMarkers(providerPayload.prompt);
  if (markers.length === 0) return null;
  return {
    sessionName: firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME),
    nodeId: firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID),
    generation: firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION),
    // The same prompt's hook running twice is one delivery: the daemon acks a repeat with the same prompt id.
    promptId: firstString(providerPayload.prompt_id),
    markers,
  };
}

// Seat Messaging, stage S2: the seat gate. A marked prompt is recorded here, on disk, before the agent sees it, and a repeat of the same
// (id, nonce) is blocked, so a resend is safe with the daemon down (M1). One file per message, made complete and then linked into place:
// the link is the atomic create, and it fails if the record exists. The id and nonce together name it, so a forged nonce neither blocks
// the real message nor stands in for it. adapters/hook-seen-store.ts is the daemon's side of this layout.
//
// Keep this small and first. A hook that crashes or times out fails OPEN: the prompt runs with no record (M4). What this code can catch
// fails closed; what it cannot, the daemon's reconcile finds in the transcript.
const SEAT_GATE_VERSION = 1;
const SEAT_GATE_RUNTIMES = new Set(["claude-code", "codex"]);
const SEAT_GATE_UNAVAILABLE_REASON =
  "OpenRig: this message could not record its delivery, so it was not shown to the agent; OpenRig will send it again.";

function seatGateDir(env, dirname = __dirname) {
  const seat = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  if (!seat || !SEAT_GATE_RUNTIMES.has(firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME))) return null;
  // The installed copy sits in `<home>/state/<folder>/`, which names the instance even for a restored seat with a frozen env.
  const root = path.basename(path.dirname(dirname)) === "state"
    ? path.resolve(dirname, "..", "seat-gates")
    : path.join(firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig"), "state", "seat-gates");
  return path.join(root, encodeURIComponent(seat).replace(/\./g, "%2E"));
}

function writeDurable(file, text) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function recordSeen(seenDir, marker, record) {
  const name = crypto.createHash("sha256").update(`${marker.id}:${marker.nonce}`).digest("hex");
  const tmp = path.join(seenDir, `.${name}.${process.pid}.tmp`);
  writeDurable(tmp, JSON.stringify(record));
  try {
    fs.linkSync(tmp, path.join(seenDir, name));
    return name;
  } catch (err) {
    if (err.code === "EEXIST") return null;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// `pass`: the agent may see it. `repeat`: every marker was seen before. `unrecorded`: the store failed, so the prompt must not run and
// must not be acked: a resend has to find this message unrecorded.
function runSeatGate(providerPayload, env = process.env, now = () => new Date()) {
  if (hookEventOf(providerPayload) !== "UserPromptSubmit" || typeof providerPayload.prompt !== "string") return "pass";
  const markers = trailingMarkers(providerPayload.prompt);
  const dir = markers.length > 0 ? seatGateDir(env) : null;
  if (!dir) return "pass";
  const seenDir = path.join(dir, "seen");
  const made = [];
  try {
    fs.mkdirSync(seenDir, { recursive: true, mode: 0o700 });
    const agentPid = Number(firstString(env.CLAUDE_PID));
    for (const marker of markers) {
      const name = recordSeen(seenDir, marker, {
        ...marker, recordedAt: now().toISOString(), via: "hook", durable: false,
        agentPid: Number.isInteger(agentPid) && agentPid > 0 ? agentPid : null,
        transcriptPath: firstString(providerPayload.transcript_path),
      });
      if (name) made.push(name);
    }
    const dirFd = fs.openSync(seenDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return made.length > 0 ? "pass" : "repeat";
  } catch {
    for (const name of made) { try { fs.rmSync(path.join(seenDir, name), { force: true }); } catch { /* a record stays: a resend is then refused, never doubled */ } }
    return "unrecorded";
  }
}

// SessionStart: this seat carries the gate. A seat on an older relay never writes this, so the daemon knows it has none.
function declareSeatGate(providerPayload, env = process.env) {
  if (hookEventOf(providerPayload) !== "SessionStart") return;
  const dir = seatGateDir(env);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The file this seat's prompts land in: the daemon may have no other way to it, and a hook that crashes leaves only the prompt there.
    const transcriptPath = firstString(providerPayload.transcript_path);
    fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ version: SEAT_GATE_VERSION, ...(transcriptPath ? { transcriptPath } : {}) }), { mode: 0o600 });
  } catch { /* no declaration: the daemon treats the seat as ungated */ }
}

function buildSessionIdentityPayload(providerPayload, env = process.env, now = () => new Date()) {
  if (!providerPayload || typeof providerPayload !== "object") return null;
  const hookEvent = firstString(
    providerPayload.hookEvent, providerPayload.hookEventName,
    providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName
  );
  if (!hookEvent || hookEvent.toLowerCase() !== "sessionstart") return null;

  const sessionId = firstString(providerPayload.session_id, providerPayload.sessionId);
  if (!sessionId) return null;

  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  // How this session began (startup, resume, clear or compact). The daemon tells a resumed
  // conversation's new id from a /clear by it; it is absent from runtimes that do not report it.
  const source = firstString(providerPayload.source);
  // Set only on the command OpenRig sends to resume this seat, so the daemon can tell the process
  // it launched from another Claude sharing the seat's environment.
  const resumeLaunch = firstString(env.OPENRIG_RESUME_LAUNCH);

  if ((!sessionName && !nodeId) || !runtime) return null;

  return {
    eventFamily: "session_identity",
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    source,
    resumeLaunch,
    // The daemon finds the Claude that ran this hook from its parent chain.
    hookPid: process.pid,
    sessionId,
    occurredAt: now().toISOString(),
  };
}

// #1077 — whether this is the first SessionStart of the launch OpenRig armed (OPENRIG_RESUME_LAUNCH
// for this occupant generation). Recorded on local disk before anything is posted, so a first hook
// whose post never reaches the daemon still makes every later one (an in-process /resume, a child
// sharing the environment) report false. Any error reports false.
function claimFirstLaunchHook(resumeLaunch, generation, dir = path.join(os.tmpdir(), `openrig-resume-launch-${uid()}`)) {
  if (!resumeLaunch || !generation) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash("sha256").update(`${generation}\0${resumeLaunch}`).digest("hex");
    fs.closeSync(fs.openSync(path.join(dir, key), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

function uid() {
  try { return typeof process.getuid === "function" ? String(process.getuid()) : "user"; } catch { return "user"; }
}

async function main() {
  const providerPayload = parseJson(await readStdin());
  const gate = runSeatGate(providerPayload);
  if (gate !== "pass") writeBlock(gate === "repeat" ? NATIVE_DUPLICATE_BLOCK_REASON : SEAT_GATE_UNAVAILABLE_REASON);
  declareSeatGate(providerPayload);
  const payload = buildOpenRigPayload(providerPayload);
  const identityPayload = buildSessionIdentityPayload(providerPayload, process.env);
  if (identityPayload && identityPayload.resumeLaunch) {
    identityPayload.resumeLaunchFirst = claimFirstLaunchHook(identityPayload.resumeLaunch, identityPayload.generation);
  }
  // A blocked prompt starts no turn and is followed by no Stop (M1, M4), so it must not tell the daemon one began.
  if (gate === "pass") await postHookPayload(payload);
  if (identityPayload) {
    await postHookPayload(identityPayload);
  }
  const endpoint = buildNativeEndpointPayload(providerPayload);
  if (endpoint) await postNativeJson("/api/activity/native-endpoint", endpoint);
  const ack = gate === "unrecorded" ? null : buildNativeAckPayload(providerPayload);
  if (ack) {
    // A copy the gate recorded is the first, and the agent must have it, even if the daemon read the record meanwhile and calls the row
    // delivered: a block here would lose the message with the row saying received. On a seat with no gate the daemon's word is the only
    // dedupe (measured: a UserPromptSubmit block stops a socket-injected copy cleanly). No reply lets the prompt through.
    const reply = await postNativeJson("/api/activity/native-ack", ack);
    if (reply && reply.block === true && gate === "pass" && seatGateDir(process.env) === null) writeBlock(NATIVE_DUPLICATE_BLOCK_REASON);
  }
}

function writeBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildNativeEndpointPayload,
  buildNativeAckPayload,
  buildOpenRigPayload,
  claimFirstLaunchHook,
  buildSessionIdentityPayload,
  parseJson,
  postHookPayload,
  runSeatGate,
  seatGateDir,
  resolveEndpoint,
};
