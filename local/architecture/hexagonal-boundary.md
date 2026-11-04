# The daemon's hexagonal boundary (fork-owned)

**Fork-owned.** This page, `hexagonal-baseline.txt` beside it, `packages/daemon/test/fork-hexagonal-boundary.test.ts` and
`packages/daemon/test/helpers/fork-hexagonal-boundary.ts` exist only on the fork (jimallen/openrig). Upstream
(mvschwarz/openrig, the git remote `origin`) has none of them and none of them is proposed upstream. OF-223; Jim's
decision: "enforce + ratchet". Measured at fork commit `eb2fe398`.

Why here and not in `ARCHITECTURE.md`: that file is upstream's, and this rule is the fork's. `local/` is the fork's directory for what is not for upstream
(`local/README.md`). `docs/` is not used: its guard admits only `docs/as-built/`, `docs/reference/` (which ships to every
user) and `docs/releases/`, and their indexes are upstream files. No upstream file links here; the census test's failure
message names this page, which is how a contributor who trips the rule finds it.

## The model

- **The domain** is `packages/daemon/src/domain/`: every file under it that the daemon build compiles (`.ts`, `.tsx`,
  `.mts`, `.cts` and their `.d.*` forms, read from `packages/daemon/tsconfig.json` through the compiler), nested folders
  included. It holds OpenRig's
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
- **Indirect paths, known and not counted.** The rule reads a domain file's own imports, not what the modules it imports
  reach. Two such paths exist at `eb2fe398`:
  - `src/openrig-compat.ts` (a top-level daemon module, neither domain nor adapter) value-imports `node:fs` and `node:os`,
    and 14 domain files value-import it, so they reach both modules through it;
  - `src/domain/project-classifier.ts` type-imports `src/routes/require-sender-identity.js`, a module of the HTTP side
    (it imports `hono`): the domain depending on the driving side. The rule does not name `src/routes`.
  Neither is a violation today.
- **Modules allowed for now.** At `eb2fe398` the domain also imports `node:worker_threads` (1 statement), `node:perf_hooks`
  (4), `tar` (1, which reads and writes files) and `hono` (4, the HTTP framework). By Jim's decision the list stays as it
  is: these four are allowed for now and will be revisited later.
- **Code the scanner cannot see.** `src/domain/slow-op-recorder.ts` builds a worker from a `String.raw` template that
  calls `require("node:fs")`; that file I/O is invisible to a parser by construction. An independent regex scan, which
  does read strings, found no other forbidden module named inside a string at `eb2fe398`. Two more forms are invisible
  and not even reported as unresolvable: a `require` made with `createRequire(...)` (`createRequire(import.meta.url)("node:fs")`)
  and code compiled at run time with `new Function(...)`. There are 0 of either in the domain at `eb2fe398`.
- **An import the parser cannot resolve**: a dynamic `import()` or `require()` whose argument is not a string literal. At
  `eb2fe398` there is one, `src/domain/skill-mirror-drift.ts` (`import(pathToFileURL(scriptPath).href)`); the test pins
  that list, so a new one fails the test.

## Targets that look misplaced

Classified by each target's own value-import closure within `src/` (does it reach an infrastructure module?) and by
reading it for `process.*` and exec calls. These are recorded in the baseline like every other target; the observation is
that they may be domain code living in the adapters folder, so moving them (in a unit that already touches them) would
remove violations without writing a port.

