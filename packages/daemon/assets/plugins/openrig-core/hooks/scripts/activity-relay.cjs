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

const CODE_OUTPUT_PROMPT_SOURCE = "poll_event";
// workspaces-o9o.124 (verify-sec review F2): Code Mode's code output is recognised by TWO signals, never the source alone: the source, and the
// prompt's shape as captured (Claude Code 2.1.327, o9o.122 report M10): the whole prompt is one `<event kind="…" …>` … `</event>` envelope.
// A typed prompt cannot carry the source (Claude Code sets it, not the person typing), and a payload with the source but not the envelope is
// handled exactly as the same prompt with no source.
const CODE_OUTPUT_ENVELOPE = /^<event kind="[A-Za-z0-9_-]+"[^>\n]*>\n[\s\S]*\n<\/event>\s*$/;

/** Whether a hook payload is Code Mode's code output dressed as a UserPromptSubmit (both signals). */
function isCodeModeOutput(providerPayload) {
  return Boolean(providerPayload) && typeof providerPayload === "object"
    && hookEventOf(providerPayload) === "UserPromptSubmit"
    && firstString(providerPayload.source) === CODE_OUTPUT_PROMPT_SOURCE
    && typeof providerPayload.prompt === "string"
    && CODE_OUTPUT_ENVELOPE.test(providerPayload.prompt);
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
  // agent_type; the main agent's carry neither). Its PostToolUse must not tell the daemon the seat moved on. Its PreToolUse
  // (relayed since workspaces-o9o.4) would name a call the main turn never closes: the main agent's own Agent call is the open one.
  if ((hookEvent === "PreToolUse" || hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure") && firstString(providerPayload.agent_id)) return null;
  // OF-278 / workspaces-o9o.4 F3: an AskUserQuestion start IS relayed, with its call id: the daemon ties the question to its own call, so a
  // late end of an earlier question cannot answer it. The question itself is reported by its PermissionRequest; a start never displaces
  // it and is never shown as the running tool (agent-activity-store promptClearedBy, openToolCallsIn).

  // workspaces-o9o.124: Code Mode follows every code evaluation with a UserPromptSubmit whose source is "poll_event" and whose prompt is the
  // code's output (measured on Claude Code 2.1.327, o9o.122 report M10). Nobody typed it: it is not relayed as a prompt (main also returns
  // before anything else for it). Twin of CODE_OUTPUT_PROMPT_SOURCE in daemon src/domain/code-mode-output.ts (a test holds them equal).
  if (isCodeModeOutput(providerPayload)) return null;
  // A UserPromptSubmit naming that source WITHOUT the envelope is not Code Mode's: it is relayed as a typed prompt, and the source is never
  // passed on as its subtype, so the daemon (which drops subtype poll_event from relay copies older than this) records it (review F2).
  const promptSourceForged = hookEvent === "UserPromptSubmit" && firstString(providerPayload.source) === CODE_OUTPUT_PROMPT_SOURCE;

  const subtype = firstString(
    providerPayload.subtype,
    providerPayload.notification_type,
    providerPayload.notificationType,
    providerPayload.tool_name,
    providerPayload.toolName,
    promptSourceForged ? null : providerPayload.source,
    providerPayload.matcher
  );

  // workspaces-o9o.4: the call a tool event belongs to (measured on Claude Code 2.1.325: the same tool_use_id on a call's start and end, one
  // per parallel call), so the daemon can tell which calls are still open.
  const toolCallId = hookEvent === "PreToolUse" || hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure"
    ? firstString(providerPayload.tool_use_id, providerPayload.toolUseId)
    : null;

  // OF-278 / workspaces-o9o.56: the end of an AskUserQuestion call names the questions it ended, so the daemon settles that question and not
  // a newer one still open (this end runs in the background and can land after a follow-up question opened). Measured on Claude Code
  // 2.1.325: the PermissionRequest that opens the dialog carries no tool_use_id, and tool_input.questions is the same on PreToolUse,
  // PermissionRequest and PostToolUse (PostToolUse adds `answers`). Only a digest is sent, never the question text.
  // workspaces-o9o.59: the PermissionRequest that opens the dialog carries it too, so the daemon counts the turn's questions by what they ask.
  const questionKey = (hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure" || hookEvent === "PermissionRequest") && subtype === "AskUserQuestion"
    ? questionKeyOf(providerPayload.tool_input)
    : null;

  return {
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    subtype,
    ...(toolCallId ? { toolCallId } : {}),
    ...(questionKey ? { questionKey } : {}),
    occurredAt: now().toISOString(),
  };
}

/** OF-278 / workspaces-o9o.56: the digest that ties an AskUserQuestion call to the question the daemon recorded for it: sha256 of the
 *  JSON of tool_input.questions, first 32 hex. Twin of questionKeyOf in daemon src/domain/seat-question-policy.ts (a test holds them equal).
 *  Null when the input has no questions to name. */
function questionKeyOf(toolInput) {
  const questions = toolInput && typeof toolInput === "object" ? toolInput.questions : undefined;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return crypto.createHash("sha256").update(canonicalJson(questions)).digest("hex").slice(0, 32);
}

// JSON with every object's keys sorted, at every depth; lists keep their order (twin of the daemon's canonicalJson).
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  }
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
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
const SEAT_GATE_VERSION = 3;
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

// A long message on a paste path: the prompt is a short note and its marker, and the text waits in the seat's spool, written by the pump before
// the paste. Adapters/seat-gate-marker.ts `spooledNote` writes the same line. Nothing here touches the daemon, and no tool call is needed.
//
// The order is the crash rule. The record is written LAST, after the text has gone to stdout, so a record proves the agent was given the text. A
// hook that crashes or times out before that leaves no record, and the prompt ran with only the note: the row stays open and the next attempt
// passes. A crash after the text and before the record gives a second copy, the safe way round. The agent sees nothing until this process ends, and
// takes nothing at all from one that is killed or fails (measured on Codex 0.166.0, OF-229): a kill after the record leaves a record and no text. The
// record therefore proves nothing alone; it carries `bodySha256`, and the daemon waits for the text to show in the agent's own file (hook-seat-gate.ts).
const SPOOLED_NOTE = /^OpenRig: long message(?:, part \d+ of \d+)?(?:, resent: not confirmed on file)?\. Its text comes with this prompt as additional context\. If you do not see it, OpenRig sends it again\. \(([a-f0-9]{16})\)$/;

function spooledMarker(prompt) {
  const markers = trailingMarkers(prompt);
  if (markers.length !== 1) return null;
  const lines = prompt.split("\n").map((line) => line.replace(/\r$/, "").trim());
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === "" || WRAPPER_CLOSE.test(lines[end - 1]))) end -= 1;
  // The tag binds the note to the nonce, which no sender knows: a body that ends in this note is an ordinary prompt.
  const tag = crypto.createHash("sha256").update(`spooled:${markers[0].id}:${markers[0].nonce}`).digest("hex").slice(0, 16);
  return (SPOOLED_NOTE.exec(lines[end - 2] || "") || [])[1] === tag ? markers[0] : null;
}

