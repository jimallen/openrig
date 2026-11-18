#!/usr/bin/env node
"use strict";

// OF-249: refuse, BEFORE it runs, a shell command that puts a command substitution into the text a
// `rig` command will carry (rig send "...`cmd`...", rig queue create --body "$(cmd)", an unquoted
// here-document with $(...) in it). The shell executes a substitution before `rig` starts, so nothing
// inside rig can stop it: the only place to stop it is the agent harness, before the shell sees the
// command. Two harnesses use this one file:
//   - Claude Code: a PreToolUse hook on Bash (hooks/claude.json runs this file; main() below), and on Code Mode's REPL tool, whose
//     JavaScript it reads (workspaces-o9o.131, "REPL code" below).
//     The Claude hook (hookDecision) also runs the background-job guard (checkBackground); Pi does not.
//   - Pi: pi/rig-body-guard.cjs (a Pi extension) requires this file and refuses on its tool_call event.
//
// It reads the SHELL STRUCTURE, not the raw text: a backtick inside single quotes, inside a quoted
// here-document (<<'EOF'), in a file given with --file, or in a comment is not a substitution and is
// allowed. The lexer is a port of the ideas in ~/.agents/scripts/bash-guard (quote-aware matching of
// $(...) and `...`, here-document bodies read at the newline), narrowed to this one question.
//
// workspaces-o9o.108 adds a second rule on the same shared path (Claude and Pi): a kill that is not by PID (pkill -f / with a pattern,
// killall, kill of a process group, kill of what pgrep selects) is refused; see "Broad kills".
//
// FAIL-CLOSED / FAIL-OPEN (decided, OF-249):
//   - A command that does not mention a guarded rig command, or a broad kill (o9o.108, see "Broad kills" below), is never refused, whatever the parser does.
//   - A command the guard cannot ANALYSE (unterminated quote or $( , nested past MAX_DEPTH, over the length, mask or work-budget bounds,
//     internal error) is refused when it contains a backtick or `$(` ANYWHERE, with no look for the word rig: every spelling check of the name
//     was bypassed by another way to write it (OF-251 re-review rounds 1 to 3). Only pathological or unparseable inputs get here, so the
//     over-refusal is accepted; a command with no backtick and no `$(` is allowed.
//   - Hook input that cannot be read at all (not JSON, no command) is allowed with a note on stderr:
//     a hook that wedges every Bash call would also block the `rig send` that reports the fault.
//
// THREAT MODEL (OF-251): this guard stops ACCIDENTAL shell expansion in message bodies. It is not a sandbox against a deliberately obfuscated
// command: whoever can write a command can run the substitution without rig at all.
//
// Covered since OF-264 (the name of a rig command assembled at run time): `rig${IFS}send`, `R=rig; $R send` (plain assignments in the same command, every reading
// tried; an unknown variable directly before a guarded rig command word is an unknown prefix), ANSI-C quoting of the name or subcommand ($'\x72ig'), $"rig", and
// `script -c "<script>"` in the spellings -c, -qc, -cSCRIPT, --command SCRIPT and --command=SCRIPT (known gaps: a getopt abbreviation such as --comm=SCRIPT, and a repeated -c, where util-linux runs the LAST one and this reads the first). Refused only when the same command carries a live substitution in
// the guarded text, as for a plain `rig`; the bounds are in the constants above resolve().
//
// Not covered (residual, documented in the OF-249 report): `eval "$x"` where the text is built elsewhere, a shell function or positional parameter that carries
// the text, globs and brace expansion that spell the name (./r?g, r{i,}g), a variable set outside the command (`export R=rig` in an earlier command) used
// anywhere but directly before a guarded rig command word, a file written with an unquoted here-document and sent in a later command,
// text typed into a pane that does not start with a guarded rig command, python/node -e shelling out, aliases.
// Residuals recorded by the OF-258/264/265 review (not fixed): a newline in text typed into a pane is not read as a separator (a second line that starts with a rig command
// is not judged; widening it would refuse prose whose second line starts with `rig send` and a substitution); a default holding a nested expansion
// (`${V:-$HOME/bin/rig}`, `${V:-path/rig}`) and a variable-held rig name behind xargs or `find -exec` are not modelled.

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