| Target | Domain statements | Reading |
|---|---|---|
| `shell-quote.js` | 15 | A 4-line pure string function. Domain code in the wrong folder. |
| `pda-runner-protocol.js` | 14 | A wire protocol (types, parsers, constants) plus one `process.kill(pid, 0)` liveness probe. The protocol is a port contract; the probe is an adapter. |
| `pi-runner-protocol.js` | 3 | Same shape: protocol definitions, plus argv building for the runner's child. |
| `non-interruptive.js`, `runner-terminal-ended.js`, `hc-delivery-token.js`, `hc-dialog-input.js`, `seat-gate-marker.js`, `hc-version.js` | 1 to 3 each | No infrastructure import in their closure and no process access: parsing, constants or types. Candidates for the domain. (`omp-resume.js` and `pda-resume.js` are not: their value closures reach `pi-resume.js`, which reads `process.env`, and `pda-runner-protocol.js`'s `process.kill`.) |
| `yolo-mode.js`, `hc-seat.js` | 2, 1 | No infrastructure import; they default a parameter to `process.env`. Pure apart from that ambient read. |
| `tmux.js` | 35 (the largest) | A real adapter (`node:fs/promises`, `node:os`), the retained tmux implementation kept for rollback. 29 of its 32 triples are type-only (by a line grep, most name `TmuxAdapter`; four name `ExecFn`). A port type for "the seat host" would retire most of these. |

## How the rule applies: fix on touch

Upstream (origin/main) is a source of ideas, not a merge target: the fork does not merge origin/main whole; a good upstream
change is ported selectively, as a fork unit. So no daemon domain file has special status because of where it came from.

- **New violations** are forbidden in every domain file.
- **Existing violations** are fixed on touch: a unit that already touches a domain file may fix that file's violations
  within its own scope (declare the port, implement it in an adapter, wire it in `src/startup.ts`) and delete the
  baseline lines it retires. No unit is opened only to fix one, and no unit widens its scope to fix one.
- **A rename, move or split is a touch**, so the unit doing it may fix the file's violations, like any other touch.
  Renaming a domain file that has a baseline line makes the census report the old line stale and the import at the new
  path new. Commit the rename, then run `sync`:
  - for an `upstream`-origin line, `sync` follows the committed rename to upstream's copy of the file, prunes the old line
    and re-records the import at the new path as `upstream` (exit 0). That re-recording is accepted: `sync` reproduces
    the line, so the review rule for added lines below holds;
  - for a `fork`-origin line, no upstream copy has the import, so `sync` prunes the old line and refuses the new one
    (exit 1, nothing written). Only here must the unit fix the import, in the same change.
  A rename git does not detect (under 50% similar), or a split into a new file, reads as the fork's, and is refused the
  same way.

### The `upstream` and `fork` tags: history only

Each baseline line carries an origin tag, recorded once when the baseline was seeded. It is history, not a rule: it says
whether the violation came from upstream's code or the fork's, and nothing treats the two differently. A line is
`upstream` when an upstream copy of the file has the same target at the same or a stronger kind (`value` is stronger than
`type`); otherwise it is `fork`. The upstream copies are origin/main's and the merge base's, each read at the file's own
path, at the path it had before a fork rename, and at the path upstream renamed it to; each copy's relative imports are
resolved from its own path. The attribution scans the upstream blobs with the same parser (no blame, so a moved or
reformatted line still matches).

At `eb2fe398` the seed tagged 346 lines `upstream` and 102 `fork`. A rename git does not detect (under 50% similar)
reads as the fork's; a fork import that upstream's copy also has reads as upstream's.

## The check

`packages/daemon/test/fork-hexagonal-boundary.test.ts` runs in the daemon suite (`npm test -w packages/daemon`). It parses
every domain file the daemon's tsconfig compiles (so a new `.tsx`, `.mts` or `.cts` file is read like a `.ts` one), compares the violations with `hexagonal-baseline.txt`, and fails on:

- a violation not in the baseline (naming the file and lines, the target, the kind and the rule, and how to fix it);
- a stale line, whose violation is gone (naming the baseline line to delete);
- a `value` line whose import became type-only (to tighten);
- a non-literal dynamic import it cannot read, other than the known one;
- a malformed, duplicate or unsorted baseline line.

It reads no git state, so it behaves the same in any checkout. That also means it cannot tell a line `sync` wrote from
one written by hand: a new violation plus a hand-added line passes it. The baseline only shrinks; the one way a line is
added is `sync`, when a unit ports an upstream change (below) or renames a file with an `upstream`-origin line (above),
and only for violations upstream's own code has. **Never add a line by hand.**

**The review rule for a diff that adds a baseline line.** The reviewer deletes the added lines and runs `sync` (from the
repository root, with `origin` fetched). A genuine upstream line comes back byte-identical; a fork line is refused with
exit 1 and nothing is written. Only lines `sync` reproduces are accepted.

The same scanner runs from the command line (from the repository root):

```sh
node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts check   # what the test compares, as text
node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync [--upstream origin/main]
```

## Porting an upstream change

A unit that ports a change from upstream brings upstream's code into the fork, and with it any violation that code has.
The ported code is upstream's design; whether to fix it now or keep it as upstream wrote it is the porting unit's call,
within its scope.

1. `git fetch origin`, then port the change (cherry-pick, or rewrite it) as a fork unit.
2. If the census test reports new violations in what you ported and you keep them, run
   `node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync`. It:
   - **prunes** every stale line and **tightens** lines whose import became type-only, printing each;
   - **adds**, tagged `upstream`, each new violation that an upstream copy of the file (origin/main's, or the merge base's,
     following renames) also has;
   - **refuses** the rest (exit 1, printed with the fix, and nothing written): an import upstream's copy does not have is
     the fork's own, and the fork adds no new violation. Fix it with a port, then run `sync` again.
3. Run the census test, and commit the baseline change with the port; the reviewer sees each added line in the diff.

When nothing was ported and no file with an `upstream`-origin line was renamed, `sync` only prunes and tightens, so it is
also the quick way to clear stale lines after any change. After a committed rename of such a file it also re-records that
file's lines at the new path, tagged `upstream`.
It needs the `origin/main` ref; the test does not.
