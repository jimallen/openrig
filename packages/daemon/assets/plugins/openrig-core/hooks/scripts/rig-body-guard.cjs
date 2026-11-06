#!/usr/bin/env node
"use strict";

// OF-249: refuse, BEFORE it runs, a shell command that puts a command substitution into the text a
// `rig` command will carry (rig send "...`cmd`...", rig queue create --body "$(cmd)", an unquoted
// here-document with $(...) in it). The shell executes a substitution before `rig` starts, so nothing
// inside rig can stop it: the only place to stop it is the agent harness, before the shell sees the
// command. Two harnesses use this one file:
//   - Claude Code: a PreToolUse hook on Bash (hooks/claude.json runs this file; main() below).
//   - Pi: pi/rig-body-guard.cjs (a Pi extension) requires this file and refuses on its tool_call event.
//
// It reads the SHELL STRUCTURE, not the raw text: a backtick inside single quotes, inside a quoted
// here-document (<<'EOF'), in a file given with --file, or in a comment is not a substitution and is
// allowed. The lexer is a port of the ideas in ~/.agents/scripts/bash-guard (quote-aware matching of
// $(...) and `...`, here-document bodies read at the newline), narrowed to this one question.
//
// FAIL-CLOSED / FAIL-OPEN (decided, OF-249):
//   - A command that does not mention a guarded rig command is never refused, whatever the parser does.
//   - A command the parser cannot read (unterminated quote or $( , too deep, internal error) is
//     refused ONLY IF a plain-text check also sees `rig <guarded command>` and a backtick or `$(`
//     in it ("fail-closed where the risk signal exists"); otherwise it is allowed.
//   - Hook input that cannot be read at all (not JSON, no command) is allowed with a note on stderr:
//     a hook that wedges every Bash call would also block the `rig send` that reports the fault.
//
// Not covered (residual, documented in the OF-249 report): a command assembled at run time
// (variables used as the command or its text, `eval "$x"`), a file written with an unquoted
// here-document and sent in a later command, `hc send`, python/node -e shelling out, aliases.

const MAX_LEN = 1_000_000;
// OF-251: stands in, in a wrapper script's text, for a substitution the LOCAL shell runs before the wrapper starts. A private-use
// character; any word or here-document holding it counts as expanded whatever quoting the inner text puts around it. check() picks, for
// each command, one that the command does not contain (a literal U+E000 in a message is plain text, OF-251 review F-2).
let OUTER_SUB = "\uE000";
// A script word with more substitutions or more text than this is not masked: the command is refused where a guarded rig command is named
// (a ParseError, see check()), because a hook that runs past its timeout fails open in Claude Code (OF-251 review F-3).
// A check that has run this long gives up with a ParseError, so the in-guard fallback (which also sees through quoting tricks in the rig name) decides well
// before the wrapper's 3 s watchdog and Claude's 5 s hook timeout (a timeout fails open). Overridable per call for tests.
const DEFAULT_BUDGET_MS = 1500;
let deadline = Infinity;
let work = 0;
function tick() { if ((++work & 1023) === 0 && Date.now() > deadline) throw new ParseError("work budget exceeded"); }
const MAX_MASK_MARKS = 20_000;
const MAX_MASK_BYTES = 262_144;
const MAX_DEPTH = 8;

class ParseError extends Error {}

// ---------------------------------------------------------------------------------------------
// The guarded command table. Re-derived against packages/cli/src/commands by
// test/rig-body-guard-census.test.ts: a CLI file that gains a text-carrying option and is in
// neither table fails the census.
//
// MESSAGE commands carry free text in their positionals and options: ANY word with a command
// substitution is refused (protect by default), except the value of a *-file option.
const MESSAGE_COMMANDS = {
  send: { stdin: "--file - <<'EOF'" },
  broadcast: { stdin: null },
  ask: { stdin: null },
  chatroom: { stdin: null },
  stream: { stdin: null },
  queue: { stdin: "--body-file - <<'EOF'" },
  proof: { stdin: "--file - <<'EOF'" },
  scope: { stdin: null },
  watchdog: { stdin: null },
  workflow: { stdin: null },
};
// FLAG commands carry text only in a few options (a reason, a note); a substitution in their other
// words (--cwd "$(pwd)") is a deliberate use and stays allowed.
const FLAG_COMMANDS = {
  seat: ["--reason", "--expect-account"],
  edge: ["--reason"],
  gateway: ["--reason"],
  project: ["--reason", "--needs-human"],
  launch: ["--hold-reason"],
  "agent-image": ["--notes"],
  bundle: ["--notes"],
  host: ["--notes"],
  slack: ["--reason", "--source-label"],
  "startup-proof": ["--answer"],
  mode: ["--evidence"],
  "restore-packet": ["--authority-boundaries", "--caveat", "--current-work-summary"],
};
// Producers whose arguments become the text of a pipe into a guarded command.
const PRODUCERS = new Set(["echo", "printf"]);

