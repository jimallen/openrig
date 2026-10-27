// OF-107: the remedy a refused restore prints when no saved startup copy can be used. It offers "start this seat from the
// rig's recorded spec" only while that spec is a source a fresh start accepts; for an untrusted one it names the
// trusted-copy route, with the rig's id (a rig name may be shared, and `rig spec-source` takes either).
// Deployed entrypoint: RestoreOrchestrator and the restore-check route call this through fresh-seat-restore-decision.ts.
import { describe, expect, it } from "vitest";
import { noUsableCopyRemedy } from "../src/domain/own-startup-replay.js";

const base = { rigName: "team", logicalId: "dev.impl", ownRow: true } as const;

describe("noUsableCopyRemedy with an untrusted recorded spec (OF-107)", () => {
  it.each(["restore", "seat"] as const)("%s scope: names rig spec-source set with the rig id and the command to run after it, and never offers the refused route", (scope) => {
    const text = noUsableCopyRemedy({ ...base, scope, specRecorded: true, specUntrusted: { rigId: "rig-42" } });
    expect(text).toContain("recorded spec source is not trusted");
    expect(text).toContain("startup_source_untrusted");
    expect(text).toContain("rig spec-source set rig-42 <path-to-rig.yaml> --operator <address>");
    expect(text).toContain(scope === "restore"
      ? "then run: rig up 'team' --existing --fresh 'dev.impl'"
      : `then run: rig seat launch 'dev.impl@team' --fresh --reason "<why>"`);
    expect(text).toContain("the saved row has to be repaired outside restore");
    expect(text).not.toContain("Start this seat from the rig's recorded spec instead");
    expect(text).not.toContain("To start it from the rig's recorded spec instead");
  });

  it.each(["restore", "seat"] as const)("%s scope control: a trusted recorded spec still gets the start-from-spec route", (scope) => {
    const text = noUsableCopyRemedy({ ...base, scope, specRecorded: true });
    expect(text).toContain("recorded spec instead");
    expect(text).not.toContain("not trusted");
  });

  it("an untrusted flag without a recorded spec changes nothing (there is no spec to be untrusted)", () => {
    const text = noUsableCopyRemedy({ ...base, scope: "seat", specRecorded: false, specUntrusted: { rigId: "rig-42" } });
    expect(text).toBe(noUsableCopyRemedy({ ...base, scope: "seat", specRecorded: false }));
  });
});
