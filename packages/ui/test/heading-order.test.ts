// workspaces-o9o.158: no heading level is skipped (axe heading-order). Each sibling set moves up together: the feed cards
// and the review bands are sections of their page (h1), so their titles are h2, and what nests inside them is one below.
// The browser measurement is the heading-outline census of every twin route; these pin the levels each file renders.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (rel: string) => readFileSync(path.resolve(__dirname, "..", "src", "components", rel), "utf8");
/** The heading levels a source file renders with literal <hN> tags, sorted, distinct. */
const levels = (text: string) => [...new Set([...text.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1])))].sort();

describe("heading order (o9o.158)", () => {
  const files: Array<[string, number[], string]> = [
    ["for-you/FeedCard.tsx", [2], "a feed card is a section of the For You page"],
    ["review/NeedsYouAccordion.tsx", [2], "a review band"],
    ["review/AgentsBandView.tsx", [2], "a review band"],
    ["review/VerifyLineageCard.tsx", [2], "a review band"],
    ["review/SliceReviewTab.tsx", [2], "the slice review's bands (Intent, Plan, Delivered, SETTLED)"],
    ["review/MissionReviewTab.tsx", [2, 3], "the mission review's bands, and a board row's INTENT / DELIVERED inside SLICES"],
    ["lab/ProjectGraphicsPreview.tsx", [1, 2, 3], "the lab page: its h1, the cards, their step titles"],
  ];
  for (const [rel, want, why] of files) {
    it(`${rel} renders levels ${want.join(",")}: ${why}`, () => {
      expect(levels(src(rel))).toEqual(want);
    });
  }

  it("control: the level scan reads a real file's headings", () => {
    expect(levels('<h1 a>x</h1><h3 b>y</h3>')).toEqual([1, 3]);
    expect(levels(src("review/SliceReviewTab.tsx")).length).toBeGreaterThan(0);
  });
});
