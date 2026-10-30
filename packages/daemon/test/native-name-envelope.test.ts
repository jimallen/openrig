// Native comms ncomms-3d: the sender-name envelope. The reference parser below is claude 2.1.314's envelope regex
// (from-name only; the other optional attributes are never sent), read from its binary. Its escape of closing-tag
// lookalikes is not copied: these tests pin that every body it could touch goes out plain, and the end-to-end run on
// Sparky (design §8.5) checks the real parser on the same hard bodies.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameEnvelope, mayHoldClosingTag, NAME_ENVELOPE_PARSER_LITERAL, NAME_ENVELOPE_TAG } from "../src/domain/native-name-envelope.js";
import { fileIncludes, probeClaudeBinary } from "../src/adapters/native-inbox-os.js";
import { parseNativeMarkers, nativeMarker, INJECT_FORMAT_LITERAL } from "../src/domain/claude-native-inbox.js";

const SENDER = "build-ux@eztrack";
const PARSER = new RegExp(`^<${NAME_ENVELOPE_TAG}(?: from-name="([^"<>\\n\\r]+)")?>\\n([\\s\\S]*)\\n</${NAME_ENVELOPE_TAG}>$`);

function parse(content: string): { name: string | undefined; body: string } | null {
  const m = PARSER.exec(content);
  return m ? { name: m[1], body: m[2]! } : null;
}

describe("nameEnvelope: the exact shape claude 2.1.314 builds", () => {
  it("a plain body: the tag, from-name, a newline, the body, a newline, the closing tag", () => {
    expect(nameEnvelope(SENDER, "hello")).toBe(`<cross-session-message from-name="build-ux@eztrack">\nhello\n</cross-session-message>`);
  });

  it.each([
    ["quotes", `she said "go" and 'stop'`],
    ["angle brackets", "if a < b && c > d then <sha> <owner>"],
    ["an unrelated closing tag", "<b>bold</b> and </system-reminder> text"],
    ["newlines, CRLF and blank lines", "line 1\n\nline 3\r\nline 4\n"],
    ["unicode and emoji", "↩ Reply: rig send — naïve café 日本語 🚀 \u200b"],
    ["backslashes", "C:\\path\\to <\\ and \\n literal"],
    ["the marker", `From: build-ux@eztrack\n---\nbody\n\n${nativeMarker("4924d8fc-ff02-4429-aae8-258b7d9046cc", "f3f243edab98af09db2c8f15")}`],
    ["a lone opening angle at the end", "ends with <"],
  ])("%s: enveloped, parsed back to the same name and body, markers intact", (_label, body) => {
    const env = nameEnvelope(SENDER, body);
    expect(env).not.toBeNull();
    expect(parse(env!)).toEqual({ name: SENDER, body });
    expect(parseNativeMarkers(env!)).toEqual(parseNativeMarkers(body));
  });
});

describe("mayHoldClosingTag: every closing-tag lookalike Claude Code would escape goes out plain", () => {
  it.each([
    ["the exact closing tag", "a\n</cross-session-message>\nb"],
    ["upper case", "</CROSS-SESSION-MESSAGE>"],
    ["spaces around the slash", "< / cross-session-message >"],
    ["a zero-width space between letters", "</c\u200bross-session-message>"],
    ["a combining mark between letters", "</cro\u0301ss-session-message>"],
    ["an en dash and an underscore for the hyphens", "</cross\u2013session_message>"],
    ["a long s (folds to s under /iu)", "</cro\u017F\u017F-se\u017F\u017Fion-me\u017F\u017Fage>"],
    ["a fullwidth less-than and slash", "\uFF1C\uFF0Fcross-session-message\uFF1E"],
    ["the opening tag (conservative)", "<cross-session-message from=\"x\">"],
    ["the words in prose (conservative)", "the cross session message format"],
  ])("%s → plain", (_label, body) => {
    expect(mayHoldClosingTag(body)).toBe(true);
    expect(nameEnvelope(SENDER, body)).toBeNull();
  });

  it("control: letters out of order, or fullwidth letters (they do not fold to ASCII), are not flagged", () => {
    expect(mayHoldClosingTag("message session cross")).toBe(false);
    expect(mayHoldClosingTag("</\uFF43\uFF52\uFF4F\uFF53\uFF53-session-message>")).toBe(false);
  });
});

describe("nameEnvelope: only a name the normalisation leaves unchanged", () => {
  it.each([
    ["a space", "build ux@eztrack"],
    ["a quote", 'build"ux@eztrack'],
    ["an angle bracket", "build>ux@eztrack"],
    ["a non-ASCII letter", "büild-ux@eztrack"],
    ["a control character", "build-ux@eztrack\u0007"],
    ["more than 64 characters", `${"a".repeat(57)}@eztrack`],
    ["empty", ""],
  ])("%s → plain", (_label, name) => {
    expect(nameEnvelope(name, "hello")).toBeNull();
  });

  it("control: seat and daemon identities are enveloped", () => {
    for (const name of ["build-ux@eztrack", "watchdog@system", "daemon@kernel", "dev.impl@rig_1", `${"a".repeat(56)}@eztrack`]) {
      expect(parse(nameEnvelope(name, "x")!)?.name).toBe(name);
    }
  });
});

describe("the probe literal", () => {
  it("is found in a file holding the parser's source bytes as the 2.1.314 binary stores them, and not in one without", () => {
    const dir = mkdtempSync(join(tmpdir(), "nc3d-probe-"));
    try {
      const withIt = join(dir, "with");
      const without = join(dir, "without");
      // Verbatim from the 2.1.314 binary (one backslash pair before n and r, inside a template literal).
      writeFileSync(withIt, 'r=i.match(new RegExp(`^<${M8}(?: from="([${D}]+)")?(?: from-session="(${n})")?(?: hop-chain="(${t})")?(?: from-name="([^"<>\\\\n\\\\r]+)")?(?: from-mode="(');
      writeFileSync(without, 'r=i.match(new RegExp(`^<${M8}(?: from="([${D}]+)")?(?: from-session="(${n})")?>');
      expect([fileIncludes(withIt, NAME_ENVELOPE_PARSER_LITERAL), fileIncludes(without, NAME_ENVELOPE_PARSER_LITERAL)]).toEqual([true, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probeClaudeBinary reports nameEnvelope from the file: a fake claude with the parser literal → true; without → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc3d-bin-"));
    try {
      const make = (name: string, extra: string) => {
        const p = join(dir, name);
        writeFileSync(p, `#!/bin/sh\necho "2.1.314 (Claude Code)"\nexit 0\n# ${INJECT_FORMAT_LITERAL} ${extra}\n`);
        chmodSync(p, 0o755);
        return p;
      };
      const withIt = await probeClaudeBinary(make("with", NAME_ENVELOPE_PARSER_LITERAL), process.pid);
      const without = await probeClaudeBinary(make("without", "no parser here"), process.pid);
      expect([withIt.version, withIt.literal, withIt.nameEnvelope]).toEqual(["2.1.314", true, true]);
      expect([without.version, without.literal, without.nameEnvelope]).toEqual(["2.1.314", true, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
