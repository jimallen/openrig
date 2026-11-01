// Which seats the pump serves: those that declared a gate at launch. pda, terminal and stub seats have none, and a seat of a gated runtime
// on an older relay or runner stays as it was.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { HookSeenStore, seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { CodexSeatHop, ClaudeSeatHop, PiSeatHop } from "../src/adapters/seat-hops.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { RuntimeSeatPorts } from "../src/domain/seat-messaging/runtime-ports.js";

describe("the seats the pump serves", () => {
  let db: Database.Database;
  let home: string;
  let ports: RuntimeSeatPorts;
  let n = 0;
  const seat = (runtime: string) => {
    const rigs = new RigRepository(db);
    const rig = rigs.createRig(`r${++n}`);
    const node = rigs.addNode(rig.id, "dev", { role: "worker", runtime });
    const name = `dev@r${n}`;
    new SessionRegistry(db).updateBinding(node.id, { attachmentType: "hc", tmuxSession: name });
    return { name, rigId: rig.id };
  };
  const declareHook = (name: string) => {
    const dir = join(seatGateRoot(home), seatGateFolder(name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ version: 1 }));
  };
  const sidecar = (root: string, name: string, extra: Record<string, unknown>) => {
    const { runnerStatePath, seatRoot } = piSeatPaths(root, name);
    mkdirSync(seatRoot, { recursive: true });
    writeFileSync(runnerStatePath, JSON.stringify({ ready: true, updatedAt: "1970-01-01T00:00:00.000Z", ...extra }));
  };
  const roots = () => ({ pi: join(home, "pi"), omp: join(home, "omp") });

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ports-"));
    ports = new RuntimeSeatPorts({
      db, rows: new MessageStore(db), hookStore: new HookSeenStore(seatGateRoot(home)), stateRoots: roots(), client: { call: async () => { throw new Error("no core here"); } },
      guard: { operation: (_n, fn) => fn() }, input: { submitText: async () => ({ ok: true }), sendKeys: async () => ({ ok: true }) },
      inbox: () => ({ eligibility: async () => ({ ok: false, reason: "x" }), writeToSeat: async () => "none", transcriptOf: () => null }), fileIncludes: () => false, rolloutOf: () => null,
    });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  it("a Claude or Codex seat is gated once its relay declared, and not before", () => {
    for (const [runtime, hop] of [["claude-code", ClaudeSeatHop], ["codex", CodexSeatHop]] as const) {
      const { name } = seat(runtime);
      expect(ports.gateFor(name)).toBeNull();
      expect(ports.hopFor(name)).toBeNull();
      declareHook(name);
      expect(ports.gateFor(name)?.version).toBe(1);
      expect(ports.hopFor(name)).toBeInstanceOf(hop);
    }
  });

  it("a Pi or OMP seat is gated when its runner says it carries the gate, and not on an older runner", () => {
    for (const runtime of ["pi", "omp"] as const) {
      const { name } = seat(runtime);
      sidecar(roots()[runtime], name, {});
      expect(ports.gateFor(name)).toBeNull();
      sidecar(roots()[runtime], name, { seatGate: 1 });
      expect(ports.gateFor(name)?.version).toBe(1);
      expect(ports.hopFor(name)).toBeInstanceOf(PiSeatHop);
    }
  });

  it("pda, terminal and stub seats are never gated, whatever files say", () => {
    for (const runtime of ["pda", "terminal", "stub"]) {
      const { name } = seat(runtime);
      declareHook(name);
      sidecar(roots().pi, name, { seatGate: 1 });
      expect(ports.gateFor(name), runtime).toBeNull();
      expect(ports.hopFor(name), runtime).toBeNull();
    }
  });

  it("a seat nobody knows, and an archived rig's seat, are not gated", () => {
    expect(ports.gateFor("ghost@none")).toBeNull();
    const { name, rigId } = seat("claude-code");
    declareHook(name);
    db.prepare("UPDATE rigs SET archived_at = 'x' WHERE id = ?").run(rigId);
    expect(ports.gateFor(name)).toBeNull();
  });
});