// null: not a long message's paste. Otherwise what the gate says of it, with the text when it may pass.
function readSpooled(providerPayload, env = process.env) {
  if (hookEventOf(providerPayload) !== "UserPromptSubmit" || typeof providerPayload.prompt !== "string") return null;
  const marker = spooledMarker(providerPayload.prompt);
  const dir = marker ? seatGateDir(env) : null;
  if (!dir) return null;
  const name = crypto.createHash("sha256").update(`${marker.id}:${marker.nonce}`).digest("hex");
  try {
    const seenDir = path.join(dir, "seen");
    if (fs.existsSync(path.join(seenDir, name))) return { gate: "repeat" };
    fs.mkdirSync(seenDir, { recursive: true, mode: 0o700 });
    const text = fs.readFileSync(path.join(dir, "spool", name), "utf8");
    if (text.length === 0) return { gate: "unrecorded" };
    return { gate: "pass", marker, seenDir, text };
  } catch {
    return { gate: "unrecorded" };  // no text to give: the note must not run as if it were the message
  }
}

async function deliverSpooled(spooled, providerPayload, env = process.env, now = () => new Date()) {
  const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: spooled.text } };
  await new Promise((resolve) => process.stdout.write(JSON.stringify(output) + "\n", resolve));
  const agentPid = Number(firstString(env.CLAUDE_PID));
  try {
    recordSeen(spooled.seenDir, spooled.marker, {
      ...spooled.marker, recordedAt: now().toISOString(), via: "hook", durable: false,
      // A record is written before this process has exited, and an agent takes a hook's output only from an exit it saw (OF-229). So the record names the text
      // it stands for, and the daemon calls the row received when the agent's own file holds that text, not before.
      bodySha256: crypto.createHash("sha256").update(spooled.text, "utf8").digest("hex"),
      agentPid: Number.isInteger(agentPid) && agentPid > 0 ? agentPid : null,
      transcriptPath: firstString(providerPayload.transcript_path),
    });
    const dirFd = fs.openSync(spooled.seenDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* the text went and the record did not: a second copy, never a lost one */ }
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

// workspaces-o9o.33: one copy of each OpenRig hook per event. OpenRig writes its managed copy into the project's .claude/settings.local.json
// (<home>/state/claude-activity-hooks/<script>); a seat that also LOADS the openrig-core plugin runs the plugin's copy of the same hook as
// well (measured on Claude Code 2.1.326: both run for every event, 7-27 ms apart, and only the plugin copy sees CLAUDE_PLUGIN_ROOT). Two
// copies posted every hook twice, put one question on record as two holds, and the second seat gate blocked a socket-delivered prompt as a
// repeat. So the plugin copy steps aside for an event whose managed copy the project's settings run. Anything it cannot read or tell keeps
// it running: an event is never left with no copy.
const MANAGED_HOOK_DIR = path.join("state", "claude-activity-hooks");

function isInside(child, parent) {
  try {
    const rel = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function defersToManagedCopy(env, hookEvent, script, selfPath) {
  // The plugin copy: Claude Code sets CLAUDE_PLUGIN_ROOT; Codex sets PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT (measured, 0.166.0: workspaces-o9o.76).
  const pluginRoot = firstString(env.CLAUDE_PLUGIN_ROOT, env.PLUGIN_ROOT);
  if (!pluginRoot || !hookEvent || !isInside(selfPath, pluginRoot)) return false;
  const projectDir = firstString(env.CLAUDE_PROJECT_DIR);
  if (projectDir) return claudeSettingsRunManagedCopy(projectDir, hookEvent, script);
  // A Codex hook has no CLAUDE_PROJECT_DIR; its managed copy is the OpenRig block of CODEX_HOME/config.toml (codex-runtime-adapter).
  const codexHome = firstString(env.CODEX_HOME);
  if (codexHome) return codexConfigRunsManagedCopy(codexHome, hookEvent, script, env);
  return false;
}

function claudeSettingsRunManagedCopy(projectDir, hookEvent, script) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(projectDir, ".claude", "settings.local.json"), "utf8")); } catch { return false; }
  const groups = settings && typeof settings === "object" && settings.hooks && Array.isArray(settings.hooks[hookEvent]) ? settings.hooks[hookEvent] : [];
  const managed = path.join(MANAGED_HOOK_DIR, script);
  return groups.some((group) => group && Array.isArray(group.hooks)
    && group.hooks.some((hook) => hook && typeof hook.command === "string" && runsManagedScript(hook.command, managed)));
}

