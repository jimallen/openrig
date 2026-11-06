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
// OF-251: stands in, in a wrapper script's text, for a substitution the LOCAL shell runs before the wrapper starts. Private-use
// character; any word or here-document holding it counts as expanded whatever quoting the inner text puts around it.
const OUTER_SUB = "\uE000";
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
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
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
  for (let guard = 0; guard < 64; guard++) {
    while (k < words.length && (ASSIGN_RE.test(words[k].text) || KEYWORDS.has(words[k].text))) k++;
    if (k >= words.length || words[k].expands) return null;
    const name = baseName(words[k].text);
    const w = WRAPPERS[name];
    if (!w) return { name, args: words.slice(k + 1) };
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
  return null;
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
  for (const h of cmd.heredocs) scan(h.body, depth + 1, out);
  for (const w of cmd.hereStrings) scan(w.text, depth + 1, out);
}

/** The text of a script word with each substitution the LOCAL shell runs replaced by OUTER_SUB. */
function maskedText(w) {
  let t = w.text;
  for (let k = w.marks.length - 1; k >= 0; k--) t = t.slice(0, w.marks[k][0]) + OUTER_SUB + t.slice(w.marks[k][1]);
  return t;
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

function scanPipeline(cmds, resolved, from, to, depth, out) {
  let message = null;
  for (let i = from; i < to; i++) {
    const res = resolved[i];
    if (!res) continue;
    if (res.name === "rig") {
      const top = topLevel(res.args);
      if (top) for (const v of rigViolations(top)) out.push(v);
      if (isMessageRig(res)) message = top.name;
    } else if (SHELLS.has(res.name)) {
      const ci = res.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
      if (ci >= 0) {
        const script = res.args.slice(ci + 1).find((a) => !a.text.startsWith("-"));
        if (script) { outerExpansion([script], depth, out); scan(script.text, depth + 1, out); }
      } else if (res.args.every((a) => a.text.startsWith("-")) || res.args.some((a) => a.text === "-s")) {
        scanStdinScript(cmds[i], depth, out);        // bash <<'EOF' ... EOF / bash <<< '...': the text is the script
      }
    } else if (res.name === "eval") {
      outerExpansion(res.args, depth, out);
      scan(res.args.map((a) => a.text).join(" "), depth + 1, out);
    } else if (res.name === "ssh") {
      let k = 0;
      while (k < res.args.length && res.args[k].text.startsWith("-")) k += SSH_VALUED.has(res.args[k].text) ? 2 : 1;
      const remote = res.args.slice(k + 1);                 // after the host
      if (remote.length) { outerExpansion(remote, depth, out); scan(remote.map((a) => a.text).join(" "), depth + 1, out); }
      else scanStdinScript(cmds[i], depth, out);            // ssh host <<'EOF' ... EOF
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

const FALLBACK_SRC =
  "(?:^|[^\\w./-])(?:[\\w./-]*/)?rig\\s+(?:-\\S+\\s+)*(" +
    Object.keys(MESSAGE_COMMANDS).concat(Object.keys(FLAG_COMMANDS)).map((n) => n.replace(/-/g, "\\-")).join("|") +
    ")\\b";
const FALLBACK_RE = new RegExp(FALLBACK_SRC);

/** check(command) -> { block, violations, reason }. Never throws. */
function check(command) {
  if (typeof command !== "string" || command.length === 0) return { block: false, violations: [], reason: "" };
  let violations = [];
  try {
    if (command.length > MAX_LEN) throw new ParseError("command too long");
    scan(command, 0, violations);
  } catch (error) {
    violations = [];
    if (FALLBACK_RE.test(command) && (command.includes("`") || command.includes("$("))) {
      violations.push({ kind: "unparseable", command: null });
    }
  }
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

module.exports = { check, hookDecision, refusal, lex, bodyExpands, MESSAGE_COMMANDS, FLAG_COMMANDS };
