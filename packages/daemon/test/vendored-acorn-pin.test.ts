import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// workspaces-o9o.131: the REPL guard parses with a vendored acorn (a single file, byte-identical to the npm registry's dist/acorn.js).
// This pins it: the file's sha256 must equal the recorded upstream value, so nobody edits the vendored parser in place. To upgrade,
// replace it from a verified registry tarball and update BOTH this value and vendor/acorn.VENDORED.
const VENDOR = new URL("../assets/plugins/openrig-core/hooks/scripts/vendor/", import.meta.url);
const EXPECTED_SHA256 = "b95392d79457d0357555c5ed3e56302d074b92dff119bcf3b44179500b10e9df";
const EXPECTED_VERSION = "8.19.0";
const EXPECTED_INTEGRITY = "sha512-oJlA3XiRm7Cyk6qFD2Jn8ak9B7jSy0qy00ADO3+8dpT0LSjFihQYv4C02LFCSYJV3Q37xYwwRy5m+IpIiUzqWw==";

describe("vendored acorn is pinned and intact", () => {
  it("acorn.cjs sha256 equals the recorded upstream dist/acorn.js", () => {
    const bytes = readFileSync(fileURLToPath(new URL("acorn.cjs", VENDOR)));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_SHA256);
  });

  it("the VENDORED note records the same version, integrity and sha256, and MIT", () => {
    const note = readFileSync(fileURLToPath(new URL("acorn.VENDORED", VENDOR)), "utf8");
    expect(note).toContain(`version:   ${EXPECTED_VERSION}`);
    expect(note).toContain(EXPECTED_INTEGRITY);
    expect(note).toContain(EXPECTED_SHA256);
    expect(note).toMatch(/MIT/);
  });

  it("the MIT licence text ships beside it", () => {
    const licence = readFileSync(fileURLToPath(new URL("acorn.LICENSE", VENDOR)), "utf8");
    expect(licence).toMatch(/MIT License/i);
  });

  it("the vendored parser loads and parses, and reports the pinned version", async () => {
    const acorn = await import(new URL("acorn.cjs", VENDOR).href);
    expect((acorn.default ?? acorn).version).toBe(EXPECTED_VERSION);
    expect((acorn.default ?? acorn).parse("process.binding(1)", { ecmaVersion: "latest" }).type).toBe("Program");
  });
});