// workspaces-o9o.76 (verify-sec review): CODEX_HOME/config.toml is read as TOML, not text, with no dependency (this script runs from Codex's
// plugin cache, where there is no node_modules). The scanner follows strings (basic, literal, and their multiline forms), comments, and
// arrays or inline tables that span lines, so only a line outside all of them can be a table header or one of OpenRig's sentinel comments:
// text inside a multiline string is never a stanza. The managed stanza counts only when its command runs EXACTLY the relay path OpenRig
// recorded under OPENRIG_HOME when it wrote the block (codex-runtime-adapter CODEX_MANAGED_RELAY_RECORD). Anything unread or unsure: false,
// and the plugin copy relays.
const CODEX_MANAGED_BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const CODEX_MANAGED_END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const CODEX_MANAGED_RELAY_RECORD = path.join("state", "codex-activity-hooks", "relay-path");

/** The top-level lines of a TOML text: each line that starts outside every string, array and inline table, with its text. Null when the
 *  text ends inside a string, an array or an inline table (not valid TOML: nothing is trusted). */
function tomlTopLevelLines(text) {
  const out = [];
  let multiline = null;   // '"""' or "'''" while inside a multiline string
  let depth = 0;          // open [ and { of values that span lines
  for (const line of text.split("\n")) {
    const topLevel = multiline === null && depth === 0;
    if (topLevel) out.push(line);
    let i = 0;
    if (topLevel && /^\s*\[/.test(line)) i = line.length;   // a table header: its brackets are not a value
    while (i < line.length) {
      if (multiline !== null) {
        const close = line.indexOf(multiline, i);
        if (close === -1) { i = line.length; break; }
        // A basic multiline string ends at an unescaped """ (count the backslashes before it).
        let backslashes = 0;
        for (let k = close - 1; k >= 0 && line[k] === "\\" && multiline === '"""'; k -= 1) backslashes += 1;
        if (backslashes % 2 === 1) { i = close + 1; continue; }
        i = close + 3;
        while (line[i] === multiline[0]) i += 1;   // up to two more quote characters belong to the string
        multiline = null;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) { multiline = line.slice(i, i + 3); i += 3; continue; }
      if (c === '"') {
        let j = i + 1;
        for (; j < line.length && line[j] !== '"'; j += 1) if (line[j] === "\\") j += 1;
        if (j >= line.length) return null;
        i = j + 1; continue;
      }
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j === -1) return null;
        i = j + 1; continue;
      }
      if (c === "[" || c === "{") depth += 1;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i += 1;
    }
  }
  return multiline === null && depth === 0 ? out : null;
}

