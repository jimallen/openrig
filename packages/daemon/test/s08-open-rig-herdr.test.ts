// OPR.0.6.0.8 — open the whole rig in Herdr: 16 cells per tab. Rewritten for the app provider (hc cutover W40): the old
// adapter's workspace.create / layout.apply / starting-tab rules went with the old multiplexer. A real TerminalService and a
// real HerdrAppProvider over an AppPort fake that records the app commands.
import { describe, expect, it } from "vitest";
import type { AppLs, AppPort } from "../src/adapters/hc-placement.js";
import { HERDR_APP_PANES_PER_PAGE, HerdrAppProvider } from "../src/domain/terminal/herdr-app-provider.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";
import { PANES_PER_PAGE } from "../src/domain/terminal/view-composer.js";

const RIG = "big";
const rows = Array.from({ length: 17 }, (_, i) => {
  const s = `seat-${String(i + 1).padStart(2, "0")}@${RIG}`;
  return { canonicalSessionName: s, attachmentType: "hc" as const, tmuxSession: s, rigName: RIG, logicalId: `pod.s${i + 1}` };
});

function appFake(): { app: AppPort; commands: Array<{ command: string; args: Record<string, unknown> }> } {
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const spaces: AppLs["spaces"] = [];
  let seq = 0;
  return {
    commands,
    app: {
      ls: async () => ({ spaces: structuredClone(spaces) }),
      do: async (command, args) => {
        commands.push({ command, args });
        const id = ++seq;
        if (command === "space.new" || command === "tab.new") {
          let space = spaces.find((s) => s.id === args["space"]);
          if (!space) { space = { id: `sp${id}`, name: String(args["name"]), tabs: [] }; spaces.push(space); }
          space.tabs.push({ id: `tb${id}`, name: String(args["tab"] ?? args["name"]), terminals: [{ terminal: `t${id}`, pane: `pn${id}` }] });
          return { space: space.id, tab: `tb${id}`, terminal: `t${id}` };
        }
        return { pane: `pn${id}` };
      },
    },
  };
}

function service(provider: HerdrAppProvider, seats = rows): TerminalService {
  return new TerminalService({
    resolveProvider: (n) => (n === "herdr" ? provider : null),
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: (r) => (r === RIG ? seats : null),
    listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [RIG],
    resolveHost: () => null, hasSession: () => true,
  } as TerminalServiceDeps);
}

describe("S08 — the rig opens as one Herdr space, 16 cells per tab", () => {
  it("17 live seats: one space, a tab of 16 then a tab of 1, every seat once, the first tab selected last", async () => {
    const f = appFake();
    const result = await service(new HerdrAppProvider(f.app)).openView({ view: RIG });
    expect(result).toMatchObject({ ok: true, pages: 2, absent: [], degraded: [] });
    expect([...result.opened].sort()).toEqual(rows.map((r) => r.canonicalSessionName).sort());
    const count = (c: string) => f.commands.filter((x) => x.command === c).length;
    expect([count("space.new"), count("tab.new"), count("pane.split"), count("tab.select")]).toEqual([1, 1, 15, 1]);
    expect(f.commands.at(-1)!.command).toBe("tab.select");
    const attached = f.commands.filter((c) => c.command !== "tab.select").map((c) => (c.args["argv"] as string[])[2]!.match(/'(s-[0-9a-f]{24})'$/)![1]);
    expect(new Set(attached).size).toBe(17);
  });

  it("re-opening makes a second space (not idempotent, as before)", async () => {
    const f = appFake();
    const svc = service(new HerdrAppProvider(f.app), rows.slice(0, 2));
    await svc.openView({ view: RIG });
    await svc.openView({ view: RIG });
    expect(f.commands.filter((c) => c.command === "space.new")).toHaveLength(2);
  });
});

describe("S08 correction — catalog pages match the Herdr open", () => {
  const ten = rows.slice(0, 10);
  const saved = { id: "ten", name: "Ten", members: ten.map((r) => ({ seat: r.canonicalSessionName, tmuxSession: r.tmuxSession })) };
  function catalogService(batch: boolean): TerminalService {
    return new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? new HerdrAppProvider(appFake().app) : null),
      viewsStore: { get: (id) => (id === "ten" ? saved : null), list: () => [saved] },
      listRigSeats: (r) => (r === RIG ? ten : null),
      ...(batch ? { listRigSeatsBatch: (names: string[]) => new Map(names.map((n) => [n, n === RIG ? ten : []])) } : {}),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [RIG],
      resolveHost: () => null, hasSession: () => true,
    } as TerminalServiceDeps);
  }

  for (const batch of [false, true]) {
    it(`${batch ? "batch" : "fallback"} inventory: saved and derived entries show 1 page for 10 seats, like preview`, async () => {
      const svc = catalogService(batch);
      const views = await svc.listViews(true);
      const pages = Object.fromEntries((views.catalog ?? []).map((e) => [e.view, e.pages]));
      expect(pages).toEqual({ "saved:ten": 1, [`rig:${RIG}`]: 1 });
      const preview = await svc.previewView({ view: "saved:ten" }) as { composed: ComposedView };
      expect(preview.composed.pages).toHaveLength(1);
    });
  }
});

describe("S08 — the composer default page size", () => {
  it("stays 9 for a provider that declares none, while Herdr declares 16", () => {
    expect(PANES_PER_PAGE).toBe(9);
    expect(HERDR_APP_PANES_PER_PAGE).toBe(16);
    expect(new HerdrAppProvider(appFake().app).panesPerPage).toBe(16);
  });
});

describe("desktop Herdr app", () => {
  it.each([false, true])("status reports available=%s from whether a window answers", async (windowOpen) => {
    const app: AppPort = { ls: async () => { if (!windowOpen) throw new Error("no window"); return { spaces: [] }; }, do: async () => ({}) };
    expect(await new HerdrAppProvider(app).status()).toMatchObject({ provider: "herdr", available: windowOpen });
  });
});
