// S2: the marker a seat gate reads. One format, shared with the native inbox's writer.
import { describe, expect, it } from "vitest";
import { nativeMarker, parseNativeMarkers } from "../src/domain/claude-native-inbox.js";
import { splitMarkedBlock } from "../src/adapters/seat-gate-marker.js";

const NONCE = "0123456789abcdef";

describe("splitMarkedBlock", () => {
  it("reads what the native inbox writes: the same bytes, one format", () => {
    const line = nativeMarker("out-1:a.b", NONCE);
    expect(splitMarkedBlock(`hi\n${line}`)).toEqual({ text: "hi", markers: [{ id: "out-1:a.b", nonce: NONCE }] });
    expect(parseNativeMarkers(line)).toEqual([{ id: "out-1:a.b", nonce: NONCE }]);
  });

  it("takes the native form too: a blank line before the markers, one marker per row of a wake group", () => {
    expect(splitMarkedBlock(`hi\n\n${nativeMarker("a", NONCE)}\n${nativeMarker("b", NONCE)}\n`)).toEqual({
      text: "hi", markers: [{ id: "a", nonce: NONCE }, { id: "b", nonce: NONCE }],
    });
  });

  it("leaves a block without a trailing marker exactly as it was, a quoted marker included", () => {
    for (const block of ["plain", `quoting [openrig-msg a:${NONCE}] here`, `[openrig-msg a:${NONCE}]\nthen text`, "x\n[openrig-msg a:SHORT]", `x\n[openrig-msg a:${NONCE}] trailing`]) {
      expect(splitMarkedBlock(block)).toEqual({ text: block, markers: [] });
    }
  });

  it("strips only the trailing run: a marker line above the body stays in the text", () => {
    const quoted = `[openrig-msg old:${NONCE}]`;
    expect(splitMarkedBlock(`${quoted}\nbody\n${nativeMarker("new", NONCE)}`)).toEqual({ text: `${quoted}\nbody`, markers: [{ id: "new", nonce: NONCE }] });
  });

  it("a block of nothing but a marker has empty text, for the caller to refuse", () => {
    expect(splitMarkedBlock(nativeMarker("a", NONCE))).toEqual({ text: "", markers: [{ id: "a", nonce: NONCE }] });
  });
});
