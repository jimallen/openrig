import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  EXIT,
  parseArguments,
  readReceipt,
  runTier,
  scanAddedLines,
  selectReach,
  summaryLines,
} from "./gate-tiers.mjs";

const GATE = resolve("scripts/gate-tiers.mjs");

// Fixture text that the T0 scan must catch is assembled at runtime, so this file never carries it literally.
const SKIP = ["it", "skip"].join(".");
const ONLY = ["describe", "only"].join(".");
const TODO = ["test", "todo"].join(".");
const XIT = ["x", "it"].join("");
const LINT_OFF = ["eslint", "disable", "next", "line"].join("-");
const TS_OFF = ["@ts", "ignore"].join("-");
const FAKE_SLACK = ["xox", "b-"].join("") + "1234567890-abcdefghijkl";

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(repo, path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function commit(repo, message) {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// A repo with the three suite packages and a base commit on `main`, then a unit branch.
async function withRepo(body) {
  const root = mkdtempSync(join(tmpdir(), "gate-tiers-test-"));
  const repo = join(root, "repo");
  const receipts = join(root, "receipts");
  try {
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 1;\n");
    write(repo, "packages/daemon/src/unrelated.ts", "export const other = 1;\n");
    write(repo, "packages/daemon/test/queue-store.test.ts", "import '../src/queue-store';\n");
    write(repo, "packages/daemon/test/census-by-name.test.ts", "const watched = ['queue-store.ts'];\n");
    write(repo, "packages/daemon/test/unrelated.test.ts", "import '../src/unrelated';\n");
    write(repo, "packages/daemon/test/graph-only.test.ts", "import { app } from '../src/app';\n");
    write(repo, "packages/cli/test/cli.test.ts", "export {};\n");
    write(repo, "packages/tui/test/tui.test.ts", "export {};\n");
    commit(repo, "base");
    git(repo, "checkout", "-q", "-b", "unit");
    return await body({ root, repo, receipts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakePorts({ exitCodes = {}, imported = {}, onExec } = {}) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    log: (line) => lines.push(line),
    exec: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      onExec?.({ command, args, cwd: options.cwd });
      const key = [command, ...args].join(" ");
      const code = Object.entries(exitCodes).find(([needle]) => key.includes(needle))?.[1] ?? 0;
      return { code, output: " Test Files  3 passed (3)\n      Tests  9 passed (9)\n" };
    },
    listChanged: async (packageDir) => imported[packageDir.split("/").pop()] ?? [],
  };
}

const run = (repo, receipts, tier, ports, extra = {}) =>
  runTier({ tier, base: "main", cwd: repo, receiptsRoot: receipts, ...extra }, ports);

async function passTiers(repo, receipts, upTo, ports) {
  for (let tier = 0; tier <= upTo; tier += 1) {
    const result = await run(repo, receipts, tier, ports);
    assert.equal(result.exitCode, EXIT.pass, ports.lines.join("\n"));
  }
}

test("tier 0 passes a clean diff and writes a receipt naming HEAD and the merge base", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    const ports = fakePorts();
    const result = await run(repo, receipts, 0, ports);
    assert.equal(result.exitCode, EXIT.pass);
    const receipt = readReceipt(receipts, head, 0);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.head, head);
    assert.equal(receipt.mergeBase, git(repo, "rev-parse", "main"));
    assert.equal(ports.calls.length, 0);
  });
});

test("tier 0 fails on each banned addition and names where it is", async () => {
  const cases = [
    [`${SKIP}("x", () => {});`, "unconditional skip, todo, only or fails"],
    [`${ONLY}("x", () => {});`, "unconditional skip, todo, only or fails"],
    [`${TODO}("later");`, "unconditional skip, todo, only or fails"],
    [`${XIT}("x", () => {});`, "x-prefixed test"],
    [`// ${LINT_OFF} no-console`, "lint or type suppression"],
    [`// ${TS_OFF}`, "lint or type suppression"],
  ];
  for (const [line, category] of cases) {
    await withRepo(async ({ repo, receipts }) => {
      write(repo, "packages/daemon/test/queue-store.test.ts", `import '../src/queue-store';\n${line}\n`);
      const head = commit(repo, "banned");
      const result = await run(repo, receipts, 0, fakePorts());
      assert.equal(result.exitCode, EXIT.failed, line);
      assert.deepEqual(readReceipt(receipts, head, 0).detail.findings, [
        { file: "packages/daemon/test/queue-store.test.ts", line: 2, category },
      ]);
    });
  }
});

