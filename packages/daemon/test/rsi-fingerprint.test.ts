import { describe, expect, it } from "vitest";
import { normaliseSubjectKey, rsiFingerprint } from "../src/domain/rsi/fingerprint.js";

describe("rsiFingerprint", () => {
  // The independent restatement of the recipe: detector id, a slash, the normalised subject key.
  it("is the detector id, a slash and the subject key", () => {
    expect(rsiFingerprint("rsi.archived-rig-live-session", "rig:01ABC")).toBe("rsi.archived-rig-live-session/rig:01abc");
  });

  it("is the same for the same subject however it is spelled, and differs for another subject or detector", () => {
    const base = rsiFingerprint("rsi.a", "rig:one");
    expect(rsiFingerprint("rsi.a", "  RIG:ONE\n")).toBe(base);
    expect(rsiFingerprint("rsi.a", "rig:two")).not.toBe(base);
    expect(rsiFingerprint("rsi.b", "rig:one")).not.toBe(base);
  });

  it("composes accents to one form", () => {
    expect(rsiFingerprint("rsi.a", "rig:café")).toBe(rsiFingerprint("rsi.a", "rig:café"));
  });

  it("refuses an empty subject and an ambiguous detector id", () => {
    expect(() => normaliseSubjectKey("   ")).toThrow("non-empty");
    expect(() => rsiFingerprint("rsi/a", "x")).toThrow("no '/'");
    expect(() => rsiFingerprint("", "x")).toThrow("non-empty");
  });
});
