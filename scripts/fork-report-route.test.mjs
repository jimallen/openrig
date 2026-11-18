// workspaces-o9o.137: this build is a private fork, and nothing from it goes to the upstream project. The shipped help
// told every seat to report problems upstream (an upstream issue, discussion or pull request, the upstream support
// address, "a useful report to the OpenRig team"). Every shipped surface now routes reports to the fork's own intake.
// Read-only links to known upstream issues (a numbered issue, "search open issues") stay: reading is not submitting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What the package ships (scripts/build-package.sh): the daemon's src, assets, specs, policies and context-pack sources,
// docs/reference, the CLI's src and scripts, and the skills the context packs and the plugin are generated from.
const SHIPPED_ROOTS = [
  'docs/reference', 'packages/daemon/src', 'packages/daemon/assets', 'packages/daemon/specs', 'packages/daemon/policies',
  'packages/daemon/context-packs-src', 'packages/cli/src', 'packages/cli/scripts', 'skills',
];

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

export function upstreamSubmissions(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (UPSTREAM_SUBMISSION.some((pattern) => pattern.test(line))) found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

function shippedFiles() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...SHIPPED_ROOTS], { encoding: 'utf8' });
  return out.split('\0').filter((f) => f && /\.(md|ts|mjs|cjs|js|json|yaml|yml|txt)$/.test(f));
}

test('the census reads the shipped surfaces (positive control)', () => {
  const files = shippedFiles();
  assert.ok(files.length > 500, `only ${files.length} shipped files listed`);
  for (const must of ['docs/reference/help.md', 'packages/daemon/assets/guidance/openrig-start.md', 'skills/_canonical/core/openrig-skills/SKILL.md']) {
    assert.ok(files.includes(must), `${must} is not in the census`);
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
