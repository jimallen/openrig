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

// What the package ships, derived from TRACKED sources (verify-qa review 2: a census that reads build output passes only on a
// tree that was built; CI runs `npm ci` then `npm run test:repo`, which builds the daemon only and runs this file before the
// packs are generated). packages/cli/package.json `files` names what is published from packages/cli; scripts/build-package.sh
// fills it: each `cp -r "$<PKG>_DIR/<from>" "$CLI_DIR/<to>"` puts <from> there. Each shipped thing is then read as its source:
// - a built `dist` as its package's `src`, plus `index.html` and `public` where they exist (vite's inputs);
// - a file prepare-workspace-build.mjs copies into packages/cli from the repository root (its copy list) as that root file;
// - the generated context packs as the generator's own default sources (its SOURCE and STATIC_SOURCE), and the generator;
// - anything else as itself, when git tracks it.
// A `files` entry or a copy this cannot place, or a generated folder it does not know, throws: a silent gap is the failure.
export function shippedRoots({ manifest, buildScript, prepareScript, generatorScript, tracked }) {
  const has = (p) => tracked(p);
  const dirs = { REPO_ROOT: '' };
  for (const m of buildScript.matchAll(/^(\w+_DIR)="\$REPO_ROOT\/([^"]+)"/gm)) dirs[m[1]] = m[2];
  const copies = [];
  for (const m of buildScript.matchAll(/cp -r "\$(\w+)\/([^"]*)"\*? "\$CLI_DIR\/([^"]+)"/g)) {
    if (!(m[1] in dirs)) throw new Error(`build-package.sh copies from an unknown folder: $${m[1]}`);
    copies.push({ from: path.posix.join(dirs[m[1]], m[2]).replace(/\/+$/, ''), to: m[3].replace(/\/+$/, '') });
  }
  const rootCopies = new Set();
  const list = /for \(const name of \[([^\]]*)\]\) copyFileSync\(path\.join\(root, name\)/.exec(prepareScript);
  if (list) for (const q of list[1].matchAll(/"([^"]+)"/g)) rootCopies.add(q[1]);
  const generated = new Map();
  const out = /const OUT = [\s\S]*?:\s*path\.join\(REPO, "([^"]+)"\)/.exec(generatorScript);
  if (out) {
    const sources = [...generatorScript.matchAll(/const (?:SOURCE|STATIC_SOURCE) = [\s\S]*?:\s*path\.join\(REPO, "([^"]+)"\)/g)].map((m) => m[1]);
    generated.set(out[1], [...sources, 'scripts/generate-context-packs.mjs']);
  }
  const builtFrom = (dist) => {
    const pkg = path.posix.dirname(dist);
    return [path.posix.join(pkg, 'src'), ...['index.html', 'public'].map((p) => path.posix.join(pkg, p)).filter(has)];
  };
  const place = (from, roots) => {
    if (path.posix.basename(from) === 'dist') for (const p of builtFrom(from)) roots.add(p);
    else if (generated.has(from)) for (const p of generated.get(from)) roots.add(p);
    else if (has(from)) roots.add(from);
    else throw new Error(`the package ships ${from}, which git does not track and no build step here makes`);
  };
  const roots = new Set();
  for (const entry of manifest.files) {
    const filled = copies.filter((c) => c.to === entry || c.to.startsWith(`${entry}/`));
    for (const c of filled) place(c.from, roots);
    if (filled.length > 0) continue;
    const own = path.posix.join('packages/cli', entry);
    if (entry === 'dist') for (const p of builtFrom(own)) roots.add(p);
    else if (has(own)) roots.add(own);
    else if (rootCopies.has(entry) && has(entry)) roots.add(entry);
    else throw new Error(`packages/cli/package.json files names ${entry}, which neither git tracks nor a build step here fills`);
  }
  return [...roots].sort();
}

