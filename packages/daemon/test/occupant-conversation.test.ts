import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type GateLookup, type LastHop, type LastHopResult, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";

// "Deliver, labelled" is about the CONVERSATION: a message is labelled when the agent that reads it is not the one it was sent to. A generation
// is minted at every launch (a restart still supersedes lifecycle text), but a launch that resumes the saved conversation continues it: the
// message is for the same agent, and a label would tell it otherwise (review of 84a26669, F1). The production path registers sessions with no
// native session id, so every relaunch here goes through registerSession and launchNode, never through mintOccupantTenure with a native id.
const SEAT = "dev-impl@r01";

/** The launcher's tmux, with every call succeeding and nothing running. An instance of the class (so its type is honest), its methods replaced. */
function mockTmux(): TmuxAdapter {
  return Object.assign(Object.create(TmuxAdapter.prototype), {
    freshManaged: new Set<string>(),
    createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }), listSessions: async () => [], listWindows: async () => [],
    listPanes: async () => [], hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
  });
}
class StubGate implements SeatGate {
  readonly version = 3;
  async lookup(): Promise<GateLookup> { return { kind: "not_seen" }; }
}
class StubHop implements LastHop {
  readonly calls: SeatMessage[] = [];
  async attempt(message: SeatMessage): Promise<LastHopResult> { this.calls.push(message); return { kind: "sent" }; }
}

