// workspaces-o9o.130: axe-core is a dev dependency of the UI, so accessibility can be scanned rather than measured by hand.
// This pins that it is installed and runs here with its default rule set: a seeded unnamed button and an image without alt
// are reported, and a control with both fixed is clean for those rules. (Colour contrast cannot be judged in jsdom; the
// twin scan in a real browser covers it: twin/capture/a11y-scan.ts.)
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";

afterEach(cleanup);

async function violations(node: Element): Promise<string[]> {
  const result = await axe.run(node);
  return result.violations.map((v) => v.id).sort();
}

describe("axe-core runs in the UI's test environment (o9o.130)", () => {
  it("reports a seeded unnamed button and an image without alt", async () => {
    const { container } = render(<main><button type="button" /><img src="data:," /></main>);
    const ids = await violations(container);
    expect(ids).toContain("button-name");
    expect(ids).toContain("image-alt");
  });

  it("control: the same markup with a name and an alt has neither violation", async () => {
    const { container } = render(<main><button type="button">Open</button><img src="data:," alt="Rig graph" /></main>);
    const ids = await violations(container);
    expect(ids).not.toContain("button-name");
    expect(ids).not.toContain("image-alt");
  });
});
