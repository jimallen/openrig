// The transcript redaction policy (workspaces-o9o.28), pinned on BOTH twins: the daemon's
// redactTranscriptContent (GET /api/transcripts/:session/full) and the CLI's restore-packet
// redact / hasSecretPattern (transcript.md, transcript-latest.md in every restore packet).
// A credential that survives either one reaches a browser or a packet on disk in clear.
//
// Every token below is a FAKE assembled by concatenation, so no scanner reads a literal secret
// in this file and no real credential is ever needed to run it.

import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SECRET_PATTERNS, redactTranscriptContent } from "../src/domain/transcript-redaction.js";
import { SECRET_PATTERNS, hasSecretPattern, redact } from "../../cli/src/restore-packet/redaction.js";

const fill = (n: number, alphabet: string): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

interface SecretRow {
  shape: string;
  text: string;
  /** The credential material that must not survive. */
  secret: string;
  /** Context that must survive (a name, a user, a host). */
  kept: string[];
}

const AKIA = "AKIA" + "Q7XZ3M2B9K4L8P0R";
const ASIA = "ASIA" + "Q7XZ3M2B9K4L8P0R";
const AIZA = "AIza" + "Sy" + fill(33, "A-b_C9d8E7f6G5h4");
const XOXB = "xox" + "b-1234567890-0987654321-" + fill(24, "aB3dE5gH7jK9mN1p");
const XAPP = "xa" + "pp-1-A0123456789-" + fill(20, "f00dBabe9");
const GLPAT = "gl" + "pat-" + fill(20, "x9_Y8-z7W6v5");
const NPM = "np" + "m_" + fill(36, "aB3dE5gH7jK9mN1pQ");
const JWT_PAYLOAD = "eyJ" + "zdWIiOiIxIn0";
const JWT = "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + JWT_PAYLOAD + "." + "dBjftJeZ4CVPmB92K27u_hbUJU1p";
const URL_PW = "Hunter2" + "pw";
const ENV_PW = "correct" + "horse9";
const QUOTED = "s3cr3t" + "valueX";
const JSON_SECRET = "abc" + "DEF123ghi";
const CAMEL = "tok" + "ValueZ9q";
const KEBAB = "kebab" + "Pass77";
const LOWER_PW = "hunter22" + "hunter";
const BEARER_VALUE = "o9o28" + fill(24, "AbCdEf012345");

const HEX41 = fill(41, "0123456789abcdef");
const HEX40 = fill(40, "0123456789abcdef");
const HEX64 = fill(64, "fedcba9876543210");
const NONHEX40 = fill(40, "0123456789abcdeg"); // a "g": 40 characters, not pure hex
const B64_64 = fill(64, "aGVsbG8rd29ybGQv");

