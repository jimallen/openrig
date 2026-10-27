// OF-135: a seat ref `<seat>@<rig>` takes the rig's id as well as its name, so a seat stays reachable when two rigs share a
// name. Precedence, as `rig down` / `rig add` resolve a rig handle (cli/src/rig-handle.ts): an exact rig id first, then a
// name among unarchived rigs. Name refs resolve exactly as before. Both seat resolvers are pinned: SeatStatusService (seat
// status, handover) and SeatLifecycleService (launch, stop, set-model, effort...).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

describe("a seat ref names its rig by id (OF-135)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let status: SeatStatusService;
  let lifecycle: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    status = new SeatStatusService({ rigRepo });
    lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: new TmuxAdapter(async () => "") });
  });
  afterEach(() => db.close());

  /** A rig with one seat `dev.impl` whose runtime tells the rigs apart (effortReport refuses naming it, after resolving). */
  function rigWithSeat(name: string, runtime: string) {
    const rig = rigRepo.createRig(name);
    rigRepo.addNode(rig.id, "dev.impl", { runtime });
    return rig;
  }
  /** Which rig each resolver picked for `ref`, or its refusal code. */
  async function resolved(ref: string) {
    const s = status.getStatus(ref);
    const l = await lifecycle.effortReport(ref);
    const runtime = "message" in l && typeof l.message === "string" ? /runs (\S+);/.exec(l.message)?.[1] : undefined;
    return { status: s.ok ? s.status.rig_id : s.code, lifecycle: l.ok ? "resolved" : runtime ?? l.code };
  }

  it.each(["dev.impl", "dev-impl"])("%s@<id> reaches the rig with that id when two rigs share a name; the name stays ambiguous", async (member) => {
    rigWithSeat("twin", "terminal");
    const second = rigWithSeat("twin", "pi");
    expect(await resolved(`${member}@twin`)).toEqual({ status: "seat_ambiguous", lifecycle: "seat_ambiguous" });
    expect(await resolved(`${member}@${second.id}`)).toEqual({ status: second.id, lifecycle: "pi" });
  });

  it("an id wins over a rig whose NAME is that id", async () => {
    const real = rigWithSeat("real-rig", "pi");
    rigWithSeat(real.id, "terminal");
    expect(await resolved(`dev.impl@${real.id}`)).toEqual({ status: real.id, lifecycle: "pi" });
  });

  it("a name shaped like an id that is no rig's id still resolves as a name", async () => {
    const named = rigWithSeat("01ZZZZZZZZZZZZZZZZZZZZZZZZ", "pi");
    expect(await resolved("dev.impl@01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toEqual({ status: named.id, lifecycle: "pi" });
  });

  it("an archived rig's id resolves no seat, as an archived rig's name does not", async () => {
    const rig = rigWithSeat("gone", "pi");
    rigRepo.archiveRig(rig.id);
    expect(await resolved(`dev.impl@${rig.id}`)).toEqual({ status: "seat_not_found", lifecycle: "seat_not_found" });
    expect(await resolved("dev.impl@gone")).toEqual({ status: "seat_not_found", lifecycle: "seat_not_found" });
  });

  it("seat status names the rig as advice should: its name while unique, its id when another rig shares the name", () => {
    const solo = rigWithSeat("solo", "pi");
    const twin = rigWithSeat("twin", "pi");
    rigWithSeat("twin", "terminal");
    const soloStatus = status.getStatus("dev.impl@solo");
    const twinStatus = status.getStatus(`dev.impl@${twin.id}`);
    expect(soloStatus.ok && soloStatus.status.rig_handle).toBe("solo");
    expect(twinStatus.ok && twinStatus.status.rig_handle).toBe(twin.id);
    expect(twinStatus.ok && twinStatus.status.rig_name).toBe("twin"); // the name itself is unchanged
    expect(solo.id).not.toBe(twin.id);
  });

  it("control: a unique name ref resolves as before, and an unknown rig is not found", async () => {
    const rig = rigWithSeat("solo", "pi");
    expect(await resolved("dev.impl@solo")).toEqual({ status: rig.id, lifecycle: "pi" });
    expect(await resolved("dev-impl@solo")).toEqual({ status: rig.id, lifecycle: "pi" });
    expect(await resolved("dev.impl@01AAAAAAAAAAAAAAAAAAAAAAAA")).toEqual({ status: "seat_not_found", lifecycle: "seat_not_found" });
  });
});
