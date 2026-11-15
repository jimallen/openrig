#!/usr/bin/env node
"use strict";

// OpenRig ask-in-modal guard. A Claude Code Stop hook that sends a turn back when it ends with a question for the human
// written in prose. Questions for the human belong in an AskUserQuestion modal: one question per modal, exactly one
// "(Recommended)" option. The rule lives in the chief-of-staff role and the house doctrine, and seats still broke it.
//
// It runs only on a seat whose rig-spec member declares `ask_in_modal: true`: the daemon puts it in that seat's launch
// `--settings` (adapters/claude-ask-in-modal-guard.ts), never in the plugin's hooks/claude.json, so no other seat runs it.
//
// Input (Claude Code Stop hook, https://code.claude.com/docs/en/hooks, "Stop input"): `stop_hook_active`,
// `last_assistant_message` (the text of the final response) and the common `transcript_path`. The docs say the transcript
// may lag at Stop time, so `last_assistant_message` is read first; the transcript is the fallback for a Claude Code that
// does not send it.
// Output: `{"decision":"block","reason":...}` on stdout ("Stop decision control"), which keeps the turn going with the
// reason as the model's next instruction. Anything else prints nothing and the turn ends.
//
// FAIL OPEN: unreadable input, a parse error, a missing or unreadable transcript, or any internal error prints nothing.
// NO LOOPS: when `stop_hook_active` is true (the turn is already continuing because a Stop hook blocked it) it never
// blocks, so a seat that still ends with a question after one correction is let through.

const fs = require("node:fs");

