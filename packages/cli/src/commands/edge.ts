import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { resolveRigHandle } from "../rig-handle.js";
import type { StatusDeps } from "./status.js";

interface EdgeResponse {
  ok?: boolean; code?: string; message?: string; error?: string; created?: boolean;
  edge?: { id: string; from: string; to: string; kind: string };
  edges?: Array<{ id: string; from: string; to: string; kind: string }>;
}

/** `rig edge add|list`: put back or read the edges between seats of a running rig. `rig remove` + `rig add` loses a seat's cross-pod
 *  edges and nothing else adds one. Both endpoints are node logical ids (`pod.member`). */
export function edgeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("edge").description("Add or list the edges between seats of a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function connect(rigHandle: string): Promise<{ client: DaemonClient; rigId: string } | null> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    const client = deps.clientFactory(getDaemonUrl(status));
    const resolution = await resolveRigHandle(client, rigHandle);
    if (resolution.kind === "ambiguous") {
      console.error(`'${rigHandle}' matches ${resolution.ids.length} rigs (${resolution.ids.join(", ")}). Nothing was changed. Pass the rig id.`);
      return null;
    }
    return { client, rigId: resolution.kind === "resolved" ? resolution.id : rigHandle };
  }

  cmd.command("add")
    .description("Add an edge between two existing seats. Refuses a self-edge, an unknown seat or kind, and a launch-order cycle; adding an edge that exists changes nothing")
    .argument("<rig>", "Rig name or ID")
    .argument("<from>", "Source seat logical id, e.g. advisor.lead")
    .argument("<to>", "Target seat logical id, e.g. queue.worker")
    .requiredOption("--kind <kind>", "Edge kind: delegates_to, spawned_by, can_observe, collaborates_with or escalates_to (required: delegates_to and spawned_by set launch order)")
    .option("--reason <text>", "Reason recorded on the audit event")
    .option("--operator <address>", "Operator recorded on the audit event when no session identity is present")
    .option("--json", "JSON output")
    .action(async (rigHandle: string, from: string, to: string, opts: { kind: string; reason?: string; operator?: string; json?: boolean }) => {
      const target = await connect(rigHandle);
      if (!target) { process.exitCode = 1; return; }
      const res = await target.client.post<EdgeResponse>(`/api/rigs/${encodeURIComponent(target.rigId)}/edges`,
        { from, to, kind: opts.kind, reason: opts.reason, operator: opts.operator });
      if (opts.json) console.log(JSON.stringify(res.data, null, 2));
      if (res.status >= 400 || !res.data.ok) {
        if (!opts.json) console.error(res.data.message ?? res.data.error ?? `Edge add failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      if (!opts.json) console.log(`${res.data.created ? "Added" : "Already present"}: ${from} ${opts.kind} ${to}`);
    });

  cmd.command("list")
    .description("List the rig's edges (seat logical ids)")
    .argument("<rig>", "Rig name or ID")
    .option("--json", "JSON output")
    .action(async (rigHandle: string, opts: { json?: boolean }) => {
      const target = await connect(rigHandle);
      if (!target) { process.exitCode = 1; return; }
      const res = await target.client.get<EdgeResponse>(`/api/rigs/${encodeURIComponent(target.rigId)}/edges`);
      if (opts.json) console.log(JSON.stringify(res.data, null, 2));
      if (res.status >= 400 || !res.data.ok) {
        if (!opts.json) console.error(res.data.message ?? res.data.error ?? `Edge list failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      if (!opts.json) for (const e of res.data.edges ?? []) console.log(`${e.from} ${e.kind} ${e.to}`);
    });

  return cmd;
}