const PARAM_START_RE = /^[A-Za-z_0-9@*#?!-]$/;

/** The text of the body of an ANSI-C quoted string $'...' with its escapes decoded (OF-264). An unknown escape stays as written. */
function ansiC(body) {
  const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  const n = body.length;
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = body[i];
    if (c !== "\\" || i + 1 >= n) { out += c; continue; }
    const d = body[++i];
    let m;
    if (Object.prototype.hasOwnProperty.call(simple, d)) out += simple[d];
    else if (d >= "0" && d <= "7" && (m = /^[0-7]{1,3}/.exec(body.slice(i)))) { out += String.fromCharCode(parseInt(m[0], 8) & 255); i += m[0].length - 1; }
    else if (d === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; }
    else if ((d === "u" || d === "U") && (m = new RegExp("^[0-9a-fA-F]{1," + (d === "u" ? 4 : 8) + "}").exec(body.slice(i + 1)))) { const cp = parseInt(m[0], 16); out += cp <= 0x10ffff ? String.fromCodePoint(cp) : ""; i += m[0].length; }
    else if (d === "c" && i + 1 < n) { out += String.fromCharCode(body.charCodeAt(++i) & 31); }
    else out += "\\" + d;
  }
  return out;
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
  let param = false;                                  // OF-264: a parameter expansion ($R, ${IFS}) outside single quotes is in the text, kept unexpanded
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
          param = true;
          text += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (d === "$" && PARAM_START_RE.test(src[i + 1] || "")) param = true;
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
        param = true;
        text += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (src[i + 1] === "'") {
        quoted = true;
        let j = i + 2;
        while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
        if (j >= n) throw new ParseError("unterminated $'");
        text += ansiC(src.slice(i + 2, j));          // OF-264: $'\x72ig' is the word rig
        i = j + 1;
        continue;
      }
      if (src[i + 1] === '"') { i++; continue; }      // OF-264: $"rig" (locale string) is "rig"
      if (PARAM_START_RE.test(src[i + 1] || "")) param = true;
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
  return { word: { text, expands: expands || text.includes(OUTER_SUB), quoted, param, subs, marks, raw: src.slice(start, i) }, next: i };
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

// OF-264: a command NAME assembled at run time. The shell expands a parameter in the name (`R=rig; $R send`, `rig${IFS}send`) before it runs, and
// the guard reads the text before that, so it follows the plain-assignment forms it can see in the same command (flat, in order of appearance and
// not scope-aware, which fails closed) and the IFS spelling of a space. A name it cannot resolve (`$R` set outside the command) is an unknown prefix,
// handled like the `$(command -v rig)` prefix: it counts as rig only when the next word is a guarded rig command. Cost is bounded by the constants below.
const ASSIGN_MAX_VALUES = 8;          // alternatives kept per variable
const ASSIGN_MAX_LEN = 512;
const NAME_MAX_COMBOS = 16;           // alternatives tried per command name word
const NAME_MAX_LEN = 4096;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const UNKNOWN = "\u0001";
let ASSIGNS = new Map();
// o9o.108 review: variables assigned in the same command from a substitution that selects pids by pattern (`pids=$(pgrep -f x); kill $pids`). Flat like ASSIGNS.
let PATTERN_VARS = new Set();

/** Record the plain NAME=value assignments of these commands (also after export / declare / local / readonly). */
function collectAssigns(cmds) {
  for (const c of cmds) {
    tick();
    let k = 0;
    if (c.words.length && DECLARERS.has(c.words[0].text)) { k = 1; while (k < c.words.length && c.words[k].text.startsWith("-")) k++; }
    for (; k < c.words.length && ASSIGN_RE.test(c.words[k].text); k++) {
      const w = c.words[k];
      const eq = w.text.indexOf("=");
      if (w.expands && w.text[eq - 1] !== "+" && (w.subs || []).some(selectsByPattern)) PATTERN_VARS.add(w.text.slice(0, eq));
      if (w.expands || w.param || w.text[eq - 1] === "+") continue;
      const name = w.text.slice(0, eq);
      const value = w.text.slice(eq + 1);
      if (value.length > ASSIGN_MAX_LEN) continue;
      const list = ASSIGNS.get(name) || [];
      if (!list.includes(value)) { if (list.length >= ASSIGN_MAX_VALUES) throw new ParseError("too many values assigned to one variable"); list.push(value); }
      ASSIGNS.set(name, list);
    }
  }
}

/** The ways a command-name word with a parameter expansion can read after the shell expands it: arrays of tokens (split on whitespace), or null when it holds no parameter. Too long or too many readings is a ParseError (refused where the command holds a substitution). */
function nameCandidates(w) {
  if (!w.param || w.expands) return null;
  if (w.text.length > NAME_MAX_LEN) throw new ParseError("command name word too long");
  let t = w.text.replace(/\$\{IFS[^}]*\}|\$IFS/g, " ").replace(/\$\{\d\}|\$\d/g, (m, off, all) => (all.length === m.length ? UNKNOWN : ""));
  t = t.replace(/\$\{([A-Za-z_]\w*):?-([^}$]*)\}/g, (m, name, dflt) => ((ASSIGNS.has(name) ? "" : dflt) || UNKNOWN));
  const names = [...new Set([...t.matchAll(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g)].map((m) => m[1] || m[2]))];
  let combos = [t];
  for (const name of names) {
    const values = ASSIGNS.get(name) || [UNKNOWN];
    const re = new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])", "g");
    const next = [];
    for (const base of combos) for (const v of values) { tick(); next.push(base.replace(re, () => v)); if (next.length > NAME_MAX_COMBOS) throw new ParseError("command name word has too many readings"); }
    combos = next;
  }
  return combos.map((c) => c.split(/\s+/).filter(Boolean));
}

const synthetic = (text) => ({ text, expands: false, quoted: false, param: false, subs: [], marks: [], raw: text });

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
    if (words[k].param) {
      const cands = nameCandidates(words[k]);
      if (cands) {
        const known = cands.filter((tokens) => tokens.length === 0 || !tokens[0].includes(UNKNOWN));
        const asRig = known.find((tokens) => tokens.length > 0 && baseName(tokens[0]) === "rig");
        if (asRig) return done({ name: "rig", args: [...asRig.slice(1).map(synthetic), ...words.slice(k + 1)] });
        if (cands.some((tokens) => tokens.length === 1 && tokens[0] === UNKNOWN) && k + 1 < words.length && !words[k + 1].expands
            && (Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, words[k + 1].text) || Object.prototype.hasOwnProperty.call(FLAG_COMMANDS, words[k + 1].text))) {
          return done({ name: "rig", args: words.slice(k + 1) });
        }
        if (known.length === 1 && cands.length === 1) { words = [...words.slice(0, k), ...known[0].map(synthetic), ...words.slice(k + 1)]; continue; }
      }
    }
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
      if (name === "env" && (t === "-S" || t === "--split-string" || /^-[A-Za-z]+S$/.test(t)) && k + 1 < words.length) { scripts.push(words[k + 1]); k += 2; continue; }
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

