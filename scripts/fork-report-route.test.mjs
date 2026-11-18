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

// verify-qa review: plain phrasings with no URL ("Report problems upstream.", "File an issue with the upstream project.",
// "Submit this issue to upstream maintainers.") passed. So the intent is matched too: in one sentence, a verb of submitting
// followed by an upstream recipient, unless the sentence negates it ("report it here, never upstream").
// "file" and "open" only in their submitting sense: "file an issue", "open a pull request", never "a companion file that" or
// "the open body". URLs are matched by the patterns above, so they are taken out of the sentence first ("search [open
// issues](https://github.com/...)" reads a list; it does not open one).
const SUBMIT = /\b(?:report|submit|send|email|post)\b|\bfile (?:an?|it|them|your|bugs?|issues?|problems?|reports?)\b|\b(?:open|raise) (?:an? |the |this |a new )?(?:issue|discussion|pull request|PR|ticket|bug)\b/i;
const RECIPIENT = /\b(?:upstream|maintainers?)\b|mvschwarz|hello@openrig\.dev|OpenRig (?:team|support)/i;
const NEGATION = /\b(?:never|nothing|not|no|don't|do not)\b/i;
// verify-qa review 2: a negation anywhere in the sentence cancelled a submission ("Report problems upstream, but do not include
// secrets." passed). The verb, the recipient after it and the negation are now read within ONE clause: the sentence is split at
// , ; : ( ) and dashes, and at "but", "and", "or", "while", "though". "report it here, never upstream" stays clean: the recipient
// sits in its own clause, with "never". Residual: a verb and its recipient in two clauses ("report it, the maintainers read it")
// is not counted.
const CLAUSE = /\s*[,;:()\u2013\u2014]\s*|\s+-\s+|\s+(?:but|and|or|while|though)\s+/i;
function submitsUpstream(text) {
  return text.split(CLAUSE).some(clauseSubmitsUpstream);
}
function clauseSubmitsUpstream(text) {
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
    // verify-qa review 2: a negation in ANOTHER clause does not cancel the submission.
    'Report problems upstream, but do not include secrets.',
    'Report problems upstream and not here.',
    'Never mind the logs; file an issue with the upstream project.',
  ]) assert.equal(upstreamSubmissions(line).length, 1, line);
  // The fork's own wording, which names upstream only to rule it out or to read it, is not a submission.
  for (const line of [
    "report it to this fork's own intake, never upstream: see [Report a problem on this fork](#report-a-problem-on-this-fork).",
    'file nothing with it (no issue, discussion or pull request on any `github.com/mvschwarz` repository) and send nothing to its support address.',
    'For a confirmed bug, search the upstream issues first and name a matching one in your report, as a reference; the',
    // A read-only link whose text is a verb: the URL names the upstream repository, and the sentence only points at it.
    'The cause is in the [report](https://github.com/mvschwarz/openrig/issues/99), which is read-only here.',
    // verify-qa review 2: a link whose text IS a submitting verb phrase, to an existing issue: read-only.
    'Reference [open this issue](https://github.com/mvschwarz/openrig/issues/99) for background only.',
    // A negation in the clause that holds the verb and the recipient does cancel it.
    'Do not report problems upstream.',
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
