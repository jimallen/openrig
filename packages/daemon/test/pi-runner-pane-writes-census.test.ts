// OF-217: every line the Pi runner prints goes through `sanitizeForPane`. Production consequence: the pane guard (runner-pane-guard.ts) lets
// cursor-move and erase CSI through (ESC [ ... A B C D G H J K), because the line editor needs them, and the console frame (runner-pane-frame.ts)
// saves the output cursor after each write. An error text that carried `ESC [ 999 ; 1 H` would park the saved cursor on the input row, and the
// output would stop scrolling. Five `console.error` lines printed an error message, a PATH, or OMP's own stderr tail without the sanitizer.
// This is the census as a test: the rule is applied at every site, so a new unsanitized write fails here whichever line it is on.
// The real-pane proof for the two sites a hostile string can reach with the frame open is pi-runner-hostile-error.real.test.ts.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RUNNER = fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url));

interface PaneWrite { line: number; callee: string; kind: "sanitized" | "constant" | "banner" | "OFFENDER" }

/** Every call that prints to the pane: console.log/error/warn/info/debug/trace, process.stdout.write, process.stderr.write. Parsed, not grepped. */
function paneWrites(source: string): PaneWrite[] {
  const sf = ts.createSourceFile("pi-runner.ts", source, ts.ScriptTarget.Latest, true);
  const out: PaneWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^console\.(log|error|warn|info|debug|trace)$/.test(callee) || /^process\.(stdout|stderr)\.write$/.test(callee)) {
        const args = node.arguments;
        const text = args.map((a) => a.getText(sf)).join(", ");
        const constant = args.every((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a));
        const kind: PaneWrite["kind"] = text.includes("sanitizeForPane(") ? "sanitized"
          : constant ? "constant"
            : text === "banner" ? "banner"
              : "OFFENDER";
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, callee, kind });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("every pane write in the Pi runner is sanitized", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  const writes = paneWrites(source);

  it("the instrument sees an unsanitized write and a sanitized one (negative and positive control)", () => {
    const sample = paneWrites("console.error(err.message);\nconsole.error(sanitizeForPane(err.message));\nprocess.stdout.write(`x ${y}`);\nconsole.log(`plain`);");
    expect(sample.map((w) => w.kind)).toEqual(["OFFENDER", "sanitized", "OFFENDER", "constant"]);
  });

  it("finds the writes it should: console.error sites and stdout writes, in the population the rule is applied to", () => {
    expect(writes.length, "all pane writes found in pi-runner.ts").toBeGreaterThanOrEqual(12);
    expect(writes.filter((w) => w.callee === "console.error").length, "the five error lines").toBe(5);
    expect(writes.filter((w) => w.callee === "process.stdout.write").length, "the stdout writes").toBeGreaterThanOrEqual(5);
  });

  it("no console or stream write prints text that did not pass sanitizeForPane (the banner is sanitized where it is made)", () => {
    expect(writes.filter((w) => w.kind === "OFFENDER").map((w) => `${w.callee} at line ${w.line}`)).toEqual([]);
    expect(/const banner = sanitizeForPane\(/.test(source), "the banner variable is made by sanitizeForPane").toBe(true);
  });

  it("each of the five error lines is sanitized (the census the ticket named, every one of them)", () => {
    const errors = writes.filter((w) => w.callee === "console.error");
    expect(errors.map((w) => w.kind)).toEqual(["sanitized", "sanitized", "sanitized", "sanitized", "sanitized"]);
  });
});
