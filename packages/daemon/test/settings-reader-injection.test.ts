// workspaces-6ul (CoS ruling A2): a domain object that reads settings takes an optional SettingsReader and falls back to
// DEFAULT_SETTINGS, which reads nothing. So a production site that forgets to pass the daemon's settings would compile and run on
// built-in defaults, silently ignoring config.json and the environment. This census parses every daemon source file and fails on any
// construction or call of a settings-reading entry point that does not pass its settings, naming the file and line.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Constructors whose options object must name the settings: [class, argument index, property]. */
const CONSTRUCTORS: Array<[string, number, string]> = [
  ["QueueRepository", 2, "settings"], ["ViewProjector", 2, "settings"], ["TranscriptStore", 0, "settings"],
  ["BootstrapOrchestrator", 0, "settings"], ["RestoreOrchestrator", 0, "settings"], ["SeatHandoverService", 0, "settings"],
  ["StartupOrchestrator", 0, "readinessSettings"], ["SuccessorSessionLauncher", 2, "readinessSettings"],
];
/** Calls whose options object must name the settings: [function or method, argument index, property]. routeBundleContents counts
 *  only as the module function (a bare name): the orchestrator's method and its deps hook of the same name take a path alone. */
const OPTION_CALLS: Array<[string, number, string]> = [
  ["runStuckSweep", 0, "settings"], ["runWakeLadderTick", 0, "settings"], ["routeBundleContents", 1, "settings"],
  ["setExecutionDeps", 0, "settings"],
];
/** Calls whose settings are a positional argument: [function, the argument count that includes it]. */
const POSITIONAL_CALLS: Array<[string, number]> = [
  ["derivePickup", 2], ["readWaitingView", 4], ["readWakeLadderBackstop", 3], ["resolveReadinessTimeoutMs", 2],
  ["resolveWorkflowHumanDestination", 1], ["getTranscriptRotationOptionsFromEnv", 1],
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? sources(full) : /\.ts$/.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
const names = (arg: ts.Expression | undefined, prop: string): boolean => !!arg && ts.isObjectLiteralExpression(arg)
  && arg.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === prop);

/** Each site in `files` (name → source) that builds or calls a settings-reading entry point without its settings, as "file:line
 *  Name"; and how many sites were checked. */
export function missingSettings(files: Record<string, string>): { missing: string[]; checked: number } {
  const missing: string[] = [];
  let checked = 0;
  for (const [file, text] of Object.entries(files)) {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node, name: string) => `${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1} ${name}`;
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        const name = calleeName(n.expression);
        if (name === "SettingsStore") { checked++; missing.push(at(n, "new SettingsStore (use openSettingsStore)")); }
        for (const [cls, index, prop] of CONSTRUCTORS) {
          if (name !== cls) continue;
          checked++;
          if (!names(n.arguments?.[index], prop)) missing.push(at(n, cls));
        }
      } else if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        for (const [fn, index, prop] of OPTION_CALLS) {
          if (name !== fn || (fn === "routeBundleContents" && !ts.isIdentifier(n.expression))) continue;
          checked++;
          if (!names(n.arguments[index], prop)) missing.push(at(n, fn));
        }
        for (const [fn, count] of POSITIONAL_CALLS) {
          if (name !== fn) continue;
          checked++;
          if (n.arguments.length < count) missing.push(at(n, fn));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { missing, checked };
}

describe("workspaces-6ul: every daemon site that builds a settings-reading domain object passes the daemon's settings", () => {
  it("the scanner flags each kind of omission and passes each kind of supply (its own controls)", () => {
    const { missing } = missingSettings({
      "a.ts": [
        "new QueueRepository(db, bus, { transport });",
        "new QueueRepository(db, bus, { transport, settings });",
        "new StartupOrchestrator({ db });",
        "new StartupOrchestrator({ db, readinessSettings: s });",
        "runWakeLadderTick({ db, queueRepo });",
        "runWakeLadderTick({ db, queueRepo, settings: s });",
        "routeBundleContents(p);",
        "routeBundleContents(p, { settings: s });\nthis.deps.routeBundleContents(p);",
        "derivePickup({ state });",
        "derivePickup({ state }, this.settings);",
        "new SettingsStore(file, home);",
        "new ViewProjector(db, bus);",
      ].join("\n"),
    });
    expect(missing).toEqual([
      "a.ts:1 QueueRepository", "a.ts:3 StartupOrchestrator", "a.ts:5 runWakeLadderTick", "a.ts:7 routeBundleContents",
      "a.ts:10 derivePickup", "a.ts:12 new SettingsStore (use openSettingsStore)", "a.ts:13 ViewProjector",
    ]);
  });

  it("no daemon source site omits the settings", () => {
    const files = Object.fromEntries(sources(SRC)
      .filter((f) => !f.includes(join("domain", "user-settings")) && !f.includes(join("adapters", "node-settings-file.ts")))
      .map((f) => [relative(SRC, f), readFileSync(f, "utf8")]));
    const { missing, checked } = missingSettings(files);
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(25);   // the sites found, so a clean result is not a blind scanner
  });
});
