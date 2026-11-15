// A surge seat (`<pod>.<member><N>`, N from 2, no leading zero) is a second copy of a spec member, added beside the rig
// with `rig add`; rig-here (`add-seat <pod> <member><N> --as <member>`) names them so. The spec declares the member
// once, so the rule that maps a seat to the member it copies is pinned here; rig-spec-source-route.test.ts pins its use.
import { describe, expect, it } from "vitest";
import { specMemberForSeat } from "../src/domain/surge-seat.js";

const pods = (members: Record<string, string[]>) =>
  Object.entries(members).map(([id, ids]) => ({ id, members: ids.map((m) => ({ id: m })) }));
const lookup = (spec: Record<string, string[]>, logicalId: string) => {
  const found = specMemberForSeat(pods(spec), logicalId);
  return found ? { pod: found.pod.id, member: found.member.id, surge: found.surge } : null;
};

describe("specMemberForSeat", () => {
  it("a seat the spec declares is its own member, not a surge", () => {
    expect(lookup({ build: ["impl"] }, "build.impl")).toEqual({ pod: "build", member: "impl", surge: false });
  });

  it("<member><N> for N from 2 is a surge seat of <member> in the same pod", () => {
    for (const id of ["impl2", "impl3", "impl9", "impl10", "impl25", "impl100"]) {
      expect(lookup({ build: ["impl", "ux"] }, `build.${id}`)).toEqual({ pod: "build", member: "impl", surge: true });
    }
    expect(lookup({ verify: ["screen"] }, "verify.screen2")).toEqual({ pod: "verify", member: "screen", surge: true });
  });

  it("impl1, impl0, impl02 and impl010 are not surge seats (N starts at 2, no leading zero)", () => {
    for (const id of ["impl1", "impl0", "impl02", "impl010", "impl00"]) expect(lookup({ build: ["impl"] }, `build.${id}`)).toBeNull();
  });

  it("an extra seat that is not a member plus a number is not declared", () => {
    for (const id of ["foo", "impl-2", "impl2a", "implx2", "2"]) expect(lookup({ build: ["impl"] }, `build.${id}`)).toBeNull();
  });

  it("the base member must be in the seat's own pod", () => {
    expect(lookup({ build: ["ux"], verify: ["impl"] }, "build.impl2")).toBeNull();
    expect(lookup({ build: ["impl"] }, "verify.impl2")).toBeNull();
  });

  it("a spec member literally named impl2 wins over the surge mapping", () => {
    expect(lookup({ build: ["impl", "impl2"] }, "build.impl2")).toEqual({ pod: "build", member: "impl2", surge: false });
    // and a surge seat of impl2 (impl22) is ambiguous with impl + 22, so it is not declared
    expect(lookup({ build: ["impl", "impl2"] }, "build.impl22")).toBeNull();
    // impl3 has only one reading: impl + 3
    expect(lookup({ build: ["impl", "impl2"] }, "build.impl3")).toEqual({ pod: "build", member: "impl", surge: true });
  });

  it("two members that both read the seat as a surge leave it undeclared rather than guessing", () => {
    expect(lookup({ verify: ["qa", "qa1"] }, "verify.qa12")).toBeNull();
  });

  it("a malformed seat id is not declared", () => {
    for (const id of ["", "build", "build.", ".impl", "build.impl.2"]) expect(lookup({ build: ["impl"] }, id)).toBeNull();
  });
});
