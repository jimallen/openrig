// workspaces-o9o.130 — the pure half of the twin accessibility scan: what is scanned (every route of src/routes.tsx, a
// parameterised one filled with a twin fixture id, plus the dialogs the twin can open), what is not and why, and how axe-core's
// results are folded into a report by rule and surface. No IO here; a11y-scan.ts drives the browser.

/** One page of the twin to scan. `open`: click this trigger, wait for this element, then scan with the dialog open. */
export interface Surface {
  id: string;
  /** The route path given to TWIN_ROUTE. */
  route: string;
  /** The route pattern in src/routes.tsx this surface covers. */
  pattern: string;
  open?: { click: string; expect: string };
}

const page = (pattern: string, route = pattern): Surface => ({ id: route, route, pattern });

/** Every route the twin can render, parameters filled from twin/fixtures.ts, plus the dialogs it can open. */
export const SURFACES: Surface[] = [
  page("/"), page("/topology"), page("/for-you"), page("/project"), page("/agents"), page("/fleet"), page("/workflows"),
  page("/specs"), page("/specs/applications"), page("/specs/skills"), page("/specs/plugins"), page("/files"),
  page("/settings"), page("/settings/policies"), page("/settings/log"), page("/settings/status"), page("/search"),
  page("/lab/project-graphics-preview"), page("/lab/card-previews"), page("/lab/vellum-lab"),
  page("/lab/vellum-bg/a-large"), page("/lab/vellum-bg/b-small"), page("/lab/vellum-bg/c-allover"),
  page("/import"), page("/packages"), page("/packages/install"), page("/bootstrap"), page("/agents/validate"),
  page("/specs/rig"), page("/specs/agent"), page("/discovery"), page("/bundles/inspect"), page("/bundles/install"),
  page("/context"), page("/mission-control"), page("/slices"), page("/progress"), page("/steering"),
  page("/topology/rig/$rigId", "/topology/rig/rig_alpha"),
  page("/topology/rig/$rigId", "/topology/rig/rig_bravo"),
  page("/topology/pod/$rigId/$podName", "/topology/pod/rig_alpha/lead"),
  page("/topology/seat/$rigId/$logicalId", "/topology/seat/rig_alpha/lead.coordinator"),
  page("/project/mission/$missionId", "/project/mission/release-1.0.0"),
  page("/project/slice/$sliceId", "/project/slice/EX.1.0.0.01"),
  // The corrective demo slice: the only seeded Review media (plan, delivered and walkthrough sections).
  page("/project/slice/$sliceId", "/project/slice/EX.2.0.0.07"),
  page("/specs/library/$entryId", "/specs/library/spec_build_rig"),
  page("/specs/$specKind/$specName", "/specs/rig/acme-build"),
  page("/rigs/$rigId", "/rigs/rig_alpha"),
  page("/rigs/$rigId/nodes/$logicalId", "/rigs/rig_alpha/nodes/lead.coordinator"),
  page("/packages/$packageId", "/packages/pkg_relay"),
  page("/slices/$name", "/slices/EX.1.0.0.01"),
  {
    id: "dialog: restore (LaunchRecoveryModal)", route: "/topology/rig/rig_bravo", pattern: "/topology/rig/$rigId",
    open: { click: '[data-testid="rig-primary-action-rig_bravo"]', expect: '[data-testid="launch-recovery-modal"]' },
  },
  {
    id: "dialog: rollback (PackageDetail)", route: "/packages/pkg_relay", pattern: "/packages/$packageId",
    open: { click: '[data-testid="rollback-btn"]', expect: '[data-testid="rollback-dialog"]' },
  },
  {
    id: "dialog: open in terminal (TerminalLauncher)", route: "/topology/rig/rig_alpha", pattern: "/topology/rig/$rigId",
    open: { click: '[data-testid="terminal-launcher-button"]', expect: '[data-testid="terminal-launcher-dialog"]' },
  },
  // Non-Radix dialogs (role="dialog" by hand). The drawer is one component with one body per selection kind.
  {
    id: "dialog: queue item drawer (SharedDetailDrawer qitem)", route: "/for-you", pattern: "/for-you",
    open: { click: '[data-testid^="feed-card-show-context-"]', expect: '[data-testid="shared-detail-drawer"]' },
  },
  {
    id: "dialog: file drawer (SharedDetailDrawer file)", route: "/project/slice/EX.2.0.0.07", pattern: "/project/slice/$sliceId",
    open: { click: '[data-testid="plan-full-prd"]', expect: '[data-testid="shared-detail-drawer"]' },
  },
  {
    id: "dialog: image lightbox (Lightbox)", route: "/project/slice/EX.2.0.0.07", pattern: "/project/slice/$sliceId",
    open: { click: '[data-testid="plan-artifact-stack-mockup.png-image"]', expect: '[data-testid="proof-lightbox"]' },
  },
];

