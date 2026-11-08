#!/usr/bin/env node
"use strict";

// OpenRig question-wait hook (OF-278). Claude Code runs it as a PermissionRequest hook for the AskUserQuestion dialog, WHILE the
// dialog is open (measured on 2.1.319: the human's answer wins, and a hook that fails or is killed leaves the dialog open).
//
// It asks the daemon, in a long-poll, whether the question should take its "(Recommended)" answer. The daemon owns the wait and the log;
// this script only enacts. It prints a decision only when the daemon sends an answer. Anything else (the daemon down, a refusal, a
// question with no safe answer, an answer from the human) prints nothing and leaves the dialog to the human. It never guesses.

const crypto = require("node:crypto");
const { parseJson, resolveEndpoint } = require("./activity-relay.cjs");

// Same number as QUESTION_HOOK_TIMEOUT_SECONDS (domain/seat-question-policy.ts) and this hook's `timeout` in hooks/claude.json (pinned by test).
const HOOK_TIMEOUT_SECONDS = 3900;
const RETRY_MS = 5000;

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function buildRequest(providerPayload, env, requestId, askedAtMs) {
  if (providerPayload.tool_name !== "AskUserQuestion") return null;
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  if (!sessionName && !nodeId) return null;
  return {
    requestId, askedAtMs, sessionName, nodeId,
    generation: firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION),
    toolInput: providerPayload.tool_input,
  };
}

function decisionOutput(updatedInput) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } } };
}

async function ask(request, env, fetchImpl) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetchImpl(new URL("/api/activity/question-wait", baseUrl).toString(), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(request), signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the long-poll; resolves the decision to print, or null for "print nothing". `sleep` and `now` are injected for the tests. */
async function run(providerPayload, env = process.env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const startedAt = now();
  const request = buildRequest(providerPayload, env, deps.requestId || crypto.randomUUID(), startedAt);
  if (!request) return null;
  while (now() - startedAt < HOOK_TIMEOUT_SECONDS * 1000) {
    const reply = await ask(request, env, fetchImpl);
    if (reply && reply.ok === true) {
      if (reply.action === "answer" && reply.updatedInput && typeof reply.updatedInput === "object") return decisionOutput(reply.updatedInput);
      if (reply.action === "none") return null;
      continue;  // "wait": ask again at once, under the same request id
    }
    await sleep(RETRY_MS);  // the daemon did not answer: it may be restarting. Same request id, so it answers nothing twice.
  }
  return null;
}

async function main() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  const decision = await run(parseJson(data));
  if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
}

if (require.main === module) main().catch(() => {});

module.exports = { buildRequest, decisionOutput, run, HOOK_TIMEOUT_SECONDS };
