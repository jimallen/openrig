# Integration scenarios

The first PR automation increment is described in [ci/README.md](ci/README.md).
It runs the existing daemon-restart baton fixture plus a fault control in the
installed-package testbed, now alongside the library's queue-baton scenario and
its explicit seed binding. The same job also runs `transcript-reads-addressed-seat`,
`capture-returns-addressed-seat` and `shipped-agent-ref-resolves` once each, healthy only
(`ci/result.mjs`).
Hosted green/red execution is required before claiming either verified. The
fifteen authored scenarios below are a broader target; they are not fifteen
admitted CI passes.

## Historical 51-03 seed contract — the ten (+ one)

Compose-only L2 scenario set for the OpenRig containerized test system (mission
release-0.5.1). Each scenario pins a NAMED defect class from the 0.4.8/0.5.0 marathon
and becomes standing infrastructure instead of a hand-built probe.

## Authoring authority (verified at authoring time)
- 51-03 spec: README `99f35af5c2d854a7` / PRD `aa0638f161cc3b82` (hash-verified).
- **Format is the LOCKED 51-02 spec** (README `b157f5bc68940963` / PRD `1bf3340188e39212`)
  and the BINDING arch shape `ARCH-SHAPE-scenario-format-and-runner` sha256
  `fc30a736c104863a…`. The daemon-lifecycle step verb for #11 is arch-ruled in
  `ARCH-RULING-51-09-host-identity-and-51-02-step-verb` (`daemon: {op: sigterm|restart}`
  on the shared env-helper's lifecycle surface).
- `emit.behavior` vocabulary = 51-01's LOCKED FOUR {compaction, slow_output,
  mid_turn_death, restore}. `usage_limit` is real-runtime-only and MUST fail validation
  loud in a stub topology — no scenario here names it.
- Assertions ride the shipped-observable surface set ONLY: `ps` · `queue` · `stream` ·
  `scope` · `pane` · `transcript` · `tui_socket` · `tui_view` · `policy_provenance`. `tui_view` reads the TUI's
  `view` verb, the digest of the world it renders, so a TUI can join a cross-surface `equals` (R-21). Read inside an
  `expect`, it also carries `view.confirmedDuringStep`: the TUI's `readAt` is at or after the moment that expect began.
  That rests on one assumption: the TUI and the scenario runner read ONE wall clock (they run on one host; the scenario
  clock injection reaches only the daemon). An `equals` projection may `join` two or more fields of each element with
  `/` (e.g. `{ join: [name, nodeCount] }`), exclusive with `pluck`; a field present but `null` joins as
  `null`. The TUI reads a rig's seats only once that rig is selected, so a scenario comparing agents first
  runs the `tui` action, `tui: {rig: <name>}` (needs `env.tui`): it sends only the TUI's own `rig <name>`
  drill to the TUI socket, never to the daemon, and fails if the TUI does not accept it. `proof` is
  reserved: the scenario runner has no read binding for it (`rig proof show` exists, but
  no scenario surface reads it), and the validator rejects it. No internal DB pokes.

## Layout
- `scenarios/` — the fifteen scenarios (§6 ten, the A1 eleventh, and four later ones:
  `capture-returns-addressed-seat`, `down-stops-every-seat`,
  `send-renders-in-addressed-pane`, `transcript-reads-addressed-seat`), one YAML file
  each, the scenario name naming its defect class. Beside them: the topology rig specs
  they bring up (`*-stub.yaml`, seats `runtime: stub`) and the `agents/` and
  `culture.md` those specs reference.
- `scenarios/scripts/` — four per-seat stub scripts (JSON). A scenario names them with
  `env.stub_scripts` (paths relative to the scenario file); the built-in default script
  applies when a scenario names none.
- `scripts/` — only its README, on the scripted-response contract.
- `evals/` — the live-model eval harness, a separate gate from these scenarios (see
  `evals/README.md`).
- `ROUTING.md` — the runner, stub and format capabilities this set depends on, and which
  of them have landed. Per 51-03 mini-req 2 these are ROUTED, never shimmed here.

## The seed contract (per-scenario, binding — kills the unfalsifiable-RED risk)
Each of the eleven historical scenarios carries a `seed_regression: {class: …}` step
and, in its header, a **SEED definition**: exactly what a seeded regression of its class plants, and why the
scenario's `expect` legs MUST catch it. Acceptance per scenario = the PAIR: GREEN on the
shipped tip + RED on the seeded run whose runner diff (expected vs last-observed) names
the class. A scenario that cannot be shown RED is not delivered.

The four later scenarios carry no seed step. Each header names a planted negative
instead, and that negative is a product-code mutation.

For executable seeds, place the step before the affected action and supply the
pipeline's `deps.seedRegression` controller. It must arm a real local fault in the
seeded run and explicitly record that fault as disabled in the healthy run. The
paired harness verifies the injection receipt and the specific failed observation.
The remaining historical markers after their assertions are not executable proofs.

## Run status honesty
The runner (`packages/daemon/scripts/run-scenarios.mjs`, over
`packages/daemon/test/helpers/scenario-*.ts`) and its hermetic env-helper exist. The stub
runs the four emit behaviors only from a per-seat launch script (`env.stub_scripts`); the
step verbs `emit`, `restore`, `mutate` and `policy` parse, but have no binding.

The runner reports five outcomes, each in its own column, and counts only PASS as passed
(workspaces-o9o.132): **PASS**; **HEALTHY-ONLY**, every step but the seed ran and held, because
host mode has no seed controller (CI arms it); **NOT RUN**, an unbound step (`emit`, `restore`,
`mutate`, `policy`) or an unbuilt fixture (`env.pre_existing_tmux`, R-14) stopped it, named with
why; **FAIL**; and **ERROR**. The summary reads `<n> scenarios: x passed, h healthy-only, y NOT RUN,
z failed` (an ERROR counts as failed), and the exit status is 1 only on a FAIL or an ERROR.
Measured in host mode on 2026-11-18 (the library's 20, at the o9o.132 tip): 9 passed, 4
healthy-only, 6 NOT RUN, 1 failed (#11, on R-20).

In CI, `queue-baton-survives-restart` runs with
its seed, and `transcript-reads-addressed-seat`, `capture-returns-addressed-seat` and
`shipped-agent-ref-resolves`, `launch-held-short-of-ready` and `launch-runner-exits-before-ready` run healthy only (see [ci/README.md](ci/README.md)). The other ten historical scenarios are
not yet runnable as meaningful checks, and `down-stops-every-seat` and
`send-renders-in-addressed-pane` don't run in CI. Scenario #11 is RED-FIRST: its setup now
holds (a claimed `env.queue` handoff, R-17), and its GREEN gates on the 51-06 transactional
execution-closure fix (R-20, workspaces-o9o.135); until then it fails at its post-restart legs,
recorded as expected-RED, never massaged. See `ROUTING.md`
for the exact per-item dependencies.
