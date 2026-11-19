# ROUTING — capabilities these scenarios need from 51-01 / 51-02 (never shimmed here)

Per 51-03 mini-req 2 + README Risks 1/2/3/5: any missing runner verb, stub behavior, or
env-helper capability is a 51-01/51-02 gap. It ROUTES to that slice's owner — it is
never patched, shimmed, or worked around inside 51-03. Each item below is authored
against the locked/ruled shape so it drops in when the dependency lands.

## → 51-01 (stub runtime)
- **R-01. Emit repertoire (items 5–8) — LANDED for launch scripts; step-time `emit`
  still unbound.** The TWO emit-bearing scenarios — #6 (`compaction`) and #8
  (`slow_output`) — consume `emit.behavior ∈ {compaction, slow_output, mid_turn_death,
  restore}`. (#2 queue-baton uses an `env.queue` precondition + `daemon: {op: restart}`,
  NOT `emit` — corrected count; see `scripts/README.md`.) Step-4 (CLEARED, verdict
  1eb6d505) built come-up + readiness only; A5 item 5 (ctx%) landed at 13e26355 (CLEARed,
  verdict 53397f73); the four emit BEHAVIORS have since landed, but they run only from a
  per-seat launch script (`stub-script.ts`, executed by `stub-runner.ts`). A step-time
  `emit` is unbound, so #6/#8 PARSE and are reported NOT RUN at their first `emit` step.
  `usage_limit` is deliberately absent (real-runtime-only).
- **R-02. Scenario-resolved stub scripts (scripted-response contract) — LANDED (host
  mode).** A scenario maps a seat to a script path (relative to the scenario file) with
  `env.stub_scripts`; the pipeline writes it to `<seat cwd>/.openrig/stub/script.json`,
  which the stub reads at launch. Container mode refuses `env.stub_scripts`
  (`ScenarioModeUnsupportedError`). The default come-up-ready script (51-01 built-in)
  covers the lifecycle/queue/send scenarios now; no behavior scripts are authored under
  `scripts/` yet.
- **R-03. Stub ctx% eligibility (A5 item 5).** No scenario here asserts `ps` ctx% for a
  stub seat (it would gate on the A5 ContextMonitor GAP-1/GAP-2 increment). Flagged so a
  future ctx% scenario is added only once that lands.

## → 51-02 (scenario format + runner + env-helper)
- **R-10. The runner + hermetic env-helper — LANDED.** The runner script
  (`packages/daemon/scripts/run-scenarios.mjs`, over `scenario-pipeline.ts`) and the
  forced-local/scrubbed-env/scratch-HOME/fail-closed helper (`hermetic-env.ts`) exist. The
  hermeticity negative (proof item) is the helper's, exercised via these scenarios.