test("tier 0 fails on loosened strictness in a tsconfig", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/tsconfig.json", '{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n');
    const head = commit(repo, "loosen");
    assert.equal((await run(repo, receipts, 0, fakePorts())).exitCode, EXIT.failed);
    assert.deepEqual(
      readReceipt(receipts, head, 0).detail.findings.map((finding) => finding.category),
      ["loosened type-checker strictness"],
    );
  });
});

test("tier 0 allows conditional skips, prose about suppressions, and skipLibCheck", () => {
  const lines = [
    { file: "a.test.ts", line: 1, text: `${["it", "skipIf"].join(".")}(process.platform === "win32")("x", () => {});` },
    { file: "a.test.ts", line: 2, text: `${["describe", "runIf"].join(".")}(hasTmux)("y", () => {});` },
    { file: "docs/as-built/test-layers.md", line: 3, text: `Never add ${TS_OFF} or ${SKIP}.` },
    { file: "tsconfig.json", line: 4, text: '"skipLibCheck": true,' },
    { file: "a.ts", line: 5, text: "const exit = fit(width);" },
  ];
  assert.deepEqual(scanAddedLines(lines), []);
});

test("tier 0 fails on a credential-shaped literal and never prints the value", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "docs/note.md", `token: "${FAKE_SLACK}"\n`);
    const head = commit(repo, "leak");
    const ports = fakePorts();
    assert.equal((await run(repo, receipts, 0, ports)).exitCode, EXIT.failed);
    const receipt = readReceipt(receipts, head, 0);
    assert.deepEqual(receipt.detail.findings, [{ file: "docs/note.md", line: 1, category: "credential-shaped literal" }]);
    assert.ok(!ports.lines.join("\n").includes(FAKE_SLACK.slice(5)));
    assert.ok(!JSON.stringify(receipt).includes(FAKE_SLACK.slice(5)));
  });
});

test("tier 0 fails on whitespace errors that git diff --check reports", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;   \n");
    const head = commit(repo, "trailing space");
    assert.equal((await run(repo, receipts, 0, fakePorts())).exitCode, EXIT.failed);
    assert.notEqual(readReceipt(receipts, head, 0).detail.diffCheckExit, 0);
  });
});

test("a dirty worktree is refused before anything runs, and no receipt is written", async () => {
  await withRepo(async ({ repo, receipts }) => {
    const head = commit(repo, "nothing");
    write(repo, "scratch.txt", "x\n");
    const ports = fakePorts();
    assert.equal((await run(repo, receipts, 0, ports)).exitCode, EXIT.refused);
    assert.equal(readReceipt(receipts, head, 0), null);
  });
});

test("each tier refuses to start without a passing receipt for every tier below it", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    commit(repo, "change");
    for (const tier of [1, 2, 3]) {
      const ports = fakePorts();
      const result = await run(repo, receipts, tier, ports);
      assert.equal(result.exitCode, EXIT.refused, `tier ${tier}`);
      assert.equal(ports.calls.length, 0, `tier ${tier} ran something`);
      assert.ok(ports.lines.some((line) => line.startsWith("REFUSED: tier 0 has not passed")));
    }
  });
});

test("tier 3 refuses when only tier 2 is missing, and runs nothing", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    commit(repo, "change");
    await passTiers(repo, receipts, 1, fakePorts());
    const ports = fakePorts();
    assert.equal((await run(repo, receipts, 3, ports)).exitCode, EXIT.refused);
    assert.deepEqual(
      ports.lines.filter((line) => line.startsWith("REFUSED")),
      ["REFUSED: tier 2 has not passed here (no receipt)."],
    );
    assert.equal(ports.calls.length, 0);
  });
});

test("a receipt against another merge base does not count", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    commit(repo, "change");
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 3;\n");
    commit(repo, "second change");
    await passTiers(repo, receipts, 0, fakePorts());
    const ports = fakePorts();
    const result = await runTier({ tier: 1, base: "unit~1", cwd: repo, receiptsRoot: receipts }, ports);
    assert.equal(result.exitCode, EXIT.refused);
    assert.ok(ports.lines.some((line) => line.includes("receipt is against merge base")));
  });
});

