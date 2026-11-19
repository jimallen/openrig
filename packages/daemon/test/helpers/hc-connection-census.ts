// workspaces-rt2 (Jim, 2026-11-19: "Merge the fix, harden the test next"). The finder behind hc-unchecked-connections.test.ts, resolved
// through the TypeScript type CHECKER instead of matching spellings (verify-sec showed the spelling finder missed `const C = HcClient`, an
// aliased import, `import * as tcp from "node:net"`, a renamed createConnection, `require("node:net")` and an imported wrapper module).
//
//  - An HcClient construction is any `new X(...)` whose X has HcClient's class type (an alias, a variable holding the class, a namespace
//    member, a re-export), and any `super(...)` in a class that extends it. Its third argument must be the literal `true`, or absent.
//  - A socket opening is any call or construction whose resolved declaration is node:net's `createConnection` / `connect` (a function, or
//    Socket's method) or node:net's `Socket` class, through any alias, namespace import or re-export.
//  - `require(...)` gives the checker nothing to resolve (it returns `any`), so every require call is listed, as is a dynamic `import()`
//    whose specifier is not a string literal.
//  - A wrapper is caught because its body is scanned (its own opening is a site), and every call that reaches a wrapper whose classification
//    PROPAGATES (it does not judge the hello itself) is a site too, transitively: its callers inherit its classification until a caller is
//    classified as the place the hello is judged.
import nodePath from "node:path";
import ts from "typescript";

export interface CensusSite {
  /** `<file relative to src>:<enclosing function, "Class.method", or "(module)">` */
  site: string;
  kind: "unchecked-hc-client" | "opening" | "require" | "dynamic-import" | "wrapper-call";
  /** For a wrapper call, the wrapper's own site; for an unchecked HcClient, the third argument's text. */
  detail: string;
}

const NET_FILE = /[\\/]@types[\\/]node[\\/]net\.d\.ts$/;
const isHcClientFile = (f: string) => /[\\/]adapters[\\/]hc-client\.ts$/.test(f);

/** The name of the function, method or variable a node sits in: "Class.method", "functionName" or "variable". */
export function enclosingDeclaration(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) return n;
    if (ts.isFunctionDeclaration(n) && n.name) return n;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n;
    if (ts.isPropertyDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n;
  }
  return undefined;
}

function declarationName(decl: ts.Node | undefined): string {
  if (!decl) return "(module)";
  const owner = (n: ts.Node) => (n.parent && (ts.isClassDeclaration(n.parent) || ts.isClassExpression(n.parent)) && n.parent.name ? n.parent.name.text : "?");
  if (ts.isConstructorDeclaration(decl)) return `${owner(decl)}.constructor`;
  if ((ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl) || ts.isPropertyDeclaration(decl)) && ts.isIdentifier(decl.name)) return `${owner(decl)}.${decl.name.text}`;
  if ((ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) && decl.name && ts.isIdentifier(decl.name)) return decl.name.text;
  return "(module)";
}

