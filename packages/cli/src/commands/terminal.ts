// OPR.0.4.6.02 C3 — the `rig terminal` command family (the TUI-1 opaque verb +
// the operator's terminal-provider-ride entry). Three subcommands, all hitting
// the ONE canonical daemon composer (`/api/terminal/...`):
//
//   rig terminal open <view> [--provider herdr] [--json]
//   rig terminal views [--json]
//   rig terminal status [--provider herdr] [--json]
//
// `<view>` resolves daemon-side: a rig name (per-rig derived) | `mission:<id>` |
// `slice:<id>` (derived) | a saved-view id. The result is the ONE shared
// `{ opened, absent, degraded }` partition, carried byte-identically here and
// in the route JSON (arch Q3).
//
// Exit semantics (PRD / arch Q3): a partial open WITH NAMES is a SUCCESS with
// disclosure → exit 0; a ZERO-pane open (nothing tiled: unknown view, provider
// down, every seat absent/degraded) → non-zero. `views`/`status` are always
// exit 0 unless the daemon is unreachable.

import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { measureHostingColumns } from "../terminal-columns.js";

export interface TerminalDeps extends StatusDeps {
  /** The width of the terminal the person is typing in (default: measured); undefined when unknown. */
  columns?: () => Promise<number | undefined>;
}

/** The one shared open-result shape (mirrors the daemon `OpenViewResult`). */
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
  notes?: string[];
}

// Opening applies pages through several bounded provider round trips; it is
// an operation, not a read that can share the client's five-second default.
const TERMINAL_OPEN_TIMEOUT_MS = 45_000;

async function withClient<T>(
  deps: TerminalDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

/** Print a plain daemon response (views/status). JSON = compact; human = pretty. */
function printResult(json: boolean, body: unknown, status: number): void {
  console.log(json ? JSON.stringify(body) : JSON.stringify(body, null, 2));
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

/** Human-format the honest-partial open result (opened/absent/degraded, each named). */
function humanOpen(r: OpenViewResult): string {
  const lines: string[] = [];
  const tiled = r.opened.length;
  lines.push(
    tiled > 0
      ? `Opened ${tiled} tile(s) in ${r.provider}${r.pages > 1 ? ` across ${r.pages} page(s)` : ""}.`
      : `No tiles opened in ${r.provider}.`,
  );
  if (r.error) lines.push(`  provider: ${r.error}${r.code ? ` (${r.code})` : ""}`);
  for (const seat of r.opened) lines.push(`  ● ${seat}`);
  for (const a of r.absent) lines.push(`  ○ ${a.seat} — absent: ${a.reason}`);
  for (const d of r.degraded) lines.push(`  ▲ ${d.seat} — skipped (${d.host}): ${d.reason}`);
  for (const n of r.notes ?? []) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

function printOpen(json: boolean, r: OpenViewResult, status: number): void {
  if (json) {
    console.log(JSON.stringify(r));
  } else {
    console.log(humanOpen(r));
  }
  if (status >= 400 || r.opened.length === 0) {
    process.exitCode = status >= 500 ? 2 : 1;
  }
}

export function terminalCommand(depsOverride?: TerminalDeps): Command {
  const cmd = new Command("terminal").description(
    "Open the OpenRig view and agent conversations in terminal tiles",
  ).addHelpText("after", "\nThe OpenRig TUI and operator (after install, and whenever the person wants their agents):\n  rig terminal open saved:kernel\n  Opens the view in the running Herdr app, one tab per page, each pane a viewer of a seat (hc attach).\n  Closing a viewer leaves its seat running. The app must already be open: nothing starts it.\n  Over headless SSH there is no app to show it in: give the exact attach command (hc attach -- <terminal>) for a new terminal.\n  Only if the app cannot open: rig tui --shared is the dashboard-only fallback.\n  On a desktop, the agent opens the view; it does not finish by printing a command to copy.\n");

  const getDeps = (): TerminalDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("open")
    .argument("<view>", "a rig name, mission:<id>, slice:<id>, or a saved-view id")
    .description("Open the view's live agents as viewer tiles in the running Herdr app")
    .option("--provider <name>", "the terminal provider (herdr, the default)")
    .option("--window", "Accepted for older callers and scripts: the view always opens in the running Herdr app, never in a new window")
    .option("--expected-plan <id>", "Open only if the view still matches this preview")
    .option("--json", "JSON output for agents")
    .action(async (view: string, opts: { provider?: string; json?: boolean; window?: boolean; expectedPlan?: string }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const columns = await (deps.columns ?? measureHostingColumns)().catch(() => undefined);
        const body = {
          view,
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.expectedPlan !== undefined ? { expectedPlan: opts.expectedPlan } : {}),
          ...(columns !== undefined && Number.isSafeInteger(columns) && columns > 0 ? { viewportColumns: columns } : {}),
        };
        const res = await client.post<OpenViewResult>("/api/terminal/open", body, { timeoutMs: TERMINAL_OPEN_TIMEOUT_MS, headers: terminalAuthHeaders() });
        if (!Array.isArray(res.data?.opened)) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        printOpen(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("views")
    .description("List saved views + the rigs openable as derived views")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/terminal/views");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("status")
    .description("Show terminal provider availability + liveness (doctor)")
    .option("--provider <name>", "restrict to one provider (herdr)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const path = opts.provider
          ? `/api/terminal/status?provider=${encodeURIComponent(opts.provider)}`
          : "/api/terminal/status";
        const res = await client.get<unknown>(path);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
