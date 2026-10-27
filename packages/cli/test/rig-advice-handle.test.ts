// OF-135: the CLI twin of the daemon's rigAdviceHandle (domain/rig-ref.ts): advice names a rig by its name while that name
// reaches it and only it, else by its id. Same expectations as the daemon's rows.
import { describe, expect, it } from "vitest";
import { rigAdviceHandle } from "../src/rig-handle.js";

describe("cli rigAdviceHandle", () => {
  const rigs = [{ id: "id-solo", name: "solo" }, { id: "id-twin-a", name: "twin" }, { id: "id-twin-b", name: "twin" }, { id: "id-x", name: "id-solo" }];
  it.each([
    ["a unique name", "id-solo", "solo", "solo"],
    ["a shared name", "id-twin-a", "twin", "id-twin-a"],
    ["a name that is another listed rig's id (the id would win)", "id-x", "id-solo", "id-x"],
    ["a rig missing from the list (archived, or the list could not be read)", "id-gone", "gone", "id-gone"],
    ["a name carried by another rig only (this one not listed)", "id-other", "solo", "id-other"],
  ])("%s", (_label, rigId, rigName, expected) => {
    expect(rigAdviceHandle(rigId, rigName, rigs)).toBe(expected);
  });
  it("an empty list gives the id (always exact)", () => {
    expect(rigAdviceHandle("id-solo", "solo", [])).toBe("id-solo");
  });
});