/** The declaration a call or construction resolves to, aliases followed. */
function resolvedDeclaration(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression): ts.Declaration | undefined {
  const sig = checker.getResolvedSignature(node);
  if (sig?.declaration && !ts.isJSDocSignature(sig.declaration)) return sig.declaration;
  let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/** True when `type` is HcClient's class (`typeof HcClient`) or a class deriving from it. */
function isHcClientClassType(checker: ts.TypeChecker, type: ts.Type): boolean {
  for (const sig of type.getConstructSignatures()) {
    let t: ts.Type | undefined = sig.getReturnType();
    for (let depth = 0; t && depth < 10; depth++) {
      const decls = t.getSymbol()?.declarations ?? [];
      if (decls.some((d) => ts.isClassDeclaration(d) && d.name?.text === "HcClient" && isHcClientFile(d.getSourceFile().fileName))) return true;
      t = t.isClassOrInterface() ? checker.getBaseTypes(t)[0] : undefined;
    }
  }
  return false;
}

function isNetOpening(decl: ts.Declaration | undefined): boolean {
  if (!decl || !NET_FILE.test(decl.getSourceFile().fileName)) return false;
  const name = (decl as { name?: ts.Node }).name;
  const text = name && ts.isIdentifier(name) ? name.text : ts.isConstructorDeclaration(decl) && decl.parent && ts.isClassDeclaration(decl.parent) ? decl.parent.name?.text : undefined;
  if (ts.isClassDeclaration(decl)) return decl.name?.text === "Socket";
  if (ts.isConstructorDeclaration(decl)) return text === "Socket";
  return text === "createConnection" || text === "connect";
}

/**
 * Every HcClient construction that turns the check off, every socket opening, every require() and computed import(), and every call that
 * reaches a propagating wrapper, in the program's source files under `srcRoot`. `propagates(site)` says whether a site's callers inherit it.
 */
export function censusHcConnections(program: ts.Program, srcRoot: string, propagates: (site: string) => boolean): CensusSite[] {
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && nodePath.resolve(f.fileName).startsWith(nodePath.resolve(srcRoot) + nodePath.sep));
  const rel = (f: ts.SourceFile) => nodePath.relative(srcRoot, f.fileName).split(nodePath.sep).join("/");
  const siteOf = (node: ts.Node) => `${rel(node.getSourceFile())}:${declarationName(enclosingDeclaration(node))}`;
  const out: CensusSite[] = [];
  const calls: { node: ts.CallExpression | ts.NewExpression; decl: ts.Declaration | undefined }[] = [];
  const checkThird = (node: ts.NewExpression | ts.CallExpression) => {
    const args = node.arguments ?? ts.factory.createNodeArray();
    const spread = args.some((a) => ts.isSpreadElement(a));
    const third = args[2];
    if (spread) out.push({ site: siteOf(node), kind: "unchecked-hc-client", detail: "(spread arguments)" });
    else if (third && third.kind !== ts.SyntaxKind.TrueKeyword) out.push({ site: siteOf(node), kind: "unchecked-hc-client", detail: third.getText() });
  };
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        if (isHcClientClassType(checker, checker.getTypeAtLocation(node.expression))) checkThird(node);
        const decl = resolvedDeclaration(checker, node);
        if (isNetOpening(decl) || isNetOpening(checker.getTypeAtLocation(node).getSymbol()?.declarations?.[0])) out.push({ site: siteOf(node), kind: "opening", detail: "new Socket" });
        calls.push({ node, decl });
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
          let cls: ts.Node | undefined = node.parent;
          while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
          const base = cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls))
            ? cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0] : undefined;
          if (base && isHcClientClassType(checker, checker.getTypeAtLocation(base.expression))) checkThird(node);
        } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) out.push({ site: siteOf(node), kind: "dynamic-import", detail: node.arguments[0]?.getText() ?? "" });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          out.push({ site: siteOf(node), kind: "require", detail: node.arguments[0]?.getText() ?? "" });
        } else {
          const decl = resolvedDeclaration(checker, node);
          if (isNetOpening(decl)) out.push({ site: siteOf(node), kind: "opening", detail: (decl as { name?: ts.Node }).name?.getText() ?? "connect" });
          calls.push({ node, decl });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Wrappers: the declaration each propagating site sits in; every call that resolves to one is a site, transitively.
  const wrapperDecls = new Map<ts.Node, string>();
  const addWrapper = (site: string, node: ts.Node) => {
    const decl = enclosingDeclaration(node);
    if (decl && !wrapperDecls.has(decl) && propagates(site)) wrapperDecls.set(decl, site);
  };
  const seed = (kind: CensusSite["kind"]) => kind === "opening" || kind === "unchecked-hc-client" || kind === "require" || kind === "dynamic-import";
  // Re-walk the recorded openings by node to seed the wrapper set.
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const site = siteOf(node);
        if (out.some((o) => o.site === site && seed(o.kind))) addWrapper(site, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
    changed = false;
    for (const { node, decl } of calls) {
      if (!decl) continue;
      const target = ts.isVariableDeclaration(decl.parent) ? decl.parent : decl;
      const wrapper = wrapperDecls.get(decl) ?? wrapperDecls.get(target);
      if (!wrapper) continue;
      const site = siteOf(node);
      if (!out.some((o) => o.site === site && o.kind === "wrapper-call" && o.detail === wrapper)) {
        out.push({ site, kind: "wrapper-call", detail: wrapper });
        const before = wrapperDecls.size;
        addWrapper(site, node);
        if (wrapperDecls.size !== before) changed = true;
      }
    }
  }
  return out;
}

/** A program over in-memory sources (path → text) beside the real node types, for the negative rows. */
export function fixtureProgram(files: Record<string, string>, typesRoot: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noEmit: true, types: ["node"], typeRoots: [typesRoot], skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const original = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (name, lang, ...rest) => (name in files ? ts.createSourceFile(name, files[name]!, lang, true) : original.getSourceFile(name, lang, ...rest));
  host.fileExists = (name) => name in files || original.fileExists(name);
  host.readFile = (name) => files[name] ?? original.readFile(name);
  // Module resolution asks whether a directory exists and for real paths: answer for the in-memory tree too.
  const dirs = new Set(Object.keys(files).flatMap((f) => f.split("/").slice(1, -1).map((_, i, parts) => `/${parts.slice(0, i + 1).join("/")}`)));
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dir) => dirs.has(dir.replace(/\/$/, "")) || (directoryExists ? directoryExists(dir) : false);
  const realpath = host.realpath?.bind(host);
  host.realpath = (p) => (p in files || dirs.has(p) ? p : realpath ? realpath(p) : p);
  return ts.createProgram(Object.keys(files), options, host);
}
