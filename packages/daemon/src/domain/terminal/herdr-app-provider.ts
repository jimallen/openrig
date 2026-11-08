// hc cutover W37: the `herdr` terminal provider for `rig terminal open`, driving the Herdr desktop APP through `herdr-app`.
//
// What was broken (live-pi-hc-20261101.md 4b, read at hc-cutover 8f33ecf3): the daemon's only provider was HerdrAdapter, which
// speaks the control socket of the OLD herdr multiplexer (`<home>/.config/herdr/herdr.sock`). The new app does not listen
// there, so every `rig terminal open --provider herdr` answered `herdr_unavailable` ("herdr control socket is not answering
// ping") however many seats were live. The composer was already moved to `hc attach` panes; the provider under it was not.
//
// What it does now (decision row 20: `rig terminal open` opens SEPARATE VIEWERS, rig-here places seats). Each page of the
// composed view becomes one tab of a new space, its panes the composer's own `hc attach` commands. A viewer is a pane
// running `hc attach`; closing it leaves the seat running (spike 1.4), so nothing here parks or kills a seat. The commands
// are the app's own (`herdr-app do space.new | tab.new | pane.split | tab.select`, `herdr-app ls`), the ones rig-here uses
// (measured there on herdr-app 0.1.10) and the app's embedded guide lists.
//
// Not rig-here's names: rig-here owns spaces named `rig:<rig>` and CLOSES a second space of that name. A view opens in a
// space named after the view (`view:<id>`), never `rig:`, so neither reconcile touches the other's tabs.
//
// Each open is fresh and not idempotent (decision row 20: "stays non-idempotent, as today").
//
// UNVERIFIED (needs a real app, which this piece never starts): that `herdr-app do tab.new` accepts `["sh","-c",<command>]`
// as `argv` and runs it as written. The old adapter passed the same shape to the old multiplexer; rig-here passes a plain
// argv. The proof here is a fake `herdr-app` that records the calls, and a private hc core that runs the recorded argv.

import { execFile } from "node:child_process";
import type { AppLs, AppPort } from "../../adapters/hc-placement.js";
import type {
  AbsentSeat, ComposedPane, ComposedView, DegradedSeat, OpenViewResult, ProviderLiveness, ProviderStatus, TerminalProvider,
} from "./terminal-provider.js";

/** Herdr lays out 4x4 per tab (OPR.0.6.0.8); the same page size the composer used for the old provider. */
export const HERDR_APP_PANES_PER_PAGE = 16;

/** The sentinel host for a pane the app itself failed to make (the old adapter's name for it, kept for the CLI's wording). */
const SURFACE_HOST = "herdr";

/** rig-here `balanced_splits`: the splits that show `count` panes evenly, as (pane to split, direction, new pane), panes
 *  numbered by position. Each split halves its pane, so halving the seats in turn, right then down, keeps them even; one
 *  after the other leaves slivers (measured in rig-here: 32x7). Seven panes: two rows, the wide pane bottom left. */
export function balancedSplits(count: number): Array<{ pane: number; direction: "right" | "down"; new: number }> {
  const plan: Array<{ pane: number; direction: "right" | "down"; new: number }> = [];
  const place = (first: number, end: number, direction: "right" | "down"): void => {
    const size = end - first;
    if (size < 2) return;
    const half = direction === "right" ? Math.floor(size / 2) : Math.floor((size + 1) / 2);
    plan.push({ pane: first, direction, new: first + half });
    const turn = direction === "right" ? "down" : "right";
    place(first, first + half, turn);
    place(first + half, end, turn);
  };
  place(0, count, "right");
  return plan;
}

/** `herdr-app` did not answer: no window is open (it exits non-zero and starts nothing), or the program is absent. `fix` is
 *  what the operator can do about THIS cause, written for the host the daemon runs on: a machine without the app cannot
 *  "start" it, and one with no desktop session cannot show it. */
export class HerdrAppUnavailableError extends Error {
  constructor(message: string, readonly fix?: string) { super(message); }
}

