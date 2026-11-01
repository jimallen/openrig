// Seat Messaging S1, invariant 1 on a real daemon and a private hc core: a daemon killed in the middle of a send leaves the message's row.
// Before S1 the row was written after the send returned, so the kill left nothing at all. The kill lands while `/send` is unanswered,
// which is what makes it mid-send: an answered request fails the test. After a restart the row is still there and still open: S1 has
// no pump, and the sender is the only one who could send it again, under the same id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type HermeticScaffold } from "./helpers/hermetic-env.js";
import { installTrustedScenario, prepareTrustedHermeticEnv } from "./helpers/trusted-scaffold.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { identityOf } from "./helpers/orphan-reaper.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");
const TARGET = "dev-qa@dev-pair-stub";

describe.runIf(findHc() !== null)("a daemon killed mid-send", () => {
  let core: HcScratch;
  let scaffold: HermeticScaffold;
  let daemon: ScenarioDaemon;
  const dbPath = () => join(scaffold.stateDir, "scenario.db");
  const rowOf = (id: string) => {
    const db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    try {
      return db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as
        { outbox_id: string; destination_session: string; body: string; delivery_state: string; message_state: string | null; attempts: number } | undefined;
    } finally { db.close(); }
  };

  beforeAll(async () => {
    core = startHcScratch();
    scaffold = prepareTrustedHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    Object.assign(scaffold.env, { HC_SESSION: core.session, XDG_RUNTIME_DIR: core.env.XDG_RUNTIME_DIR, HC_SOCKET: core.socketPath });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    mkdirSync(join(scaffold.root, "cwd"), { recursive: true });
    const up = await runRig(["up", installTrustedScenario(scaffold, join(library, "dev-pair-stub.yaml")), "--cwd", join(scaffold.root, "cwd"), "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
  }, 180_000);

  afterAll(async () => {
    try {
      if (daemon) await runRig(["down", "dev-pair-stub", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => undefined);
    } finally {
      try { if (daemon) await daemon.stop(); else scaffold?.cleanup(); } finally { core?.cleanup(); }
    }
  }, 90_000);

  it("leaves the row, open, under the id the sender named, and a restart keeps it", async () => {
    const id = `crash-${randomUUID()}`;
    const body = `row first ${id}`;
    const pid = (JSON.parse(readFileSync(join(scaffold.openrigHome, "daemon.json"), "utf8")) as { pid: number }).pid;
    const identity = identityOf(pid);
    expect(identity, "the daemon's own pid").not.toBeNull();

    // The core holds a send to a seat that starts no run for some seconds, and the stub seat reports no turn, so /send stays open.
    let answered: string | null = null;
    const send = fetch(`${daemon.baseUrl}/api/transport/send`, {
      method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "dev-impl@dev-pair-stub" },
      body: JSON.stringify({ session: TARGET, text: body, deliveryId: id }),
    }).then(async (res) => { answered = `${res.status} ${await res.text()}`; }, () => undefined);

    await expect.poll(() => rowOf(id) !== undefined || answered !== null, { timeout: 30_000, interval: 5 }).toBe(true);
    expect(answered, "the send must still be in flight when the daemon dies").toBeNull();
    expect(identityOf(pid), "still the daemon we started").toEqual(identity);
    process.kill(pid, "SIGKILL");
    await send;
    expect(answered, "the daemon died before it answered").toBeNull();

    const left = { outbox_id: id, destination_session: TARGET, body, delivery_state: "pending", message_state: "attempting", attempts: 1 };
    expect(rowOf(id)).toMatchObject(left);

    await daemon.restart();
    expect(rowOf(id)).toMatchObject(left);
  }, 120_000);
});
