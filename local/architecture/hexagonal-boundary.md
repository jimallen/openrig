# The daemon's hexagonal boundary (fork-owned)

**Fork-owned.** This page, `hexagonal-baseline.txt` beside it, `packages/daemon/test/fork-hexagonal-boundary.test.ts` and
`packages/daemon/test/helpers/fork-hexagonal-boundary.ts` exist only on the fork (jimallen/openrig). Upstream
(mvschwarz/openrig, the git remote `origin`) has none of them and none of them is proposed upstream. OF-223; Jim's
decision: "enforce + ratchet". Measured at fork commit `eb2fe398`.

Why here and not in `ARCHITECTURE.md`: that file is upstream's, and every fork edit to an upstream file is a merge conflict
waiting for upstream's next edit to the same lines. `local/` is the fork's directory for what is not for upstream
(`local/README.md`). `docs/` is not used: its guard admits only `docs/as-built/`, `docs/reference/` (which ships to every
user) and `docs/releases/`, and their indexes are upstream files. No upstream file links here; the census test's failure
message names this page, which is how a contributor who trips the rule finds it.

## The model

- **The domain** is `packages/daemon/src/domain/` (every `*.ts` under it, nested folders included). It holds OpenRig's
  behaviour: services, orchestrators, the rules about rigs, seats, the queue and delivery.
- **A port** is an interface or type the domain declares for something it needs from the outside world (a terminal, a
  process, a file, the database, the clock). The domain owns its ports: they are declared in `src/domain`, in the domain's
  language, and shaped by what the domain needs, not by what one implementation happens to offer.
- **An adapter** implements a port against the outside world. Adapters live in `src/adapters/`.
- **The composition root** is `src/startup.ts` (`createDaemon()`): it constructs each adapter and hands it to the domain
  services that take the port, usually through a constructor. `src/routes/`, `src/server.ts` and `src/index.ts` are the
  driving side (HTTP in); they may import both the domain and the adapters.

## The rule

A file in `packages/daemon/src/domain/` must not import:

1. **an adapter**: any module under `packages/daemon/src/adapters/` (rule `domain-imports-adapter`);
2. **the database layer**: any module under `packages/daemon/src/db/` (rule `domain-imports-db`);
3. **an infrastructure module** (rule `domain-imports-infrastructure`): `better-sqlite3` (and its subpaths),
   `node:fs`, `node:fs/promises`, `node:child_process`, `node:net`, `node:http`, `node:os`. The bare names (`fs`, `os`, ...)
   are the same modules.

"Import" means every form that loads or names a module: a static `import` (side-effect `import "x"` included), `import
type`, an import whose specifiers are all inline `type`, `export ... from` and `export * from`, `import x = require("x")`,
a dynamic `import("x")`, `require("x")`, and the type-position `import("x").T`. A module named only in a string, a template
or a comment is not an import.

**Type-only imports count.** `import type { TmuxAdapter } from "../adapters/tmux.js"` and `import type Database from
"better-sqlite3"` are violations, recorded with the kind `type` beside the kind `value`, so the two are counted and
ratcheted separately. Reasoning:

- The dependency the rule forbids is a dependency of **design**, not of the bundle. A domain file that names
  `TmuxAdapter` or `Database` is written against that adapter's or that library's shape; replacing the adapter means
  editing the domain. That is exactly what a port prevents. A type import is erased at run time, so it costs nothing at
  load time, but it costs the same at change time.
- Counting them separately keeps the number honest: 152 of the 157 `better-sqlite3` triples and 48 of the 106 adapter
  triples are type-only, a different and cheaper class of fix (declare the port type in the domain; often no code moves)
  than a value import (a behaviour dependency).
- A `value` import that becomes type-only is progress: the check then asks for the baseline line to be **tightened** from
  `value` to `type`. A `type` line never permits a `value` import of the same target.

Precisely, for the check: one violation is the triple (domain file, target, kind), where target is the path under
`packages/daemon` for an adapter or db module (`src/adapters/tmux.js`, as the specifier names it) and the normalised module
name for an infrastructure module (`node:fs`), and kind is the statement's: `type` for a type-only statement, otherwise
`value` (a file with both kinds of import of one target has two triples). Several statements of the same triple are one violation,
so a baseline line survives edits that only move or split import statements. The cost of that choice: a second statement
of a target the file already has at the same kind is not new, and is not caught.

