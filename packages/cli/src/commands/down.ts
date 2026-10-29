import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveRigHandle } from "../rig-handle.js";
import { inferRigFromFolder } from "../rig-folder.js";

interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
  /** OF-36 Q1: not failures (a seat the snapshot holds no startup copy for); printed, exit code unaffected. */
  warnings?: string[];
}

interface DownAgentEntry {
  nodeKind: string;
  logicalId: string;
  canonicalSessionName?: string | null;
  sessionStatus: string | null;
  activityState?: { display?: string } | null;
  agentActivity?: { state?: string };
}

/** Best-effort facts from the ordinary inventory, before teardown changes it. */
async function showAgentsBeforeDown(rigId: string, readInventory: () => Promise<unknown>): Promise<void> {
  let facts = "agent sessions unknown; work status unknown";
  try {
    const inventory = await readInventory();
    if (Array.isArray(inventory) && inventory.every(n => n && typeof n.nodeKind === "string"
      && typeof n.logicalId === "string" && (n.sessionStatus === null || typeof n.sessionStatus === "string"))) {
      const agents = (inventory as DownAgentEntry[]).filter(n => n.nodeKind === "agent"
        && ["running", "idle", "unknown"].includes(n.sessionStatus ?? ""));
      facts = agents.length === 0 ? "no agent sessions reported live" : "recorded agent sessions: " + agents.map(n => {
        // A running process or an assigned queue row does not prove work in progress.
        // Prefer the daemon's arbitrated activity; older daemons expose agentActivity.
        const activity = n.activityState
          ? n.activityState.display
          : n.agentActivity?.state === "running" ? "working"
          : n.agentActivity?.state === "idle" ? "idle"
          : n.agentActivity?.state === "needs_input" ? "needs-input" : "unknown";
        const work = ["working", "idle", "needs-input"].includes(activity ?? "") ? activity : "unknown";
        return `${n.canonicalSessionName || n.logicalId} (activity: ${work})`;
      }).join(", ");
    }
  } catch { /* Unavailable inventory is an unknown fact, never a teardown gate. */ }
  console.error(`Before stopping ${rigId}: ${facts}.`);
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

/**
 * `rig down [rig]` - tear down a rig by name or id; without one, the project rig whose folder holds the current folder.
 * @param depsOverride - injectable deps for testing
 * @param currentFolder - the folder `rig down` with no <rig> looks from (injectable for testing)
 * @returns Commander command
 */
export function downCommand(depsOverride?: StatusDeps, currentFolder: () => string = () => process.cwd()): Command {
  const cmd = new Command("down").description("Tear down a rig")
    .addHelpText("after", `
rig down stops every agent in the rig: their sessions end, and any work in progress stops with them.
Before running it, check who is working (rig ps --nodes --rig <rig>) and that the person asked for it;
don't stop a team you didn't start unless asked. OpenRig snapshots the rig first (best-effort), and
rig up <rig> --existing brings it back, resuming each seat's conversation where its harness allows. With
--delete the rig record is removed too, so it can't be brought back that way.

Without <rig>, rig down acts on the one project rig whose folder holds the current folder (a project rig's seats run in
<project>/.workspaces/, and it is named after <project>), and says which. When no rig, or more than one, matches, it
refuses and lists them; name the rig instead.`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("[rig]", "Rig name or id to tear down (default: the project rig whose folder holds the current folder)")
    .option("--delete", "Delete rig record after stopping")
    .option("--force", "Kill sessions immediately")
    .option("--snapshot", "Take snapshot before teardown")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (rigArg: string | undefined, opts: { delete?: boolean; force?: boolean; snapshot?: boolean; json?: boolean; host?: string }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly.
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();
      const refuse = (fact: string, consequence: string, action: string, candidates?: Array<{ id: string; name: string; folder: string }>) => {
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action, ...(candidates ? { candidates } : {}) } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
      };
      if (rigArg === undefined && opts.host) {
        // The current folder is on this machine; the rigs are on another. Never infer across a machine boundary.
        refuse(`rig down --host ${opts.host} needs the rig named.`, "Nothing was torn down.", `Re-run with: rig down <rig> --host ${opts.host}`);
        return;
      }
      let rigHandle = rigArg ?? "";

      if (opts.host) {
        const { runRemoteHttpOp, resolveRemoteRigId } = await import("../remote-host-ops.js");
        const rigIdResult = await resolveRemoteRigId(opts.host, rigHandle, deps);
        if (!rigIdResult.ok) {
          if (opts.json) console.log(JSON.stringify(rigIdResult));
          else console.error(`Error: ${rigIdResult.error}`);
          process.exitCode = 1;
          return;
        }
        if (!opts.json) {
          await showAgentsBeforeDown(rigIdResult.rigId, async () => {
            const inventory = await runRemoteHttpOp(opts.host!, "GET", `/api/rigs/${encodeURIComponent(rigIdResult.rigId)}/nodes`, undefined, deps, { timeoutMs: 2_000 });
            return inventory.ok ? inventory.data : undefined;
          });
        }
        const result = await runRemoteHttpOp(opts.host, "POST", `/api/down`, { rigId: rigIdResult.rigId, delete: opts.delete, force: opts.force, snapshot: opts.snapshot }, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`Error on host ${opts.host}: ${result.error}`);
          process.exitCode = 1;
        }
        if (result.ok) {
          const teardown = result.data as Partial<TeardownResult> | undefined;
          if (teardown?.errors && teardown.errors.length > 0) process.exitCode = 2;
        }
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // OF-173: no <rig> -> the one project rig whose folder holds the current folder, or a refusal. Never a guess.
      if (rigArg === undefined) {
        const inferred = await inferRigFromFolder(client, currentFolder());
        if (inferred.kind === "unavailable") {
          refuse(`Could not tell which rig this folder belongs to: ${inferred.error}.`, "Nothing was torn down.", "Name the rig: rig down <rig> (list rigs with: rig ps)");
          return;
        }
        const listed = (rigs: Array<{ id: string; name: string; folder: string }>) =>
          rigs.length === 0 ? "no rig records a project folder" : rigs.map((r) => `${r.name} (${r.id}) in ${r.folder}`).join("; ");
        if (inferred.kind === "none") {
          refuse(`No rig's project folder holds ${inferred.folder}.`, `Nothing was torn down. Rigs with a project folder: ${listed(inferred.known)}.`,
            "Run rig down from inside a rig's project folder, or name the rig: rig down <rig>", inferred.known);
          return;
        }
        if (inferred.kind === "several") {
          refuse(`${inferred.folder} is inside ${inferred.candidates.length} rigs' project folders: ${listed(inferred.candidates)}.`,
            "Refusing to tear down: the folder does not say which rig.",
            `Name the rig, e.g. ${inferred.candidates.map((r) => `rig down ${r.id}`).join("  |  ")}`, inferred.candidates);
          return;
        }
        console.error(`rig down: ${currentFolder()} is in ${inferred.rig.folder}, the project folder of rig ${inferred.rig.name} (${inferred.rig.id}); stopping that rig.`);
        rigHandle = inferred.rig.id;
      }

      // Resolve the handle (name OR id) to a concrete id BEFORE the teardown POST.
      // Ambiguous/not-found halt here and never reach `/api/down` - for a
      // destructive op, ambiguity must stop, never guess (AC-3 load-bearing).
      const resolution = await resolveRigHandle(client, rigHandle);

      if (resolution.kind === "ambiguous") {
        const fact = `'${resolution.name}' matches ${resolution.ids.length} rigs.`;
        const consequence = "Refusing to tear down: an ambiguous name could destroy the wrong rig.";
        const action = `Re-run with the specific id, e.g. ${resolution.ids.map((id) => `rig down ${id}`).join("  |  ")}`;
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action, candidates: resolution.ids } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      if (resolution.kind === "not_found") {
        const fact = `No rig found matching '${resolution.handle}'.`;
        const consequence = "Nothing was torn down.";
        const action = "List rigs with: rig ps";
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      // resolved -> the looked-up id; passthrough -> the raw handle (summary
      // unavailable; daemon resolves by exact id, 404s if absent). Either way
      // the SAME existing teardown path + guards run below - no forked path.
      const rigId = resolution.kind === "resolved" ? resolution.id : resolution.handle;

      if (!opts.json) {
        await showAgentsBeforeDown(rigId, async () => {
          const inventory = await client.get<unknown>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`, { timeoutMs: 2_000 });
          return inventory.status === 200 ? inventory.data : undefined;
        });
      }

      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        rigId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) {
          process.exitCode = 2;
        } else {
          const r = res.data as TeardownResult;
          if (r.errors && r.errors.length > 0) process.exitCode = 2;
          else if (r.alreadyStopped && !r.deleted) process.exitCode = 1;
        }
        return;
      }

      // HTTP error
      if (res.status >= 400) {
        const errMsg = (res.data as { error: string }).error ?? "unknown error";
        console.error(`Down failed: ${errMsg} (HTTP ${res.status}). Check rig ID with: rig ps`);
        process.exitCode = 2;
        return;
      }

      const result = res.data as TeardownResult;
      for (const w of result.warnings ?? []) console.error(`  warning: ${w}`);

      // Exit code: errors first, then deleted, then alreadyStopped
      if (result.errors.length > 0) {
        console.log(`Rig ${rigId}: ${result.sessionsKilled} session(s) killed`);
        if (result.deleted) console.log("Rig deleted");
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        for (const e of result.errors) console.error(`  warning: ${e}`);
        process.exitCode = 2;
        return;
      }

      if (result.deleted) {
        console.log(`Rig ${rigId} deleted. ${result.sessionsKilled} session(s) killed.`);
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        return;
      }

      if (result.alreadyStopped) {
        console.log(`Rig ${rigId} already stopped`);
        process.exitCode = 1;
        return;
      }

      // Clean stop with post-command handoff
      console.log(`Rig ${rigId} stopped. ${result.sessionsKilled} session(s) killed.`);
      if (result.snapshotId) {
        console.log(`Snapshot: ${result.snapshotId}`);
        // Post-command handoff: how to restore (check for duplicate names)
        const rigName = (res.data as Record<string, unknown>)["rigName"] as string | undefined;
        const isUniqueName = (res.data as Record<string, unknown>)["isUniqueName"] as boolean | undefined;
        if (rigName && isUniqueName !== false) {
          console.log(`To restore: rig up ${rigName}`);
        } else {
          console.log(`To restore: rig restore ${result.snapshotId} --rig ${rigId}`);
        }
      }
    });

  return cmd;
}