const SECRET_ROWS: SecretRow[] = [
  // The v0 40+ run still redacts what Jim's hex 40/64 exemption (o9o.49) does not cover.
  { shape: "41-char hex run", text: `blob ${HEX41} end`, secret: HEX41, kept: ["blob", "end"] },
  { shape: "40-char non-hex run", text: `blob ${NONHEX40} end`, secret: NONHEX40, kept: ["blob", "end"] },
  { shape: "64-char base64 run", text: `blob ${B64_64} end`, secret: B64_64, kept: ["blob", "end"] },
  { shape: "AWS access key id (AKIA)", text: `aws id ${AKIA} end`, secret: AKIA, kept: ["aws id", "end"] },
  { shape: "AWS temporary key id (ASIA)", text: `id ${ASIA} end`, secret: ASIA, kept: ["end"] },
  { shape: "Google API key (AIza)", text: `key=${AIZA} done`, secret: AIZA, kept: ["done"] },
  { shape: "Slack bot token (xoxb-)", text: `tok ${XOXB} end`, secret: XOXB, kept: ["tok", "end"] },
  { shape: "Slack app token (xapp-)", text: `app ${XAPP} end`, secret: XAPP, kept: ["app", "end"] },
  { shape: "GitLab PAT (glpat-)", text: `tok ${GLPAT} end`, secret: GLPAT, kept: ["end"] },
  { shape: "npm token (npm_)", text: `//registry.npmjs.org/:_authToken ${NPM}`, secret: NPM, kept: ["registry.npmjs.org"] },
  { shape: "JWT with segments under 40", text: `auth ${JWT} end`, secret: JWT_PAYLOAD, kept: ["auth", "end"] },
  {
    shape: "URL userinfo password",
    text: `git clone https://deploy:${URL_PW}@git.example.com/r.git`,
    secret: URL_PW,
    kept: ["https://deploy:", "@git.example.com/r.git"],
  },
  { shape: "UPPER_SNAKE assignment", text: `export DB_PASSWORD=${ENV_PW}`, secret: ENV_PW, kept: ["export DB_PASSWORD="] },
  { shape: "quoted API_KEY assignment", text: `API_KEY="${QUOTED}"`, secret: QUOTED, kept: ['API_KEY="', '"'] },
  { shape: "JSON secret field", text: `{"client_secret": "${JSON_SECRET}"}`, secret: JSON_SECRET, kept: ['"client_secret": "'] },
  { shape: "camelCase secret field", text: `accessToken: ${CAMEL}`, secret: CAMEL, kept: ["accessToken: "] },
  { shape: "kebab secret field", text: `db-password = ${KEBAB}`, secret: KEBAB, kept: ["db-password = "] },
  { shape: "bare lower password", text: `password: ${LOWER_PW}`, secret: LOWER_PW, kept: ["password: "] },
  // workspaces-o9o.28 review (2): the scheme name is case-insensitive (RFC 9110 11.1), so every casing is a credential.
  { shape: "lower-case bearer", text: `authorization: bearer ${BEARER_VALUE}`, secret: BEARER_VALUE, kept: ["authorization: "] },
  { shape: "upper-case BEARER", text: `Authorization: BEARER ${BEARER_VALUE}`, secret: BEARER_VALUE, kept: ["Authorization: "] },
  { shape: "mixed-case bEaReR", text: `-H 'Authorization: bEaReR ${BEARER_VALUE}'`, secret: BEARER_VALUE, kept: ["-H 'Authorization: ", "'"] },
  // workspaces-o9o.28 review (4): a hex tail is a hash only when it stands alone; joined to a prefix it is a token.
  { shape: "token-<40hex>", text: `use token-${HEX40} now`, secret: HEX40, kept: ["use ", " now"] },
  { shape: "token_<40hex>", text: `use token_${HEX40} now`, secret: HEX40, kept: ["use ", " now"] },
  { shape: "key-<64hex>", text: `use key-${HEX64} now`, secret: HEX64, kept: ["use ", " now"] },
  { shape: "<40hex>-suffix", text: `use ${HEX40}-prod now`, secret: HEX40, kept: ["use ", " now"] },
];

// workspaces-o9o.28 review (3): a quoted secret value with spaces is redacted whole, not only its first word (or not at
// all, when that word is under the 8-character floor). Every word of the value must be gone.
const PHRASE = ["correct", "horse", "battery", "staple" + "9"];
const LONG_FIRST = ["hunter22" + "x", "more", "words"];
const QUOTED_PHRASE_ROWS: Array<{ shape: string; text: string; words: string[]; kept: string[] }> = [
  { shape: "double-quoted UPPER_SNAKE phrase", text: `export DB_PASSWORD="${PHRASE.join(" ")}"`, words: PHRASE, kept: ['export DB_PASSWORD="', '"'] },
  { shape: "single-quoted phrase with a long first word", text: `API_KEY='${LONG_FIRST.join(" ")}' # set`, words: LONG_FIRST, kept: ["API_KEY='", "' # set"] },
  { shape: "JSON field with a phrase", text: `{"client_secret": "${PHRASE.join(" ")}", "user": "jo"}`, words: PHRASE, kept: ['{"client_secret": "', '", "user": "jo"}'] },
  { shape: "yaml-style password phrase", text: `password: "${LONG_FIRST.join(" ")}"`, words: LONG_FIRST, kept: ['password: "'] },
];