/** Whether git tracks a file, or any file under a folder. */
function trackedPath(rel) {
  return execFileSync('git', ['-C', root, 'ls-files', '--', rel], { encoding: 'utf8' }).trim() !== '';
}
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const SHIPPED_ROOTS = shippedRoots({
  manifest: JSON.parse(read('packages/cli/package.json')),
  buildScript: read('scripts/build-package.sh'),
  prepareScript: read('scripts/prepare-workspace-build.mjs'),
  generatorScript: read('scripts/generate-context-packs.mjs'),
  tracked: trackedPath,
});

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

// Jim, 2026-11-18 (o9o.137, after a third review found another negation that slipped past): a STRICT guard, no negation.
// Every shipped sentence that pairs a submitting verb with an upstream recipient, in either order, is flagged. A legitimate
// one (this fork's own help naming upstream to rule it out) goes on the reviewed allowlist, fork-report-route.allowlist.json
// (file, exact sentence, reason), and an entry that no longer matches a flagged sentence fails the guard.
// - Verbs: report, submit, send, email, post; "file", "open" and "raise" only as submitting verbs ("file an issue",
//   "open a pull request"), since "a companion file" and "the open body" are nouns, not submissions.
// - Recipients: upstream, the maintainers, mvschwarz, hello@openrig.dev, the OpenRig team or support.
// - A read-only link to an upstream issue, or to the issue list, is taken out first: reading a known issue is allowed.
const SUBMIT = /\b(?:report|submit|send|email|post)\b|\bfile (?:an?|it|them|your|bugs?|issues?|problems?|reports?)\b|\b(?:open|raise) (?:an? |the |this |a new )?(?:issue|discussion|pull request|PR|ticket|bug)\b/i;
const RECIPIENT = /\b(?:upstream|maintainers?)\b|mvschwarz|hello@openrig\.dev|OpenRig (?:team|support)/i;
const READ_ONLY_ISSUE_LINK = /(?:https?:\/\/)?github\.com\/mvschwarz\/[\w.-]+\/issues(?:\/\d+)?(?:#[\w-]+)?(?=[)\s.,;:]|$)/gi;

function flagged(sentence) {
  if (UPSTREAM_SUBMISSION.some((pattern) => pattern.test(sentence))) return true;
  const plain = sentence.replace(READ_ONLY_ISSUE_LINK, '');
  return SUBMIT.test(plain) && RECIPIENT.test(plain);
}

// A sentence may wrap across lines, so lines are joined into blocks first. A block ends at a blank line and before a line that
// starts a list item, a heading, a table row or a quote, so two items are never read as one sentence. Each sentence keeps the
// line it starts on.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#|\||>)/;
export function sentencesOf(text) {
  const out = [];
  let block = [];
  const flush = () => {
    let joined = '';
    const starts = [];
    for (const { line, body } of block) {
      starts.push({ at: joined.length + (joined ? 1 : 0), line });
      joined = joined ? `${joined} ${body}` : body;
    }
    let from = 0;
    for (const piece of joined.split(/(?<=[.!?])\s+/)) {
      const at = joined.indexOf(piece, from);
      from = at + piece.length;
      const line = [...starts].reverse().find((st) => st.at <= at)?.line ?? block[0].line;
      if (piece.trim()) out.push({ line, text: piece.trim().replace(/\s+/g, ' ') });
    }
    block = [];
  };
  text.split('\n').forEach((raw, i) => {
    const body = raw.trim();
    if (!body) { if (block.length) flush(); return; }
    if (block.length && BLOCK_START.test(raw)) flush();
    block.push({ line: i + 1, body });
  });
  if (block.length) flush();
  return out;
}

export function upstreamSubmissions(text) {
  return sentencesOf(text).filter((sentence) => flagged(sentence.text));
}

const ALLOWLIST_FILE = 'scripts/fork-report-route.allowlist.json';
const ALLOWLIST = JSON.parse(readFileSync(path.join(root, ALLOWLIST_FILE), 'utf8'));

// Every tracked file under the roots, text only (a file with a NUL byte is binary). No extension filter, so .sh files are read;
// nothing generated or built is read, so a clean checkout gives the same census as a built one.
function shippedFiles() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...SHIPPED_ROOTS], { encoding: 'utf8' });
  return out.split('\0').filter((f) => f && !readFileSync(path.join(root, f)).includes(0));
}

