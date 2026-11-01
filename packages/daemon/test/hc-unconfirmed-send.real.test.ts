// Security re-review F3, on a private hc core: a send that ends unconfirmed (the core is holding it for a person), the core then
// restarts and the held text is lost. The caller that got the unconfirmed result has moved on (the compaction enforcer advanced its
// stage, the watchdog banked its receipt). Before: SessionTransport wrote no row for such a send, so the sweep and `rig health` could
// not see the loss. Now: the row exists, the sweep reads it (and, with no runtime declared to show a paste, leaves it waiting), health names it, and an operator closes it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcDelivery } from "../src/adapters/hc-delivery.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { sweepHcUnsettled } from "../src/domain/hc-unsettled-sweep.js";
import { HcUnsettledHealthSource, outboxHcUnsettledRows } from "../src/domain/hc-unsettled-health.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { tmuxStub } from "./helpers/tmux-stub.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

/** A status-reporting program on a pty: bracketed paste on, idle at rest, echoes what it is typed, logs its stdin as hex. */
const STUB = `
import os, sys, time, tty
log_path = sys.argv[1]
tty.setraw(0)
os.write(1, b"\\x1b[?2004h")
os.write(1, b"\\x1b]7501;state=idle:app=stub\\x1b\\\\")
os.write(1, b"READY\\r\\n")
log = open(log_path, "ab", buffering=0)
while True:
    try:
        b = os.read(0, 65536)
    except InterruptedError:
        continue
    if not b:
        break
    log.write(b.hex().encode() + b"\\n")
    os.write(1, b.replace(b"\\x1b[200~", b"").replace(b"\\x1b[201~", b"").replace(b"\\r", b"\\r\\n"))
    if b"\\r" in b:
        os.write(1, b"\\x1b]7501;state=working:app=stub\\x1b\\\\")
        time.sleep(0.3)
        os.write(1, b"\\x1b]7501;state=done:app=stub\\x1b\\\\")
`;

const SEAT = "dev@ucf-rig";

describe.skipIf(!HC)("an unconfirmed send is a row, so a core restart that loses it shows in health", () => {
  const core = new PrivateCore("ucf");
  const attach = new HcAttach(core.socketPath);
  let db: Database.Database;
  let stdinLog: string;

  beforeAll(async () => {
    // Preflight, before any core starts: socket, HOME and every XDG path are under this test's own root; no caller HC_* in the env.
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) expect(core.env[key]?.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
    mkdirSync(join(core.root, "w"), { recursive: true });
    const stub = join(core.root, "w", "stub.py");
    stdinLog = join(core.root, "w", "stdin.log");
    writeFileSync(stub, STUB);
    writeFileSync(stdinLog, "");
    const address = hcTerminalName(SEAT);
    await core.client.call("terminal.run", { argv: ["python3", "-I", stub, stdinLog], name: address, labels: { "openrig.seat": SEAT }, no_parent: true, no_notify: true, outlive_parent: true });
    await until(async () => (await core.client.call<{ text: string }>("terminal.read", { terminal: address })).text, (t) => t.includes("READY"), "the stub's first paint");
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });
  afterAll(() => { db?.close(); core.stop(); });

  const stdin = () => readFileSync(stdinLog, "utf8").split("\n").filter(Boolean).map((hex) => Buffer.from(hex, "hex").toString("latin1")).join("");

  it("send, core restart, lost prompt: the row is there, the sweep leaves it waiting, health names it, an operator closes it", async () => {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("ucf-rig");
    const node = rigRepo.addNode(rig.id, "dev", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT });
    const delivery = new HcDelivery(core.client, new HcInput(core.client, attach, { deliveryTimeoutMs: 1_000 }));
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, hcDelivery: delivery,
      sleep: async () => undefined,
      tmuxAdapter: tmuxStub({
        hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        capturePaneContent: async () => "idle\n❯ ", listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
        getPanePid: async () => null, getPaneCommand: async () => null,
      }),
    });
    const outbox = new OutboxHandler(db);

    // One key, then left: the core holds a send for 3 s after it, and the key is already on the screen when the send is issued.
    const viewer = await attach.open({ terminal: hcTerminalName(SEAT), cols: 200, rows: 120 }, { onData: () => {}, onEnd: () => {} });
    viewer.write("p");
    await viewer.detach();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The enforcer's stage send: no identity, no delivery id. The core holds it; the call gives up after 1 s: unconfirmed.
    const result = await transport.send(SEAT, "restore prompt");
    expect(result).toMatchObject({ ok: false, path: "hc", reason: "waiting_on_person" });
    const row = outbox.listHcUnsettled();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ destinationSession: SEAT, body: "restore prompt", deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: "waiting_on_person" });

    // The core restarts more than the 2 s margin after the send began, inside the 3 s hold: the queued text is lost with it.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    core.restart();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stdin()).not.toContain("restore prompt");

    // The sweep reads the real core. No runtime is declared to show a paste on its screen, so an unchanged screen is no proof the text
    // never arrived (table row 6 in hc-delivery.ts): the row is NOT marked gone. It stays listed, waiting, for a person.
    const tally = await sweepHcUnsettled({ outbox, verify: (pending) => delivery.verify(pending), recordNudgeAttempt: () => undefined });
    expect(tally).toMatchObject({ gone: 0, delivered: 0, open: 1 });
    expect(outbox.getById(row[0]!.outboxId)).toMatchObject({ deliveryState: "indeterminate", ackEvidence: "waiting_on_person" });

    // `rig health`: past the 15-minute bound the lost prompt is named, with how to deal with it. Nothing silently lost.
    const notice = new HcUnsettledHealthSource(outboxHcUnsettledRows(outbox), () => new Date(Date.now() + 20 * 60_000)).coverage()[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    expect(notice.reason).toContain(`oldest ${row[0]!.outboxId} to ${SEAT}`);
    expect(notice.reason).toContain("They are not resent");
    expect(notice.reason).toContain(`rig seat retire-unsettled-send ${SEAT} ${row[0]!.outboxId}`);
    expect(stdin()).not.toContain("restore prompt");  // nothing re-sent it

    // The person looks, finds the prompt is not there, sends it again by hand, and closes the row: the notice clears.
    outbox.retireHcUnsettled(row[0]!.outboxId, SEAT, "operator@rig", "prompt was not there; sent again by hand", Date.now() + 20 * 60_000);
    expect(new HcUnsettledHealthSource(outboxHcUnsettledRows(outbox), () => new Date(Date.now() + 20 * 60_000)).coverage()).toEqual([]);
  }, 60_000);
});