/**
 * Dialogs the twin cannot open, with why: every dialog component (dialogComponents) is scanned through a SURFACES entry
 * or named here, and so is every drawer kind and image-dialog opener the inventory counts. Each is a gap in the scan.
 */
export const DIALOGS_NOT_SCANNED: Array<{ dialog: string; reason: string }> = [
  { dialog: "SharedDetailDrawer sub-spec", reason: "opened from RigSpecDisplay's member rows; the twin has no rig spec to review (/specs/rig shows \"No RigSpec Selected\")" },
  { dialog: "SharedDetailDrawer system", reason: "no opener: nothing in src sets a \"system\" selection" },
  { dialog: "ProofImageViewer", reason: "FeedCard opens it from a card's proof screenshots, and no fixture card has a proof preview; TestsVerificationTab's opener is mounted nowhere" },
  { dialog: "Lightbox (ProofTab)", reason: "ProofTab opens it from a proof capture, and the twin has no proof captures" },
  { dialog: "SnapshotPanel", reason: "mounted nowhere in src" },
];

/** The component a dialog surface opens: the first word inside the id's parentheses. */
export function dialogComponentOf(surface: Surface): string | null {
  const m = /\(([A-Za-z0-9]+)/.exec(surface.id);
  return surface.open && m ? m[1]! : null;
}

/**
 * Every component in a source tree that renders a dialog: a hand-written role="dialog" (or alertdialog), or a Radix
 * DialogContent / AlertDialogContent, or a VellumSheet (whose role="dialog" lives in the ui primitive). The ui primitives
 * themselves are not components a person opens, so src/components/ui/ is skipped. Comments are stripped first: a comment
 * that mentions a dialog does not make one. `files`: path -> source.
 */
export function dialogComponents(files: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    if (file.includes("/components/ui/")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    if (/role=["{]+(alert)?dialog/.test(code) || /<(DialogContent|AlertDialogContent|VellumSheet)\b/.test(code)) {
      out.add(file.split("/").pop()!.replace(/\.tsx?$/, ""));
    }
  }
  return [...out].sort();
}

/** Routes the twin has no fixture for, with why. Each is a gap in the scan, reported as one. */
export const NOT_SCANNED: Array<{ pattern: string; reason: string }> = [
  { pattern: "/workflow/instance/$instanceId", reason: "no workflow instance in the twin's fixtures" },
  { pattern: "/specs/skills/$skillToken", reason: "no skill in the twin's fixtures" },
  { pattern: "/specs/skills/$skillToken/file/$fileToken", reason: "no skill in the twin's fixtures" },
  { pattern: "/plugins/$pluginId", reason: "no plugin in the twin's fixtures" },
];

/** Every `path: "..."` in a routes source (src/routes.tsx). */
export function routePatterns(routesSource: string): string[] {
  return [...routesSource.matchAll(/^\s*path:\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

/** Route patterns neither scanned nor listed as not scanned. Empty when the scan accounts for every route. */
export function unaccountedRoutes(patterns: string[], surfaces: Surface[], notScanned: Array<{ pattern: string }>): string[] {
  const covered = new Set([...surfaces.map((s) => s.pattern), ...notScanned.map((n) => n.pattern)]);
  return patterns.filter((p) => !covered.has(p));
}

/**
 * The router's error screen ("Something went wrong!", then "Show Error" or, once opened, "Hide Error" and the message) in
 * place of the page: the scan must not report that screen's markup as the route's. Returns the message (or "" when it is not
 * shown), or null when the page did not crash. Measured: /settings crashed in the twin on 2026-11-18.
 */
export function crashMessage(pageText: string): string | null {
  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "Something went wrong!") return null;
  const at = lines.indexOf("Hide Error");
  return at >= 0 ? lines.slice(at + 1).join(" ").slice(0, 300) : "";
}

export type Theme = "light" | "dark";
export type Impact = "critical" | "serious" | "moderate" | "minor";

/** One axe rule's violation on one scanned surface (the fields of axe-core's result this report reads). */
export interface Violation {
  id: string;
  impact: Impact | null;
  help: string;
  helpUrl: string;
  /** The offending elements' selectors. */
  targets: string[];
}

export type ScanRecord =
  | { surface: string; theme: Theme; ok: true; violations: Violation[] }
  | { surface: string; theme: Theme; ok: false; error: string };

export interface RuleSummary {
  id: string;
  impact: Impact | null;
  help: string;
  helpUrl: string;
  /** Total offending elements, across surfaces and themes. */
  nodes: number;
  hits: Array<{ surface: string; theme: Theme; nodes: number; targets: string[] }>;
}

const IMPACT_RANK: Record<Impact, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const rank = (i: Impact | null) => (i === null ? 4 : IMPACT_RANK[i]);

/** Violations folded by rule: most severe first, then most elements, then rule id. A failed scan contributes nothing here. */
export function summarizeByRule(records: ScanRecord[]): RuleSummary[] {
  const rules = new Map<string, RuleSummary>();
  for (const r of records) {
    if (!r.ok) continue;
    for (const v of r.violations) {
      const rule = rules.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: 0, hits: [] };
      if (rank(v.impact) < rank(rule.impact)) rule.impact = v.impact;
      rule.nodes += v.targets.length;
      rule.hits.push({ surface: r.surface, theme: r.theme, nodes: v.targets.length, targets: v.targets });
      rules.set(v.id, rule);
    }
  }
  return [...rules.values()].sort((a, b) => rank(a.impact) - rank(b.impact) || b.nodes - a.nodes || a.id.localeCompare(b.id));
}

/** The report: totals, one section per rule (surfaces and themes it hit), then the failed scans and the routes not scanned. */
export function renderMarkdown(
  records: ScanRecord[],
  notScanned: Array<{ pattern: string; reason: string }>,
  meta: { axeVersion: string; commit: string },
  dialogsNotScanned: Array<{ dialog: string; reason: string }> = [],
): string {
  const ok = records.filter((r) => r.ok);
  const failed = records.filter((r): r is Extract<ScanRecord, { ok: false }> => !r.ok);
  const rules = summarizeByRule(records);
  const clean = ok.filter((r) => r.ok && r.violations.length === 0).length;
  const lines = [
    `# Twin accessibility scan (axe-core ${meta.axeVersion}, default rules)`,
    "",
    `Commit ${meta.commit}. ${ok.length} scans (surface x theme) ran, ${clean} clean; ${failed.length} failed; ${rules.length} rules violated, ${rules.reduce((n, r) => n + r.nodes, 0)} elements.`,
    "",
  ];
  for (const r of rules) {
    lines.push(`## ${r.id} (${r.impact ?? "no impact"}): ${r.help}`, "", r.helpUrl, "");
    for (const h of r.hits) lines.push(`- ${h.surface} [${h.theme}]: ${h.nodes} (${h.targets.slice(0, 3).join(" | ")}${h.targets.length > 3 ? " | ..." : ""})`);
    lines.push("");
  }
  if (failed.length) {
    lines.push("## Scans that failed", "");
    for (const f of failed) lines.push(`- ${f.surface} [${f.theme}]: ${f.error}`);
    lines.push("");
  }
  lines.push("## Routes not scanned", "");
  for (const n of notScanned) lines.push(`- ${n.pattern}: ${n.reason}`);
  if (dialogsNotScanned.length) {
    lines.push("", "## Dialogs not scanned", "");
    for (const d of dialogsNotScanned) lines.push(`- ${d.dialog}: ${d.reason}`);
  }
  return lines.join("\n") + "\n";
}