test('the shipped roots are derived from the CLI manifest and the build scripts, as tracked sources', () => {
  assert.deepEqual(SHIPPED_ROOTS, [
    'LICENSE', 'docs/reference', 'packages/cli/scripts', 'packages/cli/src', 'packages/daemon/assets',
    'packages/daemon/context-packs-src', 'packages/daemon/policies', 'packages/daemon/specs', 'packages/daemon/specs/agents/shared/skills',
    'packages/daemon/src', 'packages/tui/src', 'packages/ui/index.html', 'packages/ui/public', 'packages/ui/src',
    'scripts/generate-context-packs.mjs',
  ]);
  const inputs = (over) => ({ manifest: { files: [] }, buildScript: '', prepareScript: '', generatorScript: '', tracked: () => false, ...over });
  // A files entry nothing places, a copy from a folder the script never named, and an untracked folder no build step makes
  // are refusals, not silent gaps.
  assert.throws(() => shippedRoots(inputs({ manifest: { files: ['extra'] } })), /names extra/);
  assert.throws(() => shippedRoots(inputs({ manifest: { files: ['x'] }, buildScript: 'cp -r "$NOPE_DIR/a" "$CLI_DIR/x"' })), /unknown folder: \$NOPE_DIR/);
  assert.throws(() => shippedRoots(inputs({ manifest: { files: ['x'] }, buildScript: 'D_DIR="$REPO_ROOT/p"\ncp -r "$D_DIR/gen" "$CLI_DIR/x"' })), /ships p\/gen, which git does not track/);
});

test('the census reads every shipped surface from its sources, on a clean tree too (positive control)', () => {
  const files = shippedFiles();
  assert.ok(files.length > 1000, `only ${files.length} shipped files listed`);
  for (const must of [
    'docs/reference/help.md', 'packages/daemon/assets/guidance/openrig-start.md', 'packages/daemon/context-packs-src/help/help.md',
    'packages/daemon/context-packs-src/onboarding-width/public-what-you-can-do.md', 'packages/cli/scripts/check-abi.mjs', 'LICENSE',
  ]) assert.ok(files.includes(must), `${must} is not in the census`);
  for (const [dir, ext] of [['packages/ui/src', '.tsx'], ['packages/tui/src', '.ts'], ['packages/daemon/assets', '.sh']]) {
    assert.ok(files.some((f) => f.startsWith(`${dir}/`) && f.endsWith(ext)), `no ${ext} file of ${dir} is in the census`);
  }
  assert.ok(!files.some((f) => f.startsWith('packages/daemon/context-packs/') || f.startsWith('packages/cli/dist/')), 'build output read');
});

