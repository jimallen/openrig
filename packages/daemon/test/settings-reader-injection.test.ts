// workspaces-6ul (CoS ruling A2): a domain object that reads settings takes an optional SettingsReader and falls back to
// DEFAULT_SETTINGS, which reads nothing. So a production site that forgets to pass the daemon's settings would compile and run on
// built-in defaults, silently ignoring config.json and the environment. This census parses every daemon source file and fails on any
// construction or call of a settings-reading entry point that does not pass its settings, naming the file and line.
//
// workspaces-dkb (build-arch's nit on 6ul): the entry points are found by their shape, not from a list of names, so a new one is
// checked the day it is written. An entry point is an exported function, or an exported class's constructor or public method, with
//   - a parameter of type SettingsReader that is optional (`?` or a default): its callers must pass that argument; or
//   - a parameter whose type (an interface, a type alias or an inline type literal) has an optional SettingsReader property: its
//     callers' options object must name that property.
// A call matches by name: a function by a bare call, a constructor by `new`, a method by a property-access call.
// Boundary: an options argument that is not an object literal (a deps object handed on, `this.executionDeps`), or a literal that spreads
// another object, is taken as forwarding its settings; only a literal can be read without the type checker. The census also fails on
// `new SettingsStore(` anywhere in src outside the settings code (the daemon builds its store through openSettingsStore).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? sources(full) : /\.ts$/.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** How a caller supplies the settings: a positional argument, or a property of an options object at an argument index. */
export type EntryPoint = { kind: "function" | "constructor" | "method"; name: string; index: number; property?: string };

const isReaderType = (t: ts.TypeNode | undefined): boolean => !!t && ts.isTypeReferenceNode(t) && t.typeName.getText() === "SettingsReader";
const hasExport = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
const isPrivate = (n: ts.Node): boolean => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) =>
  m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) || (ts.isMethodDeclaration(n) && ts.isPrivateIdentifier(n.name));

/** The optional SettingsReader property of a type literal or interface body, if it has one. */
function optionalReaderProperty(members: ts.NodeArray<ts.TypeElement>): string | undefined {
  for (const m of members) if (ts.isPropertySignature(m) && m.questionToken && isReaderType(m.type)) return m.name.getText();
  return undefined;
}

/** Every settings-reading entry point declared in `files`, found by shape. */
export function settingsEntryPoints(files: Record<string, string>): EntryPoint[] {
  const parsed = Object.entries(files).map(([file, text]) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  // Named option types with an optional reader property, across all files: interface X { settings?: SettingsReader } / type X = { ... }.
  const optionTypes = new Map<string, string>();
  for (const src of parsed) {
    const visit = (n: ts.Node): void => {
      if (ts.isInterfaceDeclaration(n)) { const p = optionalReaderProperty(n.members); if (p) optionTypes.set(n.name.text, p); }
      if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
        const p = optionalReaderProperty(n.type.members); if (p) optionTypes.set(n.name.text, p);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  const entries: EntryPoint[] = [];
  const consider = (kind: EntryPoint["kind"], name: string, params: ts.NodeArray<ts.ParameterDeclaration>): void => {
    params.forEach((p, index) => {
      if (isReaderType(p.type) && (p.questionToken || p.initializer)) entries.push({ kind, name, index });
      else if (p.type && ts.isTypeLiteralNode(p.type)) {
        const property = optionalReaderProperty(p.type.members); if (property) entries.push({ kind, name, index, property });
      } else if (p.type && ts.isTypeReferenceNode(p.type) && optionTypes.has(p.type.typeName.getText())) {
        entries.push({ kind, name, index, property: optionTypes.get(p.type.typeName.getText())! });
      }
    });
  };
  for (const src of parsed) {
    for (const st of src.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && hasExport(st)) consider("function", st.name.text, st.parameters);
      if (ts.isVariableStatement(st) && hasExport(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            consider("function", d.name.text, d.initializer.parameters);
          }
        }
      }
      if (ts.isClassDeclaration(st) && st.name && hasExport(st)) {
        for (const m of st.members) {
          if (ts.isConstructorDeclaration(m)) consider("constructor", st.name.text, m.parameters);
          if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && !isPrivate(m)) consider("method", m.name.text, m.parameters);
        }
      }
    }
  }
  return entries;
}

const supplies = (arg: ts.Expression | undefined, property: string): boolean => !!arg && (!ts.isObjectLiteralExpression(arg)
  || arg.properties.some((p) => ts.isSpreadAssignment(p)
    || ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === property)));

/** Each site in `files` that builds or calls an entry point of `entries` without its settings, as "file:line name"; and how many
 *  sites were checked. */
