// workspaces-o9o.137: this build is a private fork, and nothing from it goes to the upstream project. The shipped help
// told every seat to report problems upstream (an upstream issue, discussion or pull request, the upstream support
// address, "a useful report to the OpenRig team"). Every shipped surface now routes reports to the fork's own intake.
// Read-only links to known upstream issues (a numbered issue, "search open issues") stay: reading is not submitting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What the package ships, derived (verify-qa review: a hand list missed the generated context packs, ui, tui and .sh files).
// packages/cli/package.json `files` names what is published from packages/cli; scripts/build-package.sh fills it: each
// `cp -r "$<PKG>_DIR/<from>" "$CLI_DIR/<to>"` puts <from> there. A built `dist` is read as what it is built from: its
// package's `src`, plus `index.html` and `public` where they exist (vite's inputs). An entry of `files` that no copy fills
// is packages/cli's own (`dist` is built from packages/cli/src). A `files` entry or a copy this cannot place fails the census.
export function shippedRoots(manifest, buildScript) {
  const dirs = { REPO_ROOT: '' };
  for (const m of buildScript.matchAll(/^(\w+_DIR)="\$REPO_ROOT\/([^"]+)"/gm)) dirs[m[1]] = m[2];
  const copies = [];
  for (const m of buildScript.matchAll(/cp -r "\$(\w+)\/([^"]*)"\*? "\$CLI_DIR\/([^"]+)"/g)) {
    if (!(m[1] in dirs)) throw new Error(`build-package.sh copies from an unknown folder: $${m[1]}`);
    const from = path.posix.join(dirs[m[1]], m[2]).replace(/\/+$/, '');
    copies.push({ from, to: m[3].replace(/\/+$/, '') });
  }
  const builtFrom = (dist) => {
    const pkg = path.posix.dirname(dist);
    return [path.posix.join(pkg, 'src'), ...['index.html', 'public'].map((p) => path.posix.join(pkg, p)).filter((p) => existsSync(path.join(root, p)))];
  };
  const roots = new Set();
  for (const entry of manifest.files) {
    const filled = copies.filter((c) => c.to === entry || c.to.startsWith(`${entry}/`));
    if (filled.length === 0) {
      const own = path.posix.join('packages/cli', entry);
      if (entry === 'dist') for (const p of builtFrom(own)) roots.add(p);
      else if (existsSync(path.join(root, own))) roots.add(own);
      else if (existsSync(path.join(root, entry))) roots.add(entry);
      else throw new Error(`packages/cli/package.json files names ${entry}, which neither exists nor is filled by build-package.sh`);
      continue;
    }
    for (const c of filled) {
      if (path.posix.basename(c.from) === 'dist') for (const p of builtFrom(c.from)) roots.add(p);
      else roots.add(c.from);
    }
  }
  return [...roots].sort();
}

const SHIPPED_ROOTS = shippedRoots(
  JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')),
  readFileSync(path.join(root, 'scripts/build-package.sh'), 'utf8'),
);

// Each is a way of telling a reader to submit something upstream.
const UPSTREAM_SUBMISSION = [
  /hello@openrig\.dev/i,
  /github\.com\/mvschwarz\/[\w.-]+\/(?:issues\/new|discussions|compare|pulls?\b)/i,
  /\bopen an issue\b/i,
  /\bsend a pull request\b/i,
  /\bopen a pull request to\b/i,
  /report (?:\w+ ){0,3}to the OpenRig team/i,
  /OpenRig team an? (?:\w+ )?report/i,
  /\bsubmit(?:ting)? it to openrig\.dev/i,
  /contact OpenRig support/i,
  /tell us how it went/i,
];

