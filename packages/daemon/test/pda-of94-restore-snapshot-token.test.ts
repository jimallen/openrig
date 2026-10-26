// OF-94 (reviewer-flagged, uncertain): the OF-92 holder check reads OTHER seats' tokens from the live sessions table,
// while a restore resumes the RESTORING seat from its SNAPSHOT's token. If they differ, could a holder be missed?
//
// Settled here by a real restore (RestoreOrchestrator -> startup orchestrator -> the real PdaRuntimeAdapter, wired as
// startup.ts wires it, over a fake tmux that records keystrokes; the seat is a legacy (no pod) seat, so the restore
// resumes through PdaResumeAdapter, the one door of the two where the snapshot's token is the launch target) in which the snapshot token differs from the live
// sessions row of the restoring seat:
//   - the agent CHECKED is the snapshot token's (the launch target), never the live row's;
//   - the restoring seat's own live row is excluded from the holders, whatever it says;
//   - other seats are read from their live rows, which is right: a seat that is not being restored drives the agent its
//     live row names (the one it was launched on and recorded), and when it is restored later its own check runs.
// Production consequence pinned: a restore that would put a second seat on a held agent must type nothing.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { vi } from "vitest";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { PdaResumeAdapter } from "../src/adapters/pda-resume.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { EventBus } from "../src/domain/event-bus.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { pdaSeatPaths } from "../src/adapters/pda-runner-protocol.js";

const PORT = "http://127.0.0.1:8150";
const tok = (agent: string) => `${PORT}/agents/${agent}`;

describe("OF-94: a restore whose snapshot token differs from the live sessions row", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());

  /** The restoring seat: live row says `live`, the snapshot says `snap`. Typed keystrokes are recorded. */
  async function restoringSeat(snap: string, live: string) {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const stateRoot = path.join(h.root, "pda-state");
    const tokenFile = path.join(h.root, "pda-token");
    fs.writeFileSync(tokenFile, "x".repeat(43), { mode: 0o600 });
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    for (const s of data.sessions) { s.resumeType = "pda_agent"; s.resumeToken = snap; }
    for (const ctx of Object.values(data.nodeStartupContext ?? {}) as Array<{ runtime?: string }>) ctx.runtime = "pda";
    for (const n of data.nodes ?? []) n.runtime = "pda";
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
    h.db.prepare("UPDATE nodes SET runtime = 'pda', pod_id = NULL WHERE id = ?").run(seat.nodeId);
    // The live rows (what OF-92's holder reads for every OTHER seat) say something else for this seat.
    h.db.prepare("UPDATE sessions SET resume_type = 'pda_agent', resume_token = ? WHERE node_id = ?").run(live, seat.nodeId);
    const typed: string[] = [];
    const adapter = new PdaRuntimeAdapter({
      tmux: {
        sendShellCommand: async (session: string, command: string) => {
          typed.push(command);
          const argv = command.split(" ").map((part) => part.replace(/^'|'$/g, ""));
          const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
          const paths = pdaSeatPaths(stateRoot, session);
          fs.mkdirSync(paths.seatRoot, { recursive: true });
          const at = new Date().toISOString();
          fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
            ready: true, launchId: value("--launch-id"), updatedAt: at, aliveAt: at, agent: value("--agent"), baseUrl: value("--base-url"),
            connected: true, busy: false, outboxPending: 0,
          }));
          return { ok: true as const };
        },
        hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
      } as never,
      fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } } },
      stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js", tokenFile: () => tokenFile,
      reserveBinding: (binding, nodeId) => h.rigRepo.reservePdaLaunch(binding, nodeId),
      sleep: async () => {}, pollMs: 1, launchWaitMs: 50,
    });
    return { seat, snapshotId, adapter, typed };
  }

  /** Another seat, in another live rig, whose LIVE token names `agent`. */
  function otherHolder(agent: string) {
    const rig = h.rigRepo.createRig("rig-holder");
    const node = h.rigRepo.addNode(rig.id, "dev.holder", { runtime: "pda", pda: { agent: "parked", baseUrl: PORT } });
    const session = h.sessionRegistry.registerSession(node.id, "dev-holder@rig-holder");
    h.sessionRegistry.updateStatus(session.id, "running");
    h.sessionRegistry.updateResumeToken(session.id, "pda_agent", tok(agent), "scrape");
    return node.id;
  }

  /** The restore orchestrator the daemon builds, with the legacy pda resume door wired to the real adapter. */
  const restoreOnce = async (snapshotId: string, adapter: PdaRuntimeAdapter) => {
    const eventBus = new EventBus(h.db);
    const restore = new RestoreOrchestrator({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, eventBus, snapshotRepo: h.snapshotRepo,
      snapshotCapture: h.snapshotCapture, checkpointStore: new CheckpointStore(h.db),
      nodeLauncher: new NodeLauncher({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, eventBus, tmuxAdapter: h.tmux }),
      tmuxAdapter: h.tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() } as never, codexResume: { canResume: () => false, resume: vi.fn() } as never,
      pdaResume: new PdaResumeAdapter(adapter), listProcesses: async () => [],
    } as never);
    const out = await restore.restore(snapshotId, { adapters: { pda: adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) } } as never);
    if (!out.ok) throw new Error(JSON.stringify(out));
    return out.result;
  };

  it("the snapshot's agent is held by another seat (its live token), the live row names a free agent: the restore is refused and types nothing", async () => {
    const { seat, snapshotId, adapter, typed } = await restoringSeat(tok("research"), tok("free-live"));
    otherHolder("research");
    const result = await restoreOnce(snapshotId, adapter);
    const node = result.nodes.find((n) => n.nodeId === seat.nodeId)!;
    expect(node.status).not.toBe("resumed");
    expect(node.error).toContain('seat "dev.holder" in rig "rig-holder"');
    expect(node.error).toContain("pda launch refused before anything was typed");
    expect(node.error).not.toContain("/agents/"); // never a token
    expect(typed).toEqual([]);
  });

  it("control: the same restore with nobody holding the snapshot's agent launches it, and it is the SNAPSHOT's agent, not the live row's", async () => {
    const { seat, snapshotId, adapter, typed } = await restoringSeat(tok("research"), tok("free-live"));
    const result = await restoreOnce(snapshotId, adapter);
    expect(result.nodes.find((n) => n.nodeId === seat.nodeId)!.status).toBe("resumed");
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("research");
    expect(typed[0]).not.toContain("free-live");
  });

  it("the live row names an agent another seat holds but the snapshot's agent is free: the stale live row blocks nothing", async () => {
    const { seat, snapshotId, adapter, typed } = await restoringSeat(tok("research"), tok("stale-live"));
    otherHolder("stale-live");
    const result = await restoreOnce(snapshotId, adapter);
    expect(result.nodes.find((n) => n.nodeId === seat.nodeId)!.status).toBe("resumed");
    expect(typed).toHaveLength(1);
  });

  it("the restoring seat's OWN live row naming the snapshot's agent is not a holder (it is excluded by seat)", async () => {
    const { seat, snapshotId, adapter, typed } = await restoringSeat(tok("research"), tok("research"));
    const result = await restoreOnce(snapshotId, adapter);
    expect(result.nodes.find((n) => n.nodeId === seat.nodeId)!.status).toBe("resumed");
    expect(typed).toHaveLength(1);
  });
});