**What to do instead.** Declare what the domain needs as a port (an interface or type) in `src/domain`, implement it in
`src/adapters`, and wire the adapter in `src/startup.ts`; the domain service takes the port in its constructor.
`src/adapters/pi-resume.ts` already takes its file system as an injected interface (`readFile`, `writeFile`), which is the
shape.

### Where repositories belong

A repository is a port: the domain declares the interface (what it reads and writes, in domain terms) in `src/domain`.
The SQLite implementation is an adapter: it goes under `src/adapters/` (for example `src/adapters/sqlite-<name>-repository.ts`)
and is the only code that sees `better-sqlite3`; `src/db/` stays the schema (connection, migrations). New repositories
follow this. Today the 11 files named `*-repository.ts` (`bootstrap`, `chat`, `discovery`, `install`, `package`, `pod`,
`queue`, `queue-wake`, `rig`, `snapshot`, `watchdog-jobs`) are SQLite implementations living in `src/domain`, and SQLite
reaches much further than the files with that name: 156 domain files import `better-sqlite3`, 151 of them type-only (the
`Database` handle passed through constructors). They are in the baseline and stay where they are (below).

## What the rule does not cover yet

- **Other packages**: `packages/cli`, `packages/ui`, `packages/tui` and `packages/test-system` have no boundary rule and
  no check.
- **The rest of the daemon**: `src/routes`, `src/server.ts`, `src/startup.ts`, `src/index.ts`, `src/adapters`,
  `src/db`, `src/lib`, `src/terminal` and the `*-surface.ts` files are not checked. `src/lib` is not classified: the domain
  may import it, and nothing checks that it stays free of I/O.
- **Modules not on the list.** At `eb2fe398` the domain also imports `node:worker_threads` (1 statement), `node:perf_hooks`
  (4), `tar` (1, which reads and writes files) and `hono` (4, the HTTP framework). None is a violation today; widening the
  list is Jim's decision (this unit records them and does not act on them).
- **Code in a string.** `src/domain/slow-op-recorder.ts` builds a worker from a `String.raw` template that calls
  `require("node:fs")`; that file I/O is invisible to a parser by construction. An independent regex scan, which does read
  strings, found no other forbidden module named inside a string at `eb2fe398`.
- **An import the parser cannot resolve**: a dynamic `import()` or `require()` whose argument is not a string literal. At
  `eb2fe398` there is one, `src/domain/skill-mirror-drift.ts` (`import(pathToFileURL(scriptPath).href)`); the test pins
  that list, so a new one fails the test.

## Targets that look misplaced

Classified by each target's own value-import closure within `src/` (does it reach an infrastructure module?) and by
reading it for `process.*` and exec calls. These are recorded in the baseline like every other target; the observation is
that they may be domain code living in the adapters folder, so moving them (in a fork-only change, see ownership below)
would remove violations without writing a port.

| Target | Domain statements | Reading |
|---|---|---|
| `shell-quote.js` | 15 | A 4-line pure string function. Domain code in the wrong folder. |
| `pda-runner-protocol.js` | 14 | A wire protocol (types, parsers, constants) plus one `process.kill(pid, 0)` liveness probe. The protocol is a port contract; the probe is an adapter. |
| `pi-runner-protocol.js` | 3 | Same shape: protocol definitions, plus argv building for the runner's child. |
| `non-interruptive.js`, `runner-terminal-ended.js`, `hc-delivery-token.js`, `hc-dialog-input.js`, `seat-gate-marker.js`, `hc-version.js`, `omp-resume.js`, `pda-resume.js` | 1 to 3 each | No infrastructure import in their closure and no process access: parsing, constants or types. Candidates for the domain. |
| `yolo-mode.js`, `hc-seat.js` | 2, 1 | No infrastructure import; they default a parameter to `process.env`. Pure apart from that ambient read. |
| `tmux.js` | 35 (the largest) | A real adapter (`node:fs/promises`, `node:os`), the retained tmux implementation kept for rollback. 29 of its 32 triples are type-only (by a line grep, most name `TmuxAdapter`; four name `ExecFn`). A port type for "the seat host" would retire most of these. |

## Who owns a file, and how far the rule applies

The fork merges from upstream. Code the fork moves in an upstream file is a merge conflict the next time upstream edits
it, so the rule is strict about **new** violations everywhere but asks for **fixes** only in code the fork owns.

