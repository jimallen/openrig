// workspaces-o9o.155: the color-contrast violations the o9o.130 twin axe scan found (15 elements, 6 surfaces), each measured
// in Chromium at release-7 and fixed here. jsdom cannot compute contrast, so these pin the class change per site, the way
// this repo pins layout classes; the measurement is the twin scan (`npm run twin:a11y`, o9o.130).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (rel: string) => readFileSync(path.resolve(__dirname, "..", "src", "components", rel), "utf8");
/** Every className="..." literal in a source file. */
const classLists = (text: string) => [...text.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/));

describe("contrast fixes (o9o.130 scan, o9o.155)", () => {
  it("LevelControl: the header's note uses the inverse foreground, dimmed (was the body's muted colour on the inverse header: 3.04 light, 1.93 dark)", () => {
    const s = src("for-you/LevelControl.tsx");
    expect(s).toContain('<span className="text-background/70">action items always on</span>');
    expect(s).not.toContain('<span className="text-on-surface-variant">action items always on</span>');
  });

  it("LevelControl: the amber highlights use the warning ink, not a fixed amber (amber-700 was 3.72 on dark)", () => {
    const s = src("for-you/LevelControl.tsx");
    expect(s).not.toMatch(/text-amber-\d/);
    expect((s.match(/className="text-warning-ink"/g) ?? []).length).toBe(3);
  });

  for (const [rel, n] of [["system/ClaudeCompactionPolicyForm.tsx", 6], ["mission-control/views/AuditHistoryView.tsx", 5]] as const) {
    it(`${rel}: every text field and select sets the surface and text colours (no browser-white field in dark: 1.23 and 1.07)`, () => {
      const s = src(rel);
      const controls = [...s.matchAll(/<(input|textarea|select)\b[\s\S]*?className="([^"]*)"/g)]
        .filter((m) => !/type="checkbox"/.test(m[0]))
        .map((m) => m[2]!.split(/\s+/));
      expect(controls.length).toBe(n);
      for (const c of controls) {
        expect(c, c.join(" ")).toContain("bg-surface-lowest");
        expect(c, c.join(" ")).toContain("text-on-surface");
      }
    });
  }

  it("LaunchRecoveryModal: an unselected policy option is on the theme's surface, not a fixed white (its note was 3.27 on dark)", () => {
    const s = src("LaunchRecoveryModal.tsx");
    expect(s).toContain('"border-outline bg-surface-lowest text-on-surface"');
    expect(s).not.toContain("bg-white text-stone-700");
  });

  it("TerminalLauncher: the group labels are the full muted colour (at 70% they were 3.1 light, 4.45 dark)", () => {
    const labels = classLists(src("topology/TerminalLauncher.tsx")).filter((c) => c.includes("tracking-[0.2em]") && c.includes("bg-surface-low"));
    expect(labels.length).toBeGreaterThan(0);
    for (const c of labels) {
      expect(c).toContain("text-on-surface-variant");
      expect(c.filter((x) => /^text-on-surface-variant\/\d+$/.test(x))).toEqual([]);
    }
  });

  it("control: the class scan sees the fields and labels it checks", () => {
    expect(classLists(src("topology/TerminalLauncher.tsx")).length).toBeGreaterThan(10);
    expect(classLists(src("system/ClaudeCompactionPolicyForm.tsx")).length).toBeGreaterThan(5);
  });
});
