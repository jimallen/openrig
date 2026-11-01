// V1 attempt-3 Phase 3 — system status panel for Settings>Status tab.
// Per code-map AFTER tree (NEW). Composes daemon health + rig counts
// from existing data sources.

import { useQuery } from "@tanstack/react-query";
import { SectionHeader } from "../ui/section-header.js";
import { StatusPip } from "../ui/status-pip.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";

async function fetchHealth(): Promise<boolean> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return true;
}

export function SettingsSystemStatusPanel() {
  const healthQuery = useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: false,
  });

  const { data: rigs, isLoading: rigsLoading, error: rigsError } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const daemonConnected = healthQuery.isSuccess;
  const totalRigs = rigs?.length ?? 0;
  const runningRigs = psEntries?.filter((p) => p.runningCount > 0).length ?? 0;

  const daemonStatus: React.ComponentProps<typeof StatusPip>["status"] =
    daemonConnected
      ? "active"
      : healthQuery.isError
      ? "error"
      : healthQuery.isLoading
      ? "info"
      : "stopped";

  return (
    <div data-testid="settings-status-panel" className="space-y-4">
      <section>
        <SectionHeader tone="muted">Daemon</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">Reachable</span>
          <StatusPip
            status={daemonStatus}
            label={
              daemonConnected
                ? "OK"
                : healthQuery.isError
                ? "ERROR"
                : healthQuery.isLoading
                ? "LOADING"
                : "DISCONNECTED"
            }
            variant="pill"
            testId="status-daemon"
          />
        </div>
      </section>
      <section>
        <SectionHeader tone="muted">Rigs</SectionHeader>
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Total</span>
            <span className="text-on-surface font-bold" data-testid="status-rigs-total">{totalRigs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Running</span>
            <span className="text-on-surface font-bold" data-testid="status-rigs-running">{runningRigs}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