- **Upstream-owned file**: its path exists in upstream (`origin/main`, or the merge base of the fork's `HEAD` with it),
  or the fork renamed it from such a path (git's rename detection, `git diff -M`, the default a merge uses).
- **Fork-only file**: neither.
- **Fork-modified upstream file**: upstream-owned, and the fork's copy differs from upstream's.

Each baseline line carries an origin. A line is `upstream` when an upstream copy of the file has the same target at the
same or a stronger kind (`value` is stronger than `type`); otherwise it is `fork`. The upstream copies are origin/main's
and the merge base's, each read at the file's own path, at the path it had before a fork rename, and at the path upstream
renamed it to; each copy's relative imports are resolved from its own path. The attribution scans the upstream blobs with
the same parser (no blame, so a moved or reformatted line still matches).

Measured on `eb2fe398` against origin/main `bb007efa` and the merge base `fc41b273`: 346 `upstream`, 102 `fork`.

- Of the 102 `fork` lines, 78 are in 52 fork-only files and 24 in 15 fork-modified upstream files. For each of the 23
  distinct (file, target) pairs of those 24, `git log -S` finds a fork commit since the merge base that adds or removes
  the import's module name, and no `fork` line sits in a file the fork has not changed since the merge base.
- Four lines are `upstream` only through the merge base: upstream has since removed them (`bootstrap-orchestrator.ts`,
  `native-process-lineage.ts`, `resume-metadata-refresher.ts` → `node:child_process`; `restore-check-service.ts` →
  `shell-quote.js`). Without the merge base they would be charged to the fork.
- Two lines are `upstream` only through rename following: the fork renamed `claim-service.ts` to
  `session-reconciler.ts`, whose `better-sqlite3` and `tmux.js` type imports came from upstream. Path-only attribution
  charged them to the fork; the dry merge below found it, because a merge carries upstream's `claim-service.ts` changes
  into `session-reconciler.ts`.

Limits of the attribution, by construction: a violation the fork added to an upstream file that upstream's copy also has
(at the same or a stronger kind) reads as upstream's; that is harmless, since the two are the same import. A rename git
does not detect (under 50% similar) reads as a fork-only file.

The rule per file:

| File | New violation | Existing violation |
|---|---|---|
| Fork-only | Forbidden. | Fix it when a unit already touches the file: replace the import with a port, delete the baseline line. |
| Upstream-owned, unmodified by the fork | Arrives only by merge; the merge procedure records it as `upstream`. Nobody fixes upstream code to pass. | Leave it. Never edit an upstream-owned file only to satisfy this rule. Its line goes when upstream removes the import. |
| Fork-modified upstream file | Forbidden: the fork's own edits add no violation. | `upstream` lines: leave them. `fork` lines: fix one only when a unit already touches those lines and the fix stays within the fork's own lines (for example, the fork's import is replaced by a port the fork's code takes). If the fix would move upstream's code (a constructor upstream wrote, an upstream call site), leave it and say so in the unit. |

## The check

`packages/daemon/test/fork-hexagonal-boundary.test.ts` runs in the daemon suite (`npm test -w packages/daemon`). It parses
every domain file, compares the violations with `hexagonal-baseline.txt`, and fails on:

- a violation not in the baseline (naming the file and lines, the target, the kind and the rule, and how to fix it);
- a stale line, whose violation is gone (naming the baseline line to delete);
- a `value` line whose import became type-only (to tighten);
- a non-literal dynamic import it cannot read, other than the known one;
- a malformed, duplicate or unsorted baseline line.

It reads no git state, so it behaves the same in any checkout. The baseline only shrinks; the one way a line is added is
the merge procedure below, and only for upstream's violations. **Never add a `fork` line by hand.**

The same scanner runs from the command line (from the repository root):

```sh
node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts check   # what the test compares, as text
node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync [--upstream origin/main]
```

## Merging from upstream

1. `git fetch origin`, then merge `origin/main` as usual and resolve its conflicts. This rule's files are fork-only, so
   they add none.
2. Run `node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync`. It:
   - **prunes** every stale line (a violation upstream's or the fork's change removed) and **tightens** lines whose import
     became type-only, printing each;
   - **adds**, marked `upstream`, each new violation that an upstream copy of the file (origin/main's or the merge
     base's, following renames) also has;
   - **refuses** the rest (exit 1, printed with the fix): those are fork-authored, for example a fork edit that a merge
     resolution carried into a domain file. Fix them, or take them to review; they are not the merge's to record.
3. Run the census test, and commit the baseline change with the merge.

A merge never fails because of upstream's violations, and nobody edits upstream code to pass: step 2 records them.
`sync` needs the `origin/main` ref; the test does not.
