// OF-234 / OF-239 — no daemon, cli or tui test opens a network listener on every interface.
//
// A mock server started with `server.listen(0, cb)` (no host) binds the unspecified address: while the test runs it is reachable
// from the LAN and the tailnet, not only from the test. OF-232 pinned the daemons the tests spawn; this census covers the mock
// servers the tests start themselves. Measured at 4cca0573 (TypeScript AST over packages/daemon/test): 78 `.listen(` calls in 50
// files, 77 already pinned or not TCP, ONE host-less TCP listen (hosts-add-pair-routes.test.ts, `target.listen(0, resolve)`).
//
// Structural, not text: every `.listen(` call and every `serve({...})` call is classified by the shape of its arguments. A call
// that fits no class fails, so a new kind of listener cannot arrive unclassified.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// OF-239: the same census covers the cli and tui test trees (one rule, one classifier; measured at d05bcda2: cli 126 calls in 88 files, 71 of them host-less
// TCP listens in 52 files, now pinned; tui 11 calls, all pinned; ui has no test listener). Paths in a failure are relative to packages/.
const PACKAGES = path.resolve(HERE, "../..");
const TEST_PACKAGES = ["daemon", "cli", "tui"] as const;
const TEST_DIR = PACKAGES;

const LOOPBACK_LITERALS = new Set(["127.0.0.1", "::1", "localhost"]);
/** Identifiers that name the loopback host constant the daemon-entrypoint helper exports. */
const LOOPBACK_CONSTANTS = new Set(["TEST_DAEMON_BIND_HOST"]);

export type ListenClass = "tcp-loopback" | "tcp-host-param" | "unix-socket" | "own-listen-method" | "violation";
export interface ListenFinding { line: number; kind: "listen" | "serve"; cls: ListenClass; text: string }

const isNumberish = (n: ts.Expression): boolean => ts.isNumericLiteral(n) || (ts.isIdentifier(n) && /port/i.test(n.text)) || (ts.isPropertyAccessExpression(n) && /port/i.test(n.name.text));
const isPathish = (n: ts.Expression): boolean => {
  const name = ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : ts.isStringLiteralLike(n) ? "path" : "";
  return /(path|sock)/i.test(name);
};
function isLoopbackHost(n: ts.Expression): boolean {
  if (ts.isStringLiteralLike(n)) return LOOPBACK_LITERALS.has(n.text);
  if (ts.isIdentifier(n)) return LOOPBACK_CONSTANTS.has(n.text);
  return false;
}

/** Classify every network-binding call in one source text. `host` identifier params are accepted only when the file's
 *  call sites feed loopback literals (it is the it.each(["127.0.0.1", "::1"]) shape); see HOST_PARAM_FILES. */
export function classifyListens(fileName: string, source: string): ListenFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const ownListenMethod = (() => {
    let found = false;
    // A class method `listen() {}` or a helper object's `listen: () => ...` property (the cli status/agent tests wrap their pinned server.listen in one).
    const v = (n: ts.Node): void => {
      if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "listen") found = true;
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "listen" && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = true;
      ts.forEachChild(n, v);
    };
    v(sf);
    return found;
  })();
  const out: ListenFinding[] = [];
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "listen") {
      const [first, second] = n.arguments;
      let cls: ListenClass = "violation";
      if (!first || ts.isArrowFunction(first) || ts.isIdentifier(first) && /^(r|resolve|done)$/.test(first.text)) {
        cls = ownListenMethod && n.arguments.length === 0 ? "own-listen-method" : "violation";
      } else if (isNumberish(first)) {
        if (second && isLoopbackHost(second)) cls = "tcp-loopback";
        else if (second && ts.isIdentifier(second) && second.text === "host") cls = "tcp-host-param";
      } else if (isPathish(first)) {
        cls = "unix-socket";
      }
      out.push({ line: line(n), kind: "listen", cls, text: n.getText(sf).replace(/\s+/g, " ").slice(0, 90) });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "serve") {
      const [opts] = n.arguments;
      const named = (p: ts.ObjectLiteralElementLike, name: string): boolean => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === name;
      if (opts && ts.isObjectLiteralExpression(opts) && opts.properties.some(p => named(p, "fetch"))) {
        const host = opts.properties.find(p => named(p, "hostname"));
        let ok = false;
        if (host && ts.isPropertyAssignment(host) && isLoopbackHost(host.initializer)) ok = true;
        else if (host && (ts.isShorthandPropertyAssignment(host) || (ts.isPropertyAssignment(host) && ts.isIdentifier(host.initializer)))) {
          // The host is a parameter of the enclosing function: every call of that function in this file must pass a loopback literal.
          const pname = ts.isShorthandPropertyAssignment(host) ? host.name.text : (host.initializer as ts.Identifier).text;
          let fn: ts.Node | undefined = n.parent;
          while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
          const idx = fn && ts.isFunctionDeclaration(fn) ? fn.parameters.findIndex(p => ts.isIdentifier(p.name) && p.name.text === pname) : -1;
          const fname = fn && ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : "";
          if (idx >= 0 && fname) {
            const calls: ts.CallExpression[] = [];
            const find = (m: ts.Node): void => { if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === fname) calls.push(m); ts.forEachChild(m, find); };
            find(sf);
            ok = calls.length > 0 && calls.every(c => c.arguments[idx] !== undefined && isLoopbackHost(c.arguments[idx]!));
          }
        }
        out.push({ line: line(n), kind: "serve", cls: ok ? "tcp-loopback" : "violation", text: n.getText(sf).replace(/\s+/g, " ").slice(0, 90) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name)) out.push(full);
    }
  };
  for (const pkg of TEST_PACKAGES) walk(path.join(PACKAGES, pkg, "test"));
  return out.sort();
}