// verify-qa review: plain phrasings with no URL ("Report problems upstream.", "File an issue with the upstream project.",
// "Submit this issue to upstream maintainers.") passed. So the intent is matched too: in one sentence, a verb of submitting
// followed by an upstream recipient, unless the sentence negates it ("report it here, never upstream").
// "file" and "open" only in their submitting sense: "file an issue", "open a pull request", never "a companion file that" or
// "the open body". URLs are matched by the patterns above, so they are taken out of the sentence first ("search [open
// issues](https://github.com/...)" reads a list; it does not open one).
const SUBMIT = /\b(?:report|submit|send|email|post)\b|\bfile (?:an?|it|them|your|bugs?|issues?|problems?|reports?)\b|\b(?:open|raise) (?:an? |the |this |a new )?(?:issue|discussion|pull request|PR|ticket|bug)\b/i;
const RECIPIENT = /\b(?:upstream|maintainers?)\b|mvschwarz|hello@openrig\.dev|OpenRig (?:team|support)/i;
const NEGATION = /\b(?:never|nothing|not|no|don't|do not)\b/i;
function submitsUpstream(text) {
  const sentence = text.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
  const verb = SUBMIT.exec(sentence);
  if (!verb) return false;
  return RECIPIENT.test(sentence.slice(verb.index)) && !NEGATION.test(sentence);
}

export function upstreamSubmissions(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const sentences = line.split(/(?<=[.!?;])\s+/);
    if (UPSTREAM_SUBMISSION.some((pattern) => pattern.test(line)) || sentences.some(submitsUpstream)) found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

// Every file under a root, read from disk (the context packs are generated and git-ignored), text files only: a file with a
// NUL byte is binary. No extension filter: the .sh files and anything else shipped are read.
function walk(rel, out) {
  const full = path.join(root, rel);
  if (!existsSync(full)) return;
  if (statSync(full).isFile()) { out.push(rel); return; }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (entry.isFile()) out.push(child);
  }
}
function shippedFiles() {
  const files = [];
  for (const r of SHIPPED_ROOTS) walk(r, files);
  return files.filter((f) => !readFileSync(path.join(root, f)).includes(0));
}

test('the shipped roots are derived from the CLI manifest and the build script', () => {
  assert.deepEqual(SHIPPED_ROOTS, [
    'docs/reference', 'packages/cli/LICENSE', 'packages/cli/scripts', 'packages/cli/src', 'packages/daemon/assets',
    'packages/daemon/context-packs', 'packages/daemon/policies', 'packages/daemon/specs', 'packages/daemon/src',
    'packages/tui/src', 'packages/ui/index.html', 'packages/ui/public', 'packages/ui/src',
  ]);
  // A files entry nothing places, and a copy from a folder the script never named, are refusals, not silent gaps.
  assert.throws(() => shippedRoots({ files: ['extra'] }, ''), /names extra/);
  assert.throws(() => shippedRoots({ files: ['x'] }, 'cp -r "$NOPE_DIR/a" "$CLI_DIR/x"'), /unknown folder: \$NOPE_DIR/);
});

test('the census reads every shipped surface, generated and not (positive control)', () => {
  const files = shippedFiles();
  assert.ok(files.length > 1000, `only ${files.length} shipped files listed`);
  for (const must of [
    'docs/reference/help.md', 'packages/daemon/assets/guidance/openrig-start.md', 'packages/daemon/context-packs/help/help.md',
    'packages/cli/scripts/check-abi.mjs',
  ]) assert.ok(files.includes(must), `${must} is not in the census (the context packs are made by npm run build -w packages/daemon)`);
  for (const [dir, ext] of [['packages/ui/src', '.tsx'], ['packages/tui/src', '.ts'], ['packages/daemon/assets', '.sh']]) {
    assert.ok(files.some((f) => f.startsWith(`${dir}/`) && f.endsWith(ext)), `no ${ext} file of ${dir} is in the census`);
  }
});

test('the matcher catches each way of pointing a reader upstream, and passes a read-only link', () => {
  for (const line of [
    'prepare a message to OpenRig support at hello@openrig.dev.',
    'or [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose).',
    'use [GitHub Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a).',
    '> open an issue or send a pull request',
    'Open a pull request to [mvschwarz/openrig-registry](https://github.com/mvschwarz/openrig-registry)',
    'send the OpenRig team a useful report when you are still stuck',
    'and a useful report to the OpenRig team if you are still stuck',
    '## 6. Submit it to openrig.dev/rigs',
    'next to the ways people can contact OpenRig support.',
    "You're welcome to run it and tell us how it went.",
  ]) assert.equal(upstreamSubmissions(line).length, 1, line);
  // The fork's own wording, which names upstream only to rule it out or to read it, is not a submission.
  for (const line of [
    "report it to this fork's own intake, never upstream: see [Report a problem on this fork](#report-a-problem-on-this-fork).",
    'file nothing with it (no issue, discussion or pull request on any `github.com/mvschwarz` repository) and send nothing to its support address.',
    'For a confirmed bug, search the upstream issues first and name a matching one in your report, as a reference; the',
    // A read-only link whose text is a verb: the URL names the upstream repository, and the sentence only points at it.
    'The cause is in the [report](https://github.com/mvschwarz/openrig/issues/99), which is read-only here.',
    // Nouns, not submissions: shipped lines that named "file" or "open" beside "upstream" (found by this census).
    'OpenRig adds a companion file that captures local-use insights without polluting the upstream content.',
    '/** Parse the `{ provider?, view }` open body honestly (a non-object / missing view → structured 400 upstream). */',
  ]) assert.deepEqual(upstreamSubmissions(line), [], line);
  for (const line of [
    '- Claude usage limits may not be detected: [#99](https://github.com/mvschwarz/openrig/issues/99).',
    'For everything else, search [open issues](https://github.com/mvschwarz/openrig/issues).',
  ]) assert.deepEqual(upstreamSubmissions(line), [], line);
});

test('no shipped surface tells a reader to submit anything upstream', () => {
  const hits = [];
  for (const file of shippedFiles()) {
    for (const hit of upstreamSubmissions(readFileSync(path.join(root, file), 'utf8'))) hits.push(`${file}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(hits, []);
});

test('the help names the fork\'s own route for a report', () => {
  const help = readFileSync(path.join(root, 'docs/reference/help.md'), 'utf8');
  assert.match(help, /rig send exec-cos@openrig --file -/);
  assert.match(help, /rig host list/);
  assert.match(help, /never upstream/i);
});

// verify-qa's phrasings, each its own row (review of 444a07dc9: each passed the guard).
for (const phrasing of [
  'Report problems upstream.',
  'File an issue with the upstream project.',
  'Submit this issue to upstream maintainers.',
]) {
  test(`the matcher catches a plain phrasing: ${phrasing}`, () => {
    assert.equal(upstreamSubmissions(phrasing).length, 1);
  });
}