export function missingSettings(files: Record<string, string>, entries: EntryPoint[]): { missing: string[]; checked: number } {
  const missing: string[] = [];
  let checked = 0;
  for (const [file, text] of Object.entries(files)) {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node, name: string) => `${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1} ${name}`;
    const check = (n: ts.Node, kind: EntryPoint["kind"], name: string, args: readonly ts.Expression[]): void => {
      for (const e of entries) {
        if (e.kind !== kind || e.name !== name) continue;
        checked++;
        const ok = e.property === undefined ? args.length > e.index : supplies(args[e.index], e.property);
        if (!ok) missing.push(at(n, name));
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        const name = ts.isIdentifier(n.expression) ? n.expression.text : null;
        if (name === "SettingsStore") { checked++; missing.push(at(n, "new SettingsStore (use openSettingsStore)")); }
        if (name) check(n, "constructor", name, n.arguments ?? []);
      } else if (ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression)) check(n, "function", n.expression.text, n.arguments);
        else if (ts.isPropertyAccessExpression(n.expression)) check(n, "method", n.expression.name.text, n.arguments);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { missing, checked };
}

describe("workspaces-6ul: every daemon site that builds a settings-reading domain object passes the daemon's settings", () => {
  it("the scanner finds entry points by shape and flags each kind of omission (its own controls)", () => {
    const decls: Record<string, string> = {
      "d.ts": [
        "interface RepoOpts { settings?: SettingsReader; transport?: T }",
        "export class Repo { constructor(db: Db, bus: Bus, opts?: RepoOpts) {} private hidden(s?: SettingsReader) {} }",
        "export class Orch { constructor(deps: { db: Db; readinessSettings?: SettingsReader }) {} wire(deps: RepoOpts) {} }",
        "export function derive(facts: F, settings: SettingsReader = DEFAULT_SETTINGS) {}",
        "export const tick = (deps: RepoOpts) => deps;",
        "function internal(settings?: SettingsReader) {}",
        "export function required(settings: SettingsReader) {}",
      ].join("\n"),
    };
    const entries = settingsEntryPoints(decls);
    expect(entries).toEqual([   // in source order
      { kind: "constructor", name: "Repo", index: 2, property: "settings" },
      { kind: "constructor", name: "Orch", index: 0, property: "readinessSettings" },
      { kind: "method", name: "wire", index: 0, property: "settings" },
      { kind: "function", name: "derive", index: 1 },
      { kind: "function", name: "tick", index: 0, property: "settings" },
    ]);
    const { missing } = missingSettings({
      "a.ts": [
        "new Repo(db, bus, { transport });",
        "new Repo(db, bus, { transport, settings });",
        "new Orch({ db });",
        "new Orch({ db, readinessSettings: s });",
        "tick({ db });",
        "tick(deps); tick({ ...deps });",
        "derive({ state });",
        "derive({ state }, this.settings);",
        "view.wire({ db });",
        "wire({ db }); other.derive({ state });",
        "new SettingsStore(file, home);",
      ].join("\n"),
    }, entries);
    expect(missing).toEqual([
      "a.ts:1 Repo", "a.ts:3 Orch", "a.ts:5 tick", "a.ts:7 derive", "a.ts:9 wire", "a.ts:11 new SettingsStore (use openSettingsStore)",
    ]);
  });

  it("a new entry point written with an optional reader is checked the day it is written", () => {
    const files = {
      "fresh.ts": "export function resolveNewThing(key: string, settings: SettingsReader = DEFAULT_SETTINGS) { return key; }",
      "caller.ts": "resolveNewThing(\"x\");",
    };
    expect(missingSettings(files, settingsEntryPoints(files)).missing).toEqual(["caller.ts:1 resolveNewThing"]);
  });

  it("no daemon source site omits the settings", () => {
    const files = Object.fromEntries(sources(SRC)
      .filter((f) => !f.includes(join("domain", "user-settings")) && !f.includes(join("adapters", "node-settings-file.ts")))
      .map((f) => [relative(SRC, f), readFileSync(f, "utf8")]));
    const entries = settingsEntryPoints(Object.fromEntries(sources(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")])));
    // The entry points 6ul introduced, found by shape (positive control: a blind discovery would find none of them).
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining([
      "derivePickup", "readWaitingView", "readWakeLadderBackstop", "resolveReadinessTimeoutMs", "resolveWorkflowHumanDestination",
      "getTranscriptRotationOptionsFromEnv", "routeBundleContents", "runStuckSweep", "runWakeLadderTick", "buildExecutionView",
      "QueueRepository", "ViewProjector", "TranscriptStore", "BootstrapOrchestrator", "RestoreOrchestrator", "SeatHandoverService",
      "StartupOrchestrator", "SuccessorSessionLauncher", "setExecutionDeps",
    ]));
    const { missing, checked } = missingSettings(files, entries);
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(25);   // the sites found, so a clean result is not a blind scanner
  });
});
