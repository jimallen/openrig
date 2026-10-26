// OF-56 (review-of45 delta): "no pin stops a future reader of a seat's saved sessionSource / packageRefs ignoring the
// OF-45 marker". rig-repository.ts reads a damaged nodes.session_source_json / nodes.package_refs as an EMPTY value plus
// `sessionSourceUnreadable` / `packageRefsUnreadable`; a reader that uses the value without the marker silently treats
// a damaged row as "the seat declared none" (what the exporter once did).
//
// Production consequence this pins: a new consumer of Node.sessionSource / Node.packageRefs (snapshot restore, export,
// launch, bundle) that does not look at the marker would act on a damaged seat as if it were an empty one.
//
// The instrument is the type checker, not a text search: every property access whose declaration is the `sessionSource`
// or `packageRefs` member of the `Node` interface in domain/types.ts, in packages/daemon/src (the same census OF-45
// took by renaming the two properties and reading the tsc errors). Spec-side members (RigSpec, pod members, snapshot
// nodes' RigSpec twins) are different declarations and are not counted.
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SRC = path.resolve(__dirname, "../src");

/** file -> the Node property names it reads, by repo-relative path. */
function nodeRowReaders(): Map<string, Set<string>> {
  const configPath = path.resolve(SRC, "../tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } })!;
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const checker = program.getTypeChecker();
  const out = new Map<string, Set<string>>();
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(SRC)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && (n.name.text === "sessionSource" || n.name.text === "packageRefs")) {
        const decl = checker.getSymbolAtLocation(n.name)?.declarations?.[0];
        const owner = decl && ts.isPropertySignature(decl) && ts.isInterfaceDeclaration(decl.parent) ? decl.parent.name.text : null;
        if (owner === "Node" && decl!.getSourceFile().fileName === path.join(SRC, "domain/types.ts")) {
          const rel = path.relative(SRC, file.fileName);
          (out.get(rel) ?? out.set(rel, new Set()).get(rel)!).add(n.name.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(file);
  }
  return out;
}

describe("OF-56: every reader of a seat's saved sessionSource / packageRefs honours the unreadable marker", () => {
  // Each reader and the marker it must also read (the text is found in the same file). A file not listed here is a new
  // reader: it must look at the marker, then be added with the marker it reads.
  const READERS: Record<string, { reads: string[]; marker: Record<string, string> }> = {
    "domain/rigspec-exporter.ts": { reads: ["packageRefs", "sessionSource"], marker: { packageRefs: "packageRefsUnreadable", sessionSource: "sessionSourceUnreadable" } },
    "domain/rigspec-instantiator.ts": { reads: ["sessionSource"], marker: { sessionSource: "sessionSourceUnreadable" } },
  };

  it("the readers of the two Node properties are exactly the listed files, each reading its marker", async () => {
    const readers = nodeRowReaders();
    // Positive control: the census sees the readers at all (an empty map would make the next line pass vacuously).
    expect(readers.size).toBeGreaterThan(0);
    expect([...readers.keys()].sort(), "a new reader of Node.sessionSource / Node.packageRefs: honour the marker, then list it here").toEqual(Object.keys(READERS).sort());
    const { readFileSync } = await import("node:fs");
    for (const [file, props] of readers) {
      const expected = READERS[file]!;
      expect([...props].sort(), file).toEqual([...expected.reads].sort());
      const text = readFileSync(path.join(SRC, file), "utf8");
      for (const prop of props) expect(text, `${file} reads Node.${prop} without ${expected.marker[prop]}`).toContain(expected.marker[prop]!);
    }
  }, 180_000);
});
