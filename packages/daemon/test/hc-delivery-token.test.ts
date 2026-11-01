// hc cutover (QA B2): the producer of the delivery token. The recipe is restated here, not imported, so each element of it
// (the prefix, the separator, the digest length, the key's form) can fail on its own. These tokens are idempotency keys:
// a queue retry of the same wake must carry the token its first send did, or the first landing is not found and the text
// goes in twice.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { carriesDeliveryToken, deliveryKeyOf, deliveryTokenFor, tokenLine, withDeliveryToken } from "../src/adapters/hc-delivery-token.js";

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

describe("deliveryTokenFor", () => {
  it("is 12 hex characters of sha256 over the prefix, a NUL and the key", () => {
    expect(deliveryTokenFor("delivery:wake-7")).toBe(sha12("openrig-hc-delivery\0delivery:wake-7"));
    expect(deliveryTokenFor("delivery:wake-7")).toMatch(/^[0-9a-f]{12}$/);
  });
  it("differs for a different key", () => {
    expect(deliveryTokenFor("a")).not.toBe(deliveryTokenFor("b"));
  });
});

describe("deliveryKeyOf", () => {
  it("is the committed outbox ids for a queue wake: the same ids on every retry, in order", () => {
    expect(deliveryKeyOf({ committedOutboxIds: ["wake-1", "wake-2"], deliveryId: "ignored" })).toBe("outbox:wake-1,wake-2");
    expect(deliveryTokenFor(deliveryKeyOf({ committedOutboxIds: ["wake-1"] }))).toBe(sha12("openrig-hc-delivery\0outbox:wake-1"));
  });
  it("is the caller's delivery id when there are no committed ids (an empty list is none)", () => {
    expect(deliveryKeyOf({ deliveryId: "guard-nudge-q1" })).toBe("delivery:guard-nudge-q1");
    expect(deliveryKeyOf({ committedOutboxIds: [], deliveryId: "guard-nudge-q1" })).toBe("delivery:guard-nudge-q1");
  });
  it("is unique per call when the message has no identity of its own", () => {
    const keys = new Set([deliveryKeyOf(undefined), deliveryKeyOf({}), deliveryKeyOf({})]);
    expect(keys.size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^once:/);
  });
});

describe("what the text carries", () => {
  it("one trailing line, after a line break, naming the token", () => {
    expect(tokenLine("abc123abc123")).toBe("[openrig delivery abc123abc123]");
    expect(withDeliveryToken("hello", "abc123abc123")).toBe("hello\n[openrig delivery abc123abc123]");
  });
});

describe("carriesDeliveryToken", () => {
  it.each([["claude-code", true], ["codex", true], ["pi", true], ["omp", true], ["terminal", false], ["pda", false], ["something-new", false], [null, false], [undefined, false]] as const)(
    "%s -> %s", (runtime, expected) => { expect(carriesDeliveryToken(runtime)).toBe(expected); },
  );
});
