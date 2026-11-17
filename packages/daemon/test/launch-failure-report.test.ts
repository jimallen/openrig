// workspaces-o9o.3: the quote a failed launch carries from its pane. Expected values are written out here, not derived
// from the module's constants, so a change to the line count, the cap, the separator or the redaction fails a row.
import { describe, expect, it } from "vitest";
import { launchFailureSuffix, paneTailQuote, redactPaneText, runnerErrorQuote } from "../src/domain/launch-failure-report.js";
import { redactTranscriptContent } from "../src/domain/transcript-redaction.js";

/** Fakes assembled at runtime, so no credential-shaped literal sits in this file (CoS rule, 2026-11-16). */
const SK = ["s", "k-"].join("");
const EYJ = "ey" + "J";
/** Secret values for the assignment and URL-password rows, assembled at runtime for the same reason (verify-sec, o9o.48). */
const URL_PW = "hunter2" + "pass";
const PW = "hunt" + "er2";
const KEY6 = "abc" + "123";
const TOK = "t" + "0k";
const CS = "s3cr3t" + "-v4lue";
const PHRASE = "correct" + " horse battery";
const TWO_WORDS = "two" + " words";
const LONG_FIRST = "hunter22x" + " more";
const ASSIGNMENTS = `export DB_PASSWORD=${PW} MY_API_KEY=${KEY6} SESSION_TOKEN=${TOK}`;