- **R-11. `daemon: {op: sigterm|restart}` step verb (#11) — LANDED in 51-02 v1.** Arch-ruled
  in ARCH-RULING-51-09 (the daemon-lifecycle verb on the SHARED env-helper lifecycle
  surface: single-owner spawn⇒kill/restart, re-spawned through the same
  forced-local/scratch/fail-closed guarantees under the injected clock). Per dev-planner's
  51-03 review: this verb is NOW IN the amended 51-02 v1 (A2 finals `28dc80cf` / `4180a007`)
  — no longer a rides-the-gate gap. #11 is authored in the ruled shape and is satisfied by
  the 51-02 v1 verb. The ops are `sigterm` and `restart` (`DAEMON_OPS` in
  `scenario-schema.ts`).
- **R-12. Multi-rig `up` (#9) — LANDED (host mode, workspaces-o9o.132).** #9 brings up two
  rigs to prove ps scope honesty. The locked format's `topology:` is scenario-singular; #9
  names the second rig with a per-step `up: {topology: ./rig-beta-stub.yaml}`, resolved
  against the scenario's folder. `down` stops every rig the run brought up, latest first;
  `restart` keeps the scenario's own rig. A staged (`env.stub_scripts`) or container topology
  has no scenario folder to offer, so there a per-step topology fails loud.
- **R-13. `equals` cross-surface normalizer (#10) — LANDED; #10 converted (workspaces-o9o.132).**
  The declarative normalizer ships as a per-surface projection mapping,
  `equals: {<surface>: {pluck, path, rig, join}}` (`scenario-normalizer.ts`), and it is the only
  form the validator accepts. #10 compares `ps` and `queue` by the rig set each names, with one
  `env.queue` item, and `ps` and the TUI's view (`tui_view`, R-21) by rig and agent count (`join`);
  the TUI's view counts only when fresh, and `tui_socket` (the TUI's own state) is asserted on its
  own. Its seed is armed before the equality and is a class the equality catches. Its storm
  uses `mutate`, which is unbound, so host mode reports it NOT RUN.
- **R-14. `env.pre_existing_tmux` hermetic fixture (#5) — OBSOLETE as written; replaced in
  workspaces-o9o.136.** Measured 2026-11-18 (release-7): seats run on hc, not tmux, so a
  pre-existing TMUX server is no longer anywhere a seat starts. The hc-era shape of GAP-7 (a seat
  host started with another HOME) is every scenario's: the scaffold starts its private hc core
  before the daemon, with its own HOME, and the seat still gets the daemon's HOME, because every
  seat's env is built by `seatEnvironment` (hc-seat.ts) from the daemon's. workspaces-o9o.136 drops
  the key from #5 and makes it assert the stub's preseed line. Until that lands, no runner code
  provides the fixture, so a scenario declaring `env.pre_existing_tmux` is reported NOT RUN, naming
  R-14, before any daemon starts (workspaces-o9o.132).
- **R-15. Disjunctive expect `any_of` (#5) — RESOLVED: not adopted.** #5's binding
  acceptance was "lands on ONE of two honest outcomes" (preseed reaches the seat OR the
  failure is visible on stream). The locked `expect` is a single match, and an `any_of`
  step fails validation (`UNKNOWN_STEP_VERB`). #5 no longer uses it: it asserts one
  outcome (`expect pane` contains `trust reached`) and leaves the failure-visible outcome
  to its `seed_regression` leg.
- **R-16. `ps` scope selector on `expect` (#9) — OPEN.** Asserting current-rig-default vs
  `-A` vs `--rig <name>` needs the runner to parameterize the shipped `rig ps` read. The
  `ps` reader runs only `rig ps --json` and takes no selector, so #9 asserts the default
  (current-rig) leg only; its `-A` / `--rig` legs are comments until the selector exists.
- **R-17. Handoff / queue-completion action (#11) — OPEN.** Faithfully reproducing the
  incident's `handoff-and-complete` closure may need a queue-completion action beyond
  `send`. #11 drives the executed work via `send`, but `send` runs `rig send`, which
  creates no queue item, and the grammar has no queue action verb: queue items come only
  from an `env.queue` precondition, applied after the first `up`. #11 now declares a claimed
  `env.queue` handoff (workspaces-o9o.132), so its first `expect queue` holds; its post-restart
  legs wait on R-20.

- **R-21. The TUI's view on the control socket (#10) — LANDED (workspaces-o9o.172).** The TUI
  socket's `state` returns its navigation address and `commands` its command registry; neither says what
  it renders. Its third read-only verb, `view`, returns a bounded digest of the snapshot every topology
  view is rendered from (each rig with its host and agents, the hosts it could not read, and `readAt`,
  when it last confirmed its read; names and status only). Scenarios read it as the `tui_view` surface
  (needs `env.tui`). Every list and string in the digest is capped (500 rigs, 200 agents per rig, 2000
  agents, 100 down hosts, 100 characters a string) as a first pass, and the whole reply line is at most
  1,000,000 UTF-8 bytes (agent detail goes first, then down hosts, then rig rows; `truncated` when
  anything is cut; the instance id in its envelope is at most 128 UTF-8 bytes, refused at start), and each rig
  carries its whole `agentCount`, or `null` with `inventory: not-loaded|unavailable` when the TUI has
  not read its seats: the TUI reads a rig's seats only once that rig is selected (measured on a real
  TUI, whose landing page holds no seats), so #10 first drills it into the rig with the `tui` action
  (`tui: {rig: <name>}`, which sends only the TUI's own `rig <name>` line to its socket, never the
  daemon). A view counts only when FRESH: #10 asserts `settled`, not `stale`, and
  `confirmedDuringStep` (the reader marks a view whose `readAt` is at or after the expect's start; it
  assumes the TUI and the runner read one wall clock on one host). #10 then compares `ps` and the TUI
  by rig and agent count, so a stale view, one confirmed before the step, one with fewer agents, or
  one whose seats were never read fails (pinned by `test/scenario-one-view-state-library.test.ts`).

## → 51-06 (transactional execution-closure) — #11 GREEN gate
- **R-20. #11 GREEN gate = the 51-06 transactional-closure reconcile (POOLED, NOT in
  main).** kill-daemon-mid-handoff is RED-FIRST: its product-side green gate is the 51-06
  transactional execution-closure + executed-unclosed reconcile, confirmed NOT in main at
  `13e26355` (dev-planner 51-03 review, grounded at source), and still absent from src at
  release-6 744ee7692 (workspaces-o9o.132; built under workspaces-o9o.135). Expected-RED until 51-06
  lands; recorded as expected-RED, never massaged. **Correction (supersedes an earlier
  acting-orch feed):** `bfbc2182` is the 90840bcb response-integrity CLI commit and
  `4cd2c313` is the slow-op-recorder drain latch — BOTH touch no queue/closure code and
  are orthogonal to #11; neither satisfies its gate. The daemon SIGTERM/restart is just
  the `daemon: {op}` verb (R-11); queue-claim durability across a SIGTERM is baseline
  SQLite, not a slice gate. Of #11's other blockers, the runner (R-10) and the
  `daemon:{op}` verb (R-11) have landed. Still open: its setup (R-17), and its
  post-restart `queue` and `stream` assertions, which match `items:` / `events:` mappings
  while both reads (`rig queue list --json --full`, `rig stream list --json`) return lists.

## Path finalization
These files live under `packages/test-system/` as a self-contained drop. The EXACT tree
location inside the 51-02 runner's home is finalized by the 51-02 build; the shipped
layout is CO-LOCATED — `scenarios/` carries the scenario YAMLs with their fixture assets
(topologies, agents/, culture) beside them, `scripts/` beside it; the formerly separate
`fixtures/` dir was absorbed into `scenarios/`.