// ---------------------------------------------------------------------------------------------
// Broad kills (workspaces-o9o.108)
//
// Every seat on a host runs as the same user, so a kill chosen by name, pattern or process group stops other seats' processes too:
// on 2026-11-17 at 17:28:56Z a seat ran `pkill -f 'unittest discover -s Tests/ScriptTests'` to stop its own run and stopped four other
// seats' runs. These rules ride the same traversal as the rig rules (wrappers, sh -c / eval / ssh, substitutions, stdin scripts), so
// quoting or a wrapper the guard reads cannot hide them, and text that only mentions a kill (echo, grep, a commit message) is not one.
// Refused: pkill -f / --full; pkill with a name pattern or an owner, group or session selector; killall (except listing or help);
// kill of a negative pid, -1 or 0 (a process group, or every process of the user); kill of what pgrep or pidof selects
// (`kill $(pgrep -f x)`, `pgrep -f x | xargs kill`), also through a variable assigned in the same command (`pids=$(pgrep -f x); kill $pids`, `pid=-1; kill -9 $pid`). Allowed: kill <pid>, kill %job, kill -l, pkill anchored to a pidfile (-F) or to
// literal parent pids (-P <pid>), pkill/killall help and listing. Ported from ~/.agents/scripts/bash-guard (pkill_verdict).
const KILLERS = new Set(["pkill", "killall", "kill"]);
const PKILL_VALUED_SHORT = new Set("PgGstuUFs".split(""));
const PKILL_VALUED_LONG = new Set(["--parent", "--pgroup", "--group", "--session", "--terminal", "--euid", "--uid", "--pidfile", "--signal", "--ns", "--nslist", "--cgroup"]);
const PID_LIST_RE = /^(?:[0-9]+(?:,[0-9]+)*|\$\$|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/;
const PKILL_SIGNAL_RE = /^(?:(?:SIG)?[A-Z][A-Z0-9+]+|[0-9]+)$/;

/** pkill's (and pgrep's) selection: null when anchored to pids or only asking for help, else "pkill-f" or "pkill". */
function pkillVerdict(args) {
  let full = false, pattern = false, anchored = false, helpOnly = false, seenDd = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!seenDd && t === "--") { seenDd = true; continue; }
    if (!seenDd && t.startsWith("--")) {
      const key = t.split("=", 1)[0];
      if (key === "--full") full = true;
      else if (key === "--help" || key === "--version" || key === "--list-name") helpOnly = true;
      else if (key === "--pidfile") anchored = true;
      else if (key === "--parent") { const v = t.includes("=") ? t.slice(t.indexOf("=") + 1) : (args[i + 1] || ""); anchored = anchored || PID_LIST_RE.test(v); }
      if (PKILL_VALUED_LONG.has(key) && !t.includes("=")) i++;
      continue;
    }
    if (!seenDd && t.startsWith("-") && t.length > 1) {
      const letters = t.slice(1);
      if (PKILL_SIGNAL_RE.test(letters)) continue;                 // -9, -TERM, -SIGKILL
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        if (ch === "f") full = true;
        else if (ch === "l" || ch === "h" || ch === "V") helpOnly = true;
        if (PKILL_VALUED_SHORT.has(ch)) {
          const val = letters.slice(k + 1) || (args[i + 1] || "");
          if (ch === "F") anchored = true;
          else if (ch === "P") anchored = anchored || PID_LIST_RE.test(val);
          if (!letters.slice(k + 1)) i++;
          break;
        }
      }
      continue;
    }
    pattern = true;
  }
  if (helpOnly && !full && !pattern) return null;
  if (full) return "pkill-f";
  if (pattern) return "pkill";
  if (args.length === 0) return null;                             // bare pkill: a usage error, kills nothing
  return anchored ? null : "pkill";
}

/** True when a command substitution's text selects processes by name or pattern (pgrep that is not anchored, or pidof). */
function selectsByPattern(subText) {
  let cmds;
  try { cmds = lex(subText).cmds; } catch { return /(?:^|[^\w./-])(?:pgrep|pidof)(?![\w-])/.test(subText); }
  return cmds.some((c) => {
    const res = resolve(c.words);
    if (!res) return false;
    if (res.name === "pidof") return true;
    return res.name === "pgrep" && pkillVerdict(res.args.map((a) => a.text)) !== null;
  });
}

/** The variable name when a word is exactly one parameter ($p, ${p}, "$p"), else null. */
function soleVar(w) {
  if (!w || !w.param || w.expands) return null;
  const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(w.text);
  return m ? m[1] || m[2] : null;
}

/** The values a one-variable word takes from plain assignments in this same command, or null when it is not one or none is known (carried-in values stay allowed). */
function varValues(w) {
  const name = soleVar(w);
  return name && ASSIGNS.has(name) ? ASSIGNS.get(name) : null;
}

/** The broad-kill violations of one resolved simple command ({ name, args }). */
function killViolations(res) {
  if (!res || !KILLERS.has(res.name)) return [];
  const texts = res.args.map((a) => a.text);
  if (res.name === "pkill") { const v = pkillVerdict(texts); return v ? [{ kind: v, command: "pkill" }] : []; }
  if (res.name === "killall") {
    if (texts.length === 0 || texts.every((t) => ["-l", "-h", "--help", "-V", "--version", "--list"].includes(t))) return [];
    return [{ kind: "killall", command: "killall" }];
  }
  // kill: the first -X is the signal (or -s/-n with a value); -l/-L list signals. Then the targets.
  // A word that is one variable assigned in this same command reads as its values (o9o.108 review): `pid=-1; kill -9 "$pid"` is `kill -9 -1`.
  let i = 0;
  let signal = false;
  for (; i < res.args.length; i++) {
    const t = texts[i];
    if (t === "--") { i++; break; }
    if (t === "-l" || t === "-L" || t === "--list" || t === "--table") return [];
    if (t === "-s" || t === "-n" || t === "--signal") { signal = true; i++; continue; }
    if (!signal && t.startsWith("-") && t.length > 1) { signal = true; continue; }
    // `sig=-9; kill $sig 4242`: a variable read as a signal only when a target follows it; alone (`pid=-4242; kill "$pid"`) it is judged as a target (fails closed)
    const vals = !signal && i + 1 < res.args.length ? varValues(res.args[i]) : null;
    if (vals && vals.every((v) => v.startsWith("-") && v.length > 1)) { signal = true; continue; }
    break;
  }
  for (const w of res.args.slice(i)) {
    if (w.text.startsWith("-") || w.text === "0") return [{ kind: "kill-group", command: "kill" }];
    if (w.expands && (w.subs || []).some(selectsByPattern)) return [{ kind: "kill-pattern", command: "kill" }];
    const name = soleVar(w);
    if (name && PATTERN_VARS.has(name)) return [{ kind: "kill-pattern", command: "kill" }];
    const vals = varValues(w);
    if (vals && vals.some((v) => v.trim().startsWith("-") || /^\s*0(?:\s|$)/.test(v) || /\s(?:-|0(?:\s|$))/.test(v))) return [{ kind: "kill-group", command: "kill" }];
  }
  return [];
}

/** A pgrep that selects by pattern (or pidof) feeding a later `xargs ... kill` in the same pipeline. */
function selectsForXargs(res) {
  if (!res) return false;
  if (res.name === "pidof") return true;
  return res.name === "pgrep" && pkillVerdict(res.args.map((a) => a.text)) !== null;
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
  collectAssigns(cmds);
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
    tick();
    scanStdinScript(cmds[j], depth, out);                          // cat <<EOF | sh
    const res = resolved[j];
    if (!res || !PRODUCERS.has(res.name)) continue;
    let words = res.args;
    while (words.length && /^-[neE]+$/.test(words[0].text)) words = words.slice(1);
    // A printf format and its arguments are the produced text together (`printf 'rig send s %s\\n' "$(id)" | sh`): all of the words are scanned as the script.
    if (words.length) scanScriptWords(words, depth, out);
  }
}

