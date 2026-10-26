// OF-55: a pinned MCP config file with more than one hard link is refused, as a spec file is. A link elsewhere
// could change the bytes after the sha256 pin was taken. Rows restate the rule; none imports the pin helper's internals.
import { afterAll, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mcpArgFileProblem, mcpArgFilePins } from "../src/domain/codex-mcp-servers.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-pin-links-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (links = 1) => {
  const f = join(dir, `cfg-${n++}.toml`);
  writeFileSync(f, "x = 1\n");
  if (links > 1) linkSync(f, `${f}.other`);
  return f;
};

describe("pinned MCP argument files must have exactly one link (OF-55)", () => {
  it("control: a single-link config file after --config is pinned", () => {
    const f = file();
    const r = mcpArgFilePins(["--config", f]);
    expect(r.ok && r.pins.map((p) => p.arg)).toEqual([f]);
  });
  it("refuses a hard-linked config file after --config, naming the link count", () => {
    const r = mcpArgFilePins(["--config", file(2)]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2 hard links");
  });
  it("refuses a hard-linked file given as --config=<path>", () => {
    expect(mcpArgFilePins([`--config=${file(2)}`]).ok).toBe(false);
  });
  it("refuses a hard-linked file given as -c<path>", () => {
    expect(mcpArgFilePins([`-c${file(2)}`]).ok).toBe(false);
  });
  it("refuses a hard-linked file named by a plain absolute path argument", () => {
    expect(mcpArgFilePins(["--flag", file(2)]).ok).toBe(false);
  });
  it("a link made AFTER the pin is caught by the launch re-check", () => {
    const f = file();
    const first = mcpArgFilePins(["--config", f]);
    if (!first.ok) throw new Error("setup");
    expect(mcpArgFileProblem(["--config", f], first.pins)).toBeNull();
    linkSync(f, `${f}.late`);
    expect(mcpArgFileProblem(["--config", f], first.pins)).toContain("hard links");
  });
});
