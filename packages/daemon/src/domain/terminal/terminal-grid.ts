// The equal-grid description of a composed view page: `rig terminal open`'s preview (`grids`, and the plan id that hashes them)
// and the TUI's "N x M" line. Moved unchanged from herdr-adapter.ts (hc cutover W40) when the old multiplexer's adapter and socket
// transport were removed; the bytes the plan id hashes are the same as before. NOTE: the app provider (herdr-app-provider.ts)
// lays panes out with rig-here's balanced splits, not this grid; this describes the page, it does not drive the app.

import type { ComposedPane } from "./terminal-provider.js";

/** A herdr layout-tree pane leaf — `command` is an ARGV array (capture-verified). */
export interface HerdrPaneNode {
  type: "pane";
  label: string;
  command: string[];
}

/** A herdr layout-tree binary split (capture-verified shape). */
export interface HerdrSplitNode {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: HerdrLayoutNode;
  second: HerdrLayoutNode;
}

export type HerdrLayoutNode = HerdrPaneNode | HerdrSplitNode;

/**
 * Combine N nodes into an equal N-way strip along one direction. PURE.
 * Equal N-way BSP is first-vs-rest at ratio 1/N, recursively 1/(N-1) —
 * NOT midpoint 0.5 (the VM-reproduced defect: alternating 0.5 splits gave
 * N=7 a 4×2 layout with one double-width cell instead of the promised 3×3).
 */
export function equalStrip(nodes: HerdrLayoutNode[], direction: "right" | "down"): HerdrLayoutNode {
  if (nodes.length === 1) return nodes[0]!;
  return {
    type: "split",
    direction,
    ratio: 1 / nodes.length,
    first: nodes[0]!,
    second: equalStrip(nodes.slice(1), direction),
  };
}

/**
 * The modal Auto-grid column count for N panes. MUST mirror the UI's
 * TerminalLauncher `suggestLayout` (N=7 → 3×3, never 2×4). Kept here because
 * the daemon cannot import from packages/ui; a drift is a bug in whichever
 * side changed.
 */
export function autoGridCols(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** An inert blank pane — pads an incomplete grid rectangle. */
function blankPane(): HerdrPaneNode {
  return { type: "pane", label: "", command: ["sh"] };
}

function herdrPaneCommand(pane: ComposedPane): string {
  const agent = pane.runtime === "claude-code" ? "claude" : pane.runtime === "codex" ? "codex" : null;
  return agent ? `env HERDR_AGENT=${agent} ${pane.paneCommand}` : pane.paneCommand;
}

/**
 * Build an equal grid for one page. Explicit columns are capped to its pane
 * count; otherwise use the UI TerminalLauncher `suggestLayout` —
 * cols = ceil(sqrt(N)), rows = ceil(N/cols): N=2 → 2×1, N=5 → 3×2, N=7 → 3×3
 * (cols×rows). An incomplete rectangle is padded with inert blank panes so
 * every cell is the same size; blanks are layout filler only — they are never
 * reported as opened seats. Each real leaf runs the composer's shell
 * `paneCommand` via `["sh","-c",…]` so the composed quoting (read-only `-r`,
 * ssh-wrap) is preserved; a known Claude/Codex runtime adds Herdr's detection
 * hint. Rows are built as equal `right` strips,
 * then combined with equal `down` strips.
 */
export function buildGridRoot(panes: ComposedPane[], columns?: number): { root: HerdrLayoutNode; blanks: number; columns: number; rows: number } {
  const cols = Math.min(columns ?? autoGridCols(panes.length), panes.length || 1);
  const rows = Math.ceil(panes.length / cols);
  const blanks = rows * cols - panes.length;
  const leaves: HerdrLayoutNode[] = panes.map((pane) => ({
    type: "pane",
    label: pane.label,
    command: ["sh", "-c", herdrPaneCommand(pane)],
  }));
  for (let i = 0; i < blanks; i++) leaves.push(blankPane());
  const rowStrips: HerdrLayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    rowStrips.push(equalStrip(leaves.slice(r * cols, (r + 1) * cols), "right"));
  }
  return { root: equalStrip(rowStrips, "down"), blanks, columns: cols, rows };
}