test('the matcher flags each way of pointing a reader upstream, negated or not, and passes a read-only issue link', () => {
  for (const sentence of [
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
    // verify-qa's probes, all three reviews: with no negation handling, each is flagged.
    'Report problems upstream, but do not include secrets.',
    'Report problems upstream and not here.',
    'Never mind the logs; file an issue with the upstream project.',
    'Report problems upstream if they are not already filed.',
    'Do not report problems upstream.',
    // Either order; and a sentence that wraps across lines is one sentence.
    'The upstream maintainers want you to report it.',
    "report it to this fork's own intake, never upstream.",
  ]) assert.equal(upstreamSubmissions(sentence).length, 1, sentence);
  assert.equal(upstreamSubmissions('Report problems\nupstream, please.').length, 1, 'a sentence across two lines');
  for (const sentence of [
    // A read-only link to an upstream issue, or to the issue list, is not a recipient.
    '- Claude usage limits may not be detected: [#99](https://github.com/mvschwarz/openrig/issues/99).',
    'For everything else, search [open issues](https://github.com/mvschwarz/openrig/issues).',
    'The cause is in the [report](https://github.com/mvschwarz/openrig/issues/99), which is read-only here.',
    'Reference [open this issue](https://github.com/mvschwarz/openrig/issues/99) for background only.',
    'See the report at https://github.com/mvschwarz/openrig/issues/99 for the cause.',
    // Nouns, not submitting verbs.
    'OpenRig adds a companion file that captures local-use insights without polluting the upstream content.',
    '/** Parse the `{ provider?, view }` open body honestly (a non-object / missing view → structured 400 upstream). */',
  ]) assert.deepEqual(upstreamSubmissions(sentence), [], sentence);
  // Two list items, or two paragraphs, are never one sentence.
  assert.deepEqual(upstreamSubmissions('- report it here\n- the upstream project is read-only'), []);
  assert.deepEqual(upstreamSubmissions('Report it here\n\nThe upstream project is read-only.'), []);
});

test('every flagged shipped sentence is on the reviewed allowlist (file, exact sentence, reason)', () => {
  const allowed = new Set(ALLOWLIST.map((e) => `${e.file}\u0000${e.sentence}`));
  const hits = [];
  for (const file of shippedFiles()) {
    for (const hit of upstreamSubmissions(readFileSync(path.join(root, file), 'utf8'))) {
      if (!allowed.has(`${file}\u0000${hit.text}`)) hits.push(`${file}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(hits, []);
});

/** What is wrong with allowlist entries: no reason, a duplicate, or a sentence no shipped file still flags (stale). */
export function allowlistProblems(entries, shipped, textOf) {
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.file}\u0000${entry.sentence}`;
    if (seen.has(key)) problems.push(`duplicate: ${entry.file}: ${entry.sentence}`);
    seen.add(key);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) problems.push(`no reason: ${entry.file}: ${entry.sentence}`);
    const live = shipped.has(entry.file) && upstreamSubmissions(textOf(entry.file)).some((hit) => hit.text === entry.sentence);
    if (!live) problems.push(`stale: ${entry.file}: ${entry.sentence}`);
  }
  return problems;
}

test('every allowlist entry is reviewed, and still matches a flagged sentence in a shipped file', () => {
  assert.deepEqual(allowlistProblems(ALLOWLIST, new Set(shippedFiles()), (f) => readFileSync(path.join(root, f), 'utf8')), []);
});

test('the allowlist check names a stale entry, a missing reason and a duplicate', () => {
  const text = { 'a.md': 'Report problems upstream.\n\nNothing else here.' };
  const ok = { file: 'a.md', sentence: 'Report problems upstream.', reason: 'a reviewed reason that is long enough' };
  assert.deepEqual(allowlistProblems([ok], new Set(['a.md']), (f) => text[f]), []);
  assert.deepEqual(allowlistProblems([{ ...ok, sentence: 'Nothing else here.' }], new Set(['a.md']), (f) => text[f]), ['stale: a.md: Nothing else here.']);
  assert.deepEqual(allowlistProblems([ok], new Set(), (f) => text[f]), ['stale: a.md: Report problems upstream.']);
  assert.deepEqual(allowlistProblems([{ ...ok, reason: 'ok' }], new Set(['a.md']), (f) => text[f]), ['no reason: a.md: Report problems upstream.']);
  assert.deepEqual(allowlistProblems([ok, ok], new Set(['a.md']), (f) => text[f]), ['duplicate: a.md: Report problems upstream.']);
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
  'Report problems upstream if they are not already filed.',
  'Report problems upstream, but do not include secrets.',
  'Do not report problems upstream.',
]) {
  test(`the matcher catches a plain phrasing: ${phrasing}`, () => {
    assert.equal(upstreamSubmissions(phrasing).length, 1);
  });
}
