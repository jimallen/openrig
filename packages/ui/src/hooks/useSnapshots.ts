import { useQuery } from "@tanstack/react-query";

export interface Snapshot {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  /** OF-117: set (with the reason) when the saved snapshot's data is damaged; it is listed but cannot be restored. */
  unreadable?: string;
}

async function fetchSnapshots(rigId: string): Promise<Snapshot[]> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSnapshots(rigId: string) {
  return useQuery({
    queryKey: ["rig", rigId, "snapshots"],
    queryFn: () => fetchSnapshots(rigId),
    enabled: !!rigId,
  });
}