function codexConfigRunsManagedCopy(codexHome, hookEvent, script, env) {
  if (script !== "activity-relay.cjs") return false;   // OpenRig's Codex block runs the relay only
  const openrigHome = firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
  let expected;
  try { expected = fs.readFileSync(path.join(openrigHome, CODEX_MANAGED_RELAY_RECORD), "utf8").trim(); } catch { return false; }
  if (!expected || !path.isAbsolute(expected)) return false;
  let text;
  try { text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch { return false; }
  const lines = tomlTopLevelLines(text);
  if (lines === null) return false;
  let inBlock = false;
  let event = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === CODEX_MANAGED_BEGIN) { inBlock = true; event = null; continue; }
    if (trimmed === CODEX_MANAGED_END) { inBlock = false; event = null; continue; }
    if (!inBlock) continue;
    const header = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(trimmed);
    if (header) { event = header[1]; continue; }
    // Any other table ends the stanza, except the stanza's own [[hooks.<Event>.hooks]] (Codex's `plugin add` appends [marketplaces.*] and
    // [plugins.*] tables INSIDE this block, measured on 0.166.0).
    if (trimmed.startsWith("[")) { if (trimmed !== `[[hooks.${event}.hooks]]`) event = null; continue; }
    if (event !== hookEvent) continue;
    // The adapter writes a TOML literal string ('...'); a command in any other form is not counted, and the plugin copy runs.
    const literal = /^command\s*=\s*'([^']*)'$/.exec(trimmed);
    if (literal && runsRecordedRelay(literal[1], expected)) return true;
  }
  return false;
}

