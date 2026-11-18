// workspaces-o9o.175: the shared detail drawer is a dialog over the page. Its viewers head their content with a <header>,
// which was a second banner landmark: axe reported landmark-banner-is-top-level (a banner inside a dialog) and
// landmark-no-duplicate-banner / landmark-unique against the page's own top bar. The drawer's content now sits in sectioning
// content, so the header heads the sheet and the page keeps the one banner. Real axe-core over the whole document.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import axe from "axe-core";
import { SharedDetailDrawer, type DrawerSelection } from "../src/components/SharedDetailDrawer";

afterEach(cleanup);

const LANDMARK_RULES = ["landmark-banner-is-top-level", "landmark-no-duplicate-banner", "landmark-unique"];

async function landmarkViolations(): Promise<string[]> {
  const result = await axe.run(document, { runOnly: { type: "rule", values: LANDMARK_RULES } });
  return result.violations.map((v) => v.id).sort();
}

/** The page as the app lays it out: one top-bar banner, the main content, and the drawer over it. */
function page(selection: DrawerSelection) {
  return render(
    <>
      <header data-testid="page-top-bar">OpenRig</header>
      <main>Workspace</main>
      <SharedDetailDrawer selection={selection} onClose={() => {}} events={[]} />
    </>,
  );
}

describe("o9o.175: the shared detail drawer adds no banner landmark", () => {
  it("control: axe here does report a second top-level banner on the page", async () => {
    render(<><header>OpenRig</header><main>Workspace</main><header>Second</header></>);
    expect(await landmarkViolations()).toContain("landmark-no-duplicate-banner");
  });

  const selections: Array<[string, DrawerSelection]> = [
    ["queue item", { type: "qitem", data: { qitemId: "qitem-20261118-o175" } }],
    ["file", { type: "file", data: { path: "docs/guide.md", kind: "markdown", content: "# Guide" } }],
  ];

  it.each(selections)("%s drawer: one banner on the page, and axe finds no landmark violation", async (_kind, selection) => {
    page(selection);
    const dialog = screen.getByRole("dialog");
    // Positive control: the viewer still renders its header inside the dialog.
    expect(dialog.querySelector("header")).not.toBeNull();
    // testing-library's role computation does not scope a <header> by sectioning content; axe does, as browsers do.
    expect(await landmarkViolations()).toEqual([]);
  });
});
