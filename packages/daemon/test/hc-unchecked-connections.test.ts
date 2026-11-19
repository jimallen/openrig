// workspaces-87f (verify-sec, attempt 3; Jim: "One more round, fix the root"). Every hello the daemon makes to the hc core must be judged
// against the pin, but the readers were found one at a time: the stream (attempt 2), then refreshStale, which built an HcClient with the
// check OFF (attempt 3). This census is the root: it PARSES daemon src (TypeScript AST, not grep) and fails on
//   (A) any `new HcClient(...)` that turns the per-socket check off (a third argument that is not the literal `true`), except the one
//       deliberate probe, probeCore, whose caller (HcCoreWatch.connectOnce) verifies and pins its hello itself; and
//   (B) any socket the daemon opens (`createConnection`, node:net `connect`, `new Socket`) in a place not classified below. A new one fails
//       here until it is classified: an hc connection must say how its hello is judged.
// Each rule has a positive control that runs the finder on in-memory source.
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(nodePath.join(dir, e.name)) : e.name.endsWith(".ts") ? [nodePath.join(dir, e.name)] : []);
}

/** The name of the function, method or variable a node sits in: "Class.method", "functionName" or "variable". */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n)) {
      const cls = n.parent && ts.isClassDeclaration(n.parent) && n.parent.name ? n.parent.name.text : "?";
      const method = ts.isConstructorDeclaration(n) ? "constructor" : n.name && ts.isIdentifier(n.name) ? n.name.text : "?";
      return `${cls}.${method}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
  }
  return "(module)";
}

interface Construction { site: string; third: string | null }
interface Opening { site: string; how: string }

/** Every `new HcClient(...)` and every socket opening in one source text. */
export function findConnections(file: string, text: string): { constructions: Construction[]; openings: Opening[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `connect` counts only where it is node:net's (imported from "node:net" or "net"); a bare connect() elsewhere is a local function.
  const netConnect = new Set<string>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !["node:net", "net"].includes(s.moduleSpecifier.text)) continue;
    const named = s.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) if ((el.propertyName ?? el.name).text === "connect") netConnect.add(el.name.text);
  }
  const constructions: Construction[] = [];
  const openings: Opening[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "HcClient") {
        const third = node.arguments?.[2];
        constructions.push({ site: `${file}:${enclosingName(node)}`, third: third ? third.getText(source) : null });
      }
      if (node.expression.text === "Socket") openings.push({ site: `${file}:${enclosingName(node)}`, how: "new Socket" });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const receiver = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
      if (name === "createConnection") openings.push({ site: `${file}:${enclosingName(node)}`, how: "createConnection" });
      else if ((ts.isIdentifier(callee) && netConnect.has(callee.text)) || (receiver === "net" && name === "connect")) {
        openings.push({ site: `${file}:${enclosingName(node)}`, how: "net.connect" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { constructions, openings };
}

/** The one HcClient allowed to turn the per-socket check off. */
const UNCHECKED_PROBE = "adapters/hc-core-watch.ts:probeCore";

/** Every place the daemon opens a socket, and how its hello (if it is the hc core) is judged. */
const CLASSIFIED: Record<string, string> = {
  "adapters/hc-client.ts:HcClient.open": "hc core: every hello passes greet, which runs checkHcHello (per-socket pin) and the client's ownCheck",
  "adapters/hc-attach.ts:HcAttach.connect": "hc core: the attach wire's hello runs checkHcHello before anything is asked",
  "adapters/hc-viewer.ts:CoreSizeSource.watch": "hc core: the size watch's hello runs checkHcHello before it subscribes",
  "adapters/hc-core-watch.ts:openStream": "hc core: the watch's own stream; HcCoreWatch.connectOnce runs verifyHello on its hello and pins it (pinFromHello)",
  "adapters/native-inbox-os.ts:writeSocketLines": "not the hc core: the native inbox socket (lines out, nothing read back)",
  "domain/gateway/transport.ts:connectGateway": "not the hc core: the Slack connector's socket",
  "routes/hosts.ts:probeHost": "not the hc core: a TCP reachability probe to a registered remote host (node:net connect)",
};

const tree = () => {
  const all = walk(SRC).map((f) => findConnections(nodePath.relative(SRC, f).split(nodePath.sep).join("/"), fs.readFileSync(f, "utf8")));
  return { constructions: all.flatMap((a) => a.constructions), openings: all.flatMap((a) => a.openings), files: all.length };
};

describe("no hc core connection without the check (workspaces-87f root fix; parsed, not grepped)", () => {
  it("every HcClient construction keeps the per-socket check, except the one deliberate probe", () => {
    const { constructions, files } = tree();
    expect(files).toBeGreaterThan(300);  // positive control: the scan saw the tree
    expect(constructions.length).toBeGreaterThan(5);
    const unchecked = constructions.filter((c) => c.third !== null && c.third !== "true");
    expect(unchecked).toEqual([{ site: UNCHECKED_PROBE, third: "false" }]);
  });

  it("every socket the daemon opens is classified, and each hc one says how its hello is judged", () => {
    const { openings } = tree();
    const sites = [...new Set(openings.map((o) => o.site))].sort();
    expect(sites).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("the classified hc openers really run the check (the text each classification names is in its file)", () => {
    const text = (f: string) => fs.readFileSync(nodePath.join(SRC, f), "utf8");
    expect(text("adapters/hc-client.ts")).toMatch(/if \(this\.enforcePin\) checkHcHello\(this\.socketPath, hello\);\s*this\.ownCheck\?\.\(hello\);/);
    expect(text("adapters/hc-attach.ts")).toContain("checkHcHello(socketPath, hello);");
    expect(text("adapters/hc-viewer.ts")).toContain("checkHcHello(this.socketPath, hello);");
    const watch = text("adapters/hc-core-watch.ts");
    expect(watch).toMatch(/verifyHello\(stream\.hello, \{ \.\.\.this\.options\.pin, coreId: this\.coreId \}\);[\s\S]*?this\.pinFromHello\(stream\.hello\);/);
    expect(watch).toMatch(/verifyHello\(presence\.hello, \{ \.\.\.this\.options\.pin, coreId: this\.coreId \}\);\s*this\.pinFromHello\(presence\.hello\);/);
  });

  describe("positive controls: the finder on in-memory source", () => {
    it("flags an HcClient that turns the check off, by literal or by a value", () => {
      const src = `function readSomething(p: string, enforce: boolean) { const a = new HcClient(p, undefined, false); const b = new HcClient(p, 1000, enforce); const c = new HcClient(p); const d = new HcClient(p, 5, true); }`;
      expect(findConnections("x.ts", src).constructions.map((c) => c.third)).toEqual(["false", "enforce", null, "true"]);
      expect(findConnections("x.ts", src).constructions.every((c) => c.site === "x.ts:readSomething")).toBe(true);
    });
    it("finds createConnection, node:net connect (renamed too) and new Socket, and not a local connect()", () => {
      const src = `import { connect as dial, createConnection } from "node:net";\nimport * as net from "node:net";\n`
        + `class A { open() { return createConnection("/s"); } }\nconst b = () => dial({ host: "h", port: 1 });\nfunction c() { net.connect(1); new Socket(); }\nfunction connect() {}\nfunction d() { connect(); }`;
      expect(findConnections("y.ts", src).openings).toEqual([
        { site: "y.ts:A.open", how: "createConnection" },
        { site: "y.ts:b", how: "net.connect" },
        { site: "y.ts:c", how: "net.connect" },
        { site: "y.ts:c", how: "new Socket" },
      ]);
    });
  });
});
