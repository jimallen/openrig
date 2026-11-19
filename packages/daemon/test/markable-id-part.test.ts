// workspaces-d7l (verify-qa2 attempt 2): an id the daemon builds from free text (a session name, a caller's qitem id) must stay in the
// alphabet a gate marker carries, or the transport sends it past the pump. `markableIdPart` is that encoding; these rows pin its contract.
import { describe, expect, it } from "vitest";
import { markableIdPart } from "../src/domain/seat-messaging/ports.js";
import { NATIVE_MARKER_RE } from "../src/domain/claude-native-inbox.js";

/** The marker's id group, from the defining module (`[openrig-msg <id>:<nonce>]`), anchored. */
const markerCarries = (id: string): boolean => new RegExp(`^${NATIVE_MARKER_RE.source}$`).test(`[openrig-msg ${id}:${"a".repeat(16)}]`);

describe("markableIdPart", () => {
  it("a session name's @ becomes _40, and an id already in the alphabet without _ keeps its bytes", () => {
    expect(markableIdPart("dev-pi@my-rig")).toBe("dev-pi_40my-rig");
    for (const id of ["qitem-20261119082300-0a1b2c3d", "01JDZ3K9Q8W7X6V5T4S3R2P1N0", "a.b:c-d"]) expect(markableIdPart(id)).toBe(id);
  });

  it("whatever the text, the result is an id a marker carries", () => {
    for (const text of ["dev@rig", "a b", "line\nbreak", "x]y", "under_score here", "é ü 中", "tab\there", "%40", "@", "a:b@c.d"]) {
      const encoded = markableIdPart(text);
      expect(markerCarries(`guard-model-0-${encoded}`), text).toBe(true);
      expect(markerCarries(`guard-model-0-${text}`), `control: the raw text ${JSON.stringify(text)} is not one`).toBe(false);
    }
  });

  it("two different texts never encode alike: _ is escaped too, and every UTF-8 byte is its own escape", () => {
    expect(markableIdPart("a@b")).toBe("a_40b");
    expect(markableIdPart("a_40b")).toBe("a_5f40b");
    expect(markableIdPart("é")).toBe("_c3_a9");
    const texts = ["a@b", "a_40b", "a_5f40b", "é", "_c3_a9", "", "_", "__"];
    expect(new Set(texts.map(markableIdPart)).size).toBe(texts.length);
  });
});
