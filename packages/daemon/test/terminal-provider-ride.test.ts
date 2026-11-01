// OPR.0.4.6.02 C2 — the terminal-provider ride core commit.
//
// Covers the plan's C2 test contract:
//  - composer partition vectors: read-only `-r`, ssh wrap, http honest-degrade
//    (exact reason class), unknown-host degrade, absent-named, mixed partition,
//    paging cap 9 (3×3);
//  - derived views computed live are NEVER persisted (A3);
//  - saved-views store round-trip is byte-stable + writes atomically (tmp+rename);
//  - herdr fresh-tab-on-relaunch decision (not-replace) + the FB4 socket shapes
//    (probe=ping; fresh workspace.create → ONE atomic layout.apply per page;
//    the no-CLI-strings regression — the VM-RED `herdr layout apply` class);
//  - herdr equal auto-grid root (2×1 / 3×2 / 3×3 matching UI suggestLayout;
//    first-vs-rest ratios; inert blank padding — the OPR.0.4.7.1 fix for the
//    alternating-0.5 double-width-cell defect).

import { describe, it, expect } from "vitest";
import { mkTemp } from "./helpers/temp-roots.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

import {
  composeView,
  chunkPanes,
  PANES_PER_PAGE,
  type ViewMemberInput,
  type ComposeContext,
} from "../src/domain/terminal/view-composer.js";
import {
  TerminalViewsStore,
  deriveViewMembers,
  type SavedView,
  type LiveSeatRow,
} from "../src/domain/terminal/terminal-views-store.js";
import {
  buildGridRoot,
  autoGridCols,
  type HerdrLayoutNode,
  type HerdrPaneNode,
  type HerdrSplitNode,
} from "../src/domain/terminal/terminal-grid.js";
import type { HostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";

// --- host-registry fixtures ---
const SSH_HOST: HostEntry = { id: "vm1", transport: "ssh", target: "vm1.local", user: "admin" };
const HTTP_HOST: HostEntry = { id: "factory", transport: "http", url: "http://x:7433", bearer_env: "T" };

function ctxWith(hosts: HostEntry[]): ComposeContext {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return { resolveHost: (id) => byId.get(id) ?? null };
}

function member(overrides: Partial<ViewMemberInput> & { seat: string }): ViewMemberInput {
  return {
    label: overrides.seat,
    tmuxSession: overrides.seat,
    host: null,
    readOnly: false,
    alive: true,
    ...overrides,
  };
}

/** The hc terminal name of a seat, restated here (`s-` + the first 24 hex digits of sha-256 of the canonical name) so the pin does not import the recipe it pins. */
const hcName = (seat: string): string => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

describe("view-composer partition vectors", () => {
  it("local live seat → hc attach -- <terminal> (writable: a plain attach)", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig" })], ctxWith([]));
    expect(v.opened).toHaveLength(1);
    expect(v.opened[0]!.paneCommand).toBe(`hc attach -- '${hcName("dev-a@rig")}'`);
    expect(v.opened[0]!.readOnly).toBe(false);
    expect(v.absent).toHaveLength(0);
    expect(v.degraded).toHaveLength(0);
  });

  it("view-only / cross-rig read-only seat → hc attach --observe (never types, never resizes)", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig", readOnly: true })], ctxWith([]));
    expect(v.opened[0]!.paneCommand).toBe(`hc attach --observe -- '${hcName("dev-a@rig")}'`);
    expect(v.opened[0]!.readOnly).toBe(true);
  });

  it("ssh host → hc attach -- '<host id>/<terminal>' through the hc machine of that name; read-only adds --observe", () => {
    const rw = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: "s@r" })], ctxWith([SSH_HOST]));
    expect(rw.opened[0]!.paneCommand).toBe(`hc attach -- 'vm1/${hcName("s@r")}'`);

    const ro = composeView("v", [member({ seat: "s@r", host: "vm1", readOnly: true })], ctxWith([SSH_HOST]));
    expect(ro.opened[0]!.paneCommand).toBe(`hc attach --observe -- 'vm1/${hcName("s@r")}'`);

    // The registry's ssh user and target no longer reach the command: the machine link owns them.
    expect(rw.opened[0]!.paneCommand).not.toContain("admin");
    expect(rw.opened[0]!.paneCommand).not.toContain("vm1.local");
    expect(rw.opened[0]!.paneCommand).not.toContain("ssh");
  });

  // The shell string carries a host id and a terminal name from our own data; both must stay ONE shell word,
  // and neither may be read by hc as an option.
  it("a shell-sensitive host id stays ONE quoted argument after `--`, and a session name with a quote reaches hc only as its digest", () => {
    const NASTY: HostEntry = { id: "a b; rm -rf /", transport: "ssh", target: "x" };
    const v = composeView("v", [member({ seat: "s@r", host: NASTY.id, tmuxSession: "u'x" })], ctxWith([NASTY]));
    expect(v.opened).toHaveLength(1);
    expect(v.opened[0]!.paneCommand).toBe(`hc attach -- 'a b; rm -rf //${hcName("u'x")}'`);
    expect(v.opened[0]!.paneCommand).not.toContain("; rm -rf / hc");
  });

  it("a machine name that starts with '-' follows `--`, so it is a name and not an option", () => {
    const DASHED: HostEntry = { id: "-x", transport: "ssh", target: "x" };
    const v = composeView("v", [member({ seat: "s@r", host: DASHED.id, readOnly: true })], ctxWith([DASHED]));
    expect(v.opened[0]!.paneCommand).toBe(`hc attach --observe -- '-x/${hcName("s@r")}'`);
  });

  it("http host → NO pane, honest-degrade with the exact reason class", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "factory" })], ctxWith([HTTP_HOST]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "factory", reason: "host factory is http-registered; tiles need ssh" },
    ]);
  });

  it("unknown host id → degraded named, never silently omitted", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "ghost" })], ctxWith([]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "ghost", reason: "host ghost is not in the hosts registry" },
    ]);
  });

  it("dead local seat → absent named; terminal-less seat → absent named", () => {
    const dead = composeView("v", [member({ seat: "s@r", alive: false })], ctxWith([]));
    expect(dead.opened).toHaveLength(0);
    expect(dead.absent).toEqual([{ seat: "s@r", host: null, reason: "hc terminal s@r is not alive" }]);

    const noSess = composeView("v", [member({ seat: "s@r", tmuxSession: null })], ctxWith([]));
    expect(noSess.absent).toEqual([
      { seat: "s@r", host: null, reason: "no hc terminal recorded for this seat" },
    ]);

    const sshNoSess = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: null })], ctxWith([SSH_HOST]));
    expect(sshNoSess.absent).toEqual([
      { seat: "s@r", host: "vm1", reason: "no hc terminal recorded for this seat" },
    ]);
  });

  it("mixed view partitions each member into the right bucket", () => {
    const v = composeView(
      "mix",
      [
        member({ seat: "live@r" }),
        member({ seat: "ro@r", readOnly: true }),
        member({ seat: "ssh@r", host: "vm1" }),
        member({ seat: "http@r", host: "factory" }),
        member({ seat: "dead@r", alive: false }),
        member({ seat: "ghost@r", host: "nope" }),
      ],
      ctxWith([SSH_HOST, HTTP_HOST]),
    );
    expect(v.opened.map((p) => p.seat)).toEqual(["live@r", "ro@r", "ssh@r"]);
    expect(v.degraded.map((d) => d.seat).sort()).toEqual(["ghost@r", "http@r"]);
    expect(v.absent.map((a) => a.seat)).toEqual(["dead@r"]);
  });

  it("paging caps at 9 (3×3) panes per page with deterministic order", () => {
    expect(PANES_PER_PAGE).toBe(9);
    const members = Array.from({ length: 20 }, (_, i) => member({ seat: `s${i}@r` }));
    const v = composeView("big", members, ctxWith([]));
    expect(v.opened).toHaveLength(20);
    expect(v.pages).toHaveLength(3); // 9 + 9 + 2
    expect(v.pages[0]).toHaveLength(9);
    expect(v.pages[1]).toHaveLength(9);
    expect(v.pages[2]).toHaveLength(2);
    // Order preserved into pages.
    expect(v.pages[0]![0]!.seat).toBe("s0@r");
    expect(v.pages[2]![1]!.seat).toBe("s19@r");
  });

  it("chunkPanes rejects a non-positive page size", () => {
    expect(() => chunkPanes([], 0)).toThrow();
  });

  it("carries live Claude and Codex runtimes into Herdr tile hints but leaves terminal seats unchanged", () => {
    const members = deriveViewMembers([
      { canonicalSessionName: "claude@rig", attachmentType: "tmux", runtime: "claude-code" },
      { canonicalSessionName: "codex@rig", attachmentType: "tmux", runtime: "codex" },
      { canonicalSessionName: "operator@rig", attachmentType: "tmux", runtime: "terminal" },
    ]);
    const view = composeView("rig:rig", members, ctxWith([]));
    const grid = buildGridRoot(view.opened).root;
    const panes: HerdrPaneNode[] = [];
    const collect = (node: HerdrLayoutNode) => {
      if (node.type === "pane") panes.push(node);
      else { collect(node.first); collect(node.second); }
    };
    collect(grid);

    expect(panes.filter((pane) => pane.label).map((pane) => pane.command)).toEqual([
      ["sh", "-c", `env HERDR_AGENT=claude hc attach -- '${hcName("claude@rig")}'`],
      ["sh", "-c", `env HERDR_AGENT=codex hc attach -- '${hcName("codex@rig")}'`],
      ["sh", "-c", `hc attach -- '${hcName("operator@rig")}'`],
    ]);
    expect(panes.at(-1)?.command).toEqual(["sh"]);
  });
});

