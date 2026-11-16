# OpenRig Instance Layout

An OpenRig instance keeps its managed state under one configured
`$OPENRIG_HOME`. `rig daemon start` and direct daemon first start reconcile the
same additive layout before the database is opened or the listener binds.

```text
$OPENRIG_HOME/
  config.json             # typed instance settings; created as an empty object
  state/                  # runtime-owned durable state
  context/                # addressable context library (`context.root`)
    system/
      system-world.yaml   # selected baseline context + skill identities
  skills/                 # managed skill catalog (`skills.root`)
  workspace/              # project work tree (`workspace.root`)
    SPEC.md                # project intent
    project.yaml           # project context and skill selection
    workspace.yaml         # project-location catalog
    .gitignore
    missions/
    exhaust/
  specs/                  # canonical instance spec library
  topology/               # instance, rig, pod, and seat continuity tree
  plugins/                # installed OpenRig plugins
  run/                    # process coordination files
  logs/                   # daemon and operation logs
  transcripts/            # durable per-seat terminal transcripts
  backups/                # operator-created recovery artifacts
  secrets/                # local connector and host secrets
```

The initializer creates only missing managed entries. It never overwrites an
existing file, and it checks every managed path before the first write. A path
with the wrong type is reported by its exact location; unrelated user-owned
content is preserved. A second run against an already-converged instance writes
nothing.

The workspace subtree is owned by the [Project Workspace
Contract](project-workspace.md). The instance initializer calls that owner
rather than carrying another copy of its file bytes. `skills/` and `topology/`
are created as empty roots; their respective catalog and topology workflows own
their contents.

## Permissions

An instance is private to the user who runs it. Seat conversations (Pi session
files, Codex rollouts, pane transcripts) hold full tool output, which can include
secrets, so the daemon keeps `$OPENRIG_HOME` at `0700` on every start, whatever
the login umask. On the same pass it removes group and other access from
everything below the home, keeping the owner's bits, so an executable such as
`rig-bin/git` or a `handover/*/release.sh` stays executable by its owner.

The pass never follows a symlink and never walks outside the home: a workspace,
context, skills or topology root configured elsewhere keeps its modes, and so
does the target of a link such as `state/pi/<seat>/agent/auth.json`. A file it
cannot change is named in the daemon log; start goes on.

The daemon will not start on a home that is the user's own home directory or one
above it. It refuses before it writes anything, and it compares real paths as
well as the path given, so a symlinked alias of the home directory or of one of
its ancestors is refused too.

Transcripts can live outside the home (`transcripts.path`). At every start the
daemon gives that root the same pass (folders `0700`, files `0600`, symlinks not
followed), and the transcript writer creates new folders `0700` and new
transcripts `0600`.

One window stays open: a file or folder swapped for a symlink between the check
and the mode change. Closing it needs `openat`-style calls that Node does not
have. It needs a concurrent process running as the same user, which can already
read and change those files, so Jim accepted it on 2026-11-16 under the same
threat model as o9o.17.

## Context library setting

The addressable context library has one typed setting and one environment
override:

| Surface | Value |
| --- | --- |
| Config key | `context.root` |
| Environment | `OPENRIG_CONTEXT_ROOT` |
| Default | `$OPENRIG_HOME/context` |
| Resolved property | `contextRoot` |

The removed `context.packs_root`, `context.packsRoot`, and
`OPENRIG_CONTEXT_PACKS_ROOT` spellings are refused with guidance to use
`context.root`; they are not compatibility aliases. Bundle installation and
`rig context add` both resolve the same configured landing root.

## System World

The System World is the instance-wide baseline selected before topology/role
and Project World material. Its versioned manifest contains ordered context-pack
references plus managed skill identities; it never contains authoritative skill
bytes. The default manifest is installed additively at
`$OPENRIG_HOME/context/system/system-world.yaml`.

| Surface | Value |
| --- | --- |
| Config key | `context.system_world` |
| Environment | `OPENRIG_CONTEXT_SYSTEM_WORLD` |
| Default | `default` |
| Resolved property | `systemWorld` |

`default` selects the installed manifest, a safe relative or absolute path
selects an explicit replacement, and `disabled` is an explicit off state.
Missing or malformed selections fail; absence is never inferred as disablement.
`rig context work-install --json` reports the effective state, source, manifest,
context selectors, and skills. With `--runtime`, its managed skill loadout then
combines System World, topology, and Project World selectors with provenance.
The catalog is a Git checkout. A skill folder with uncommitted or untracked content is
skipped by itself and named. With `--runtime`, work-install reports selected skips with
exit 1. It inspects by default; `--apply-skills` projects the remaining clean skills while
keeping any previously projected copy of the skipped skill. An uncommitted change directly
in the catalog root, such as `catalog.yaml`, still makes the whole catalog unavailable.

For a pre-0.5.9 home, use the `openrig-upgrade` skill's
`migrate-telemetry-state-0.5.9.mjs` helper as an Agent-Operated Migration. Its
order is plan → `--apply-state` → separately activate the target runtime →
paired new-root samples newer than any bounded legacy tail → `--verify` → the
non-destructive finalizer `--apply-library`. During activation, runtime readers
are canonical-first with legacy-fallback and a custom context-library root
remains stable. Verification binds exact accepted tail bytes; finalization
revalidates them, copies without overwrite, and switches config last. It never
removes the legacy telemetry or library. `--rollback` reverses only helper-owned
config, System World, empty-directory, and copied-library effects. The helper
must stop rather than claim success if writer/reader convergence, resumed legacy
writes, byte drift, collision, or any migration-owned path cannot be proved.
`--help` prints the phase grammar without inventorying; no phase flag is the
intentional read-only plan, and unknown options fail nonzero before plan or
mutation.

## Existing spec libraries

Creating `$OPENRIG_HOME/specs` does not migrate existing launch-era specs.
Upgraded installations may still have a separate legacy specs library that the
runtime reads for compatibility. Treat the two-home state as an explicit
limitation: use the live spec-library commands to determine where a spec is
served from, and do not infer convergence merely because the canonical
directory exists.

Config updates publish a complete replacement file atomically where directory
permissions and the filesystem allow it. On POSIX systems, replacement preserves
the existing owner, group, and read/write/execute permission bits. If creating or
preparing the replacement, or renaming it, fails with `EACCES`, `EPERM`, or `EBUSY`,
the stores write the writable target in place, preserving compatibility with
unwritable directories and single-file bind mounts. This fallback is not atomic
and retains the previous partial-write risk. Read-only config files are refused.
Other errors, including `ENOSPC`, leave the original file intact on the atomic
path. Atomic replacement does not carry extended ACLs or other inode metadata;
a hard-linked second name continues to refer to the previous file.
