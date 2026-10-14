import { resolve as resolvePath } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveDefaultAgentRef } from "./topology-default-agent.js";

interface RigNode {
  rigName: string;
  podNamespace: string | null;
}

interface GrowNode {
  logicalId: string;
  status: "launched" | "failed" | "attention_required";
  sessionName?: string;
  error?: string;
}

interface AddMemberResult {
  ok: boolean;
  result?: {
    podNamespace: string;
    node: GrowNode;
  };
  errors?: string[];
  message?: string;
  error?: string;
}

interface ExpandResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podNamespace?: string;
  nodes?: GrowNode[];
  warnings?: string[];
  retryTargets?: string[];
  errors?: string[];
  message?: string;
  error?: string;
}

export function growCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("grow").description("Add one or more seats to a running rig")
    .addHelpText("after", `
Each seat gets the shipped orchestrator agent unless --agent-ref names another. A seat
added to a running rig does not get the rig's own culture file unless --culture names it
(the rig does not remember it). --culture is for an existing pod; with --new-pod it is refused.

Relative paths differ by flag: --culture is taken from the directory you run the command in,
while a local: --agent-ref is resolved from --cwd (the rig root sent to the daemon). Use an
absolute path or path: to avoid the difference. rig add behaves the same way (--culture from
your directory, the fragment's agent_ref from --rig-root).

Examples:
  rig grow my-rig worker qa --pod dev
  rig grow my-rig worker --pod dev --culture ./my-rig/CULTURE.md --agent-ref path:/agents/builder`);
  const getDeps = () => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<rig-id>", "Target rig ID")
    .argument("<members...>", "Names for the new seats")
    .option("--pod <pod>", "Target pod; inferred when the rig has one pod")
    .option("--new-pod <pod>", "Create a new pod for the seats")
    .option("--runtime <runtime>", "Agent runtime", "claude-code")
    .option("--cwd <path>", "Working directory for the seat", process.cwd())
    .option("--agent-ref <ref>", "Agent spec for every named seat (for example path:/abs/dir or local:agents/name; a local: ref is resolved from --cwd, not from the current directory); default is the shipped orchestrator agent")
    .option("--culture <path>", "The rig's culture file (a relative path is taken from the current directory). The rig does not remember it, so name it to give the added seats the rig's own culture. Not available with --new-pod")
    .option("--json", "JSON output for agents")
    .action(async (
      rigId: string,
      members: string[],
      opts: { pod?: string; newPod?: string; runtime: string; cwd: string; agentRef?: string; culture?: string; json?: boolean },
    ) => {
      if (opts.pod && opts.newPod) {
        console.error("Choose either --pod or --new-pod, not both.");
        process.exitCode = 1;
        return;
      }
      // The expand route a new pod goes through carries no culture file, so the seats would silently start
      // without the culture the operator named. Refuse before any call rather than drop it.
      if (opts.newPod && opts.culture !== undefined) {
        console.error("--culture is not supported with --new-pod: creating a pod does not carry a culture file, so the new seats would start without it. Create the pod first, then add the seats to it with rig grow --pod <pod> --culture <path>.");
        process.exitCode = 1;
        return;
      }
      if (opts.agentRef !== undefined && opts.agentRef.trim() === "") {
        console.error("--agent-ref must be a non-empty agent reference.");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRes = await client.get<RigNode[]>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
      if (rigRes.status >= 400) {
        console.error(`Rig ${rigId} was not found.`);
        process.exitCode = 1;
        return;
      }
      const rigName = rigRes.data[0]?.rigName;
      const pods = [...new Set(
        rigRes.data
          .map((node) => node.podNamespace)
          .filter((namespace): namespace is string => typeof namespace === "string"),
      )];
      if (opts.newPod && pods.includes(opts.newPod)) {
        console.error(`Pod ${opts.newPod} already exists. Use --pod ${opts.newPod} to grow it.`);
        process.exitCode = 1;
        return;
      }
      const pod = opts.newPod
        ?? (opts.pod
          ? pods.find((candidate) => candidate === opts.pod)
          : pods.length === 1
            ? pods[0]
            : undefined);
      if (!pod) {
        const available = pods.join(", ") || "none";
        console.error(opts.pod
          ? `Pod ${opts.pod} was not found. Available pods: ${available}.`
          : `Choose a pod with --pod. Available pods: ${available}.`);
        process.exitCode = 1;
        return;
      }

      let agentRef: string;
      if (opts.agentRef !== undefined) {
        agentRef = opts.agentRef;
      } else {
        try {
          agentRef = await resolveDefaultAgentRef(client);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }
      }
      const cwd = resolvePath(opts.cwd);
      // Same as rig add: the daemon resolves a relative path against its own cwd, not the operator's, so
      // resolve against the caller's cwd here. An empty value is sent as typed so the daemon refuses it
      // (resolving it would turn a mistake into the cwd).
      const cultureFile = opts.culture === undefined
        ? undefined
        : opts.culture === "" ? opts.culture : resolvePath(process.cwd(), opts.culture);
      const memberSpecs = members.map((member) => ({
        id: member,
        agent_ref: agentRef,
        runtime: opts.runtime,
        profile: "default",
        cwd,
      }));
      let nodes: GrowNode[] = [];
      let ok = false;
      let detail: string | undefined;
      let warnings: string[] = [];
      let retryTargets: string[] = [];

      if (opts.newPod) {
        const res = await client.post<ExpandResult>(
          `/api/rigs/${encodeURIComponent(rigId)}/expand`,
          {
            pod: { id: pod, label: pod, members: memberSpecs, edges: [] },
            rigRoot: cwd,
          },
          { timeoutMs: 120_000 },
        );
        nodes = res.data.nodes ?? [];
        warnings = res.data.warnings ?? [];
        retryTargets = res.data.retryTargets ?? [];
        ok = res.status < 400
          && res.data.ok
          && res.data.status === "ok"
          && nodes.length === members.length
          && nodes.every((node) => node.status === "launched");
        detail = res.data.errors?.join("; ")
          ?? res.data.message
          ?? res.data.error
          ?? nodes.find((node) => node.error)?.error;
        const returned = new Set(nodes.map((node) => node.logicalId));
        for (const member of memberSpecs) {
          const logicalId = `${pod}.${member.id}`;
          if (!returned.has(logicalId)) {
            nodes.push({ logicalId, status: "failed", error: detail ?? "No node outcome returned." });
          }
        }
      } else {
        const failures: string[] = [];
        for (const member of memberSpecs) {
          const res = await client.post<AddMemberResult>(
            `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(pod)}/members`,
            { member, rigRoot: cwd, ...(cultureFile !== undefined ? { cultureFile } : {}) },
            { timeoutMs: 120_000 },
          );
          const responseDetail = res.data.errors?.join("; ")
            ?? res.data.message
            ?? res.data.error
            ?? res.data.result?.node.error
            ?? `Grow failed (HTTP ${res.status})`;
          const node = res.data.result?.node ?? {
            logicalId: `${pod}.${member.id}`,
            status: "failed" as const,
            error: responseDetail,
          };
          nodes.push(node);
          if (res.status >= 400 || !res.data.ok || node.status !== "launched") {
            failures.push(`${member.id}: ${responseDetail}`);
          }
        }
        ok = failures.length === 0;
        detail = failures.join("; ") || undefined;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok,
          rigId,
          rigName,
          pod,
          seats: nodes.map((node) => node.logicalId),
          source: agentRef,
          ...(nodes.length === 1 ? { seat: nodes[0]?.logicalId, node: nodes[0] } : {}),
          nodes,
          ...(detail ? { detail } : {}),
          warnings,
          retryTargets,
        }, null, 2));
      } else if (ok) {
        console.log(`Grew rig ${rigName ?? rigId}`);
        if (nodes.length === 1) {
          const node = nodes[0]!;
          console.log(`  Seat: ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}`);
        } else {
          console.log("  Seats:");
          for (const node of nodes) {
            console.log(`    ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}`);
          }
        }
      } else {
        console.error(`Grow did not fully succeed for ${rigName ?? rigId}`);
        for (const node of nodes) {
          const icon = node.status === "launched" ? "OK" : node.status === "attention_required" ? "ATTENTION" : "FAIL";
          const session = node.sessionName ? ` (${node.sessionName})` : "";
          const error = node.error ? ` - ${node.error}` : "";
          console.error(`  [${icon}] ${node.logicalId}: ${node.status}${session}${error}`);
        }
        if (detail && !nodes.some((node) => node.error && detail.includes(node.error))) {
          console.error(`  ${detail}`);
        }
        for (const warning of warnings) console.error(`  Warning: ${warning}`);
        if (retryTargets.length > 0) {
          console.error("  Failed nodes can be relaunched individually. Recover by:");
          for (const target of retryTargets) console.error(`    rig launch ${rigId} ${target}`);
        }
      }

      if (!ok) process.exitCode = 1;
    });

  return cmd;
}