describe("terminal-views store — round-trip byte-stable + atomic write + A3", () => {
  function tmpStore(): { store: TerminalViewsStore; dir: string; file: string } {
    const dir = mkTemp(path.join(os.tmpdir(), "terminal-views-"));
    const file = path.join(dir, "terminal-views.yaml");
    return { store: new TerminalViewsStore(file), dir, file };
  }

  const view: SavedView = {
    id: "acme-build",
    name: "acme build",
    members: [
      { seat: "orch@acme", label: "orch@acme · s02", host: "vm1", tmuxSession: "orch@acme", readOnly: true },
      { seat: "dev@acme", tmuxSession: "dev@acme" }, // no host/label/readOnly → omitted on write
    ],
  };

  it("absent file reads as the empty set", () => {
    const { store } = tmpStore();
    expect(store.read()).toEqual({ version: 1, views: [] });
    expect(store.list()).toEqual([]);
  });

  it("save→read→save round-trip is byte-identical (omit-when-absent, fixed order)", () => {
    const { store, file } = tmpStore();
    store.save(view);
    const firstBytes = fs.readFileSync(file, "utf-8");

    const readBack = store.read();
    // Optionals that were false/absent are not resurrected as null.
    expect(readBack.views[0]!.members[1]).toEqual({ seat: "dev@acme", tmuxSession: "dev@acme" });

    // Re-saving the same logical content reproduces identical bytes.
    store.save(readBack.views[0]!);
    expect(fs.readFileSync(file, "utf-8")).toBe(firstBytes);
  });

  it("save writes atomically via a tmp file then rename (no lingering tmp)", () => {
    const { store, dir, file } = tmpStore();
    store.save(view);
    expect(fs.existsSync(file)).toBe(true);
    // The tmp sidecar is renamed away, never left behind.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["terminal-views.yaml"]);
  });

  it("upsert by id and remove are idempotent", () => {
    const { store } = tmpStore();
    store.save(view);
    store.save({ ...view, name: "renamed" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("acme-build")!.name).toBe("renamed");
    store.remove("acme-build");
    expect(store.list()).toEqual([]);
    store.remove("acme-build"); // idempotent
    expect(store.list()).toEqual([]);
  });

  it("derived views are computed live and NEVER written to disk (A3)", () => {
    const { store, file } = tmpStore();
    const rows: LiveSeatRow[] = [
      { canonicalSessionName: "a@r", attachmentType: "tmux", logicalId: "pod.a", rigName: "r" },
      { canonicalSessionName: "b@r", attachmentType: "external_cli", logicalId: "pod.b", rigName: "r" }, // dropped (non-tmux)
      { canonicalSessionName: null, attachmentType: "tmux" }, // dropped (no seat)
    ];
    const derived = deriveViewMembers(rows, { labelSuffix: "s02", readOnly: true, host: "vm1" });
    expect(derived).toEqual([
      { seat: "a@r", label: "pod.a · s02", tmuxSession: "a@r", host: "vm1", readOnly: true, alive: true },
    ]);
    // No save path was invoked → the store file must not exist.
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toEqual({ version: 1, views: [] });
  });
});

describe("grid description of a page (preview grids, plan id) — equal auto-grid root", () => {
  const view: ComposedView = {
    id: "acme-build",
    opened: [
      { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
      { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
    ],
    absent: [],
    degraded: [],
    pages: [
      [
        { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
        { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
      ],
    ],
  };

  it("one grid root per page (N=2 → 2×1) — pane leaves carry <agent> · <slice> AND the composed shell command via sh -c", () => {
    const plan = { pages: view.pages.map((page) => buildGridRoot(page)) };
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.blanks).toBe(0);
    // N=2 is a single equal right strip at ratio 1/2 (argv command shape
    // capture-verified for layout.apply).
    expect(plan.pages[0]!.root).toEqual({
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", label: "pod.a · s02", command: ["sh", "-c", "tmux attach -t 'a@r'"] },
      second: { type: "pane", label: "pod.b · s02", command: ["sh", "-c", "tmux attach -r -t 'b@r'"] },
    });
  });

  // The VM-reproduced defect: alternating-0.5 BSP rendered N=7 as 4 columns ×
  // 2 rows with one double-width cell. The grid root must match the UI
  // suggestLayout shape (cols=ceil(sqrt(N)), rows=ceil(N/cols)) with EQUAL
  // cells: equal right-strips per row (first-vs-rest ratios 1/N, 1/(N-1), …)
  // combined by equal down-strips, padding the rectangle with inert blanks.
  function walkLeaves(n: HerdrLayoutNode, out: HerdrPaneNode[] = []): HerdrPaneNode[] {
    if (n.type === "pane") out.push(n);
    else {
      walkLeaves(n.first, out);
      walkLeaves(n.second, out);
    }
    return out;
  }

  it.each([
    [0, 1], [1, 1], [2, 2], [3, 2], [4, 2], [5, 3], [7, 3], [9, 3], [10, 4], [16, 4], [17, 5],
  ])("autoGridCols(%i) = %i: the daemon mirror of the UI's suggestLayout (cols = ceil(sqrt(N)), at least 1); a drift from the modal preview is a bug", (n, cols) => {
    expect(autoGridCols(n)).toBe(cols);
  });

  it.each([
    { n: 2, cols: 2, rows: 1, blanks: 0 },
    { n: 5, cols: 3, rows: 2, blanks: 1 },
    { n: 7, cols: 3, rows: 3, blanks: 2 }, // the founder repro size
  ])("buildGridRoot N=$n → $cols×$rows with $blanks inert blank(s), panes in order", ({ n, cols, rows, blanks }) => {
    const panes = Array.from({ length: n }, (_, i) => ({
      seat: `s${i + 1}`,
      label: `s${i + 1}`,
      paneCommand: `attach s${i + 1}`,
      readOnly: false,
    }));
    const grid = buildGridRoot(panes);
    expect(grid.blanks).toBe(blanks);

    const leaves = walkLeaves(grid.root);
    expect(leaves).toHaveLength(rows * cols); // full rectangle: N real + blanks
    // Real panes first, in page order, running their composed command via sh -c.
    expect(leaves.slice(0, n).map((l) => l.label)).toEqual(panes.map((p) => p.label));
    for (const leaf of leaves.slice(0, n)) expect(leaf.command.slice(0, 2)).toEqual(["sh", "-c"]);
    // Blanks pad the rectangle tail and are inert (no composed attach command).
    for (const leaf of leaves.slice(n)) {
      expect(leaf.label).toBe("");
      expect(leaf.command).toEqual(["sh"]);
    }

    // Equal-cells geometry: the root combines `rows` down-strips at ratio
    // 1/rows (then 1/(rows-1), …); each row combines `cols` leaves right at
    // ratio 1/cols (then 1/(cols-1), …) — first-vs-rest, never midpoint 0.5.
    const root = grid.root;
    if (rows > 1) {
      if (root.type !== "split") throw new Error("expected a split root");
      expect(root.direction).toBe("down");
      expect(root.ratio).toBeCloseTo(1 / rows, 10);
      if (rows > 2) {
        const restRows = root.second;
        if (restRows.type !== "split") throw new Error("expected nested down split");
        expect(restRows.direction).toBe("down");
        expect(restRows.ratio).toBeCloseTo(1 / (rows - 1), 10);
      }
    }
    const firstRow: HerdrLayoutNode = rows > 1 ? (root as HerdrSplitNode).first : root;
    if (cols > 1) {
      if (firstRow.type !== "split") throw new Error("expected a row split");
      expect(firstRow.direction).toBe("right");
      expect(firstRow.ratio).toBeCloseTo(1 / cols, 10);
      if (cols > 2) {
        const restCols = firstRow.second;
        if (restCols.type !== "split") throw new Error("expected nested right split");
        expect(restCols.direction).toBe("right");
        expect(restCols.ratio).toBeCloseTo(1 / (cols - 1), 10);
      }
    }
  });

  it("kernel geometry uses the composed three columns for the preview grid", () => {
    const panes = ["TUI", "advisor", "operator"].map(label => ({ seat: label, label, paneCommand: `attach ${label}`, readOnly: false }));
    const grid = buildGridRoot(panes, 3);
    expect(grid).toMatchObject({ columns: 3, rows: 1, blanks: 0 });
    expect(grid.root).toMatchObject({
      type: "split", direction: "right", ratio: 1 / 3, first: { type: "pane", label: "TUI" },
      second: { type: "split", direction: "right", ratio: 1 / 2,
        first: { type: "pane", label: "advisor" }, second: { type: "pane", label: "operator" } },
    });
    expect(buildGridRoot(panes)).toMatchObject({ columns: 2, rows: 2, blanks: 1 });
    expect(buildGridRoot(panes.slice(0, 2), 3)).toMatchObject({ columns: 2, rows: 1, blanks: 0 });
  });
});
