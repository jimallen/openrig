// workspaces-o9o.9 — the plain-text form of `GET /api/seat/queued/:seat` for `rig seat queued`. The daemon owns the reading (which rows
// are open, their order, the redaction); this only lays it out.

export interface QueuedItemView {
  id: string;
  sender: string;
  recordedAt: string;
  state: string;
  attempts: number;
  pauseReason?: string | null;
  lastRefusal?: string | null;
  previousOccupant?: string | null;
  redeliveryOf?: string | null;
  preview: string;
  bodyBytes?: number;
}

export interface QueuedListingView {
  seat: string;
  knownSeat: boolean;
  total: number;
  redaction?: string;
  items: QueuedItemView[];
}

function why(item: QueuedItemView): string {
  if (item.pauseReason) return `, paused: ${item.pauseReason}`;
  if (item.lastRefusal) return `, last refused: ${item.lastRefusal}`;
  return "";
}

function label(item: QueuedItemView): string {
  if (item.redeliveryOf) return `  [re-delivery of ${item.redeliveryOf}]`;
  if (item.previousOccupant) return `  [first sent to a previous occupant]`;
  return "";
}

export function formatQueuedListing(view: QueuedListingView): string[] {
  const items = Array.isArray(view.items) ? view.items : [];
  // An empty list from a name this host does not know is not "nothing queued": the name may be wrong, so it says so.
  const unknown = view.knownSeat === false ? " (seat unknown on this host)" : "";
  if (items.length === 0) {
    return [view.knownSeat === false
      ? `${view.seat}: seat unknown on this host; no messages are queued under that name. Check the name with rig ps --nodes.`
      : `${view.seat}: nothing queued.`];
  }
  const lines = [`${view.seat}${unknown}: ${view.total} queued, in delivery order (the first goes next)`];
  for (const item of items) {
    lines.push(`  ${item.id}  from ${item.sender}  ${item.recordedAt}  ${item.state}, ${item.attempts} attempt(s)${why(item)}${label(item)}`);
    lines.push(`    ${item.preview}`);
  }
  if (view.total > items.length) lines.push(`Showing ${items.length} of ${view.total}; pass --limit to see more.`);
  lines.push(`Previews are redacted (${view.redaction ?? "transcript"} policy). End one that will never arrive: rig seat cancel-message <seat> <id> --reason <text>`);
  return lines;
}
