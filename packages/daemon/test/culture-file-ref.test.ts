// workspaces-o9o.52 (verify-sec review, FIX 3): the shipped: culture_file's confinement takes the filesystem through a port
// (CulturePathIo, the realpath half of PathJudgeIo), and the rig spec validator loads no module that reads files.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { confineShippedCulture } from "../src/domain/culture-file-ref.js";
import { scanImports } from "./helpers/fork-hexagonal-boundary.js";

describe("the shipped: culture's dependency direction", () => {
  const src = (f: string) => nodePath.resolve(import.meta.dirname, "../src/domain", f);
  const imports = (f: string) => scanImports(src(f), readFileSync(src(f), "utf8")).edges.map((e) => e.specifier);

  it("the rig spec validator imports the pure culture_file module, never the file-reading guard", () => {
    expect(imports("rigspec-schema.ts")).toContain("./culture-file-ref.js");
    expect(imports("rigspec-schema.ts")).not.toContain("./culture-file-guard.js");
  });

  it("the pure culture_file module reaches only node:path (no filesystem, no adapter), through the shared confinement rule", () => {
    // workspaces-o9o.53: the confinement is the one shared with shipped: and agents-release: agent refs (confined-ref.ts), itself pure.
    expect(imports("culture-file-ref.ts")).toEqual(["node:path", "./confined-ref.js"]);
    expect(imports("confined-ref.ts")).toEqual(["node:path"]);
  });

  it("confinement runs on the port alone: a fake realpath decides, no filesystem is read", () => {
    const seen: string[] = [];
    const io = { realpath: (p: string) => { seen.push(p); if (p.endsWith("escape.md")) return "/elsewhere/secret.md"; return p; } };
    expect(confineShippedCulture("shipped:rigs/k/escape.md", "/nonexistent/specs", io)).toMatchObject({ ok: false });
    expect(confineShippedCulture("shipped:rigs/k/CULTURE.md", "/nonexistent/specs", io)).toEqual({ ok: true, absolutePath: "/nonexistent/specs/rigs/k/CULTURE.md", ownerRoot: "/nonexistent/specs" });
    expect(seen.length).toBeGreaterThan(0);
  });
});
