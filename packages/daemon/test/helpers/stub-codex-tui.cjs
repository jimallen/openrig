#!/usr/bin/env node
"use strict";
// A stub of the Codex TUI for a private hc core, as measured on 0.166.0 (s0 M4, M8): `› ` composer with its placeholder, a paste over
// 1000 characters collapsed to `[Pasted Content N chars]`, Enter runs the UserPromptSubmit hook, a block leaves the composer clean and
// no rollout record, a crashed hook fails open. It reports status by OSC 7501 and never runs a model.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { STUB_RELAY, STUB_ROLLOUT } = process.env;
let staged = "";
let pasting = false;
let pending = "";
const status = (state) => process.stdout.write(`\u001b]7501;state=${state}:app=codex\u001b\\`);
function paint() {
  const shown = staged === "" ? "Ask Codex to do anything" : staged.length > 1000 ? `[Pasted Content ${staged.length} chars]` : staged.split("\n").join("\n  ");
  process.stdout.write(`\u001b[2J\u001b[H› ${shown}\r\n\r\n  stub-model · /work · idle\r\n`.replace(/\n {2}/g, "\r\n  "));
}
function submit() {
  const prompt = staged;
  staged = "";
  const hook = spawnSync(process.execPath, [STUB_RELAY], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, transcript_path: STUB_ROLLOUT }), encoding: "utf8" });
  let blocked = false;
  try { blocked = JSON.parse(hook.stdout.trim()).decision === "block"; } catch { /* no decision: fail open */ }
  if (!blocked) fs.appendFileSync(STUB_ROLLOUT, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } })}\n`);
  paint();
}
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    if (pasting) {
      const end = pending.indexOf("\u001b[201~");
      if (end < 0) return;
      staged += pending.slice(0, end).replace(/\r/g, "\n");
      pending = pending.slice(end + 6);
      pasting = false;
      paint();
      continue;
    }
    if (pending.startsWith("\u001b[200~")) { pending = pending.slice(6); pasting = true; continue; }
    if (pending === "" || pending.startsWith("\u001b")) { if (pending.length > 6) pending = ""; return; }
    const c = pending[0];
    pending = pending.slice(1);
    if (c === "\r") { if (staged !== "") submit(); } else { staged += c; paint(); }
  }
});
process.stdout.write("\u001b[?2004h");
status("idle");
paint();