describe("paneTailQuote", () => {
  it("quotes the last four non-empty lines, joined with ' | '", () => {
    expect(paneTailQuote("one\ntwo\n\nthree\nfour\n   \nfive\n\n")).toBe("two | three | four | five");
  });

  it("strips escape sequences and control characters, and turns tabs into spaces", () => {
    expect(paneTailQuote("\x1b[1;32mgreen\x1b[0m\tword\x07\r\n\x1b]0;title\x07next")).toBe("green word | next");
  });

  it("redacts secret-shaped tokens", () => {
    expect(paneTailQuote(`key ${SK}abcdefghijklmnop0123 here`)).toBe("key [REDACTED] here");
  });

  // workspaces-o9o.3 review (verify-sec 1): shapes the v0 transcript patterns miss. Synthetic values only.
  it.each([
    ["Slack bot token", "xox" + "b-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", "xox" + "b-"],
    ["Slack user token", "xox" + "p-1234567890-1234567890-1234567890123-abcdef0123456789abcdef0123456789", "xox" + "p-"],
    ["GitLab token", "gl" + "pat-AbCdEfGhIjKlMnOpQrSt", "glpat-"],
    ["npm token", "np" + "m_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "npm_"],
    ["JWT", `${EYJ}hbGciOiJIUzI1NiJ9.${EYJ}zdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`, EYJ],
    ["AWS access key id", "AK" + "IAIOSFODNN7EXAMPLE", "AKIA"],
    ["Google API key", "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv", "AIza"],
  ])("redacts a %s", (_label, secret, prefix) => {
    const quote = paneTailQuote(`before ${secret} after`);
    expect(quote).toBe("before [REDACTED] after");
    expect(quote).not.toContain(prefix);
  });

  it.each([
    ["a URL's password", `git clone https://jim:${URL_PW}@example.com/repo.git`, "git clone https://jim:[REDACTED]@example.com/repo.git"],
    ["NAME=value for a secret-named variable", ASSIGNMENTS, "export DB_PASSWORD=[REDACTED] MY_API_KEY=[REDACTED] SESSION_TOKEN=[REDACTED]"],
    ["NAME: value for a secret-named key", `client_secret: ${CS}`, "client_secret: [REDACTED]"],
  ])("redacts %s", (_label, input, expected) => {
    expect(paneTailQuote(input)).toBe(expected);
  });

  it("control: leaves ordinary text, a variable that is not secret-named and a URL with no password alone", () => {
    expect(paneTailQuote("export EDITOR=vim LANG=en_US.UTF-8 https://example.com/a?b=c [Y/n]")).toBe("export EDITOR=vim LANG=en_US.UTF-8 https://example.com/a?b=c [Y/n]");
  });

  it("caps the quote at 400 characters with an ellipsis", () => {
    // Space-separated filler: an unbroken run of 40+ word characters is itself a redaction match.
    const quote = paneTailQuote("ab ".repeat(400));
    expect(quote).toHaveLength(400);
    expect(quote.endsWith("…")).toBe(true);
    expect(paneTailQuote(`${"ab ".repeat(133)}a`)).toBe(`${"ab ".repeat(133)}a`); // exactly 400: not cut
  });

  it("redacts before it cuts, so a token across the cap is not left as an unredacted fragment", () => {
    const quote = paneTailQuote(`${"ab ".repeat(130)}${SK}abcdefghijklmnopqrstuvwxyz0123456789`);
    expect(quote).toBe(`${"ab ".repeat(130)}[REDACTED]`);
  });

  it("is empty for an empty, blank or missing pane", () => {
    expect(paneTailQuote("")).toBe("");
    expect(paneTailQuote("\n  \n")).toBe("");
    expect(paneTailQuote(null)).toBe("");
    expect(paneTailQuote(undefined)).toBe("");
  });
});

describe("runnerErrorQuote", () => {
  it.each(["pi", "omp", "pda", "stub"])("finds a [%s-runner] ERROR line", (runtime) => {
    expect(runnerErrorQuote(`starting\n[${runtime}-runner] ERROR launch: refused\n$ `)).toBe(`[${runtime}-runner] ERROR launch: refused`);
  });

  it("takes the last ERROR line when there are several", () => {
    expect(runnerErrorQuote("[pi-runner] ERROR first\nmore\n[pi-runner] ERROR second\n")).toBe("[pi-runner] ERROR second");
  });

  it("is null when the pane has no runner ERROR line (a READY line, a bare word ERROR, a runner name alone)", () => {
    expect(runnerErrorQuote("[pi-runner] READY\nERROR: something\n[pi-runner] ERRORS seen\n")).toBeNull();
    expect(runnerErrorQuote("")).toBeNull();
    expect(runnerErrorQuote(null)).toBeNull();
  });

  it("redacts the ERROR line", () => {
    expect(runnerErrorQuote("[pi-runner] ERROR bad key gh" + "p_abcdefghijklmnopqrstuvwxyz")).toBe("[pi-runner] ERROR bad key [REDACTED]");
  });
});

describe("launchFailureSuffix", () => {
  it("prefers the runner's own ERROR line", () => {
    expect(launchFailureSuffix("[pi-runner] ERROR launch: No Pi credential\n$ ")).toBe(" — runner said: [pi-runner] ERROR launch: No Pi credential");
  });

  it("falls back to the pane tail", () => {
    expect(launchFailureSuffix("[oh-my-zsh] Would you like to update? [Y/n] claude\n")).toBe(" — pane: [oh-my-zsh] Would you like to update? [Y/n] claude");
  });

  it("is empty when the pane shows nothing", () => {
    expect(launchFailureSuffix("")).toBe("");
    expect(launchFailureSuffix(null)).toBe("");
  });
});

// workspaces-o9o.48: pane text is redacted by the ONE transcript list (transcript-redaction.ts), not by a pane-only list
// of its own. C's own assignment rule redacted any value after a name ending in KEY, so it ate prose and code, and it
// missed the JSON form; the shared rule keeps prose and catches JSON.
describe("redactPaneText is the shared transcript redaction policy", () => {
  it.each([
    ["prose 'the key:'", "the key: ensure tests pass"],
    ["an object literal", "const o = { key: valueFromSomewhere };"],
    ["MONKEY=", "MONKEY=bananarama"],
    ["SORT_KEY=", "SORT_KEY=lastname_first"],
    ["primary_key:", "primary_key: identifier"],
  ])("leaves %s alone", (_label, text) => {
    expect(redactPaneText(text)).toBe(text);
  });

  it("redacts a JSON secret field", () => {
    const value = "abc" + "DEF123ghi";
    expect(redactPaneText(`{"client_secret": "${value}"}`)).toBe('{"client_secret": "[REDACTED]"}');
  });

  it("redacts a quoted phrase whole and keeps its quotes", () => {
    expect(redactPaneText(`export DB_PASSWORD="${PHRASE}"`)).toBe('export DB_PASSWORD="[REDACTED]"');
  });

  it("gives the transcript policy's output, byte for byte, over a mixed corpus", () => {
    const corpus = [
      `key ${SK}abcdefghijklmnop0123 here`,
      `git clone https://jim:${URL_PW}@example.com/repo.git`,
      ASSIGNMENTS,
      `client_secret: ${CS}`,
      `API_KEY="${TWO_WORDS}" and password: "${LONG_FIRST}"`,
      "the key: ensure tests pass; SORT_KEY=lastname_first",
      `auth ${EYJ}hbGciOiJIUzI1NiJ9.${EYJ}zdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk end`,
    ];
    for (const text of corpus) expect(redactPaneText(text), text).toBe(redactTranscriptContent(text));
  });
});