test("a failed re-run withdraws its own pass and every pass above it", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    await passTiers(repo, receipts, 2, fakePorts());
    const failing = fakePorts({ exitCodes: { "run lint": 1 } });
    assert.equal((await run(repo, receipts, 1, failing)).exitCode, EXIT.failed);
    assert.equal(readReceipt(receipts, head, 1).ok, false);
    assert.equal(readReceipt(receipts, head, 2), null);
    const ports = fakePorts();
    assert.equal((await run(repo, receipts, 3, ports)).exitCode, EXIT.refused);
    assert.ok(ports.lines.some((line) => line === "REFUSED: tier 1 has not passed here (its last run failed)."));
  });
});

test("tier 1 runs npm run lint and fails with it", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    commit(repo, "change");
    await passTiers(repo, receipts, 0, fakePorts());
    const ports = fakePorts({ exitCodes: { "run lint": 2 } });
    assert.equal((await run(repo, receipts, 1, ports)).exitCode, EXIT.failed);
    assert.deepEqual(ports.calls.map((call) => [call.command, ...call.args].join(" ")), ["npm run lint"]);
  });
});

test("the tier 2 selection unites imports, files naming a changed stem, and changed tests", async () => {
  await withRepo(async ({ repo }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    write(repo, "packages/daemon/test/new.test.ts", "export {};\n");
    commit(repo, "change");
    const picked = await selectReach({
      repo,
      mergeBase: git(repo, "rev-parse", "main"),
      changed: ["packages/daemon/src/queue-store.ts", "packages/daemon/test/new.test.ts"],
      packageName: "daemon",
      // graph-only.test.ts reaches queue-store only through another module, so only the import graph finds it.
      listChanged: async (packageDir) => [join(packageDir, "test/graph-only.test.ts")],
    });
    assert.deepEqual(picked.files, [
      "test/census-by-name.test.ts",
      "test/graph-only.test.ts",
      "test/new.test.ts",
      "test/queue-store.test.ts",
    ]);
    assert.deepEqual(picked.viaNamesOnly, ["test/census-by-name.test.ts", "test/queue-store.test.ts"]);
  });
});

test("tier 2 runs test:repo and vitest on each reached package, with 4 workers, no --reporter, scratch homes", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    await passTiers(repo, receipts, 1, fakePorts());
    const ports = fakePorts({ imported: { daemon: ["test/queue-store.test.ts"] } });
    assert.equal((await run(repo, receipts, 2, ports)).exitCode, EXIT.pass);
    const commands = ports.calls.map((call) => [call.command, ...call.args].join(" "));
    assert.deepEqual(commands, [
      "npm run test:repo",
      "nice -n 10 npx vitest run --maxWorkers=4 test/census-by-name.test.ts test/queue-store.test.ts",
    ]);
    assert.equal(ports.calls[1].cwd, join(git(repo, "rev-parse", "--show-toplevel"), "packages/daemon"));
    assert.ok(!commands.some((command) => command.includes("--reporter")));
    for (const call of ports.calls) {
      assert.notEqual(call.env.HOME, process.env.HOME);
      assert.match(call.env.OPENRIG_HOME, /gate-tiers-home-/);
      assert.ok(!existsSync(call.env.HOME), "the scratch home is removed after the run");
    }
    const receipt = readReceipt(receipts, head, 2);
    assert.deepEqual(receipt.detail.runs[1].summary, ["Test Files  3 passed (3)", "Tests  9 passed (9)"]);
  });
});

test("tier 2 builds the TUI before running its tests, and fails when a package run fails", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/tui/test/tui.test.ts", "export const changed = true;\n");
    const head = commit(repo, "tui change");
    await passTiers(repo, receipts, 1, fakePorts());
    const ports = fakePorts({ exitCodes: { "vitest run": 1 } });
    assert.equal((await run(repo, receipts, 2, ports)).exitCode, EXIT.failed);
    assert.deepEqual(
      ports.calls.map((call) => [call.command, ...call.args].join(" ")),
      ["npm run test:repo", "npm run build", "nice -n 10 npx vitest run --maxWorkers=4 test/tui.test.ts"],
    );
    assert.equal(readReceipt(receipts, head, 2).ok, false);
  });
});

test("tier 2 fails when test:repo fails", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "README.md", "changed\n");
    const head = commit(repo, "doc");
    await passTiers(repo, receipts, 1, fakePorts());
    assert.equal((await run(repo, receipts, 2, fakePorts({ exitCodes: { "test:repo": 1 } }))).exitCode, EXIT.failed);
    assert.equal(readReceipt(receipts, head, 2).ok, false);
  });
});