/** The script word of a util-linux `script` command line (-c SCRIPT, -qc SCRIPT, -cSCRIPT, --command SCRIPT, --command=SCRIPT), or null. */
function scriptCommand(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") return null;
    if (t === "--command") return args[i + 1] || null;
    if (t.startsWith("--command=")) return subWord(args[i], 10);
    const m = /^-[a-zA-Z]*?c/.exec(t);
    if (m && !t.startsWith("--")) return t.length > m[0].length ? subWord(args[i], m[0].length) : (args[i + 1] || null);
  }
  return null;
}

// OF-265 review F2: the tmux subcommands that type text into a pane or run a shell command, with their aliases (tmux 3.4 `list-commands`, measured on Sparky in a
// private socket; the rest only display or store text and stay as they were at base: display-message, set-buffer, set-option, ...).
const TMUX_TEXT_COMMANDS = new Set([
  "send-keys", "send", "run-shell", "run", "new-window", "neww", "split-window", "splitw", "new-session", "new", "respawn-pane", "respawnp",
  "respawn-window", "respawnw", "if-shell", "if", "pipe-pane", "pipep", "display-popup", "popup",
]);
const TMUX_VALUED = new Set(["-L", "-S", "-f", "-c", "-T"]);

/** The tmux subcommand of an argument list: the first word that is not an option or an option's value. */
function tmuxSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t.startsWith("-") && t.length > 1) { if (TMUX_VALUED.has(t)) i++; continue; }
    return t;
  }
  return "";
}