const FIX_NOT_INSTALLED = "Install the Herdr app on the daemon's host and open it, or, from a terminal on that host, attach to a seat with its `hc attach` command.";
const FIX_NOT_RUNNING = "Open the Herdr app on that machine's desktop, then run this again; with no desktop session, attach to a seat from a terminal on that host with its `hc attach` command.";
/** `herdr-app do <command>` answered an error, or something that is not JSON. */
export class HerdrAppCommandError extends Error {}

export interface HerdrAppExec {
  (file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;
}

const nodeExec: HerdrAppExec = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) return resolve({ code: 0, stdout, stderr });
    const e = err as NodeJS.ErrnoException & { code?: number | string };
    if (e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
    resolve({ code: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "" });
  });
});

const APP_TIMEOUT_MS = 30_000;

/** The real `AppPort`: `herdr-app ls` and `herdr-app do <command> <json>`. The binary is the daemon's own resolution of
 *  `herdr-app` (an absolute path), or a bare name left to PATH. Never starts the app: `ls` exits non-zero when no window is open.
 *  `timeoutMs` bounds each call (default 30 s; the seat host passes 2 s, OF-281). */
export function createHerdrAppCli(binary = "herdr-app", exec: HerdrAppExec = nodeExec, timeoutMs: number = APP_TIMEOUT_MS): AppPort {
  return {
    async ls(): Promise<AppLs> {
      const out = await exec(binary, ["ls"], timeoutMs);
      if (out.missing) throw new HerdrAppUnavailableError("herdr-app is not installed", FIX_NOT_INSTALLED);
      if (out.code !== 0) throw new HerdrAppUnavailableError("the Herdr app is not running (herdr-app ls found no window)", FIX_NOT_RUNNING);
      try {
        const parsed: unknown = JSON.parse(out.stdout);
        if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { spaces?: unknown }).spaces)) return parsed as AppLs;
      } catch { /* falls through */ }
      throw new HerdrAppCommandError("herdr-app ls answered something unreadable");
    },
    async do(command, args): Promise<Record<string, unknown>> {
      const out = await exec(binary, ["do", command, JSON.stringify(args)], timeoutMs);
      if (out.missing) throw new HerdrAppUnavailableError("herdr-app is not installed", FIX_NOT_INSTALLED);
      let body: unknown = {};
      try { body = JSON.parse(out.stdout); } catch { /* an error answer need not be JSON */ }
      const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      if (out.code !== 0 || body === null || typeof body !== "object" || Array.isArray(body) || error) {
        throw new HerdrAppCommandError(`herdr-app do ${command} failed: ${(typeof error === "string" ? error : `${out.stdout}${out.stderr}`).trim().slice(0, 200)}`);
      }
      return body as Record<string, unknown>;
    },
  };
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export class HerdrAppProvider implements TerminalProvider {
  readonly name = "herdr";
  readonly panesPerPage = HERDR_APP_PANES_PER_PAGE;

  constructor(private readonly app: AppPort) {}

  async status(): Promise<ProviderStatus> {
    const live = await this.liveness();
    return { provider: this.name, available: live.alive, capabilities: { app: live.alive, "space.new": live.alive, "pane.split": live.alive } };
  }

  /** Alive means a window answers `herdr-app ls`; the app is never started to find out. */
  async liveness(): Promise<ProviderLiveness> {
    try {
      await this.app.ls();
      return { alive: true };
    } catch (err) {
      return { alive: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    const absent: AbsentSeat[] = [...view.absent];
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];
    try {
      await this.app.ls();
    } catch (err) {
      return {
        provider: this.name, ok: false, opened, absent, degraded, pages: 0, code: "herdr_unavailable",
        error: `${err instanceof Error ? err.message : String(err)}; nothing was opened. ${(err instanceof HerdrAppUnavailableError ? err.fix : undefined) ?? "Start the Herdr app, then run this again."}`,
      };
    }
    if (view.pages.length === 0) return { provider: this.name, ok: view.opened.length === 0, opened, absent, degraded, pages: 0 };

    const notes: string[] = [];
    const base = view.spaceLabel ?? `view:${view.id}`;
    let space: string | null = null;
    const tabs: string[] = [];
    for (let index = 0; index < view.pages.length; index++) {
      const page = view.pages[index]!;
      // A named view (the default kernel view) names its tabs for what they show: "dashboard · operator". Others: "view", "view 2".
      const tabName = view.spaceLabel ? page.map((pane) => pane.label).join(" · ") : view.pages.length === 1 ? "view" : `view ${index + 1}`;
      const made = await this.makeTab(page, space, base, tabName, degraded, opened, notes);
      if (made) {
        space = made.space;
        tabs.push(made.tab);
      }
    }
    // A new tab takes the focus (rig-here, measured), so land on the first page's tab once all exist.
    if (space !== null && tabs.length > 1) {
      try { await this.app.do("tab.select", { id: tabs[0] }); }
      catch (err) { notes.push(`the app did not focus the first tab: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // Splits make panes out of reading order; the result lists seats in the composed view's order, as every provider did.
    const place = new Map(view.opened.map((pane, i) => [pane.seat, i]));
    opened.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0));
    return {
      provider: this.name, ok: opened.length > 0 || view.opened.length === 0, opened, absent, degraded, pages: tabs.length,
      ...(notes.length ? { notes } : {}),
    };
  }

  /** One page as one tab: the first pane starts it, the others are splits in `balancedSplits` order. A pane the app
   *  refuses degrades that seat alone and the page goes on. Returns null when the tab itself could not be made. */
  private async makeTab(
    page: ComposedPane[], space: string | null, spaceName: string, tabName: string,
    degraded: DegradedSeat[], opened: string[], notes: string[],
  ): Promise<{ space: string; tab: string } | null> {
    const fail = (pane: ComposedPane, err: unknown): void => {
      degraded.push({ seat: pane.seat, host: SURFACE_HOST, reason: `herdr-app could not open the pane: ${err instanceof Error ? err.message : String(err)}` });
    };
    const argvOf = (pane: ComposedPane): string[] => ["sh", "-c", pane.paneCommand];
    const lead = page[0];
    if (!lead) return null;
    let made: Record<string, unknown>;
    try {
      made = space === null
        ? await this.app.do("space.new", { name: spaceName, tab: tabName, argv: argvOf(lead) })
        : await this.app.do("tab.new", { name: tabName, space, argv: argvOf(lead) });
    } catch (err) {
      for (const pane of page) fail(pane, err);
      return null;
    }
    const madeSpace = text(made["space"]) ?? space;
    const tab = text(made["tab"]);
    const terminal = text(made["terminal"]);
    if (madeSpace === null || tab === null || terminal === null) {
      for (const pane of page) fail(pane, new Error("the app's answer named no space, tab and terminal"));
      return null;
    }
    opened.push(lead.seat);
    if (page.length > 1) {
      const panes = new Map<number, string>();
      try {
        const found = (await this.app.ls()).spaces.flatMap((s) => s.tabs).flatMap((t) => t.terminals).find((t) => t.terminal === terminal);
        if (!found) throw new Error(`herdr-app ls does not show the new terminal ${terminal}`);
        panes.set(0, found.pane);
      } catch (err) {
        for (const pane of page.slice(1)) fail(pane, err);
        return { space: madeSpace, tab };
      }
      for (const split of balancedSplits(page.length)) {
        const target = page[split.new]!;
        const from = panes.get(split.pane);
        if (from === undefined) { fail(target, new Error("the pane to split was not made")); continue; }
        try {
          const answered = await this.app.do("pane.split", { direction: split.direction, pane: from, argv: argvOf(target) });
          const pane = text(answered["pane"]);
          if (pane === null) throw new Error("the app's answer named no pane");
          panes.set(split.new, pane);
          opened.push(target.seat);
        } catch (err) {
          fail(target, err);
        }
      }
    }
    return { space: madeSpace, tab };
  }
}
