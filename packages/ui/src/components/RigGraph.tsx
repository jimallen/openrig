import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ReactFlow, Controls, Handle, Position, type NodeTypes, type EdgeTypes, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRigGraph } from "../hooks/useRigGraph.js";
import { useRigEvents } from "../hooks/useRigEvents.js";
import { getEdgeStyle } from "@/lib/edge-styles";
import { applyTreeLayout } from "@/lib/graph-layout";
import { RigNode } from "./RigNode.js";
import { HotPotatoEdge } from "./topology/HotPotatoEdge.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { useTopologyActivity } from "../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import {
  applyHotPotatoEdges,
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
} from "../lib/topology-activity.js";

function PodGroupNode({
  data,
}: {
  data: {
    podLabel?: string | null;
    logicalId?: string | null;
    podId?: string | null;
    podNamespace?: string | null;
    podDisplayName?: string | null;
  };
}) {
  const label = data.podDisplayName ?? data.podNamespace ?? inferPodName(data.logicalId) ?? displayPodName(data.podId ?? data.logicalId);

  return (
    <div
      data-testid="pod-group-node"
      className="w-full h-full relative pointer-events-auto"
    >
      <div className="absolute left-4 top-3 inline-flex items-center font-mono text-[12px] font-bold leading-none tracking-[0.08em] text-on-surface">
        {`${label} pod`}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  rigNode: RigNode,
  podGroup: PodGroupNode,
};

const edgeTypes: EdgeTypes = {
  hotPotato: HotPotatoEdge,
};

/** Wireframe ghost for empty topology */
function EmptyTopologyGhost() {
  return (
    <div className="flex flex-col items-center justify-center h-full relative text-foreground-muted" data-testid="empty-topology">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 300" fill="none" style={{ opacity: 0.08 }}>
        <rect x="160" y="60" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="60" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="260" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <line x1="200" y1="100" x2="100" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="200" y1="100" x2="300" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
      </svg>
      <div className="relative z-10 text-center">
        <h2 className="text-headline-md uppercase">EMPTY TOPOLOGY</h2>
      </div>
    </div>
  );
}

interface FocusMessage {
  text: string;
  type: "success" | "error" | "info";
}

export function RigGraph({
  rigId,
  rigName = null,
  podScope,
}: {
  rigId: string | null;
  rigName?: string | null;
  /** V1 polish slice Phase 5.1 P5.1-5: pod-scope filter. When set, the
   *  graph renders only nodes/edges/podGroups whose pod matches this
   *  name (matched via inferPodName + node.podId/podNamespace). Other
   *  rig nodes are filtered out so the graph reads as a single-pod
   *  subset. Used by /topology/pod/$rigId/$podName graph view-mode. */
  podScope?: string;
}) {
  const { data, isPending: loading, error: queryError } = useRigGraph(rigId ?? "");
  const allRawNodes = data?.nodes ?? [];
  const allRawEdges = data?.edges ?? [];

  // P5.1-5 pod-scope filter: when podScope set, restrict nodes to those
  // whose pod matches; restrict edges to those between filtered nodes.
  // Hook data is typed as unknown[]; cast inline to known shape.
  const { rawNodes, rawEdges } = useMemo(() => {
    if (!podScope) return { rawNodes: allRawNodes, rawEdges: allRawEdges };
    type RigNodeShape = {
      id: string;
      type?: string;
      data?: { logicalId?: string; podId?: string | null; podNamespace?: string | null };
    };
    type RigEdgeShape = { source: string; target: string };
    const allowedNodeIds = new Set<string>();
    const filteredNodes = (allRawNodes as RigNodeShape[]).filter((n) => {
      if (n.type === "podGroup" || n.type === "group") {
        const matches =
          (n.data?.podNamespace ?? n.data?.podId) === podScope;
        if (matches) allowedNodeIds.add(n.id);
        return matches;
      }
      const inferredPod =
        n.data?.podNamespace ??
        n.data?.podId ??
        inferPodName(n.data?.logicalId ?? null);
      const matches = inferredPod === podScope;
      if (matches) allowedNodeIds.add(n.id);
      return matches;
    });
    const filteredEdges = (allRawEdges as RigEdgeShape[]).filter(
      (e) => allowedNodeIds.has(e.source) && allowedNodeIds.has(e.target),
    );
    return { rawNodes: filteredNodes, rawEdges: filteredEdges };
  }, [allRawNodes, allRawEdges, podScope]);
  const error = queryError?.message ?? null;
  const { reconnecting } = useRigEvents(rigId);
  const reducedMotion = usePrefersReducedMotion();
  // OPR.0.4.6.MH2 rev1-r2 B1: cmux focus is a LOCAL session action; under a
  // remote selection the node click still navigates (read drill-in) but the
  // bare-local focus POST must never fire.
  const graphIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const [focusMessage, setFocusMessage] = useState<FocusMessage | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entrance animation tracking: keyed by rigId, fires once per navigation
  const animatedRigRef = useRef<string | null>(null);
  const shouldAnimate = rigId !== null && animatedRigRef.current !== rigId;

  // Mark animation as done after first render
  useEffect(() => {
    if (rigId && rawNodes.length > 0 && animatedRigRef.current !== rigId) {
      animatedRigRef.current = rigId;
    }
  }, [rigId, rawNodes.length]);

  const showFocusMessage = useCallback((msg: FocusMessage) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setFocusMessage(msg);
    dismissTimerRef.current = setTimeout(() => {
      setFocusMessage(null);
      dismissTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const sessionIndex = useMemo(() => {
    return buildTopologySessionIndex((rawNodes as Node[])
      .filter((node) => node.type === "rigNode")
      .map((node) => {
        const data = node.data as {
          logicalId?: string | null;
          canonicalSessionName?: string | null;
          agentActivity?: TopologyActivityBaseline["agentActivity"];
          currentQitems?: TopologyActivityBaseline["currentQitems"];
          startupStatus?: string | null;
          terminalActive?: boolean | null;
          hasAssignedWork?: boolean;
          pendingWorkCount?: number;
        } | undefined;
        return {
          nodeId: node.id,
          rigId,
          rigName,
          logicalId: data?.logicalId ?? null,
          canonicalSessionName: data?.canonicalSessionName ?? null,
          agentActivity: data?.agentActivity ?? null,
          currentQitems: data?.currentQitems ?? null,
          startupStatus: data?.startupStatus ?? null,
          terminalActive: data?.terminalActive,
          hasAssignedWork: data?.hasAssignedWork ?? false,
          pendingWorkCount: data?.pendingWorkCount ?? 0,
        };
      }));
  }, [rawNodes, rigId, rigName]);
  const topologyActivity = useTopologyActivity(sessionIndex);

  const rfEdges = useMemo(() => {
    return (rawEdges as (Edge & { data?: { kind?: string } })[]).map((edge) => {
      const kind = (edge as { data?: { kind?: string } }).data?.kind ??
        (edge as { label?: string }).label ?? "delegates_to";
      const styleResult = getEdgeStyle(kind);
      return {
        ...edge,
        ...styleResult,
        className: shouldAnimate ? "edge-draw-in" : undefined,
        style: {
          ...styleResult.style,
          animationDelay: shouldAnimate ? `${Math.min(rawNodes.length * 50 + 100, 2000)}ms` : undefined,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEdges, shouldAnimate, rawNodes.length]);

  // Apply tree layout + entrance animation to nodes
  const rfNodes = useMemo(() => {
    const podDisplayNames = new Map<string, string>();
    for (const node of rawNodes as Node[]) {
      if (!node.parentId) {
        continue;
      }

      const logicalId = typeof node.data === "object" && node.data !== null && "logicalId" in node.data
        ? (node.data as { logicalId?: string | null }).logicalId
        : null;
      const podId = typeof node.data === "object" && node.data !== null && "podId" in node.data
        ? (node.data as { podId?: string | null }).podId
        : null;
      const podDisplayName = inferPodName(logicalId) ?? displayPodName(podId);

      if (podDisplayName && !podDisplayNames.has(node.parentId)) {
        podDisplayNames.set(node.parentId, podDisplayName);
      }
    }

    const layoutNodes = applyTreeLayout(rawNodes as Node[], rawEdges as unknown as Parameters<typeof applyTreeLayout>[1]);
    const managed = layoutNodes.map((node, index) => ({
      ...node,
      data: (() => {
        if (node.type === "podGroup" || node.type === "group") {
          return {
            ...(node.data ?? {}),
            podDisplayName: podDisplayNames.get(node.id) ?? null,
          };
        }

        return node.data;
      })(),
      className: shouldAnimate ? "node-enter" : undefined,
      style: {
        ...(node.style ?? {}),
        animationDelay: shouldAnimate ? `${Math.min(index * 50, 2000)}ms` : undefined,
      },
    }));
    return managed as Node[];
  }, [rawNodes, rawEdges, shouldAnimate]);

  const activityNodes = useMemo(() => rfNodes.map((node) => {
    if (node.type !== "rigNode") return node;
    const data = node.data as TopologyActivityBaseline;
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        activityRing: topologyActivity.getNodeActivity(node.id, data),
        reducedMotion,
        // OPR.0.4.6.MH2 rev1-r2 B1: rides the same enrichment channel as
        // reducedMotion so RigNode stays hook-free (standalone harnesses
        // need no QueryClientProvider).
        remoteReadonly: graphIsRemote,
      },
    };
  }), [rfNodes, topologyActivity, reducedMotion, graphIsRemote]);

  const activityEdges = useMemo(
    () => applyHotPotatoEdges(rfEdges, topologyActivity.packets, { reducedMotion }),
    [rfEdges, topologyActivity.packets, reducedMotion],
  );

  // V1 polish slice Phase 5.1 P5.1-2 + DRIFT P5.1-D2: graph node click
  // navigates to /topology/seat/$rigId/$logicalId center page (matches
  // Explorer tree click + table row click contract). Replaces legacy
  // setSelection({type:'seat-detail'}) drawer-open behavior. The
  // useNodeSelection alias is fully retired post-Phase 5.1.
  const navigate = useNavigate();

  const onNodeClick: NodeMouseHandler = useCallback(
    async (_event, node) => {
      if (!rigId) return;

      if (node.type === "podGroup" || node.type === "group") {
        // Phase 4 P4-5: 'rig' kind retired from DrawerSelection;
        // pod-group click is a no-op at the graph level (pods open
        // via Explorer tree's /topology/pod/$rigId/$podName link).
        return;
      }

      const nodeData = node.data as {
        logicalId: string;
        binding: { cmuxSurface?: string | null } | null;
      };

      // V1 polish slice Phase 5.1 P5.1-2: navigate to center page
      // (canonical agent-detail = LiveNodeDetails). Parity with Explorer
      // tree click + topology table row click (P5.1-7).
      navigate({
        to: "/topology/seat/$rigId/$logicalId",
        params: { rigId, logicalId: encodeURIComponent(nodeData.logicalId) },
      });

      if (graphIsRemote) {
        return;
      }

      if (!nodeData.binding?.cmuxSurface) {
        showFocusMessage({ text: "Not bound to cmux surface", type: "info" });
        return;
      }

      try {
        const res = await fetch(
          `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeData.logicalId)}/focus`,
          { method: "POST" }
        );

        if (!res.ok) {
          showFocusMessage({ text: "Focus failed", type: "error" });
          return;
        }

        const result = await res.json();

        if (result.ok === false && result.code === "unavailable") {
          showFocusMessage({ text: "cmux not connected", type: "error" });
        } else if (result.ok) {
          showFocusMessage({ text: "Focused", type: "success" });
        } else {
          showFocusMessage({ text: "Focus failed", type: "error" });
        }
      } catch {
        showFocusMessage({ text: "Focus failed", type: "error" });
      }
    },
    [rigId, navigate, showFocusMessage, graphIsRemote]
  );

  if (rigId === null) {
    return <div className="p-spacing-6 text-foreground-muted">No rig selected</div>;
  }

  if (loading) {
    return (
      <div className="p-spacing-6" data-testid="graph-loading">
        <div className="h-8 w-48 animate-pulse-tactical mb-spacing-4" />
        <div className="h-64 animate-pulse-tactical" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-spacing-6">
        <Alert data-testid="graph-error">
          <AlertDescription>Error: {error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (activityNodes.length === 0) {
    return <EmptyTopologyGhost />;
  }

  return (
    <div
      className="w-full h-full relative"
      data-testid="graph-view"
      data-animated={shouldAnimate ? "true" : "false"}
    >
      {/* Registration marks on canvas */}
      <div className="absolute top-4 left-4 w-3 h-3 reg-mark"><div className="reg-tl" /></div>
      <div className="absolute top-4 right-4 w-3 h-3"><div className="reg-tr" /></div>
      <div className="absolute bottom-4 left-4 w-3 h-3"><div className="reg-bl" /></div>
      <div className="absolute bottom-4 right-4 w-3 h-3"><div className="reg-br" /></div>

      {reconnecting && (
        <div className="absolute top-spacing-4 right-spacing-4 z-20">
          <Alert>
            <AlertDescription className="text-warning">Live updates disconnected from daemon - reconnecting...</AlertDescription>
          </Alert>
        </div>
      )}
      {focusMessage && (
        <div className={`absolute top-spacing-4 left-spacing-4 z-20 px-spacing-4 py-spacing-2 font-mono text-[10px] border ${
          focusMessage.type === "success" ? "bg-surface-lowest border-on-surface text-on-surface" :
          focusMessage.type === "error" ? "bg-tertiary/10 border-tertiary text-tertiary" :
          "bg-surface-lowest border-outline-variant text-on-surface-variant"
        }`}>
          {focusMessage.text}
        </div>
      )}
      <ReactFlow
        nodes={activityNodes}
        edges={activityEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        selectionOnDrag={false}
        panOnDrag
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
        className="relative z-10"
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Controls />
      </ReactFlow>
    </div>
  );
}