function scanPipeline(cmds, resolved, from, to, depth, out) {
  let message = null;
  let patternFeed = false;      // an earlier command of this pipeline selects pids by pattern (pgrep -f x | xargs kill)
  let producersDone = from;     // commands [from, producersDone) were already scanned as a stdin shell's producers: each is read once per pipeline (linear, not per shell)
  const producers = (i) => { scanPipeProducers(cmds, resolved, producersDone, i, depth, out); if (i > producersDone) producersDone = i; };
  for (let i = from; i < to; i++) {
    tick();
    const res = resolved[i];
    if (!res) continue;
    if (res.scripts) for (const sw of res.scripts) scanScriptWords([sw], depth, out);
    for (const v of killViolations(res)) out.push(v);
    if (patternFeed && (res.name === "xargs" || res.name === "parallel") && res.args.some((a) => !a.expands && baseName(a.text) === "kill")) {
      out.push({ kind: "kill-pattern", command: "kill" });
    }
    if (selectsForXargs(res)) patternFeed = true;
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
      } else if (STDIN_SHELLS.has(res.name) && (res.args.every((a) => a.text.startsWith("-")) || res.args.some((a) => a.text === "-s" || a.text === "/dev/stdin"))) {
        scanStdinScript(cmds[i], depth, out);        // bash <<'EOF' ... EOF / bash <<< '...' / bash /dev/stdin: the text is the script
        producers(i);
      } else handled = false;
    } else if (res.name === "eval") {
      scanScriptWords(res.args, depth, out);
    } else if (res.name === "watch") {
      let k = 0;                                      // watch joins its words and runs them with sh -c
      while (k < res.args.length && res.args[k].text.startsWith("-")) k += (res.args[k].text === "-n" || res.args[k].text === "--interval") ? 2 : 1;
      if (k < res.args.length) scanScriptWords(res.args.slice(k), depth, out);
    } else if (res.name === "script" && scriptCommand(res.args)) {
      scanScriptWords([scriptCommand(res.args)], depth, out);   // util-linux script -c "<script>", -qc, -c"<script>", --command[=]"<script>" (OF-264)
    } else if ((res.name === "source" || res.name === ".") && res.args.some((a) => a.text === "/dev/stdin")) {
      scanStdinScript(cmds[i], depth, out);                // source /dev/stdin: the pipe or here-document is the script
      producers(i);
    } else if (res.name === "ssh") {
      let k = 0;
      while (k < res.args.length && res.args[k].text.startsWith("-")) k += SSH_VALUED.has(res.args[k].text) ? 2 : 1;
      const remote = res.args.slice(k + 1);                 // after the host
      // ssh host sh / ssh host bash -s: the remote command is a bare shell, which reads its script from the stdin ssh forwards
      const bareShell = remote.length > 0 && STDIN_SHELLS.has(baseName(remote[0].text)) && remote.slice(1).every((a) => a.text.startsWith("-"));
      if (remote.length && !bareShell) scanScriptWords(remote, depth, out);
      else { scanStdinScript(cmds[i], depth, out); producers(i); }   // ssh host <<'EOF' ... EOF, printf ... | ssh host [sh]
    } else handled = false;
    if (!handled && !NON_RUNNERS.has(res.name) && !KILLERS.has(res.name)) {
      // a runner this guard does not model that runs a kill among its arguments (xargs pkill -f, find -exec pkill, docker exec c pkill -f)
      const kj = res.args.findIndex((a) => !a.expands && KILLERS.has(baseName(a.text)));
      if (kj >= 0) for (const v of killViolations({ name: baseName(res.args[kj].text), args: res.args.slice(kj + 1) })) out.push(v);
    }
    if (!handled && !NON_RUNNERS.has(res.name)) {
      // OF-251 review F-1/F-3: a runner this guard does not model (find -exec, parallel, docker exec, script, tmux, ...): `rig <guarded command> ...` among its
      // arguments is judged as if it were run directly, and an argument that is itself a script string naming a guarded rig command is read as shell text
      // (fail closed). tmux send-keys and hc send type into another pane, whose shell expands the text: it is read as shell text by the same rule (OF-265), anchored
      // at a guarded rig command, so prose typed into an agent pane that merely mentions `rig send` is not a script.
      const j = res.args.findIndex((a) => !a.expands && baseName(a.text) === "rig");
      if (j >= 0) {
        const top = topLevel(res.args.slice(j + 1));
        if (top) {
          for (const v of rigViolations(top)) out.push(v);
          if (Object.prototype.hasOwnProperty.call(MESSAGE_COMMANDS, top.name)) message = top.name;
        }
      }
      if (res.name !== "tmux" || TMUX_TEXT_COMMANDS.has(tmuxSubcommand(res.args))) for (const a of res.args) if (/\s/.test(a.text) && SCRIPT_START_RE.test(a.text)) scanScriptWords([a], depth, out);
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

const KILL_FALLBACK_RE = /(?:^|[^\w./-])(?:pkill|killall)(?![\w-])|(?:^|[^\w./-])kill\s+(?:\S+\s+)*?(?:-[0-9]|0(?:\s|$))/;

/** check(command[, { budgetMs }]) -> { block, violations, reason }. Never throws. */
function check(command, options) {
  if (typeof command !== "string" || command.length === 0) return { block: false, violations: [], reason: "" };
  let violations = [];
  try {
    if (command.length > MAX_LEN) throw new ParseError("command too long");
    OUTER_SUB = pickMarker(command);
    work = 0;
    ASSIGNS = new Map();
    PATTERN_VARS = new Set();
    deadline = Date.now() + (options && typeof options.budgetMs === "number" ? options.budgetMs : DEFAULT_BUDGET_MS);
    scan(command, 0, violations);
  } catch (error) {
    violations = [];
    // The guard could not analyse the command (parse error, nesting, size or work budget): refuse ANY command that holds a backtick or `$(`, with no
    // check for the word rig (rounds 1 to 3 of the OF-251 review found a bypass of every spelling match: r$''ig, r"$(:)"ig, ri\<newline>g, ...).
    if (command.includes("`") || command.includes("$(")) {
      violations.push({ kind: "unparseable", command: null });
    }
    // o9o.108: an unreadable command that names pkill or killall, or a kill aimed at a group, is refused too (fail closed).
    if (KILL_FALLBACK_RE.test(command)) violations.push({ kind: "unparseable-kill", command: null });
  }
  deadline = Infinity;
  if (violations.length === 0) return { block: false, violations, reason: "" };
  return { block: true, violations, reason: refusal(violations) };
}

const KILL_KINDS = new Set(["pkill-f", "pkill", "killall", "kill-group", "kill-pattern", "unparseable-kill"]);

function killRefusal(kind) {
  const why = {
    "pkill-f": "`pkill -f` matches its pattern against every process's full command line, so it also stops other seats' processes whose command lines contain the same text",
    pkill: "`pkill` selects by name pattern or by owner, so it stops every matching process on this host, not only the one you started",
    killall: "`killall` stops every process with that name on this host, not the one you started",
    "kill-group": "a negative pid, -1 or 0 signals a whole process group, or every process you own, not one process",
    "kill-pattern": "the pids come from a pattern match (pgrep or pidof), which is `pkill` by another spelling",
    "unparseable-kill": "the guard could not analyse this command, and it names pkill or killall, or a kill aimed at a process group",
  }[kind];
  return [
    "rig-body-guard BLOCKED this command before it ran. Nothing was executed.",
    `Why: ${why}. Every seat on this host runs as the same user, so a kill by name or pattern reaches the other seats too (2026-11-17: a \`pkill -f\` stopped four other seats' test runs).`,
    "Fix: stop by PID. Find it with `pgrep -af '<the exact path or command line you started>'` (or `ps`), confirm each pid is yours (its command line, or its working folder: `readlink /proc/<pid>/cwd`), then `kill <pid>` for each; escalate to `kill -9 <pid>` only if it ignores TERM. For a run you started in the background, stop it by its own pid.",
  ].join("\n");
}

function refusal(violations) {
  const first = violations[0];
  if (KILL_KINDS.has(first.kind)) return killRefusal(first.kind);
  const cmd = first.command ? `rig ${first.command}` : "a rig command";
  const spec = first.command && MESSAGE_COMMANDS[first.command];
  const why = {
    substitution: `this command puts a command substitution (backticks or $(...)) inside double quotes, or unquoted, in the text of ${cmd}`,
    heredoc: `this command feeds ${cmd} from an UNQUOTED here-document (<<EOF) whose body contains a command substitution (backticks or $(...))`,
    "here-string": `this command feeds ${cmd} from a here-string (<<<) holding a command substitution (backticks or $(...))`,
    "pipe-producer": `this command pipes echo/printf with a command substitution (backticks or $(...)) in its text into ${cmd}`,
    unparseable: `the guard could not analyse this command (an unterminated quote or $( , nesting deeper than it reads, a very large command, or too much work) and it contains a command substitution (backticks or $(...)): rewrite it without command substitutions, or put the text in a file and send it with --file`,
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
// The background-job guard (Claude Code only: hookDecision runs it, check() and the Pi extension do not).
//
// A shell background job started inside a FOREGROUND Bash call (`( swift test ...; echo rc=$? ) > log 2>&1 &`, `nohup x &`) leaves the
// harness nothing to wake the seat when the job ends, and the seat sits idle (eztrack build-impl2, 2026-11-15, ~40 min). The Bash tool's
// run_in_background: true re-invokes the agent when the command exits, so the guard refuses the shell form and names that one instead.
// It rides in this file, not a sibling script, so a Bash call still starts one node process for both checks.
//
// Refused, when tool_input.run_in_background is not true:
//   - a control operator `&` at the top level of the command (the lexer reads `&&`, `&>`, `&>>`, `>&`, `<&`, `|&` and `2>&1` as the operators
//     or redirections they are, and skips quotes, here-document bodies, comments and substitution bodies) with no `wait` command after the last one;
//   - nohup, disown or setsid as the command word of a simple command (after assignments, keywords and wrappers such as nice or env).
// FAIL-OPEN: a command the lexer cannot read, one with `((` arithmetic, or an unclosed `[[` before the `&`, is allowed. A false refusal blocks
// real work; a miss costs idle time. Not seen: a `&` inside `bash -c '...'`, eval, `$( ... & )` or a script file.

const DETACHERS = new Set(["nohup", "disown", "setsid"]);

/** True when the simple command runs nohup, disown or setsid: its command word, or the program a wrapper (nice, env, sudo, ...) runs. */
function runsDetacher(words) {
  let k = 0;
  while (k < words.length && !words[k].quoted && (ASSIGN_RE.test(words[k].text) || KEYWORDS.has(words[k].text))) k++;
  for (let guard = 0; guard < 16 && k < words.length; guard++) {
    if (words[k].expands || words[k].param) return false;
    const name = baseName(words[k].text);
    if (DETACHERS.has(name)) return true;
    const w = WRAPPERS[name];
    if (!w) return false;
    k++;
    let skip = w[1];
    while (k < words.length) {
      const t = words[k].text;
      if (t === "--") { k++; break; }
      if (t.startsWith("-") && t.length > 1) { k += w[0].has(t) ? 2 : 1; continue; }
      if (name === "env" && ASSIGN_RE.test(t)) { k++; continue; }
      if (skip > 0) { skip--; k++; continue; }
      break;
    }
  }
  return false;
}

/** The first non-assignment, non-keyword word of a simple command, or "". */
function firstWord(words) {
  let k = 0;
  while (k < words.length && !words[k].quoted && (ASSIGN_RE.test(words[k].text) || KEYWORDS.has(words[k].text))) k++;
  return k < words.length ? words[k].text : "";
}

/** checkBackground(command[, { budgetMs }]) -> { block, kind, reason }. kind is "ampersand" or "detach". Never throws; fails open. */
function checkBackground(command, options) {
  const allow = { block: false, kind: null, reason: "" };
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_LEN) return allow;
  if (!command.includes("&") && !/nohup|disown|setsid/.test(command)) return allow;
  let cmds;
  try {
    OUTER_SUB = pickMarker(command);
    work = 0;
    deadline = Date.now() + (options && typeof options.budgetMs === "number" ? options.budgetMs : DEFAULT_BUDGET_MS);
    cmds = lex(command).cmds;
  } catch {
    return allow;
  } finally {
    deadline = Infinity;
  }
  if (cmds.some((c) => runsDetacher(c.words))) return { block: true, kind: "detach", reason: backgroundRefusal("detach") };
  let last = -1;
  cmds.forEach((c, i) => { if (c.sep === "&") last = i; });
  if (last < 0) return allow;
  // `((` is arithmetic (`(( a & b ))`), which the lexer reads as two subshells: ambiguous, allow. `$((` is read inside a word and is fine.
  if (/(?:^|[^$])\(\(/.test(command)) return allow;
  for (let i = 0; i <= last; i++) {
    const c = cmds[i];
    if (c.sep !== "&") continue;
    const texts = c.words.map((w) => (w.quoted ? "" : w.text));
    if (texts.lastIndexOf("[[") > texts.lastIndexOf("]]")) return allow;   // `&` inside [[ ... ]]: not a job
  }
  for (let i = last + 1; i < cmds.length; i++) if (baseName(firstWord(cmds[i].words)) === "wait") return allow;
  return { block: true, kind: "ampersand", reason: backgroundRefusal("ampersand") };
}

function backgroundRefusal(kind) {
  const what = kind === "detach"
    ? "it uses nohup, disown or setsid to detach a job"
    : "it starts a shell background job with `&` and does not `wait` for it";
  return [
    `bg-job-guard BLOCKED this command before it ran. Nothing was executed. Why: ${what}, so nothing wakes you when the job ends.`,
    "Fix: run the command in the foreground form (no `&`, nohup, disown or setsid) with the Bash tool's run_in_background: true; you are re-invoked when it exits. To watch its output while it runs, use Monitor. If this call should block until the jobs finish, end it with `wait`.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Claude Code PreToolUse hook entry: JSON event on stdin, JSON decision on stdout.

// ---------------------------------------------------------------------------------------------
// REPL code (workspaces-o9o.131)
//
// In Claude Code's Code Mode each piece of code reaches PreToolUse as tool_name "REPL" with the JavaScript in tool_input.code (measured on
// Claude Code 2.1.327). Its shell calls arrive separately as Bash and are checked as before; the code is checked here:
//   - every string and template literal in it is judged by the Bash rules above (rig send bodies, broad kills): code builds the commands
//     it hands to the shell tool as strings. A `${...}` in a template reads as an unknown value ($OPENRIG_JS_EXPR), as a shell variable would;
//   - code that names child_process, process.binding, process.dlopen or a Function-constructor chain is refused: those reach the host
//     outside the tool calls this guard checks.
// Claude Code itself refuses module loading in REPL code (measured: "the vm context is sealed"). This is defence in depth over that
// refusal, NOT a sandbox: a name assembled at run time (globalThis["child_" + "process"]) is not seen here. Comments are skipped. Code this
// reader cannot follow (an unterminated literal) is refused when it carries a risk signal, and allowed otherwise, like check()'s rule.

// The API rules run on a NORMALISED projection of the code (apiScanText), where every property access is written as a dotted member
// chain — `x["binding"]`, `x?.binding`, `x[("binding")]`, `globalThis["process"]["binding"]` all fold to `...process.binding` — escapes
// are decoded, optional chaining is flattened, and parentheses are dropped. The rules are REFERENCE-based (CoS ruling, o9o.131 round 2),
// not call-shape based: ANY reference to the global `Function` value is refused however used (bare, `typeof`, via globalThis/self/window,
// an alias even if unused, `.call`/`.apply`/`.bind`, `Reflect.construct(Function, …)`), as is ANY `.constructor` access, and
// `process.binding`/`process.dlopen` in any spelling. String CONTENTS are not scanned (a log line naming one is not a refusal), except a
// module specifier, so `require("child_process")` is still caught. A name assembled at run time (globalThis["child_"+"process"]) stays a residual.
const REPL_API_RULES = [
  { re: /child_process/, name: "child_process" },
  { re: /\bprocess\s*\.\s*binding\b/, name: "process.binding" },
  { re: /\bprocess\s*\.\s*dlopen\b/, name: "process.dlopen" },
  { re: /\.\s*constructor\b/, name: "a .constructor access (reaches the Function constructor)" },
  { re: /\bFunction\b/, name: "the Function constructor" },
];
const REPL_RISK_RE = /\b(?:rig|pkill|killall|kill)\b|child_process|constructor|\bFunction\b|\bprocess\b|\bglobalThis\b|\bself\b|\bwindow\b|\bReflect\b|\brequire\b|\bimport\b/;
const JS_EXPR = "$OPENRIG_JS_EXPR";

/** Decode the \uXXXX, \u{XXXX} and \xXX escapes that spell identifier characters (process -> process, binding -> binding). */
function decodeIdentEscapes(s) {
  const cp = (h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } };
  return s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => cp(h))
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => cp(h))
          .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => cp(h));
}

/** The code normalised for the API scan: property access folded to dotted member chains, identifier escapes decoded, optional chaining
 *  flattened, regex literals and comments blanked, and string contents blanked EXCEPT a module specifier. `ok: false` on an unterminated
 *  literal or comment (the caller then takes the fail-closed path). A template's ${...} expressions are normalised in place. */
function apiScanText(code) {
  let out = "";
  let i = 0;
  let prev = "";
  const regexAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  // Whether out's tail is a module-specifier position: require( / import( / ... from
  const specifierHere = () => /(?:\brequire|\bimport)\s*\(\s*$/.test(out) || /(?:\bfrom|\bimport)\s*$/.test(out);
  while (i < code.length) {
    tick();
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); i = e < 0 ? code.length : e; out += " "; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); if (e < 0) return { ok: false, text: out }; i = e + 2; out += " "; continue; }
    if (c === "/" && (regexAfter.has(prev) || /\b(?:return|typeof|case|in|of)$/.test(out.trimEnd()))) {
      let j = i + 1; let cls = false;
      for (; j < code.length; j++) {
        if (code[j] === "\\") { j++; continue; }
        if (code[j] === "\n") return { ok: false, text: out };
        if (code[j] === "[") cls = true; else if (code[j] === "]") cls = false;
        else if (code[j] === "/" && !cls) break;
      }
      if (j >= code.length) return { ok: false, text: out };
      i = j + 1; while (i < code.length && /[a-z]/i.test(code[i])) i++;
      out += " "; prev = "x"; continue;
    }
    if (c === "?" && code[i + 1] === ".") {
      // Optional chaining. `?.[` / `?.(` are a bracket access / call: drop the `?.` so the member folds the same as a plain `[`;
      // `?.name` is a member access: emit the dot.
      const after = code[i + 2];
      if (after === "[" || after === "(") { i += 2; continue; }
      out += "."; i += 2; prev = "."; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const lit = readStringOrTemplate(code, i);
      if (!lit) return { ok: false, text: out };
      // A computed member key: `X[ "name" ]`, or a parenthesised key `X[ ("name") ]` / `X?.[ ("name") ]`, the string the sole content of
      // the brackets with no interpolation. The parens before the string and the `)` after it are tolerated and dropped in the fold.
      let nextSig = lit.end; while (nextSig < code.length && (/\s/.test(code[nextSig]) || code[nextSig] === ")")) nextSig++;
      const openKey = /\[\s*\(*\s*$/.test(out.replace(/\s+$/, ""));   // out tail is `[` or `[(` (any depth of parens)
      if (openKey && code[nextSig] === "]" && !lit.hasExpr) {
        out = out.replace(/\s+$/, "").replace(/\[\s*\(*\s*$/, "");     // drop the opening bracket and any `(` we already wrote
        out += "." + lit.raw;                                          // fold to a dotted member (escapes decoded at the end)
        i = nextSig + 1; prev = "x"; continue;
      }
      if (specifierHere() && !lit.hasExpr) { out += ` ${lit.raw} `; i = lit.end; prev = "x"; continue; }  // module specifier: kept
      // An ordinary string/template: contents blanked; a template's ${...} expressions are normalised in place so code inside them is scanned.
      out += ` ${lit.exprText} `; i = lit.end; prev = "x"; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? "x" : c;
    i++;
  }
  return { ok: true, text: decodeIdentEscapes(out) };
}

/** Read a string ('...', "...") or template (`...`) from its opening quote. Returns the raw inner text (for a simple key/specifier),
 *  whether it holds a ${...} expression, the normalised text of those expressions (string parts blanked), and where it ends. */
function readStringOrTemplate(code, start) {
  const q = code[start];
  if (q !== "`") {
    let j = start + 1; let raw = "";
    for (; j < code.length && code[j] !== q; j++) {
      if (code[j] === "\n") return null;
      if (code[j] === "\\") { raw += code[j] + (code[j + 1] ?? ""); j++; continue; }  // keep the escape for decodeIdentEscapes
      raw += code[j];
    }
    if (j >= code.length) return null;
    return { raw, hasExpr: false, exprText: "", end: j + 1 };
  }
  let raw = ""; let exprText = ""; let hasExpr = false;
  for (let j = start + 1; j < code.length; j++) {
    tick();
    const ch = code[j];
    if (ch === "\\") { raw += ch + (code[j + 1] ?? ""); j++; continue; }
    if (ch === "`") return { raw, hasExpr, exprText, end: j + 1 };
    if (ch === "$" && code[j + 1] === "{") {
      hasExpr = true;
      let depth = 1; let k = j + 2;
      for (; k < code.length && depth > 0; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") depth--;
        else if (code[k] === "`" || code[k] === "'" || code[k] === '"') {
          const inner = readStringOrTemplate(code, k);
          if (!inner) return null; k = inner.end - 1;
        }
      }
      if (depth > 0) return null;
      const expr = code.slice(j + 2, k - 1);
      const sub = apiScanText(expr);
      if (!sub.ok) return null;
      exprText += ` ${sub.text} `; j = k - 1; continue;
    }
    raw += ch;
  }
  return null;
}

/** The string and template literals of a piece of JavaScript, and the code with its comments and literals blanked (for the API scan).
 *  `ok: false` when a literal or comment does not end. A `/` starts a regular expression where a value cannot stand before it. */
function jsLiterals(code) {
  const literals = [];
  let bare = "";
  let i = 0;
  let prev = "";                     // the last significant character outside literals and comments
  const regexAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  while (i < code.length) {
    tick();
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); i = e < 0 ? code.length : e; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); if (e < 0) return { ok: false, literals, bare }; i = e + 2; continue; }
    if (c === "/" && (regexAfter.has(prev) || /\b(?:return|typeof|case|in|of)$/.test(bare.trimEnd()))) {
      let j = i + 1; let cls = false;
      for (; j < code.length; j++) {
        if (code[j] === "\\") { j++; continue; }
        if (code[j] === "\n") return { ok: false, literals, bare };
        if (code[j] === "[") cls = true; else if (code[j] === "]") cls = false;
        else if (code[j] === "/" && !cls) break;
      }
      if (j >= code.length) return { ok: false, literals, bare };
      i = j + 1; while (i < code.length && /[a-z]/i.test(code[i])) i++;
      bare += " "; prev = "x"; continue;
    }
    if (c === "'" || c === '"') {
      let text = ""; let j = i + 1;
      for (; j < code.length && code[j] !== c; j++) {
        if (code[j] === "\n") return { ok: false, literals, bare };
        if (code[j] === "\\") { j++; text += jsEscape(code[j]); continue; }
        text += code[j];
      }
      if (j >= code.length) return { ok: false, literals, bare };
      literals.push(text); bare += ` ${c}${text}${c} `; i = j + 1; prev = "x"; continue;
    }
    if (c === "`") {
      const t = jsTemplate(code, i + 1);
      if (!t) return { ok: false, literals, bare };
      for (const inner of t.inner) {
        const sub = jsLiterals(inner);
        if (!sub.ok) return { ok: false, literals, bare };
        literals.push(...sub.literals); bare += ` ${sub.bare} `;
      }
      literals.push(t.text); bare += ` \`${t.text}\` `; i = t.end; prev = "x"; continue;
    }
    bare += c;
    if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? "x" : c;
    i++;
  }
  return { ok: true, literals, bare };
}

function jsEscape(ch) {
  return ch === "n" ? "\n" : ch === "t" ? "\t" : ch === undefined ? "" : ch;
}

/** A template literal from just after its opening backtick: its text with each ${...} as JS_EXPR, the expressions' source, and where it ends. */
function jsTemplate(code, start) {
  let text = ""; const inner = [];
  for (let j = start; j < code.length; j++) {
    tick();
    const ch = code[j];
    if (ch === "\\") { j++; text += jsEscape(code[j]); continue; }
    if (ch === "`") return { text, inner, end: j + 1 };
    if (ch === "$" && code[j + 1] === "{") {
      let depth = 1; let k = j + 2;
      for (; k < code.length && depth > 0; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") depth--;
        else if (code[k] === "`" || code[k] === "'" || code[k] === '"') {
          const q = code[k];
          if (q === "`") { const t = jsTemplate(code, k + 1); if (!t) return null; k = t.end - 1; continue; }
          let m = k + 1; for (; m < code.length && code[m] !== q; m++) if (code[m] === "\\") m++;
          if (m >= code.length) return null; k = m;
        }
      }
      if (depth > 0) return null;
      inner.push(code.slice(j + 2, k - 1));
      text += JS_EXPR; j = k - 1; continue;
    }
    text += ch;
  }
  return null;
}

/** checkReplCode(code[, { budgetMs }]) -> { block, violations, reason }. Never throws. */
function checkReplCode(code, options) {
  if (typeof code !== "string" || code.length === 0) return { block: false, violations: [], reason: "" };
  const budget = options && typeof options.budgetMs === "number" ? options.budgetMs : DEFAULT_BUDGET_MS;
  let parsed;
  try {
    deadline = Date.now() + budget;
    parsed = jsLiterals(code);
  } catch {
    parsed = { ok: false, literals: [], bare: code };
  }
  let api;
  try { api = apiScanText(code); } catch { api = { ok: false, text: "" }; }
  if (!parsed.ok || !api.ok) {
    if (!REPL_RISK_RE.test(code)) return { block: false, violations: [], reason: "" };
    const violations = [{ kind: "unparseable-repl", command: null }];
    return { block: true, violations, reason: replRefusal(violations) };
  }
  // Reference-based (o9o.131 round 2): any reference to the global Function value, any .constructor access, and process.binding/dlopen
  // in any spelling are refused however used — an alias that is never called is still a reference, so the rules match the normalised
  // text directly, with no separate call-shape check.
  for (const rule of REPL_API_RULES) {
    if (rule.re.test(api.text)) {
      const violations = [{ kind: "repl-api", command: rule.name }];
      return { block: true, violations, reason: replRefusal(violations) };
    }
  }
  for (const literal of parsed.literals) {
    const verdict = check(literal, options);
    if (verdict.block) return verdict;
  }
  return { block: false, violations: [], reason: "" };
}

function replRefusal(violations) {
  const v = violations[0];
  const why = v.kind === "repl-api"
    ? `this code names ${v.command}, which reaches the host outside the tool calls this guard checks`
    : "the guard could not read this code (a string, template or comment that does not end), and it names a rig command, a kill or a host API";
  return [
    "rig-body-guard BLOCKED this code before it ran. Nothing was executed.",
    `Why: ${why}. This check is defence in depth over Claude Code's own refusal of module loading in REPL code, not a sandbox.`,
    "Fix: run commands through the shell tool from code (await Bash({ command: \"...\" }) or the $ tag), whose commands this guard checks, and read files with the tool globals (Read, Glob, Grep). Do not reach for child_process, process.binding, process.dlopen or the Function constructor.",
  ].join("\n");
}

function hookDecision(rawInput) {
  let event;
  try { event = JSON.parse(rawInput); } catch { return { output: null, note: "rig-body-guard: hook input is not JSON; allowed" }; }
  // workspaces-o9o.131: Code Mode's REPL tool carries JavaScript in tool_input.code.
  if (event && typeof event === "object" && event.tool_name === "REPL") {
    const code = event.tool_input && typeof event.tool_input.code === "string" ? event.tool_input.code : null;
    if (code === null) return { output: null, note: "rig-body-guard: no REPL code in the hook input; allowed" };
    const verdict = checkReplCode(code);
    if (!verdict.block) return { output: null, note: null };
    return { output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } }, note: null };
  }
  const command = event && typeof event === "object" && event.tool_input && typeof event.tool_input.command === "string" ? event.tool_input.command : null;
  if (command === null) return { output: null, note: "rig-body-guard: no Bash command in the hook input; allowed" };
  const verdict = check(command);
  let reason = verdict.block ? verdict.reason : null;
  if (reason === null && event.tool_input.run_in_background !== true) {
    let bg = { block: false, reason: "" };
    try { bg = checkBackground(command); } catch { /* fail open: a guard fault must not stop the seat's Bash calls */ }
    if (bg.block) reason = bg.reason;
  }
  if (reason === null) return { output: null, note: null };
  return {
    output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } },
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

module.exports = { check, checkBackground, checkReplCode, hookDecision, refusal, lex, bodyExpands, maskPieces, DEFAULT_BUDGET_MS, MESSAGE_COMMANDS, FLAG_COMMANDS };