test("tier 3 runs the given command after every lower tier passed, and can record a baseline", async () => {
  await withRepo(async ({ root, repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    await passTiers(repo, receipts, 2, fakePorts());
    const ports = fakePorts();
    const baselineDir = join(root, "baselines");
    const command = ["heavy-run", "npm", "test"];
    assert.equal((await run(repo, receipts, 3, ports, { command, baselineDir })).exitCode, EXIT.pass);
    assert.deepEqual(ports.calls.map((call) => [call.command, ...call.args]), [command]);
    const baseline = JSON.parse(readFileSync(join(baselineDir, `${head}.json`), "utf8"));
    assert.equal(baseline.tier, 3);
    assert.equal(baseline.ok, true);
    assert.deepEqual(baseline.detail.summary, ["Test Files  3 passed (3)", "Tests  9 passed (9)"]);
  });
});

test("tier 3 defaults to npm test and fails with it", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    await passTiers(repo, receipts, 2, fakePorts());
    const ports = fakePorts({ exitCodes: { "npm test": 1 } });
    assert.equal((await run(repo, receipts, 3, ports)).exitCode, EXIT.failed);
    assert.deepEqual(ports.calls.map((call) => [call.command, ...call.args].join(" ")), ["npm test"]);
    assert.equal(readReceipt(receipts, head, 3).ok, false);
  });
});

test("a run that moves HEAD or dirties the tree does not pass", async () => {
  for (const [label, act] of [
    ["moves HEAD", (repo) => { write(repo, "x.txt", "x\n"); commit(repo, "during"); }],
    ["dirties the tree", (repo) => write(repo, "left-behind.log", "x\n")],
  ]) {
    await withRepo(async ({ repo, receipts }) => {
      write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
      const head = commit(repo, "change");
      await passTiers(repo, receipts, 0, fakePorts());
      const ports = fakePorts({ onExec: () => act(repo) });
      assert.equal((await run(repo, receipts, 1, ports)).exitCode, EXIT.failed, label);
      const receipt = readReceipt(receipts, head, 1);
      assert.equal(receipt.ok, false, label);
      assert.equal(receipt.problems.length, 1, label);
    });
  }
});

test("--list prints the tier 2 selection without a receipt, a prerequisite or a run", async () => {
  await withRepo(async ({ repo, receipts }) => {
    write(repo, "packages/daemon/src/queue-store.ts", "export const store = 2;\n");
    const head = commit(repo, "change");
    write(repo, "uncommitted.txt", "a mutant's tree is dirty\n");
    const ports = fakePorts();
    assert.equal((await run(repo, receipts, 2, ports, { list: true })).exitCode, EXIT.pass);
    assert.equal(ports.calls.length, 0);
    assert.equal(readReceipt(receipts, head, 2), null);
    assert.ok(ports.lines.includes("  test/census-by-name.test.ts"));
  });
});

test("summary lines are read from the default reporter's output, colour codes removed", () => {
  const output = "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m12 passed\x1b[39m (12)\n\x1b[2m      Tests \x1b[22m 80 passed | 2 skipped (82)\nnoise\n";
  assert.deepEqual(summaryLines(output), ["Test Files  12 passed (12)", "Tests  80 passed | 2 skipped (82)"]);
});

test("the command line rejects what it cannot honour", () => {
  for (const argv of [
    [],
    ["--tier", "4", "--base", "main"],
    ["--tier", "1"],
    ["--tier", "1", "--base", "main", "--list"],
    ["--tier", "2", "--base", "main", "--", "npm", "test"],
    ["--tier", "3", "--base", "main", "--"],
    ["--tier", "2", "--base", "main", "--baseline-dir", "x"],
    ["--tier", "0", "--base", "main", "--bogus"],
  ]) {
    assert.throws(() => parseArguments(argv), undefined, argv.join(" "));
  }
  assert.deepEqual(parseArguments(["--tier", "3", "--base", "main", "--", "heavy-run", "npm", "test"]).command, [
    "heavy-run",
    "npm",
    "test",
  ]);
});

test("the CLI exits 64 on a usage error and 2 when it refuses", async () => {
  await withRepo(({ repo, receipts }) => {
    const usage = spawnSync(process.execPath, [GATE, "--tier", "9"], { cwd: repo, encoding: "utf8" });
    assert.equal(usage.status, 64, usage.stderr);
    const refused = spawnSync(process.execPath, [GATE, "--tier", "3", "--base", "main", "--receipts", receipts], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /REFUSED: tier 0 has not passed here \(no receipt\)\./);
  });
});