describe("OF-234: the classifier sees a host-less listen (instrument rows)", () => {
  it("flags a TCP listen with no host, and a callback-only listen", () => {
    expect(classifyListens("a.ts", "s.listen(0, resolve);").map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", "s.listen(0);").map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", "s.listen(port, () => r());").map(f => f.cls)).toEqual(["violation"]);
  });
  it("flags a non-loopback host, including 0.0.0.0 and an empty string", () => {
    expect(classifyListens("a.ts", 's.listen(0, "0.0.0.0", r);').map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", 's.listen(0, "", r);').map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", 's.listen(0, "100.64.0.1", r);').map(f => f.cls)).toEqual(["violation"]);
  });
  it("accepts a loopback pin, a unix socket and the daemon helper's constant", () => {
    expect(classifyListens("a.ts", 's.listen(0, "127.0.0.1", r);').map(f => f.cls)).toEqual(["tcp-loopback"]);
    expect(classifyListens("a.ts", 's.listen(0, "::1");').map(f => f.cls)).toEqual(["tcp-loopback"]);
    expect(classifyListens("a.ts", "s.listen(0, TEST_DAEMON_BIND_HOST, r);").map(f => f.cls)).toEqual(["tcp-loopback"]);
    expect(classifyListens("a.ts", "s.listen(socketPath, resolve);").map(f => f.cls)).toEqual(["unix-socket"]);
  });
  it("flags a hono serve() with no hostname, accepts one with a loopback hostname", () => {
    expect(classifyListens("a.ts", "serve({ fetch, port: 0 });").map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", 'serve({ fetch, port: 0, hostname: "0.0.0.0" });').map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", 'serve({ fetch, port: 0, hostname: "127.0.0.1" });').map(f => f.cls)).toEqual(["tcp-loopback"]);
  });
  it("a serve() hostname that is a parameter is accepted only when every call passes a loopback literal", () => {
    const fn = (arg: string): string => `function listen(app: A, hostname: string) { return serve({ fetch: app.fetch, port: 0, hostname }); } listen(a, ${arg});`;
    expect(classifyListens("a.ts", fn('"127.0.0.1"')).map(f => f.cls)).toEqual(["tcp-loopback"]);
    expect(classifyListens("a.ts", fn('"0.0.0.0"')).map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", fn("someHost")).map(f => f.cls)).toEqual(["violation"]);
  });
  it("accepts a zero-argument listen() only where the file declares its own listen method", () => {
    expect(classifyListens("a.ts", "core.listen();").map(f => f.cls)).toEqual(["violation"]);
    expect(classifyListens("a.ts", "class C { async listen() {} } const c = new C(); c.listen();").map(f => f.cls)).toEqual(["own-listen-method"]);
    expect(classifyListens("a.ts", "const h = { listen: () => new Promise(r => s.listen(0, r)) }; h.listen();").map(f => f.cls)).toEqual(["violation", "own-listen-method"]);
    expect(classifyListens("a.ts", 'const h = { listen: () => new Promise(r => s.listen(0, "127.0.0.1", r)) }; h.listen();').map(f => f.cls)).toEqual(["tcp-loopback", "own-listen-method"]);
  });
});

describe("OF-234: every listener a daemon test opens is loopback", () => {
  const findings = testFiles().flatMap(file => {
    const rel = path.relative(TEST_DIR, file);
    return classifyListens(file, fs.readFileSync(file, "utf8")).map(f => ({ ...f, rel }));
  });

  it("the census sees the population (positive control: a clean zero below is not an empty scan)", () => {
    expect(findings.filter(f => f.kind === "listen").length).toBeGreaterThan(50);
    // Per package, so a scan that silently lost one tree cannot pass on the others' population.
    const per = (pkg: string) => findings.filter(f => f.kind === "listen" && f.rel.startsWith(`${pkg}${path.sep}test${path.sep}`)).length;
    expect(per("daemon"), "daemon test listeners seen").toBeGreaterThan(50);
    expect(per("cli"), "cli test listeners seen").toBeGreaterThan(100);
    expect(per("tui"), "tui test listeners seen").toBeGreaterThan(5);
    expect(findings.filter(f => f.cls === "tcp-loopback").length).toBeGreaterThan(20);
    expect(findings.filter(f => f.cls === "unix-socket").length).toBeGreaterThan(10);
  });

  it("no listen/serve call binds all interfaces or a non-loopback host", () => {
    const bad = findings.filter(f => f.cls === "violation").map(f => `${f.rel}:${f.line}  ${f.text}`);
    expect(bad, "a host-less or non-loopback listener: pass \"127.0.0.1\" as the host").toEqual([]);
  });

  it("a parameterised host reaches only loopback literals", () => {
    const files = [...new Set(findings.filter(f => f.cls === "tcp-host-param").map(f => f.rel))];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(TEST_DIR, rel), "utf8");
      const each = /it\.each\(\s*\[([^\]]*)\]\s*\)/.exec(src);
      expect(each, `${rel}: a host parameter must come from an it.each of loopback literals`).not.toBeNull();
      const literals = [...each![1]!.matchAll(/["']([^"']+)["']/g)].map(m => m[1]!);
      expect(literals.filter(l => !LOOPBACK_LITERALS.has(l)), rel).toEqual([]);
    }
  });
});