// The command runs EXACTLY the recorded relay: `node <that path>` (node, or any path whose basename is node), the file readable.
function runsRecordedRelay(command, expected) {
  const words = shellWords(command);
  if (!words || words.length !== 2) return false;
  if (words[0] !== "node" && path.basename(words[0]) !== "node") return false;
  if (words[1] !== expected) return false;
  try { fs.accessSync(expected, fs.constants.R_OK); return fs.statSync(expected).isFile(); } catch { return false; }
}
// The words of a shell command as a POSIX shell splits them, for the plain forms the adapter writes (`node '<path>'`, an apostrophe in the
// path written '"'"'): single quotes, double quotes with backslash escapes, bare words. Null when the command uses anything a plain
// invocation does not (an unquoted ; | & < > $ ` ( ) or a newline), so a chained or redirected command never counts as running the script.
function shellWords(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? "") + command.slice(i + 1, end); i = end;
    } else if (c === '"') {
      let j = i + 1; let text = "";
      for (; j < command.length && command[j] !== '"'; j += 1) {
        if (command[j] === "\\" && j + 1 < command.length) { j += 1; }
        else if (command[j] === "$" || command[j] === "`") return null;
        text += command[j];
      }
      if (j >= command.length) return null;
      word = (word ?? "") + text; i = j;
    } else if (c === " " || c === "\t") {
      if (word !== null) { words.push(word); word = null; }
    } else if (";|&<>$`()\n\\".includes(c)) {
      return null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

// workspaces-o9o.33 (verify-qa review): a settings command counts as the managed copy only when it RUNS the managed script, either the
// script itself (then executable) or `node <script>` (then readable), and that script is a regular file. A command that only mentions the path, names a missing file, or
// hands it to another program leaves the plugin copy running: an event is never lost to a copy that cannot run.
function runsManagedScript(command, managed) {
  const words = shellWords(command);
  if (!words || words.length === 0 || words.length > 2) return false;
  if (words.length === 2 && words[0] !== "node" && path.basename(words[0]) !== "node") return false;
  const target = words[words.length - 1];
  if (!path.isAbsolute(target) || !target.endsWith(path.sep + managed)) return false;
  // Run directly, the script must be executable (question-wait.cjs ships 100644, and the adapter keeps the source mode); node only reads it.
  const access = words.length === 1 ? fs.constants.X_OK : fs.constants.R_OK;
  try { fs.accessSync(target, access); return fs.statSync(target).isFile(); } catch { return false; }
}

async function main() {
  const providerPayload = parseJson(await readStdin());
  // workspaces-o9o.124 (verify-sec review F1): Code Mode's code output is not a prompt, so nothing below runs for it: no settings read, no
  // spool read, no seat-gate record, no post on any route, nothing on stdout. Its output text can carry a marker or a spooled note.
  if (isCodeModeOutput(providerPayload)) return;
  if (defersToManagedCopy(process.env, hookEventOf(providerPayload), "activity-relay.cjs", __filename)) return;
  const spooled = readSpooled(providerPayload);
  const gate = spooled ? spooled.gate : runSeatGate(providerPayload);
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
  // A spooled prompt is settled by its own record alone, written below.
  const ack = gate === "unrecorded" || spooled ? null : buildNativeAckPayload(providerPayload);
  if (ack) {
    // A copy the gate recorded is the first, and the agent must have it, even if the daemon read the record meanwhile and calls the row
    // delivered: a block here would lose the message with the row saying received. On a seat with no gate the daemon's word is the only
    // dedupe (measured: a UserPromptSubmit block stops a socket-injected copy cleanly). No reply lets the prompt through.
    const reply = await postNativeJson("/api/activity/native-ack", ack);
    if (reply && reply.block === true && gate === "pass" && seatGateDir(process.env) === null) writeBlock(NATIVE_DUPLICATE_BLOCK_REASON);
  }
  // Last of all, so a daemon that is slow to answer above cannot time the hook out with a record already written.
  if (spooled && spooled.gate === "pass") await deliverSpooled(spooled, providerPayload);
}

function writeBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  CODE_OUTPUT_PROMPT_SOURCE,
  isCodeModeOutput,
  defersToManagedCopy,
  hookEventOf,
  buildNativeEndpointPayload,
  buildNativeAckPayload,
  buildOpenRigPayload,
  claimFirstLaunchHook,
  buildSessionIdentityPayload,
  parseJson,
  postHookPayload,
  questionKeyOf,
  runSeatGate,
  seatGateDir,
  resolveEndpoint,
};