// ---------------------------------------------------------------------------------------------
// Lexer

const HEREDOC_RE = /<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\?[^\s;&|()<>'"\\]+)+)/y;
const REDIR_RE = /<<<|<<-|<<|>>|>&|<&|&>>|&>|>\||<>|>|</y;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

function skipBacktick(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    i++;
  }
  throw new ParseError("unterminated backtick");
}

function closeBrace(src, i) {
  // src[i] is just after "${": index of the matching "}".
  let depth = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) throw new ParseError("unterminated '"); i = j + 1; continue; }
    if (c === '"') { i = skipDq(src, i + 1); continue; }
    if (c === "`") { i = skipBacktick(src, i + 1); continue; }
    if (c === "$" && src[i + 1] === "(") { i = closeParen(src, i + 2) + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new ParseError("unterminated ${");
}

function skipDq(src, i) {
  // src[i] is just after an opening double quote: index just after the closing one.
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === "`") { i = skipBacktick(src, i + 1); continue; }
    if (c === "$" && src[i + 1] === "(") { i = closeParen(src, i + 2) + 1; continue; }
    if (c === "$" && src[i + 1] === "{") { i = closeBrace(src, i + 2) + 1; continue; }
    i++;
  }
  throw new ParseError("unterminated double quote");
}

