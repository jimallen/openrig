import { RSI_PROJECT_REPORT } from "./detector-ids.js";
import {
  RsiFindingSource, hoursBefore, partitionText, sortedParts,
  type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * D14: project-rig reports (rev2 §5.4, R5). A project rig emits
 * `rig stream emit --hint-tags rsi-report,rsi-class:<class> --body <pointer>`. This detector
 * counts those stream items per (reporting rig, class). It NEVER selects the body: a report is
 * a number, and its text cannot become a proposal.
 *
 * NOTHING CALLER-CHOSEN REACHES A FINDING. `source_session` and `hint_tags` are set by whoever
 * posts to the stream (any local process, including an LLM seat). So:
 *  - the reporting rig is the text after the first `@` of `source_session`, and it is used ONLY if
 *    it equals the name of an existing un-archived rig AND passes a strict charset+length check
 *    (RIG_NAME). Anything else is counted under the fixed label `(unknown-rig)`; no byte of it is kept;
 *  - the class comes from a closed list, anything else is `other`;
 *  - reports whose source rig is the kernel are ignored (the steward must not originate its own
 *    fingerprint, rev2 §5.3), and counted in the explanation only.
 *
 * Narrowest readings chosen where the design is silent (listed in the PR report):
 *  - A report is live while it is un-archived and emitted in the last 7 days; one report is enough
 *    (a deliberate act by a project rig has no volume threshold to reach).
 *  - The class list is closed; any other or missing `rsi-class:` tag counts as `other`. The five named
 *    classes duplicate daemon detectors (D5/D6/D8/D9/D12); dropping them would leave only `other`, so
 *    the list is kept and the architect owns its final content.
 *  - More than REPORT_ROW_CAP candidate rows in the window is a flood: the source is unavailable, never a count.
 */
export const PROJECT_REPORT_WINDOW_HOURS = 24 * 7;
export const PROJECT_REPORT_TAG = "rsi-report";
export const PROJECT_REPORT_CLASS_PREFIX = "rsi-class:";
export const PROJECT_REPORT_CLASSES = [
  "compaction-storm", "context-high-water", "permission-stall", "outbox-unsettled", "delivery-failure",
] as const;
export const PROJECT_REPORT_KERNEL_RIG = "kernel";
export const PROJECT_REPORT_UNKNOWN_RIG = "(unknown-rig)";
export const PROJECT_REPORT_ROW_CAP = 5000;
/** The only rig names that may appear in a finding. */
export const PROJECT_REPORT_RIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface ReportRow { rid: number; ts_emitted: string; source_session: string; hint_tags: string }
interface Group { n: number; firstId: number; lastId: number; firstSeen: string; lastSeen: string }

function tagsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export class ProjectReportSource extends RsiFindingSource {
  readonly name = "rsi-project-report";
  readonly detectors = [RSI_PROJECT_REPORT];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = hoursBefore(now, PROJECT_REPORT_WINDOW_HOURS).toISOString();
    // No body column is selected anywhere in this source. LIKE only narrows the scan; the match is exact, below.
    const candidates = db.prepare(`SELECT rowid AS rid, ts_emitted, source_session, hint_tags FROM stream_items
      WHERE archived_at IS NULL AND ts_emitted >= ? AND hint_tags LIKE ? ORDER BY rowid LIMIT ?`)
      .all(since, `%${PROJECT_REPORT_TAG}%`, PROJECT_REPORT_ROW_CAP + 1) as ReportRow[];
    if (candidates.length > PROJECT_REPORT_ROW_CAP) {
      throw new Error(`more than ${PROJECT_REPORT_ROW_CAP} stream items mention ${PROJECT_REPORT_TAG} in the window: refusing to count a flood`);
    }
    const population = (db.prepare("SELECT count(*) AS n FROM stream_items WHERE archived_at IS NULL AND ts_emitted >= ?").get(since) as { n: number }).n;
    const rigNames = new Set((db.prepare("SELECT name FROM rigs WHERE archived_at IS NULL").all() as Array<{ name: string }>).map((row) => row.name));

    const groups = new Map<string, Group & { rig: string; cls: string }>();
    const classes = new Map<string, number>();
    let reports = 0;
    let kernelIgnored = 0;
    let unknownRig = 0;
    for (const row of candidates) {
      const tags = tagsOf(row.hint_tags);
      if (!tags.includes(PROJECT_REPORT_TAG)) continue;
      reports += 1;
      const at = row.source_session.indexOf("@");
      const claimed = at >= 0 ? row.source_session.slice(at + 1) : "";
      if (claimed === PROJECT_REPORT_KERNEL_RIG) { kernelIgnored += 1; continue; }
      const known = PROJECT_REPORT_RIG_NAME.test(claimed) && rigNames.has(claimed);
      if (!known) unknownRig += 1;
      const rig = known ? claimed : PROJECT_REPORT_UNKNOWN_RIG;
      const raw = tags.find((tag) => tag.startsWith(PROJECT_REPORT_CLASS_PREFIX))?.slice(PROJECT_REPORT_CLASS_PREFIX.length) ?? "";
      const cls = (PROJECT_REPORT_CLASSES as readonly string[]).includes(raw) ? raw : "other";
      classes.set(cls, (classes.get(cls) ?? 0) + 1);
      const key = `${rig}\u0000${cls}`;
      const g = groups.get(key) ?? { rig, cls, n: 0, firstId: Infinity, lastId: -Infinity, firstSeen: "", lastSeen: "" };
      g.n += 1;
      g.firstId = Math.min(g.firstId, row.rid);
      g.lastId = Math.max(g.lastId, row.rid);
      if (g.firstSeen === "" || row.ts_emitted < g.firstSeen) g.firstSeen = row.ts_emitted;
      if (row.ts_emitted > g.lastSeen) g.lastSeen = row.ts_emitted;
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => b.n - a.n || (a.rig < b.rig ? -1 : a.rig > b.rig ? 1 : 0) || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
    const ordinary = population - reports;
    const classParts = sortedParts(classes);

    return {
      total: ordered.length, unit: "rig and class pairs", order: "reports desc, rig, class",
      findings: ordered.slice(0, limit).map((g) => ({
        detectorId: RSI_PROJECT_REPORT, className: `project-report:${g.cls}`, subjectKey: `rig:${g.rig}:class:${g.cls}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: g.n, controlTotal: ordinary, population,
        firstSeq: g.firstId, lastSeq: g.lastId, firstSeen: g.firstSeen, lastSeen: g.lastSeen,
        summary: g.rig === PROJECT_REPORT_UNKNOWN_RIG
          ? `${g.n} ${PROJECT_REPORT_TAG} report${g.n === 1 ? "" : "s"} of class ${g.cls} came from sessions that name no existing rig, in the last ${PROJECT_REPORT_WINDOW_HOURS / 24} days.`
          : `Project rig ${g.rig} filed ${g.n} ${PROJECT_REPORT_TAG} report${g.n === 1 ? "" : "s"} of class ${g.cls} in the last ${PROJECT_REPORT_WINDOW_HOURS / 24} days.`,
        threshold: `at least 1 un-archived stream item tagged ${PROJECT_REPORT_TAG} from a rig, emitted within ${PROJECT_REPORT_WINDOW_HOURS / 24} days, per ${PROJECT_REPORT_CLASS_PREFIX}<class>`,
        explanation: `${ordered.length} rig and class pair(s) report; ${reports} report(s) among ${population} stream items, ${ordinary} of them ordinary traffic; ${kernelIgnored} from the kernel rig ignored; ${unknownRig} from sessions naming no existing rig. Reports by class (kernel excluded): ${partitionText(classParts)}. The report body and the reporting session text are never read into a finding; open the stream items by rig and tag.`,
        suggestedInspection: g.rig === PROJECT_REPORT_UNKNOWN_RIG
          ? `List the ${PROJECT_REPORT_TAG} stream items of class ${g.cls} whose source session names no existing rig.`
          : `List the ${PROJECT_REPORT_TAG} stream items from rig ${g.rig} and read the pointer they carry.`,
      })),
    };
  }
}
