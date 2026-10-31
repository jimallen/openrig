import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient, HcUnavailableError } from "../src/adapters/hc-client.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { startTranscriptRotation, stopTranscriptRotation, getActiveRotationCount, getLastCaptureAt } from "../src/domain/transcript-rotation.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The real client to the private core, except that the core cannot be reached for a kill while `failKill` is set. */
class KillFailingClient extends HcClient {
  failKill = false;
  override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.failKill && method === "terminal.kill") throw new HcUnavailableError("fixture transport unavailable");
    return super.call<T>(method, params, options);
  }
}

describe.skipIf(!findHc())("hc failed-kill transcript continuity", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); vi.stubEnv("SHELL", "/bin/sh"); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  it.each([true, false])("preserves capture only while the seat survives (kill fails=%s)", async (failure) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kill-capture-"));
    const sessionName = `worker@kill-fixture-${failure}`;
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const client = new KillFailingClient(scratch.socketPath);
    const hc = new HcAdapter(client);
    try {
      expect(await hc.createSession(sessionName, temp)).toEqual({ ok: true });
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const rig = rigRepo.createRig("kill-fixture");
      const node = rigRepo.addNode(rig.id, "worker");
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus,
        snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
      const orchestrator = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: hc });
      const outputPath = path.join(temp, "transcript.log");
      startTranscriptRotation(hc, sessionName, outputPath, { lines: 20, pollIntervalMs: 30 });
      const deadline = Date.now() + 5000;
      while (getLastCaptureAt(sessionName) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(outputPath)).toBe(true);
      const before = getLastCaptureAt(sessionName)!;
      client.failKill = failure;
      const result = await orchestrator.teardown(rig.id);
      expect(await hc.hasSession(sessionName)).toBe(failure);
      expect(sessionRegistry.getSessionsForRig(rig.id).find((entry) => entry.id === session.id)?.status).toBe(failure ? "running" : "exited");
      expect(result.sessionsKilled).toBe(failure ? 0 : 1);
      expect(getActiveRotationCount()).toBe(failure ? 1 : 0);
      if (failure) {
        expect(result.errors.join("\n")).toContain("hc core unavailable");
        const captureDeadline = Date.now() + 5000;
        while ((getLastCaptureAt(sessionName) ?? 0) <= before && Date.now() < captureDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getLastCaptureAt(sessionName)).toBeGreaterThan(before);
      } else {
        expect(result.errors).toEqual([]);
        expect(getLastCaptureAt(sessionName)).toBeUndefined();
      }
    } finally {
      stopTranscriptRotation(sessionName);
      client.failKill = false;
      await hc.killSession(sessionName).catch(() => undefined);
      db.close(); fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
