import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { listNativeProcesses, observeClaudeDelivery } from "../src/domain/native-process-lineage.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig } from "./helpers/scenario-daemon.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// Real daemon, CLI, SQLite and a private hc core (the daemon finds it through HC_SOCKET). The scripted process exits
// normally on /exit; this checks terminal preservation, not provider authentication.
// process.title / foreground-process evidence here is bound to Linux.
it.runIf(process.platform === "linux" && !!findHc())("launch does not call an exited agent already running in its preserved shell", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
  let scratch: HcScratch | undefined;
  let daemon: Awaited<ReturnType<typeof spawnScenarioDaemon>> | undefined;
  let db: Database.Database | undefined;
  let shellPid: number | undefined;
  const name = "dev-build@launch-exit";
  const terminal = () => scratch!.client().call<{ address: string; pid: number; foreground?: { name?: string } | null }>("terminal.get", { terminal: hcTerminalName(name) });
  /** The terminal's foreground program as hc reports it on its sweep; the shell itself while no child holds the tty. */
  const foreground = async () => (await terminal()).foreground?.name;
  const type = (text: string) => scratch!.client().call("terminal.send", { terminal: hcTerminalName(name), text });
  async function until(predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("fixture did not settle");
  }
  try {
    scratch = startHcScratch();
    daemon = await spawnScenarioDaemon({ ...scaffold, env: { ...scaffold.env, HC_SOCKET: scratch.socketPath } }, { rigBin });
    db = new Database(join(scaffold.stateDir, "scenario.db"));
    db.pragma("busy_timeout = 5000");
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("launch-exit");
    const node = rigs.addNode(rig.id, "dev.build", { role: "build", runtime: "claude-code" });
    await scratch.client().call("terminal.run", {
      argv: ["/bin/bash", "--noprofile", "--norc"], name: hcTerminalName(name), labels: { [SEAT_LABEL]: name },
      cwd: scaffold.root, no_parent: true, no_notify: true, outlive_parent: true,
    });
    const { address: pane, pid } = await terminal();
    shellPid = pid;
    const ready = join(scaffold.root, "agent.pid");
    const script = join(scaffold.root, "agent.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
process.title='claude'; writeFileSync(${JSON.stringify(ready)},String(process.pid));
createInterface({input:process.stdin}).on('line',line=>{if(line==='/exit')process.exit(0);});\n`);
    await type(`node '${script}'`);
    await until(async () => existsSync(ready) && (await foreground()) === "claude");
    const agentPid = Number(readFileSync(ready, "utf8"));
    const session = sessions.registerSession(node.id, name);
    sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name, terminalAddress: pane });
    const snapshot = new SnapshotRepository(db).createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: rig.name }, nodes: rigs.getRig(rig.id)!.nodes,
      sessions: sessions.getSessionsForRig(rig.id), edges: [], checkpoints: {},
    } as any);
    const args = ["launch", rig.id, "--seats", node.logicalId, "--snapshot-id", snapshot.id, "--json"];
    const live = await runRig(args, daemon.readEnv, rigBin);
    expect(live.code, JSON.stringify(live)).toBe(0);
    expect(JSON.parse(live.stdout).alreadyRunning).toEqual([{ nodeId: node.id, logicalId: node.logicalId }]);

    await type("/exit");
    await until(() => {
      try { process.kill(agentPid, 0); return false; } catch { return true; }
    });
    // hc's sweep reports the shell as the foreground again a moment after the agent is gone.
    await until(async () => (await foreground()) === "bash");
    expect(await foreground()).toBe("bash");
    const observed = await observeClaudeDelivery({ target: pane, tmux: { getPanePid: (target) => new HcAdapter(scratch!.client()).getPanePid(target) } });
    const rows = await listNativeProcesses();
    const root = rows.find(row => row.pid === shellPid);
    expect(observed.state, JSON.stringify({ observed, root, children: rows.filter(row => row.ppid === shellPid || row.pgid === root?.tpgid), binding: sessions.getBindingForNode(node.id), node: rigs.getRig(rig.id)!.nodes[0] })).toBe("idle_shell");
    const exited = await runRig(args, daemon.readEnv, rigBin);
    console.log("EXITED_AGENT_RECEIPT", JSON.stringify({ live, exited, pane, agentPid }));
    expect(exited.code, JSON.stringify(exited)).not.toBe(0);
    const result = JSON.parse(exited.stdout);
    expect(result.ok).toBe(false);
    expect(result.alreadyRunning ?? []).toEqual([]);
    expect(JSON.stringify(result)).toMatch(/session alive, agent not running/i);
    const human = await runRig(args.filter(a => a !== "--json"), daemon.readEnv, rigBin);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toMatch(/session alive, agent not running/i);
    expect(human.stderr).toContain("restart the agent");
    expect(human.stdout).not.toMatch(/Already running|Launched:/);
    expect(await foreground()).toBe("bash");
  } finally {
    db?.close();
    try {
      if (shellPid) {
        // Let the preserved fixture shell finish its exit/history writes before
        // the helper removes HOME. No production pane is touched by this test.
        await new HcAdapter(scratch!.client()).killSession(name);
        await until(() => {
          try { process.kill(shellPid!, 0); return false; } catch { return true; }
        });
      }
    } finally {
      try {
        if (daemon) await daemon.stop(); else scaffold.cleanup();
      } finally { scratch?.cleanup(); }
    }
  }
}, 60_000);
