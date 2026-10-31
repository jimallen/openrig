// OPR.0.4.6.02 C2 — the PURE view composer.
//
// Turns a resolved list of view members into a provider-neutral `ComposedView`
// (`{ opened, absent, degraded, pages }`, BR-6 honest-partial). All of the
// partition rules live here, in one testable pure function, so no provider
// re-implements them:
//
//   local live       → `hc attach -- <terminal>` (hc = the daemon-resolved
//                      absolute path when the context carries one)
//   view-only / cross-rig (read-only)
//                    → `hc attach --observe -- <terminal>`
//   ssh host         → `hc attach [--observe] -- <machine>/<terminal>`: the
//                      host id names the hc machine (design section 13)
//   http host        → NO pane; honest-degrade { seat, host, reason }
//   dead / no terminal → absent[] (named, never silently dropped)
//
// Size (measured on a private hc 0.1.15 core, 2026-10-31): a plain `hc attach` resizes the
// program to the attaching terminal at once, with no key typed, and the program goes back to
// its creation size (200x120) when the last viewer leaves. `--observe` never resizes and never
// types. So a read-only pane is an observer, and a writable pane is the person's seat: it takes
// the size of the tile it runs in, and with two writable viewers the last to attach wins.
//
// The composer takes members that already carry a STRUCTURED `host` field (a
// host id, never a `member@rig@host` string — MH BR-1). Host classification
// (ssh vs http vs unknown) is resolved through the operator's read-only hosts
// registry via the injected `resolveHost`.

import { hcTerminalName } from "../../adapters/hc-seat.js";
import type { HostEntry } from "../hosts/hosts-registry-reader.js";
import type {
  AbsentSeat,
  ComposedPane,
  ComposedView,
  DegradedSeat,
} from "./terminal-provider.js";

/**
 * Default panes per grid page (3×3), used when a provider declares no page size
 * of its own (cmux). Herdr declares 16 (4×4). Overflow spills to the next
 * provider tab/page. A future per-rig `terminal.tiles_per_page` config key is the
 * natural seam for a layout choice; no config key ships here.
 */
export const PANES_PER_PAGE = 9;

/**
 * One resolved member of a view, ready to compose. `alive` and `readOnly` are
 * decided upstream (liveness probe + cross-rig/saved-read-only policy); the
 * composer only routes on them. `host` is a structured host id or null (local).
 */
export interface ViewMemberInput {
  /** Canonical session name of the seat. */
  seat: string;
  /** Runtime recorded for a live seat; absent for saved members without inventory data. */
  runtime?: string | null;
  /** Pane label — `<agent> · <slice>` (AC-7). */
  label: string;
  /**
   * The seat's session name as the host knows it (the canonical name; `deriveViewMembers` and `savedMemberToInput` fill it so,
   * and `hasSession` asks about it); null if the seat has none. It is NOT the hc terminal name: the composer attaches to
   * `hcTerminalName(tmuxSession)`, because hc refuses a canonical name such as `verify-qa@eztrack` as a terminal name.
   * The field keeps its tmux-era name until the callers that fill it are renamed with it.
   */
  tmuxSession: string | null;
  /** Structured host id when remote; null for a local seat. */
  host: string | null;
  /** View-only / cross-rig membership → read-only (`-r`) attach. */
  readOnly: boolean;
  /** Local liveness (has-session). Ignored for remote members (reachability is an ssh concern). */
  alive: boolean;
}

/** The composer's only side-channel: read-only host resolution from the registry. */
export interface ComposeContext {
  /** Resolve a host id to its registry entry, or null if the id is unknown. */
  resolveHost(id: string): HostEntry | null;
  /** Panes per page for the target provider; defaults to PANES_PER_PAGE. */
  panesPerPage?: number;
  /**
   * Absolute path of the hc executable the daemon resolves, so a provider started with a narrower
   * PATH can still run the attach (#707, now for hc). Absent → the bare `hc` token. Used for every
   * pane: a remote member also attaches through the local hc, which forwards over its machine link.
   */
  localHc?: string;
  /** @deprecated tmux is gone; ignored. Kept only so terminal-service.ts, which still passes it, compiles until it is rewired. */
  localTmux?: string;
  /** @deprecated tmux is gone; ignored (see localTmux). */
  localTmuxServer?: readonly string[];
}

/** POSIX single-quote a string so session names / targets are shell-inert in the composed command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** Chunk panes into fixed-size grid pages (one provider tab per page). */
export function chunkPanes(
  panes: ComposedPane[],
  perPage: number = PANES_PER_PAGE,
): ComposedPane[][] {
  if (perPage < 1) throw new Error(`chunkPanes: perPage must be >= 1 (got ${perPage})`);
  const pages: ComposedPane[][] = [];
  for (let i = 0; i < panes.length; i += perPage) {
    pages.push(panes.slice(i, i + perPage));
  }
  return pages;
}

/**
 * Compose a resolved member list into a provider-neutral view. Pure: same
 * inputs → byte-identical output. Member order is preserved into `opened`
 * (and therefore into page assignment), so paging is deterministic.
 */
export function composeView(
  id: string,
  members: ViewMemberInput[],
  ctx: ComposeContext,
): ComposedView {
  const opened: ComposedPane[] = [];
  const absent: AbsentSeat[] = [];
  const degraded: DegradedSeat[] = [];
  const hc = ctx.localHc ? shellQuote(ctx.localHc) : "hc";

  for (const m of members) {
    // `--` ends options, so a terminal or machine name that starts with `-` stays a name (measured:
    // `hc attach -- -x` looks the terminal up as "-x").
    const attach = (target: string) => `${hc} attach ${m.readOnly ? "--observe " : ""}-- ${shellQuote(target)}`;

    if (m.host !== null) {
      // Remote member: classify by the registry entry's transport.
      const host = ctx.resolveHost(m.host);
      if (!host) {
        // Unknown host id is a config gap, not a live seat — degrade named,
        // never a silent omission.
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `host ${m.host} is not in the hosts registry`,
        });
        continue;
      }
      if (host.transport === "http") {
        // http hosts speak daemon REST, not interactive ssh panes — the tile
        // surface needs ssh. Honest-degrade, R1(a).
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `host ${m.host} is http-registered; tiles need ssh`,
        });
        continue;
      }
      // ssh host: a seat with no recorded terminal cannot be attached.
      if (!m.tmuxSession) {
        absent.push({
          seat: m.seat,
          host: m.host,
          reason: "no hc terminal recorded for this seat",
        });
        continue;
      }
      // The host id is the hc machine name (`hc machine add --name <id>`); that mapping is
      // not read from `hc machine ls` yet (unverified for any registry whose ids differ).
      opened.push({
        seat: m.seat,
        ...(m.runtime ? { runtime: m.runtime } : {}),
        label: m.label,
        paneCommand: attach(`${m.host}/${hcTerminalName(m.tmuxSession)}`),
        readOnly: m.readOnly,
      });
      continue;
    }

    // Local member.
    if (!m.tmuxSession) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: "no hc terminal recorded for this seat",
      });
      continue;
    }
    if (!m.alive) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: `hc terminal ${m.tmuxSession} is not alive`,
      });
      continue;
    }
    opened.push({
      seat: m.seat,
      ...(m.runtime ? { runtime: m.runtime } : {}),
      label: m.label,
      paneCommand: attach(hcTerminalName(m.tmuxSession)),
      readOnly: m.readOnly,
    });
  }

  return { id, opened, absent, degraded, pages: chunkPanes(opened, ctx.panesPerPage ?? PANES_PER_PAGE) };
}