function heredocDelim(raw) {
  return { quoted: /['"\\]/.test(raw), delim: raw.replace(/\\(.)/g, "$1").replace(/['"]/g, "") };
}

function readHeredocBodies(src, i, docs) {
  // i is the start of the line after the one that declared the here-documents; reads each body in
  // order. Returns the index after the last terminator. An unterminated body runs to the end of the
  // text (bash accepts it with a warning).
  const n = src.length;
  for (const d of docs) {
    const lines = [];
    while (i < n) {
      tick();
      const j = src.indexOf("\n", i);
      const line = j < 0 ? src.slice(i) : src.slice(i, j);
      i = j < 0 ? n : j + 1;
      if ((d.strip ? line.replace(/^\t+/, "") : line) === d.delim) break;
      lines.push(line);
    }
    d.target.body = lines.join("\n");
  }
  return i;
}

function closeParen(src, i) {
  // src[i] is just after "(" (or "$("): index of the matching ")", quote and here-document aware.
  let depth = 1;
  const n = src.length;
  let docs = [];
  while (i < n) {
    const c = src[i];
    if (c === "\n" && docs.length) {
      i = readHeredocBodies(src, i + 1, docs);
      docs = [];
      continue;
    }
    if (c === "<" && src.startsWith("<<", i) && src[i + 2] !== "<") {
      HEREDOC_RE.lastIndex = i;
      const m = HEREDOC_RE.exec(src);
      if (m) {
        const d = heredocDelim(m[2]);
        docs.push({ delim: d.delim, strip: m[1] === "-", target: {} });
        i = HEREDOC_RE.lastIndex;
        continue;
      }
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) throw new ParseError("unterminated '"); i = j + 1; continue; }
    if (c === '"') { i = skipDq(src, i + 1); continue; }
    if (c === "`") { i = skipBacktick(src, i + 1); continue; }
    if (c === "$" && src[i + 1] === "(") { i = closeParen(src, i + 2) + 1; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new ParseError("unterminated $(");
}

/** True when text (a here-document body or an arithmetic/parameter expansion) holds a substitution the
 *  shell would execute: an unescaped backtick or "$(" that is not "$((". */
function bodyExpands(text) {
  if (text.includes(OUTER_SUB)) return true;      // OF-251: a substitution the OUTER shell runs (see outerExpansion)
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") return true;
    if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") return true;
  }
  return false;
}

const WORD_STOP = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** Read one shell word starting at i. Returns { word, next }. A word is
 *  { text, expands, quoted, subs }: text has its quotes removed (what the program receives, up to
 *  expansion); expands is true when a command substitution or process substitution outside single quotes
 *  is in it; subs are the bodies of those substitutions (scanned as commands in their own right). */
function readWord(src, i) {
  const n = src.length;
  const start = i;
  let text = "";
  let expands = false;
  let quoted = false;
  const subs = [];
  const marks = [];                                   // [from, to) spans of `text` that are substitutions the shell runs
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      quoted = true;
      if (i + 1 < n) {
        if (src[i + 1] !== "\n") text += src[i + 1];
        i += 2;
      } else i++;
      continue;
    }
    if (c === "'") {
      quoted = true;
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ParseError("unterminated '");
      text += src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= n) throw new ParseError("unterminated double quote");
        const d = src[i];
        if (d === '"') { i++; break; }
        if (d === "\\" && i + 1 < n) {
          text += '"\\$`'.includes(src[i + 1]) ? src[i + 1] : d + src[i + 1];
          i += 2;
          continue;
        }
        if (d === "$" && src[i + 1] === "(" ) {
          const j = closeParen(src, i + 2);
          const from = text.length;
          if (src[i + 2] === "(") {
            const inner = src.slice(i + 3, j - 1);
            if (bodyExpands(inner)) { expands = true; subs.push(inner); marks.push([from, from + (j + 1 - i)]); }
          } else { expands = true; subs.push(src.slice(i + 2, j)); marks.push([from, from + (j + 1 - i)]); }
          text += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (d === "$" && src[i + 1] === "{") {
          const j = closeBrace(src, i + 2);
          if (bodyExpands(src.slice(i + 2, j))) { expands = true; marks.push([text.length, text.length + (j + 1 - i)]); }
          text += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (d === "`") {
          const j = skipBacktick(src, i + 1);
          expands = true;
          subs.push(src.slice(i + 1, j - 1).replace(/\\([`$\\])/g, "$1"));
          marks.push([text.length, text.length + (j - i)]);
          text += src.slice(i, j);
          i = j;
          continue;
        }
        text += d;
        i++;
      }
      continue;
    }
    if (c === "$") {
      if (src[i + 1] === "(") {
        const j = closeParen(src, i + 2);
        const from = text.length;
        if (src[i + 2] === "(") {
          const inner = src.slice(i + 3, j - 1);
          if (bodyExpands(inner)) { expands = true; subs.push(inner); marks.push([from, from + (j + 1 - i)]); }
        } else { expands = true; subs.push(src.slice(i + 2, j)); marks.push([from, from + (j + 1 - i)]); }
        text += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (src[i + 1] === "{") {
        const j = closeBrace(src, i + 2);
        if (bodyExpands(src.slice(i + 2, j))) { expands = true; marks.push([text.length, text.length + (j + 1 - i)]); }
        text += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (src[i + 1] === "'") {
        quoted = true;
        let j = i + 2;
        while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
        if (j >= n) throw new ParseError("unterminated $'");
        text += src.slice(i + 2, j);
        i = j + 1;
        continue;
      }
      text += c;
      i++;
      continue;
    }
    if (c === "`") {
      const j = skipBacktick(src, i + 1);
      expands = true;
      subs.push(src.slice(i + 1, j - 1).replace(/\\([`$\\])/g, "$1"));
      marks.push([text.length, text.length + (j - i)]);
      text += src.slice(i, j);
      i = j;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const j = closeParen(src, i + 2);
      expands = true;
      subs.push(src.slice(i + 2, j));
      marks.push([text.length, text.length + (j + 1 - i)]);
      text += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (WORD_STOP.has(c)) break;
    text += c;
    i++;
  }
  return { word: { text, expands: expands || text.includes(OUTER_SUB), quoted, subs, marks, raw: src.slice(start, i) }, next: i };
}

/** Split shell text into simple commands. Returns { cmds, subs }. A cmd is
 *  { words, heredocs: [{ delim, quoted, strip, body }], hereStrings: [word], sep } where sep is the
 *  operator that FOLLOWS it. */
function lex(src) {
  const n = src.length;
  const cmds = [];
  const subs = [];
  let cur = { words: [], heredocs: [], hereStrings: [], sep: "" };
  let pending = [];
  let i = 0;

  const pushSubs = (word) => { for (const s of word.subs) subs.push(s); };
  const endCmd = (sep) => {
    if (cur.words.length || cur.heredocs.length || cur.hereStrings.length) {
      cur.sep = sep;
      cmds.push(cur);
      cur = { words: [], heredocs: [], hereStrings: [], sep: "" };
    } else if (sep !== "\n" && cmds.length && cmds[cmds.length - 1].sep === ")") {
      cmds[cmds.length - 1].sep = sep;          // (a) | b
    }
  };

  while (i < n) {
    tick();
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "\n") {
      endCmd("\n");
      i++;
      if (pending.length) { i = readHeredocBodies(src, i, pending); pending = []; }
      continue;
    }
    if (c === "&" && src[i + 1] === ">") {
      REDIR_RE.lastIndex = i;
      REDIR_RE.exec(src);
      i = REDIR_RE.lastIndex;
      while (src[i] === " " || src[i] === "\t") i++;
      const r = readWord(src, i); pushSubs(r.word); i = r.next;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      let op = c;
      if ((c === "&" || c === "|") && src[i + 1] === c) op = c + c;
      else if (c === "|" && src[i + 1] === "&") op = "|&";
      i += op.length;
      endCmd(c === "(" ? ";" : op === ")" ? ")" : op);
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] !== "(") {
      REDIR_RE.lastIndex = i;
      const m = REDIR_RE.exec(src);
      const op = m ? m[0] : c;
      i += op.length;
      while (src[i] === " " || src[i] === "\t") i++;
      if (op === "<<" || op === "<<-") {
        const r = readWord(src, i);
        i = r.next;
        const dd = heredocDelim(r.word.raw);       // the raw span: quotes decide whether the body expands
        const doc = { delim: dd.delim, quoted: dd.quoted, strip: op === "<<-", body: "" };
        cur.heredocs.push(doc);
        pending.push({ delim: dd.delim, strip: doc.strip, target: doc });
      } else {
        const r = readWord(src, i);
        i = r.next;
        pushSubs(r.word);
        if (op === "<<<") cur.hereStrings.push(r.word);
      }
      continue;
    }
    const startAt = i;
    const r = readWord(src, i);
    i = r.next;
    if (i === startAt) { i++; continue; }              // a stray metacharacter: skip it
    // "2>&1" / "2>file": a digits-only word glued to a redirect operator is a file descriptor.
    if (/^\d+$/.test(r.word.text) && !r.word.quoted && (src[i] === ">" || src[i] === "<") && src[i + 1] !== "(") continue;
    pushSubs(r.word);
    cur.words.push(r.word);
  }
  endCmd("");
  if (pending.length) readHeredocBodies(src, n, pending);
  return { cmds, subs };
}

// ---------------------------------------------------------------------------------------------
// Command resolution

const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc", "time"]);
const STDIN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const SHELLS = new Set([...STDIN_SHELLS, "su"]);   // su -c takes a shell script like sh -c
// Programs that only print or search their arguments: `rig send ...` among their arguments is text, not a command to run.
const NON_RUNNERS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "which", "type", "whereis", "man", "cat"]);
// wrapper -> [options that take a value, leading positionals to skip]
const WRAPPERS = {
  sudo: [new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D", "--user", "--group"]), 0],
  doas: [new Set(["-u", "-C"]), 0],
  env: [new Set(["-u", "-C", "-S", "--unset", "--chdir"]), 0],
  nohup: [new Set(), 0], setsid: [new Set(), 0], builtin: [new Set(), 0], exec: [new Set(["-a"]), 0],
  command: [new Set(), 0], stdbuf: [new Set(["-i", "-o", "-e"]), 0], unbuffer: [new Set(), 0],
  caffeinate: [new Set(["-t", "-w"]), 0], nice: [new Set(["-n", "--adjustment"]), 0],
  ionice: [new Set(["-c", "-n", "-p", "-P", "-u"]), 0], timeout: [new Set(["-s", "-k", "--signal", "--kill-after"]), 1],
};
const SSH_VALUED = new Set("BbcDEeFIiJLlmOopQRSWw".split("").map((c) => "-" + c));

function baseName(text) {
  const i = text.lastIndexOf("/");
  return i < 0 ? text : text.slice(i + 1);
}

/** The program a simple command runs and its arguments, after assignments, keywords and wrappers. */
function resolve(words) {
  let k = 0;
  let skipped = false;
  const scripts = [];          // `env -S "<string>"`: the string is split and run as a command (OF-251 review F-3)
  const done = (r) => { if (scripts.length) { r = r || { name: "", args: [] }; r.scripts = scripts; } return r; };
  for (let guard = 0; guard < 64; guard++) {
    // OF-251 review F-1: a leading word that expands (`$(true) rig send ...`, `$(command -v rig) send ...`) is an unknown prefix, not the end of resolution.
    while (k < words.length && (ASSIGN_RE.test(words[k].text) || KEYWORDS.has(words[k].text) || words[k].expands)) { if (words[k].expands && !ASSIGN_RE.test(words[k].text)) skipped = true; k++; }
    if (k >= words.length) return done(null);
    const name = baseName(words[k].text);
    const w = WRAPPERS[name];
    if (!w) {
      // `$(command -v rig) send s hi $(date)`: the name word is a substitution and the next word is a guarded rig command.
      if (skipped && (Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, words[k].text) || Object.prototype.hasOwnProperty.call(FLAG_COMMANDS, words[k].text))) return done({ name: "rig", args: words.slice(k) });
      return done({ name, args: words.slice(k + 1) });
    }
    k++;
    let skip = w[1];
    while (k < words.length) {
      const t = words[k].text;
      if (t === "--") { k++; break; }
      if (name === "env" && (t === "-S" || t === "--split-string") && k + 1 < words.length) { scripts.push(words[k + 1]); k += 2; continue; }
      if (name === "env" && (t.startsWith("-S") || t.startsWith("--split-string=")) && t.length > (t.startsWith("-S") ? 2 : 15)) { scripts.push(subWord(words[k], t.startsWith("-S") ? 2 : 15)); k++; continue; }
      if (t.startsWith("-") && t.length > 1) { k += w[0].has(t) ? 2 : 1; continue; }
      if (name === "env" && ASSIGN_RE.test(t)) { k++; continue; }
      if (skip > 0) { skip--; k++; continue; }
      break;
    }
  }
  return done(null);
}

/** A word made of the tail of another word's text (`-S"rig send"` style attached values), marks shifted with it. */
function subWord(w, offset) {
  return { ...w, text: w.text.slice(offset), marks: w.marks.filter((m) => m[0] >= offset).map((m) => [m[0] - offset, m[1] - offset]) };
}

/** The first word after "rig" that is not an option: the top-level command. */
function topLevel(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") continue;
    if (t.startsWith("-")) continue;
    return { name: t, rest: args.slice(i + 1) };
  }
  return null;
}

const FILE_OPTION_RE = /^(?:--file|-f|--[a-z][a-z-]*-file)$/;
const FILE_OPTION_EQ_RE = /^(?:--file|--[a-z][a-z-]*-file)=/;

/** Violations in one rig command: [{ kind, command }]. */
function rigViolations(top) {
  const out = [];
  const message = Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, top.name);
  const flags = Object.prototype.hasOwnProperty.call(FLAG_COMMANDS, top.name) ? FLAG_COMMANDS[top.name] : null;
  if (!message && !flags) return out;
  const words = top.rest;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (FILE_OPTION_RE.test(w.text) && !w.expands) { i++; continue; }          // the value is a path
    if (FILE_OPTION_EQ_RE.test(w.text)) continue;
    if (message) {
      if (w.expands) out.push({ kind: "substitution", command: top.name });
      continue;
    }
    const eq = w.text.indexOf("=");
    const flag = eq > 0 ? w.text.slice(0, eq) : w.text;
    if (!flags.includes(flag)) continue;
    const value = eq > 0 ? w : words[i + 1];
    if (value && value.expands) out.push({ kind: "substitution", command: top.name });
    if (eq <= 0) i++;
  }
  return out;
}

function isMessageRig(res) {
  if (!res || res.name !== "rig") return null;
  const top = topLevel(res.args);
  return top && Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, top.name) ? top : null;
}

function scan(src, depth, out) {
  if (depth > MAX_DEPTH) throw new ParseError("nested too deep");
  if (Date.now() > deadline) throw new ParseError("work budget exceeded");
  const { cmds, subs } = lex(src);
  const resolved = cmds.map((c) => resolve(c.words));
  // Pipelines: a run of commands joined by | or |&.
  let start = 0;
  for (let i = 0; i < cmds.length; i++) {
    if (cmds[i].sep === "|" || cmds[i].sep === "|&") continue;
    scanPipeline(cmds, resolved, start, i + 1, depth, out);
    start = i + 1;
  }
  for (const s of subs) scan(s, depth + 1, out);
}

/** The here-documents and here-strings of a shell command that reads its script from stdin are shell text too. */
function scanStdinScript(cmd, depth, out) {
  for (const h of cmd.heredocs) {
    // OF-251 review F-6/F-1: an UNQUOTED delimiter makes THIS shell expand the body first, whatever single quotes the script puts around it, so that expanded
    // text is the script (scanned once: scanning the raw body as well doubled the work at every nesting level).
    scan(h.quoted ? h.body : expandUnquotedHeredoc(h.body), depth + 1, out);
  }
  for (const w of cmd.hereStrings) scan(w.text, depth + 1, out);
}

/** The text of a script word with each substitution the LOCAL shell runs replaced by OUTER_SUB. */
function maskedText(w) {
  if (w.marks.length > MAX_MASK_MARKS || (w.marks.length > 0 && w.text.length > MAX_MASK_BYTES)) throw new ParseError("script word too large to mask");
  return maskPieces(w.text, w.marks);
}

/** One linear pass: text with each [from, to) span (ascending, non-overlapping) replaced by OUTER_SUB. */
function maskPieces(text, marks) {
  const pieces = [];
  let at = 0;
  for (const [from, to] of marks) { pieces.push(text.slice(at, from), OUTER_SUB); at = to; }
  pieces.push(text.slice(at));
  return pieces.join("");
}

/** What the shell that reads an UNQUOTED here-document hands on: each substitution is run by THIS shell (OUTER_SUB), and \$, \`, \\ and \<newline> are unescaped
 *  (so `sh <<EOF` / `rig send s "\$(x)"` gives the inner shell a live `$(x)`). One linear pass; this is the only text of the body that is scanned (OF-251 review F-1, F-2). */
function expandUnquotedHeredoc(text) {
  const n = text.length;
  const pieces = [];
  let at = 0;
  let i = 0;
  const cut = (from, to, repl) => { pieces.push(text.slice(at, from), repl); at = to; };
  while (i < n) {
    tick();
    const c = text[i];
    if (c === "\\") {
      const d = text[i + 1];
      if (d === "$" || d === "`" || d === "\\") cut(i, i + 2, d);
      else if (d === "\n") cut(i, i + 2, "");
      i += 2;
      continue;
    }
    if (c === "`") { const j = skipBacktick(text, i + 1); cut(i, j, OUTER_SUB); i = j; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const j = closeParen(text, i + 2);
      if (text[i + 2] !== "(" || bodyExpands(text.slice(i + 3, j - 1))) cut(i, j + 1, OUTER_SUB);
      i = j + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      const j = closeBrace(text, i + 2);
      if (bodyExpands(text.slice(i + 2, j))) cut(i, j + 1, OUTER_SUB);
      i = j + 1;
      continue;
    }
    i++;
  }
  pieces.push(text.slice(at));
  return pieces.join("");
}

/** F1 (OF-249 review), narrowed by OF-251: the script handed to sh -c / eval / ssh is itself a word of THIS shell. When that word has a command
 *  substitution (outer double quotes or none), the local shell runs it before the wrapper starts, so judging the inner text against its own quoting
 *  ('...' inside) is the wrong context. The script is therefore read again with each such substitution replaced by OUTER_SUB, which counts as expanded
 *  wherever it sits in the inner text, quoted or not: it is refused only when it lands in the words or the stdin of a guarded rig command. An unrelated
 *  substitution next to plain rig text (ssh host "cd $(pwd) && rig send s hi") stays allowed, as it is when run locally. */
function outerExpansion(words, depth, out) {
  if (!words.some((w) => w.marks.length > 0)) return;
  scan(words.map(maskedText).join(" "), depth + 1, out);
}

/** A script string handed to a program that runs it as shell text (eval, watch, sh -c, su -c, script -c, env -S, ssh's remote command): the words are words of THIS shell. */
function scanScriptWords(words, depth, out) {
  outerExpansion(words, depth, out);
  scan(words.map((a) => a.text).join(" "), depth + 1, out);
}

/** A shell (or ssh) that reads its script from a pipe: what the earlier commands of the pipeline print is the script (OF-251 review F-3). */
function scanPipeProducers(cmds, resolved, from, to, depth, out) {
  for (let j = from; j < to; j++) {
    scanStdinScript(cmds[j], depth, out);                          // cat <<EOF | sh
    const res = resolved[j];
    if (!res || !PRODUCERS.has(res.name)) continue;
    let words = res.args;
    while (words.length && /^-[neE]+$/.test(words[0].text)) words = words.slice(1);
    if (res.name === "printf" && words.length && words[0].text.includes("%")) words = words.slice(1);   // the format is not the text
    if (words.length) scanScriptWords(words, depth, out);
  }
}

function scanPipeline(cmds, resolved, from, to, depth, out) {
  let message = null;
  for (let i = from; i < to; i++) {
    const res = resolved[i];
    if (!res) continue;
    if (res.scripts) for (const sw of res.scripts) scanScriptWords([sw], depth, out);
    let handled = true;
    if (res.name === "rig") {
      const top = topLevel(res.args);
      if (top) for (const v of rigViolations(top)) out.push(v);
      if (isMessageRig(res)) message = top.name;
    } else if (SHELLS.has(res.name)) {
      const ci = res.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
      if (ci >= 0) {
        const script = res.args.slice(ci + 1).find((a) => !a.text.startsWith("-"));
        if (script) { outerExpansion([script], depth, out); scan(script.text, depth + 1, out); }
      } else if (STDIN_SHELLS.has(res.name) && (res.args.every((a) => a.text.startsWith("-")) || res.args.some((a) => a.text === "-s"))) {
        scanStdinScript(cmds[i], depth, out);        // bash <<'EOF' ... EOF / bash <<< '...': the text is the script
        scanPipeProducers(cmds, resolved, from, i, depth, out);
      } else handled = false;
    } else if (res.name === "eval") {
      scanScriptWords(res.args, depth, out);
    } else if (res.name === "watch") {
      let k = 0;                                      // watch joins its words and runs them with sh -c
      while (k < res.args.length && res.args[k].text.startsWith("-")) k += (res.args[k].text === "-n" || res.args[k].text === "--interval") ? 2 : 1;
      if (k < res.args.length) scanScriptWords(res.args.slice(k), depth, out);
    } else if (res.name === "script" && res.args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text) || a.text === "--command")) {
      const ci = res.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text) || a.text === "--command");
      if (res.args[ci + 1]) scanScriptWords([res.args[ci + 1]], depth, out);   // util-linux script -c "<script>"
    } else if (res.name === "ssh") {
      let k = 0;
      while (k < res.args.length && res.args[k].text.startsWith("-")) k += SSH_VALUED.has(res.args[k].text) ? 2 : 1;
      const remote = res.args.slice(k + 1);                 // after the host
      if (remote.length) scanScriptWords(remote, depth, out);
      else { scanStdinScript(cmds[i], depth, out); scanPipeProducers(cmds, resolved, from, i, depth, out); }   // ssh host <<'EOF' ... EOF, printf ... | ssh host
    } else handled = false;
    if (!handled && !NON_RUNNERS.has(res.name)) {
      // OF-251 review F-1/F-3: a runner this guard does not model (find -exec, parallel, docker exec, script, tmux, ...): `rig <guarded command> ...` among its
      // arguments is judged as if it were run directly, and an argument that is itself a script string naming a guarded rig command is read as shell text
      // (fail closed). tmux send-keys types into another pane, a different vector that is left alone: only the first rule applies to it.
      const j = res.args.findIndex((a) => !a.expands && baseName(a.text) === "rig");
      if (j >= 0) {
        const top = topLevel(res.args.slice(j + 1));
        if (top) {
          for (const v of rigViolations(top)) out.push(v);
          if (Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, top.name)) message = top.name;
        }
      }
      if (res.name !== "tmux") for (const a of res.args) if (/\s/.test(a.text) && SCRIPT_START_RE.test(a.text)) scanScriptWords([a], depth, out);
    }
  }
  if (!message) return;
  // The text of the message can also arrive on stdin: here-documents, here-strings and echo/printf
  // producers in the same pipeline as a message command.
  for (let i = from; i < to; i++) {
    const c = cmds[i];
    for (const h of c.heredocs) if ((!h.quoted || h.body.includes(OUTER_SUB)) && bodyExpands(h.body)) out.push({ kind: "heredoc", command: message });
    for (const w of c.hereStrings) if (w.expands) out.push({ kind: "here-string", command: message });
    const res = resolved[i];
    if (res && PRODUCERS.has(res.name)) {
      for (const w of res.args) if (w.expands) { out.push({ kind: "pipe-producer", command: message }); break; }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Verdict

const GUARDED_ALT = Object.keys(MESSAGE_COMMANDS).concat(Object.keys(FLAG_COMMANDS)).map((n) => n.replace(/-/g, "\\-")).join("|");
const RIG_TAIL = "(?:[\\w./-]*/)?rig\\s+(?:-\\S+\\s+)*(" + GUARDED_ALT + ")\\b";
const FALLBACK_SRC = "(?:^|[^\\w./-])" + RIG_TAIL;
const FALLBACK_RE = new RegExp(FALLBACK_SRC);
// A script string whose command (at its start, or right after ; & | or an opening parenthesis) is a guarded rig command: `docker exec c "rig send s $(x)"`. Anchored, so a commit message that
// merely mentions `rig send` is not a script.
const SCRIPT_START_RE = new RegExp("(?:^|[;&|(])\\s*" + RIG_TAIL);

/** A private-use character the command does not contain; a ParseError when it holds all 6400 of them. */
function pickMarker(src) {
  const used = new Set();
  for (const m of src.matchAll(/[\uE000-\uF8FF]/g)) used.add(m[0]);
  for (let c = 0xE000; c <= 0xF8FF; c++) { const ch = String.fromCharCode(c); if (!used.has(ch)) return ch; }
  throw new ParseError("no free marker character");
}

/** check(command[, { budgetMs }]) -> { block, violations, reason }. Never throws. */
function check(command, options) {
  if (typeof command !== "string" || command.length === 0) return { block: false, violations: [], reason: "" };
  let violations = [];
  try {
    if (command.length > MAX_LEN) throw new ParseError("command too long");
    OUTER_SUB = pickMarker(command);
    work = 0;
    deadline = Date.now() + (options && typeof options.budgetMs === "number" ? options.budgetMs : DEFAULT_BUDGET_MS);
    scan(command, 0, violations);
  } catch (error) {
    violations = [];
    // The plain-text signal also reads through quotes and backslashes in the name (r""ig, r\ig, 'r'ig), which the shell removes before it runs rig.
    if ((command.includes("`") || command.includes("$(")) && (FALLBACK_RE.test(command) || FALLBACK_RE.test(command.replace(/["'\\]/g, "")))) {
      violations.push({ kind: "unparseable", command: null });
    }
  }
  deadline = Infinity;
  if (violations.length === 0) return { block: false, violations, reason: "" };
  return { block: true, violations, reason: refusal(violations) };
}

function refusal(violations) {
  const first = violations[0];
  const cmd = first.command ? `rig ${first.command}` : "a rig command";
  const spec = first.command && MESSAGE_COMMANDS[first.command];
  const why = {
    substitution: `this command puts a command substitution (backticks or $(...)) inside double quotes, or unquoted, in the text of ${cmd}`,
    heredoc: `this command feeds ${cmd} from an UNQUOTED here-document (<<EOF) whose body contains a command substitution (backticks or $(...))`,
    "here-string": `this command feeds ${cmd} from a here-string (<<<) holding a command substitution (backticks or $(...))`,
    "pipe-producer": `this command pipes echo/printf with a command substitution (backticks or $(...)) in its text into ${cmd}`,
    unparseable: `this command mentions ${cmd} with backticks or $(...) and could not be read as shell syntax (an unterminated quote or $( ?)`,
  }[first.kind];
  const lines = [
    "rig-body-guard BLOCKED this command before it ran. Nothing was executed.",
    `Why: ${why}. The shell runs a command substitution BEFORE rig starts, so it would execute on this host and its output would replace your text (a double-quoted message once ran \`rig down\`, another ran an unbounded test run in a repository).`,
    "Fix: put the text in a quoted here-document so it reaches rig literally: " +
      (spec && spec.stdin ? `rig ${first.command} ... ${spec.stdin}` : "rig send <session> --file - <<'EOF'") +
      "\n<your text, backticks and $(...) included>\nEOF\n" +
      "The quotes around 'EOF' are what stop the shell from expanding the text. Equivalent: --file <path> (write the file first), or single quotes for a short plain body that holds no single quote.",
  ];
  lines.push("The flag is --file - <<'EOF' for rig send and --body-file - <<'EOF' for rig queue create/update/handoff.");
  if (spec && !spec.stdin) lines.push(`rig ${first.command} has no --file option: send the text with \`rig send <session> --file - <<'EOF'\`, or put it in single quotes.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Claude Code PreToolUse hook entry: JSON event on stdin, JSON decision on stdout.

function hookDecision(rawInput) {
  let event;
  try { event = JSON.parse(rawInput); } catch { return { output: null, note: "rig-body-guard: hook input is not JSON; allowed" }; }
  const command = event && typeof event === "object" && event.tool_input && typeof event.tool_input.command === "string" ? event.tool_input.command : null;
  if (command === null) return { output: null, note: "rig-body-guard: no Bash command in the hook input; allowed" };
  const verdict = check(command);
  if (!verdict.block) return { output: null, note: null };
  return {
    output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } },
    note: null,
  };
}

function main() {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => {
    const decision = hookDecision(data);
    if (decision.note) process.stderr.write(decision.note + "\n");
    if (decision.output) process.stdout.write(JSON.stringify(decision.output) + "\n");
    process.exitCode = 0;
  });
}

if (require.main === module) main();

module.exports = { check, hookDecision, refusal, lex, bodyExpands, maskPieces, MESSAGE_COMMANDS, FLAG_COMMANDS };
