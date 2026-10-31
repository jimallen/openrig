import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcDelivery } from "../src/adapters/hc-delivery.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// Private core and in-memory registry: no agent runtime, credentials or live daemon.
describe.skipIf(!findHc() || !fs.existsSync("/bin/bash"))("terminal send verification through bash on an hc seat", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("confirms a command at a glyph prompt before a later prompt appears", async () => {
    const sessionName = "infra-ui@term-rig";
    const rc = path.join(scratch.root, "bashrc");
    fs.writeFileSync(rc, "PS1='❯ '; unset PROMPT_COMMAND; bind 'set enable-bracketed-paste on'\n");
    const db = createFullTestDb();
    try {
      const hc = new HcAdapter(scratch.client());
      await scratch.client().call("terminal.run", {
        argv: ["/bin/bash", "--noprofile", "--rcfile", rc, "-i"], name: hcTerminalName(sessionName), labels: { [SEAT_LABEL]: sessionName },
        cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true,
      });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if ((await hc.capturePaneContent(sessionName, 30))?.includes("❯")) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ready).toBe(true);
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("term-rig");
      const node = rigRepo.addNode(rig.id, "infra.ui", { role: "ui", runtime: "terminal" });
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "hc" });
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: hc, hcDelivery: new HcDelivery(hc.client, hc) });
      // Hold the command in flight so there is exactly one (historical) shell prompt.
      const result = await transport.send(sessionName, "printf 'SHELL_VERIFY_RECEIPT\\n'; sleep 15", { verify: true });
      const capture = await hc.capturePaneContent(sessionName, 30);
      expect(capture).toContain("\nSHELL_VERIFY_RECEIPT\n");
      expect(capture?.match(/❯/g)).toHaveLength(1);
      expect(result).toMatchObject({ ok: true, path: "hc", verified: true, outcome: "delivered" });
    } finally {
      db.close();
    }
  });
});
