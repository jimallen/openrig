// workspaces-o9o.71 (verify-qa FAIL 1): `rig up --existing --fresh` restores through RestoreOrchestrator and NodeLauncher, not through
// `rig seat launch`. Each seat it starts fresh is judged for a held lease like a fresh launch: a leased seat is NOT launched and gets its
// own refusal (relaunch_check_held, naming the holder); every other seat goes on as before. No whole-rig refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLeaseStore } from "../src/adapters/seat-lease-store.js";
import { PodRepository } from "../src/domain/pod-repository.js";

describe("o9o.71: rig up --existing --fresh judges each fresh seat's leases", () => {
  let db: Database.Database;
  let leaseRoot: string;
  let leases: SeatLeaseStore;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    leaseRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o71-restore-leases-"));
    leases = new SeatLeaseStore(leaseRoot);
    setup = createTestApp(db, { seatLeases: leases, wireRuntimeAdapters: true });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(leaseRoot, { recursive: true, force: true }); });

  /** The restore's own row for one seat, wherever the route puts it in its answer. */
  function seatRow(answer: unknown, logicalId: string): Record<string, unknown> | undefined {
    if (Array.isArray(answer)) {
      for (const item of answer) { const found = seatRow(item, logicalId); if (found) return found; }
    } else if (answer && typeof answer === "object") {
      const record = answer as Record<string, unknown>;
      if (record["logicalId"] === logicalId && typeof record["status"] === "string") return record;
      for (const value of Object.values(record)) { const found = seatRow(value, logicalId); if (found) return found; }
    }
    return undefined;
  }

  /** Two stopped seats with saved startup context, as `rig down` leaves them. */
  function seed(name: string) {
    const rig = setup.rigRepo.createRig(name);
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const nodes = ["dev.impl", "dev.qa"].map((logicalId) => {
      const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", podId: pod.id });
      const session = setup.sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@${name}`);
      setup.sessionRegistry.updateStatus(session.id, "stopped");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
      return node;
    });
    return { rig, impl: nodes[0]!, qa: nodes[1]! };
  }

  it("a held lease on one of two seats: that seat is refused with relaunch_check_held, the other is launched", async () => {
    const { rig } = seed("lease-rig");
    leases.acquire("dev-impl@lease-rig", { holder: "ui-test-host", pid: process.pid });
    const createSession = vi.mocked(setup.tmuxAdapter.createSession);

    const res = await setup.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: rig.name, freshLogicalIds: ["dev.impl", "dev.qa"] }),
    });
    const answer: unknown = await res.json();

    const started = createSession.mock.calls.map((call) => String(call[0]));
    expect(started).not.toContain("dev-impl@lease-rig");
    expect(started).toContain("dev-qa@lease-rig");
    // The leased seat's own row says why: the restore's refusal, not some other failure carrying the same words.
    expect(seatRow(answer, "dev.impl")).toMatchObject({ status: "failed", errorCode: "relaunch_check_held" });
    expect(String(seatRow(answer, "dev.impl")?.["error"])).toContain("ui-test-host");
  });

  it("leases that cannot be read warn, and the seat is started", async () => {
    const { rig } = seed("unread-rig");
    const dir = nodePath.join(leaseRoot, encodeURIComponent("dev-impl@unread-rig"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "broken.json"), "{}");
    const createSession = vi.mocked(setup.tmuxAdapter.createSession);

    const res = await setup.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: rig.name, freshLogicalIds: ["dev.impl"] }),
    });
    const body = JSON.stringify(await res.json());

    expect(createSession.mock.calls.map((call) => String(call[0]))).toContain("dev-impl@unread-rig");
    expect(body).toContain("its leases were not judged");
  });

  it("a seat the restore resumes is not judged: its conversation continues, nothing is replaced", async () => {
    const { rig, impl } = seed("resume-rig");
    const session = setup.sessionRegistry.getSessionsForRig(rig.id).find((row) => row.nodeId === impl.id)!;
    setup.sessionRegistry.updateResumeToken(session.id, "claude_id", "00000000-0000-4000-8000-0000000000aa", "hook");
    leases.acquire("dev-impl@resume-rig", { holder: "ui-test-host", pid: process.pid });

    // The plan does not judge it either: plan and apply agree on a resumed seat.
    const planned = JSON.stringify(await (await setup.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: rig.name, plan: true }),
    })).json());
    expect(planned).not.toContain("relaunch_check_held");

    const res = await setup.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: rig.name }),
    });
    const body = JSON.stringify(await res.json());

    expect(body).not.toContain("relaunch_check_held");
  });

  // verify-qa FAIL 2: the plan judges each fresh seat's leases with the restore's own function, so plan and apply agree. Applying a plan
  // changes nothing, so plan then apply on one state compares them.
  const routes: Array<[string, (rig: { id: string; name: string }, body: Record<string, unknown>) => Promise<Response>]> = [
    ["POST /api/up", async (rig, body) => setup.app.request("/api/up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: rig.name, ...body }) })],
    ["POST /api/rigs/:id/up", async (rig, body) => setup.app.request(`/api/rigs/${rig.id}/up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })],
  ];
  it.each(routes)("%s: --plan names the leased seat's refusal, and apply on the same state refuses that seat and starts the other", async (_route, up) => {
    const { rig } = seed(`plan-rig-${_route.length}`);
    const leased = `dev-impl@${rig.name}`;
    leases.acquire(leased, { holder: "ui-test-host", pid: process.pid });
    const createSession = vi.mocked(setup.tmuxAdapter.createSession);

    const plan: { nodes: Array<{ logicalId: string; intendedAction: string; reason?: string; restoreStatus?: string }> } =
      await (await up(rig, { freshLogicalIds: ["dev.impl", "dev.qa"], plan: true })).json();
    expect(createSession).not.toHaveBeenCalled();
    const forecast = Object.fromEntries(plan.nodes.map((node) => [node.logicalId, node]));
    expect(forecast["dev.impl"]).toMatchObject({ intendedAction: "awaiting-decision", restoreStatus: "failed" });
    expect(forecast["dev.impl"]!.reason).toContain("relaunch_check_held");
    expect(forecast["dev.impl"]!.reason).toContain("ui-test-host");
    expect(forecast["dev.qa"]).toMatchObject({ intendedAction: "fresh-primed" });

    const applied: unknown = await (await up(rig, { freshLogicalIds: ["dev.impl", "dev.qa"] })).json();
    const started = createSession.mock.calls.map((call) => String(call[0]));
    expect(started).not.toContain(leased);
    expect(started).toContain(`dev-qa@${rig.name}`);
    expect(seatRow(applied, "dev.impl")).toMatchObject({ status: "failed", errorCode: "relaunch_check_held" });
  });
});
