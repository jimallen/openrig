// OF-135: how advice names a rig (rigAdviceHandle) and how a seat ref's rig part resolves (seatRefRigs). Advice gives the
// rig's name while that name reaches it and only it, else its id; the precedence it mirrors is an exact id first (archived
// included), then a name among unarchived rigs (cli/src/rig-handle.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { dbRigLookup, rigAdviceHandle, rigAdviceHandleIn, seatRefRigs } from "../src/domain/rig-ref.js";
import { liveSeatGateInputs } from "../src/domain/restore-seat-gates.js";

describe("rig refs and the rig advice names (OF-135)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => db.close());

  it.each(["repository", "database"] as const)("advice by %s: the name while it reaches this rig alone, else the id", (via) => {
    const handle = (rigId: string, name: string) => via === "repository" ? rigAdviceHandle(rigRepo, rigId, name) : rigAdviceHandleIn(db, rigId, name);
    const solo = rigRepo.createRig("solo");
    expect(handle(solo.id, "solo")).toBe("solo");

    const twinA = rigRepo.createRig("twin");
    const twinB = rigRepo.createRig("twin");
    expect([handle(twinA.id, "twin"), handle(twinB.id, "twin")]).toEqual([twinA.id, twinB.id]);

    // This rig archived and another unarchived rig carries the name: the name would reach the other rig.
    const old = rigRepo.createRig("reused");
    rigRepo.archiveRig(old.id);
    const current = rigRepo.createRig("reused");
    expect(handle(old.id, "reused")).toBe(old.id);
    expect(handle(current.id, "reused")).toBe("reused"); // the archived namesake does not make the name ambiguous

    // A rig whose name is another rig's id: an id wins, so that name reaches the other rig.
    const target = rigRepo.createRig("target");
    const lookalike = rigRepo.createRig(target.id);
    expect(handle(lookalike.id, target.id)).toBe(lookalike.id);
  });

  it("advice gives the id when the rigs cannot be read", () => {
    const broken = { findRigById: () => { throw new Error("db gone"); }, findUnarchivedRigsByName: () => [] };
    expect(rigAdviceHandle(broken, "rig-id-1", "solo")).toBe("rig-id-1");
  });

  it("dbRigLookup reads ids across archived rigs and names among unarchived ones, as the repository does", () => {
    const rig = rigRepo.createRig("arch");
    rigRepo.archiveRig(rig.id);
    expect(dbRigLookup(db).findRigById(rig.id)).toEqual(rigRepo.findRigById(rig.id));
    expect(dbRigLookup(db).findRigById(rig.id)?.archived).toBe(true);
    expect(dbRigLookup(db).findUnarchivedRigsByName("arch")).toEqual([]);
    expect(dbRigLookup(db).findRigById("no-such-rig")).toBeNull();
  });

  it("a seat ref's rig part: an id first (none if archived), else unarchived rigs by name", () => {
    const real = rigRepo.createRig("real");
    const lookalike = rigRepo.createRig(real.id);
    expect(seatRefRigs(rigRepo, real.id).map((r) => r.id)).toEqual([real.id]);
    expect(seatRefRigs(rigRepo, "real").map((r) => r.id)).toEqual([real.id]);
    rigRepo.archiveRig(real.id);
    expect(seatRefRigs(rigRepo, real.id)).toEqual([]); // archived: no seat, and not the rig named like the id
    expect(lookalike.name).toBe(real.id);
  });

  it("the seat gates' advice names a rig that shares its name by id (restore and restore-check both use these inputs)", () => {
    const solo = rigRepo.createRig("solo");
    const soloNode = rigRepo.addNode(solo.id, "dev.impl", { runtime: "claude-code" });
    expect(liveSeatGateInputs({ db, rigRepo }, { rigId: solo.id, fallbackRigName: "x" })({ id: soloNode.id, logicalId: "dev.impl" }).rigName).toBe("solo");
    const twin = rigRepo.createRig("twin");
    const twinNode = rigRepo.addNode(twin.id, "dev.impl", { runtime: "claude-code" });
    rigRepo.createRig("twin");
    expect(liveSeatGateInputs({ db, rigRepo }, { rigId: twin.id, fallbackRigName: "x" })({ id: twinNode.id, logicalId: "dev.impl" }).rigName).toBe(twin.id);
  });
});