describe("a relaunch of a seat: the generation always moves, the conversation moves only when the launch is not a resume", () => {
  let homes: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;

  beforeAll(async () => {
    homes = await fs.mkdtemp(path.join(os.tmpdir(), "occ-conv-"));
    await fs.mkdir(path.join(homes, "codex"), { recursive: true });
    await fs.writeFile(path.join(homes, "codex", "auth.json"), "{}");
    process.env["OPENRIG_HOME"] = path.join(homes, "openrig");
    process.env["CODEX_HOME_DEFAULT"] = path.join(homes, "codex");
  });
  afterAll(async () => {
    delete process.env["OPENRIG_HOME"];
    delete process.env["CODEX_HOME_DEFAULT"];
    await fs.rm(homes, { recursive: true, force: true });
  });
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); rigRepo = new RigRepository(db); registry = new SessionRegistry(db); });
  afterEach(() => db.close());

  const tenures = (nodeId: string) => db.prepare("SELECT generation_uuid AS generation, kind FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal").all(nodeId) as Array<{ generation: string; kind: string }>;
  const conversationOf = (seat: string): string | null => {
    const fate = new DbSeatDirectory(db).fate(seat);
    return fate.kind === "live" ? (fate.conversation ?? null) : null;
  };
  const generationOf = (seat: string): string | null => {
    const fate = new DbSeatDirectory(db).fate(seat);
    return fate.kind === "live" ? fate.occupantGeneration : null;
  };

  describe("SessionRegistry, as the launch paths call it (no native session id)", () => {
    let nodeId: string;
    beforeEach(() => { nodeId = rigRepo.addNode(rigRepo.createRig("r01").id, "dev.impl", { role: "worker", runtime: "claude-code" }).id; });

    it("a launch is a new conversation by default, and each launch is a new generation", () => {
      registry.registerSession(nodeId, SEAT);
      const [first, second] = [conversationOf(SEAT), (registry.registerSession(nodeId, SEAT), conversationOf(SEAT))];
      expect(tenures(nodeId)).toHaveLength(2);
      expect(second).not.toBe(first);
    });
    it("a launch that resumes continues the conversation: the generation still moves, the conversation does not", () => {
      registry.registerSession(nodeId, SEAT);
      const generation = generationOf(SEAT);
      const conversation = conversationOf(SEAT);
      registry.registerSession(nodeId, SEAT, "initial", null, false, true);
      expect(generationOf(SEAT)).not.toBe(generation);
      expect(conversationOf(SEAT)).toBe(conversation);
    });
    it("a resume keeps continuing across several launches, and a fresh one after them starts over", () => {
      registry.registerSession(nodeId, SEAT);
      const conversation = conversationOf(SEAT);
      registry.registerSession(nodeId, SEAT, "initial", null, false, true);
      registry.registerSession(nodeId, SEAT, "initial", null, false, true);
      expect(conversationOf(SEAT)).toBe(conversation);
      registry.registerSession(nodeId, SEAT, "fresh", null, true);
      expect(conversationOf(SEAT)).not.toBe(conversation);
    });
    it("a resume with nothing before it is a first launch", () => {
      registry.registerSession(nodeId, SEAT, "initial", null, false, true);
      expect(conversationOf(SEAT)).toBe(generationOf(SEAT));
    });
    it("a handover successor and an adopted session are new conversations", () => {
      registry.registerSession(nodeId, SEAT);
      const conversation = conversationOf(SEAT);
      registry.registerClaimedSession(nodeId, SEAT, "handover");
      const afterHandover = conversationOf(SEAT);
      expect(afterHandover).not.toBe(conversation);
      registry.registerClaimedSession(nodeId, SEAT, "adopt");
      expect(conversationOf(SEAT)).not.toBe(afterHandover);
    });
    it("a tenure written before conversations existed is its own conversation", () => {
      registry.registerSession(nodeId, SEAT);
      db.prepare("UPDATE occupant_tenures SET conversation_uuid = NULL WHERE node_id = ?").run(nodeId);
      expect(conversationOf(SEAT)).toBe(generationOf(SEAT));
    });
  });

  describe.each([["claude-code"], ["codex"], ["pi"]])("%s: launchNode, then the pump", (runtime) => {
    let rigId: string;
    let nodeId: string;
    let store: MessageStore;
    let hop: StubHop;
    let pump: MessagePump;
    let now: number;
    const launcher = () => new NodeLauncher({ db, rigRepo, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: mockTmux() });
    const bodies = () => hop.calls.map((c) => c.body);
    /** A relaunch: the seat's binding is released (it went down) and launched again, the way restore and `rig seat launch --fresh` do it. */
    const relaunch = async (opts: { continuesConversation?: boolean; freshStart?: boolean; occupantKind?: "fresh" } = {}) => {
      registry.clearBinding(nodeId);
      const result = await launcher().launchNode(rigId, "dev.impl", { ...opts, sessionName: SEAT });
      expect(result.ok).toBe(true);
    };
    const send = (id: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "lead@r01", body: `body of ${id}` });

    beforeEach(async () => {
      const rig = rigRepo.createRig("r01");
      rigId = rig.id;
      nodeId = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime }).id;
      expect((await launcher().launchNode(rigId, "dev.impl", { sessionName: SEAT })).ok).toBe(true);
      store = new MessageStore(db);
      hop = new StubHop();
      now = 7_000_000;
      pump = new MessagePump({
        store, directory: new DbSeatDirectory(db), held: { status: () => "held" }, senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) },
        clock: () => now, log: () => undefined, ports: { gateFor: () => new StubGate(), hopFor: () => hop },
      });
    });

    it("a waiting message is not labelled by a launch that resumes the conversation, and the generation did move", async () => {
      send("m1");
      await pump.tick();
      const generation = generationOf(SEAT);
      await relaunch({ continuesConversation: true });
      expect(generationOf(SEAT)).not.toBe(generation);
      now += 2 * 60_000;
      await pump.tick();
      expect(bodies()).toEqual(["body of m1", "body of m1"]);
      expect(db.prepare("SELECT message_previous_occupant AS p FROM outbox_entries WHERE outbox_id = 'm1'").get()).toEqual({ p: null });
    });
    it("a waiting message is labelled by a fresh launch (the proof: --fresh --stop --startup-from stored)", async () => {
      send("m1");
      await pump.tick();
      await relaunch({ freshStart: true, occupantKind: "fresh" });
      now += 2 * 60_000;
      await pump.tick();
      expect(bodies()).toEqual(["body of m1", `${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
    });
    it("a waiting message is labelled by a launch that is not a resume, whatever its kind", async () => {
      send("m1");
      await relaunch();
      await pump.tick();
      expect(bodies()).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
    });
    it("a message waiting across a resume and then a fresh launch is labelled by the fresh launch alone", async () => {
      send("m1");
      await relaunch({ continuesConversation: true });
      await pump.tick();
      expect(bodies()).toEqual(["body of m1"]);
      await relaunch({ continuesConversation: true });
      now += 30 * 60_000;
      await pump.tick();
      expect(bodies()).toEqual(["body of m1", "body of m1"]);
      await relaunch({ freshStart: true, occupantKind: "fresh" });
      now += 30 * 60_000;
      await pump.tick();
      expect(bodies()).toEqual(["body of m1", "body of m1", `${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
    });
    it("a message sent after a fresh launch, or after a resume of it, carries no label", async () => {
      await relaunch({ freshStart: true, occupantKind: "fresh" });
      await relaunch({ continuesConversation: true });
      send("m1");
      await pump.tick();
      expect(bodies()).toEqual(["body of m1"]);
    });
    it("a message sent after one resume still waits unlabelled across the next: its binding is the conversation, not the generation it was sent under", async () => {
      await relaunch({ continuesConversation: true });
      send("m1");
      await relaunch({ continuesConversation: true });
      await pump.tick();
      await relaunch({ continuesConversation: true });
      now += 30 * 60_000;
      await pump.tick();
      expect(bodies()).toEqual(["body of m1", "body of m1"]);
    });
    it("lifecycle text bound to the generation still ends at a resume: a restart supersedes it", async () => {
      const generation = generationOf(SEAT)!;
      store.accept({ id: messageId("life1"), seat: SEAT, sender: "lead@r01", body: "prep", messageClass: "lifecycle", occupantGeneration: generation });
      await relaunch({ continuesConversation: true });
      await pump.tick();
      expect(bodies()).toEqual([]);
      expect(db.prepare("SELECT message_state AS s FROM outbox_entries WHERE outbox_id = 'life1'").get()).toEqual({ s: "undeliverable" });
    });
  });
});