/** Lines read from the end of a transcript, at most. A turn's final message is near the end. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_QUOTED = 3;
const MAX_QUOTE_CHARS = 160;

// Phrasings that ask the human for something without ending in "?". Matched only at the start of a sentence (after list
// markers and emphasis), so "impl will let me know when it lands" is not a question.
const STOCK_ASK = /^(?:want me to|shall i|should i|let me know|tell me (?:if|whether|which)|say (?:when|if)|would you like|do you want)\b/i;
// "If you want, I'll ..." / "If you'd like X, say so": an offer waiting on a yes, the same ask as "Say if you want ...". Only
// when the sentence goes on to an offer or a request for an answer, so "If you want it to stick, the rule text needs changing"
// (a statement) is not counted.
const OFFER_ASK = /^if you(?:'d|’d| would)? (?:want|like|prefer)\b.*\b(?:i'll|i’ll|i will|i can|i'd|i’d|i would|say so|tell me)\b/i;

// After a "?", these may close emphasis or a parenthesis before the sentence ends: "**Merge it?**", "(right?)".
const CLOSERS = new Set(["*", "_", ")", "]", "~"]);
// A "?" right before one of these is inside quoted speech ('impl asked "is it flaky?"'): not a question to the human.
const QUOTE_CLOSERS = new Set(['"', "'", "”", "’", "»", "`"]);

/** The prose of a reply with code, block quotes, headings and table rows removed (they are not asks). Lines are kept. */
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    if (/^\s*>/.test(raw)) continue;          // block quote
    if (/^\s{0,3}#{1,6}\s/.test(raw)) continue; // heading ("## What changed?" is a title, not an ask)
    if (/^\s*\|/.test(raw)) continue;          // table row
    // Inline code spans (one or more backticks, matched in pairs of the same length) become a neutral word.
    out.push(raw.replace(/(`+)[\s\S]*?\1/g, " code "));
  }
  return out;
}

/** The sentence that ends at `end` (inclusive) in `line`, trimmed and shortened for the reason text. */
function sentenceEndingAt(line, end) {
  let start = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (/[.!?]/.test(line[i]) && /\s/.test(line[i + 1] || "")) { start = i + 1; break; }
  }
  const sentence = line.slice(start, end + 1).replace(/^[\s*_\-+>]+|\s+$/g, "").replace(/^\d+[.)]\s+/, "");
  return sentence.length > MAX_QUOTE_CHARS ? `…${sentence.slice(sentence.length - MAX_QUOTE_CHARS + 1)}` : sentence;
}

/** Sentences of `line` that ask a question: a "?" that ends a sentence (followed by whitespace or the end of the line,
 *  after closing emphasis or brackets), not inside quoted speech and not inside a word or URL ("a?b", "?x=1"). */
function questionMarks(line) {
  const found = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "?") continue;
    let j = i + 1;
    while (j < line.length && line[j] === "?") j++;
    const lastMark = j - 1;
    const next = line[j];
    if (next !== undefined && QUOTE_CLOSERS.has(next)) { i = j; continue; }
    while (j < line.length && CLOSERS.has(line[j])) j++;
    if (j < line.length && !/\s/.test(line[j])) { i = j - 1; continue; }
    found.push(sentenceEndingAt(line, lastMark));
    i = j - 1;
  }
  return found;
}

/** Sentences of `line` that open with a stock asking phrase ("Want me to ...", "Let me know ..."). */
function stockAsks(line) {
  const found = [];
  const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
  for (const sentence of body.split(/(?<=[.!?:;])\s+/)) {
    const bare = sentence.replace(/^[\s*_~(\["“]+/, "");
    if (STOCK_ASK.test(bare) || OFFER_ASK.test(bare)) found.push(bare.length > MAX_QUOTE_CHARS ? `${bare.slice(0, MAX_QUOTE_CHARS - 1)}…` : bare.trim());
  }
  return found;
}

/** The questions for the human that `text` asks, in order and without repeats. Empty when it asks none. */
function findQuestions(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const seen = new Set();
  const out = [];
  for (const line of proseLines(text)) {
    for (const q of [...questionMarks(line), ...stockAsks(line)]) {
      if (q && !seen.has(q)) { seen.add(q); out.push(q); }
    }
  }
  return out;
}

function contentBlocks(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((b) => b && typeof b === "object") : [];
}

/** A transcript entry that starts a turn: a user prompt (not a tool result, not a meta entry). */
function isPrompt(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta === true) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b && b.type === "tool_result");
}

/** From a transcript's JSONL text: the final text of the last turn, and whether an AskUserQuestion tool_use came after it.
 *  Entries this does not know (system, attachment, queue-operation, ...) are skipped; an unparseable line is skipped. */
function lastTurnFromTranscript(jsonl) {
  const lines = String(jsonl).split("\n");
  const blocks = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (isPrompt(entry)) break;
    if (entry && entry.type === "assistant") blocks.unshift(...contentBlocks(entry));
  }
  let lastText = -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === "text" && typeof blocks[i].text === "string") { lastText = i; break; }
  if (lastText === -1) return { text: "", askedAfter: false };
  let first = lastText;
  while (first > 0 && blocks[first - 1].type === "text") first--;
  const text = blocks.slice(first, lastText + 1).map((b) => b.text).join("\n");
  const askedAfter = blocks.slice(lastText + 1).some((b) => b.type === "tool_use" && b.name === "AskUserQuestion");
  return { text, askedAfter };
}

function readTail(file, bytes = TRANSCRIPT_TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    // A tail that starts mid-file starts mid-line: drop the partial first line.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function blockReason(questions) {
  const quoted = questions.slice(0, MAX_QUOTED).map((q) => `"${q}"`).join("; ");
  const more = questions.length > MAX_QUOTED ? ` (and ${questions.length - MAX_QUOTED} more)` : "";
  return [
    `ask-in-modal guard: this turn ended with a question for the human in prose: ${quoted}${more}.`,
    "Questions for the human go in the AskUserQuestion tool, never in prose. Now:",
    "1. Call AskUserQuestion with one question per decision. Put the option you recommend first and mark it, and only it, \"(Recommended)\". Make each question self-contained: say what it is about and what each option means, because the human may not have read your report.",
    "2. Do not repeat the question in prose.",
    "If a sentence was not a question for the human (a rhetorical question, or one you have already put to another seat), rephrase it as a statement of what you will do or what you found, and end the turn without a question.",
  ].join("\n");
}

/** The hook's decision for one Stop input: the object to print, or null to print nothing. Never throws. */
function decide(input, readTranscript = readTail) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    if (input.stop_hook_active === true) return null;
    let text;
    let askedAfter = false;
    if (typeof input.last_assistant_message === "string") {
      text = input.last_assistant_message;
    } else if (typeof input.transcript_path === "string" && input.transcript_path) {
      ({ text, askedAfter } = lastTurnFromTranscript(readTranscript(input.transcript_path)));
    } else {
      return null;
    }
    if (askedAfter) return null;
    const questions = findQuestions(text);
    return questions.length > 0 ? { decision: "block", reason: blockReason(questions) } : null;
  } catch {
    return null;
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch { return; }
  const decision = decide(input);
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (require.main === module) main().catch(() => {});

module.exports = { decide, findQuestions, lastTurnFromTranscript, proseLines, blockReason, STOCK_ASK, OFFER_ASK };
