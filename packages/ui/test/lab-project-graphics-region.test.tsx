// workspaces-o9o.156: axe scrollable-region-focusable (serious) on /lab/project-graphics-preview. The shell's <main> scrolls there and
// holds nothing focusable, so a keyboard user of a browser that does not make scrollers focusable itself (Safari) cannot scroll it.
// Measured: Chromium already makes that <main> a tab stop; every other page's <main> holds its own controls. CoS decision A: page-local.
// The lab page's gallery is a region named by its visible heading and focusable, so <main> holds focusable content and arrow keys scroll it
// from there; the shell and every other page are unchanged. jsdom has no layout, so axe cannot judge scrolling here: the twin scan in
// Chromium measures the rule; this pins the structure and that the region's ARIA is valid.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { ProjectGraphicsPreview } from "../src/components/lab/ProjectGraphicsPreview.js";

afterEach(cleanup);

describe("the project graphics preview (lab) can be reached and scrolled from the keyboard", () => {
  it("its gallery is one focusable region, named by the page's own heading", () => {
    const { container, getByRole } = render(<main><ProjectGraphicsPreview /></main>);
    const regions = [...container.querySelectorAll('[role="region"]')];
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.getAttribute("tabindex")).toBe("0");
    const heading = getByRole("heading", { level: 1 });
    expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.id).not.toBe("");
    expect(getByRole("region", { name: heading.textContent ?? "" })).toBe(region);
  });

  it("axe finds no ARIA violation on the page (default rules)", async () => {
    const { container } = render(<main><ProjectGraphicsPreview /></main>);
    const result = await axe.run(container);
    expect(result.violations.filter((v) => v.id.startsWith("aria-")).map((v) => v.id)).toEqual([]);
  });
});
