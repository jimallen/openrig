// workspaces-o9o.171: /project/mission/<id> rendered two h1s, the page title and the steering document's "# ..." heading.
// Every MarkdownViewer is shown inside a page that has its own h1, so a document's headings sit one level below the page
// title: # renders as h2, ## as h3, and so on. The test id and the size still follow the source level.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer";

afterEach(cleanup);

describe("o9o.171: a markdown document never adds an h1 to the page", () => {
  it("renders each source heading one level below the page title, and no h1", () => {
    const { container } = render(<MarkdownViewer content={"# Steering\n\n## Goals\n\n### Notes\n\n#### Detail"} hideRawToggle />);
    expect(container.querySelector("h1")).toBeNull();
    expect([1, 2, 3, 4].map((level) => screen.getByTestId(`md-heading-${level}`).tagName)).toEqual(["H2", "H3", "H4", "H5"]);
    expect(screen.getByTestId("md-heading-1").textContent).toBe("Steering");
  });
});