// Legitimate transcript text the policy must leave byte-for-byte alone (over-redaction pins).
const NEGATIVE_ROWS: Array<[string, string]> = [
  // The word after "key:" is 8+ characters, so only the name rule (not the length floor) keeps this row intact.
  ["prose 'the key:'", "the key: everything passes before you merge"],
  ["object literal { key: value }", "const o = { key: valueFromSomewhere };"],
  ["MONKEY=", "MONKEY=bananarama"],
  ["SORT_KEY=", "SORT_KEY=lastname_first"],
  ["primary_key:", "primary_key: identifier"],
  ["md5 hex32", "md5 9e107d9d372bb6826bd81d3542a419d6"],
  ["uuid", "id 123e4567-e89b-12d3-a456-426614174000"],
  ["ULID", "node 01M7JHJAEPK0VXHM2WDRNEMCKM"],
  ["short git sha", "HEAD is 136d46a13"],
  // Jim, 2026-11-16 (o9o.49): "Keep shas, exempt hex 40/64".
  ["40-hex git sha", "commit 136d46a139037b1fd87ff64bc507814c0e138237 landed"],
  ["64-hex sha256", "sha256 3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed ok"],
  ["upper-case 40-hex", "ID 136D46A139037B1FD87FF64BC507814C0E138237"],
  ["git@ ssh URL", "git@github.com:jimallen/openrig.git and ssh://git@host/r"],
  ["npm_config_*", "npm_config_cache=/home/user/.npm"],
  ["max_tokens=", "max_tokens=409600000"],
  ["short TOKEN value", "TOKEN: abc"],
  ["variable reference", "API_KEY=$OPENAI_API_KEY_FROM_ENV and SECRET=${VAULT_SECRET_VALUE}"],
  ["placeholder", "GITHUB_TOKEN=<your-token-here>"],
  ["URL with port, no userinfo", "http://localhost:8080/api@x"],
  // Bare vendor prefixes with too little after them, assembled so no prefix sits in the source as a literal.
  ["bare AIza / eyJ / xox words", `${"AI" + "za"}Something short, ${"ey" + "J"}hbGci only, ${"xo" + "xb-"} alone`],
  // workspaces-o9o.28 review (4): a standalone sha stays visible wherever ordinary punctuation sits beside it.
  ["40-hex sha in parentheses and before a colon", `(${HEX40}) and ${HEX40}: done`],
  ["two 40-hex shas as a range", `${HEX40}..${HEX40}`],
];

const twins: Array<[string, (text: string) => string]> = [
  ["daemon redactTranscriptContent", redactTranscriptContent],
  ["cli redact", redact],
];

describe("transcript redaction policy (both twins)", () => {
  for (const [twin, apply] of twins) {
    describe(twin, () => {
      for (const row of SECRET_ROWS) {
        it(`redacts ${row.shape}, keeping its context`, () => {
          const out = apply(row.text);
          expect(out, `${row.shape} survived`).not.toContain(row.secret);
          expect(out).toContain("[REDACTED]");
          for (const k of row.kept) expect(out, `context "${k}" lost`).toContain(k);
        });
      }
      for (const [name, text] of NEGATIVE_ROWS) {
        it(`leaves legitimate text alone: ${name}`, () => {
          expect(apply(text)).toBe(text);
        });
      }
      for (const row of QUOTED_PHRASE_ROWS) {
        it(`redacts every word of a ${row.shape}, keeping its name and quotes`, () => {
          const out = apply(row.text);
          for (const w of row.words) expect(out, `"${w}" of ${row.shape} survived`).not.toContain(w);
          expect(out).toContain("[REDACTED]");
          for (const k of row.kept) expect(out, `context "${k}" lost`).toContain(k);
        });
      }
      it("is idempotent: redacting redacted text changes nothing", () => {
        const once = apply(SECRET_ROWS.map((r) => r.text).join("\n"));
        expect(apply(once)).toBe(once);
      });
    });
  }

  describe("cli hasSecretPattern (the redacted_secrets counter)", () => {
    for (const row of SECRET_ROWS) {
      it(`detects ${row.shape}`, () => {
        expect(hasSecretPattern(row.text)).toBe(true);
      });
    }
    for (const row of QUOTED_PHRASE_ROWS) {
      it(`detects a ${row.shape}`, () => {
        expect(hasSecretPattern(row.text)).toBe(true);
      });
    }
    for (const [name, text] of NEGATIVE_ROWS) {
      it(`does not count legitimate text: ${name}`, () => {
        expect(hasSecretPattern(text)).toBe(false);
      });
    }
  });
});

describe("twin parity: daemon TRANSCRIPT_SECRET_PATTERNS and cli SECRET_PATTERNS are one list", () => {
  it("holds the same patterns, in the same order, with the same flags", () => {
    const shape = (list: readonly RegExp[]) => list.map((p) => `${p.source} /${p.flags}`);
    expect(shape(TRANSCRIPT_SECRET_PATTERNS)).toEqual(shape(SECRET_PATTERNS));
  });

  it("every pattern carries the g flag and nothing else (hasSecretPattern rebuilds from source alone)", () => {
    for (const p of [...TRANSCRIPT_SECRET_PATTERNS, ...SECRET_PATTERNS]) expect(p.flags, p.source).toBe("g");
  });

  it("gives the same output over a shared corpus", () => {
    const corpus = [...SECRET_ROWS.map((r) => r.text), ...QUOTED_PHRASE_ROWS.map((r) => r.text), ...NEGATIVE_ROWS.map(([, t]) => t)];
    for (const text of corpus) expect(redactTranscriptContent(text), text).toBe(redact(text));
  });
});
