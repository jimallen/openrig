import { describe, expect, it } from "vitest";
import { HC_OLDEST_ACCEPTED_VERSION, HC_TESTED_VERSION, HC_TESTED_VERSIONS, judgeHcVersion, parseHcVersionOutput } from "../src/adapters/hc-version.js";

// One rule for every site that judges an hc version (core watch, runtime verifier, CLI setup/doctor/preflight). Jim, 2026-11-01:
// accept the same minor line from 0.1.15 up and warn when it is not the tested one; refuse a new generation, a new minor, a new
// major, anything older, and anything that is not major.minor.patch. The production consequence of a wrong row: a too-wide rule
// lets OpenRig drive a core whose protocol may have changed; a too-narrow one refuses the core the Herdr app just updated and
// stops OpenRig managing seats. Every boundary is restated literally, so a drift in the constants fails here.
describe("the constants", () => {
  it("are hc 0.1.16, 0.1.17 and 0.1.18 tested, 0.1.18 the newest, and 0.1.15 the oldest accepted (restated, so a change must be deliberate)", () => {
    expect([...HC_TESTED_VERSIONS]).toEqual(["0.1.16", "0.1.17", "0.1.18"]);
    expect(HC_TESTED_VERSION).toBe("0.1.18");
    expect(HC_OLDEST_ACCEPTED_VERSION).toBe("0.1.15");
  });
});

describe("judgeHcVersion", () => {
  it.each([
    ["0.1.0", "refused"],
    ["0.1.9", "refused"],    // numeric, not lexical, order: "9" > "15" as text
    ["0.1.14", "refused"],   // one below the floor
    ["0.1.15", "untested"],  // the floor: accepted
    ["0.1.16", "tested"],    // the tested release
    ["0.1.17", "tested"],    // tested on Sparky's and the Mac's hc 0.1.17 (OF-241)
    ["0.1.18", "tested"],    // tested on Sparky's hc 0.1.18 (hc-hc018)
    ["0.1.19", "untested"],  // nothing has run on it
    ["0.1.99", "untested"],  // far above, same minor
    ["0.1.100", "untested"], // numeric, not lexical, order: "100" > "15" although "1" < "15" as text
    ["0.2.0", "refused"],    // another minor
    ["0.2.15", "refused"],   // another minor with a patch at the floor: only the minor check refuses it (0.2.0 is also below the floor)
    ["0.2.16", "refused"],
    ["0.2.99", "refused"],
    ["0.0.99", "refused"],   // the minor below
    ["1.1.16", "refused"],   // another major with the tested minor and patch
    ["1.1.99", "refused"],
    ["1.0.0", "refused"],
  ])("%s -> %s", (version, verdict) => {
    expect(judgeHcVersion(version).verdict).toBe(verdict);
  });

  it.each(["", "0.1", "0.1.16.1", "0.1.x", "x.y.z", "v0.1.16", "0.1.16-rc1", "0.1.16+b1", "0.1.016", "00.1.16", " 0.1.16", "0.1.16 ", "0.1.-16", "0.1.1e1", "０.1.16", "0.1.99999999999999999999"])("malformed %j -> refused", (version) => {
    const judged = judgeHcVersion(version);
    expect(judged.verdict).toBe("refused");
    expect(judged.version).toBe(version);
  });

  it("an accepted version outside the tested set carries a warning naming it and both tested versions; a tested one carries none", () => {
    for (const v of ["0.1.15", "0.1.19", "0.1.99"]) {
      const judged = judgeHcVersion(v);
      expect(judged.verdict).toBe("untested");
      expect(judged.verdict === "untested" ? judged.warning : "").toContain(v);
      expect(judged.verdict === "untested" ? judged.warning : "").toContain("tested on hc 0.1.16, 0.1.17 and 0.1.18");
    }
    expect(judgeHcVersion("0.1.16")).toEqual({ verdict: "tested", version: "0.1.16" });
    expect(judgeHcVersion("0.1.17")).toEqual({ verdict: "tested", version: "0.1.17" });
    expect(judgeHcVersion("0.1.18")).toEqual({ verdict: "tested", version: "0.1.18" });
  });

  it("a refusal says why in words that name the version and the line it was held against", () => {
    const reasons = Object.fromEntries(["0.1.14", "0.2.0", "1.1.16", "nonsense"].map((v) => {
      const j = judgeHcVersion(v);
      return [v, j.verdict === "refused" ? j.reason : ""];
    }));
    expect(reasons["0.1.14"]).toContain("0.1.14");
    expect(reasons["0.1.14"]).toContain("0.1.15");
    expect(reasons["0.1.14"]).toContain("tested on hc 0.1.16, 0.1.17 and 0.1.18");
    expect(reasons["0.2.0"]).toContain("(hc 0.1.16, 0.1.17 and 0.1.18)");
    expect(reasons["0.2.0"]).toContain("0.1");
    expect(reasons["1.1.16"]).toContain("1.1.16");
    expect(reasons["nonsense"]).toContain("nonsense");
  });
});

describe("parseHcVersionOutput", () => {
  it.each([
    ["hc 0.1.16\n", "0.1.16"], ["hc 0.1.16", "0.1.16"], ["hc 12.30.4", "12.30.4"],
    ["hc 0.1.16-rc1\n", "0.1.16-rc1"],  // kept whole, so the rule calls it malformed rather than reading 0.1.16
    ["hc 0.1\n", "0.1"],
    ["usage: hc", null], ["", null], ["herdr-core 0.1.16", null],
  ])("%j -> %j", (output, expected) => {
    expect(parseHcVersionOutput(output)).toBe(expected);
  });
});
