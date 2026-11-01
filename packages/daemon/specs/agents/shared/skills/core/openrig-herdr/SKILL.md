---
name: openrig-herdr
description: >
  Use when opening OpenRig fleet terminals as a herdr wall — turning a rig, pod, mission, slice, or
  saved view into live interactive agent tiles via `rig terminal`, watching another rig read-only,
  or driving herdr on an agent's request ("open all my rigs + a mission as views"). Covers the
  `rig terminal open|views|status` verbs, the honest-partial/degrade reading of the result, the
  read-only-by-construction rail for cross-rig views, scroll/copy out of the box, and the
  same-size-only duplicate-pane limit. herdr is the default, proof-gated provider.
metadata:
  openrig:
    stage: candidate
    sibling_skills:
      - openrig-cmux
      - openrig-user
---

# openrig-herdr

OpenRig decides **which** agents make up a view (a rig, a pod, a mission, a slice, or a saved
group); **herdr** renders the pixels. A view opens as live, interactive terminal tiles — each tile
is an `hc attach` to a daemon-owned agent terminal, so you get the real terminal, not a
snapshot. OpenRig owns the semantics; herdr owns the surface. You drive it entirely through the
`rig terminal` CLI, which rides the installed herdr binary at arm's length — never link, embed, or
plugin it.

## The whole surface — three verbs

```bash
rig terminal open <view> [--provider herdr|cmux] [--json]   # herdr is the default provider
rig terminal views [--json]                                 # list openable views (saved + derived)
rig terminal status [--provider] [--json]                   # provider liveness / health
```

`<view>` resolves, in order, to one of:
- a **rig name** — every live agent in that rig, auto-laid-out;
- **`pod:<rig>/<podNamespace>`** — every live agent in one pod of a rig (the rig's inventory filtered by pod);
- **`mission:<id>`** — the agents working that mission (derived live from topology);
- **`slice:<id>`** — the agents working that slice (derived live);
- a **saved-view name** — a user-defined group (see Saved views).

## Compose a view from a sentence

An agent asked "open all my rigs plus a mission as views" runs one `open` per target:

```bash
rig terminal open acme-web                     # a whole rig, live agents as tiles
rig terminal open mission:site-relaunch        # exactly the agents working the mission
rig terminal open slice:search-filters      # the agents working one slice
```

No hand-listing of seats: the mission/slice membership is derived from live topology at open time.

## Read the result honestly — partial and degrade

The result is a partition — every seat lands in exactly one bucket, each **named**:

- **opened** — the live agents now showing as tiles.
- **absent** — seats in the view that aren't currently live: **named and skipped, never silently
  dropped.** A view that opens *some* of its seats is a success (the partial is disclosed) and exits
  **0**. Only a view where **no** pane opens exits **non-zero**.
- **degraded** — an agent that structurally cannot tile, named **with the reason**. The v1 case:
  an agent on a host registered over HTTP has no ssh path, so its tile can't be composed — it reads
  as **"host `<id>` is http-registered; tiles need ssh"** and is skipped, never dropped. (ssh-reachable
  hosts tile via an ssh-wrapped attach; full http-host tiling is deferred to the cross-host transport
  seam.)

Read `--json` to branch on the partition programmatically; the exit code alone tells you opened-something
(0) vs opened-nothing (non-zero).

## Read-only — who's interactive, who's watch-only

Read-only is composed into the pane at open time — a read-only tile is an `hc attach --observe`, which never types and never resizes,
so it **cannot send input**. The current policy, by view kind:

- **A rig view or a `pod:` view is interactive** — you asked for that rig (or pod) directly, so you
  can drive its agents.
- **`mission:` and `slice:` views are read-only by construction** — these derived views cut across
  rigs; you watch and scroll, you don't keystroke into them.
- **A saved view is per-member** — each member carries its own `readOnly` (omit = interactive;
  `true` = `attach --observe`).

So you don't have to remember to be careful: the view kind (and, for a saved view, the per-member
flag) sets it at open time.

## Safety rails (hard — the fleet-safety rail)

- A tile is a **view** (an `hc attach`) of a daemon-owned terminal. **Never** move, join, kill,
  or re-parent a daemon-owned terminal. Closing a tile detaches one hc client — the daemon's terminal is
  untouched and its addressing (send/capture/nudge) is unaffected.
- Host-local read-only viewing mutates nothing. Anything that would change a **live** daemon session's
  shared state (e.g. changing a label or option on a running seat) is a config/design change — prove it in
  an isolated environment, never live-flip in production.

## Scroll + copy work out of the box

On a freshly-launched agent tile the mouse wheel scrolls the pane's history and a drag-select copies
to your **system** clipboard — with no commands typed. OpenRig sets no tmux scroll or clipboard
options for an hc seat (the tmux server and window option setters are no-ops on hc, and a built-in tmux option
is refused); scrolling and copying are Herdr's own.

## Limits — state them, don't paper over them

- **Tile chrome v1 = a plain label** (agent + slice). Rich per-tile status is roadmap.
- **Duplicate / multi-view membership** (the same agent live in two views at once) works — put the
  duplicates in **same-size panes**. A writable `hc attach` resizes the program to its tile at once and, with
  two writable viewers, the last to attach wins (measured on a private hc 0.1.15 core); an `--observe` tile never
  resizes. It is **documented, not fixed** — don't expect a setting to remove it.
- **There is no inner tmux status bar** on an hc seat (herdr provides the chrome). The `terminal.status_bar` key is
  still accepted, but it sets tmux options, which are no-ops on hc.

## Saved views — the library (`terminal-views.yaml`)

In v1 you **create** a saved view by **hand-authoring** `terminal-views.yaml` — there is no save/write
verb (`open` / `views` / `status` are the whole surface; a `rig terminal save <id>` verb is a named
stretch/follow-up). You **reopen** it like any other view: `rig terminal open <id>`.

The file lives at the OpenRig home root (resolved via `getDefaultOpenRigPath()`), is written
atomically (tmp + rename), and is byte-stable. **Only hand-authored saved views live here — derived
views (a rig, `pod:<rig>/<pod>`, `mission:<id>`, `slice:<id>`) are computed live and never written to
this file.**

Schema — use these field names **exactly**, in this order; **omit** optional fields when absent
(never write `null`):

```yaml
version: 1
views:
  - id: my-view-id             # required — the id `rig terminal open <id>` takes
    name: Human Name           # required
    members:
      - seat: pod-member@rig    # required — the canonical session name
        label: agent . slice    # optional — pane label
        host: some-host-id      # optional — STRUCTURED host id (NEVER a `member@rig@host` string);
                                #            omit for local. ssh-registered hosts tile;
                                #            http-registered hosts honest-degrade (named + skipped, with reason)
        tmuxSession: sessname   # optional — the session name the hc terminal is derived from; defaults to `seat`
        readOnly: true          # optional — omit = interactive; true = `hc attach --observe`
```

An agent composing a saved view on request **writes this YAML** and then opens the id:
`rig terminal open my-view-id` (add `--provider cmux` for cmux). The library is provider-agnostic —
the same saved view opens in herdr or cmux.

## AGPL / clean-room

Driving herdr through the `rig terminal` CLI (which talks to the installed herdr binary over its
CLI/socket) is arm's-length and fine. Do **not** link herdr's source, embed it in-process, or ship a
herdr plugin — a plugin needs legal review. This skill and its docs are clean-room: patterns only,
never herdr source text.
