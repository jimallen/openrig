// workspaces-o9o.116: cn() (tailwind-merge) did not know the theme's custom font sizes (tailwind.config fontSize: label-sm and
// the rest), so it read a custom size and a text colour in the same call as one conflict and kept only the last. The size
// was dropped where the colour came after it (the install stepper rendered at ~16px), and the colour where it came before
// (every table header lost text-foreground-muted). Now cn() knows the sizes: a size and a colour both stay, and two sizes
// dedupe the way two standard sizes do.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { cn, CUSTOM_FONT_SIZES } from "../src/lib/utils.js";
import { Table, TableHeader, TableRow, TableHead } from "../src/components/ui/table.js";
import tailwindConfig from "../tailwind.config.js";

afterEach(cleanup);

const configSizes = () => Object.keys((tailwindConfig as { theme: { extend: { fontSize: Record<string, unknown> } } }).theme.extend.fontSize);

describe("cn() knows the theme's custom font sizes (o9o.116)", () => {
  it("drift guard: cn()'s list is exactly tailwind.config's fontSize keys", () => {
    expect([...CUSTOM_FONT_SIZES].sort()).toEqual(configSizes().sort());
    expect(CUSTOM_FONT_SIZES.length).toBeGreaterThan(0);
  });

  for (const size of configSizes()) {
    it(`text-${size} and a text colour both stay, in either order`, () => {
      expect(cn(`text-${size}`, "text-success").split(" ")).toEqual([`text-${size}`, "text-success"]);
      expect(cn("text-foreground-muted", `text-${size}`).split(" ")).toEqual(["text-foreground-muted", `text-${size}`]);
    });
  }

  it("two sizes dedupe, the later one winning, as for standard sizes", () => {
    expect(cn("text-label-md", "text-[9px]")).toBe("text-[9px]");
    expect(cn("text-sm", "text-label-sm")).toBe("text-label-sm");
    expect(cn("text-label-sm", "text-label-md")).toBe("text-label-md");
  });

  it("control: a variant-prefixed size is a different group and stays beside a plain colour", () => {
    expect(cn("md:text-label-sm", "text-success")).toBe("md:text-label-sm text-success");
  });

  it("TableHead keeps its own muted colour and label-md size", () => {
    render(<Table><TableHeader><TableRow><TableHead data-testid="th">Seat</TableHead></TableRow></TableHeader></Table>);
    const classes = screen.getByTestId("th").className.split(/\s+/);
    expect(classes).toContain("text-foreground-muted");
    expect(classes).toContain("text-label-md");
  });
});
