// workspaces-o9o.4 — the reported symptom (verify-sec@eztrack diagnosis, 2026-11-16): the seat read "working" through a 20-minute tool call,
// with nothing to tell a hung tool from a long one. The daemon's seat posture now names an open tool call (`tool`, and `at` its start).
// These rows feed that served shape through the TUI's real hydrate path (a fake daemon on the node route) and render it the way the TUI does,
// on a render clock far from wall clock.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stripAnsi } from "../src/theme.js";
import { postureClock } from "../src/time.js";
import type { FleetSnapshot, ViewState } from "../src/types.js";

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const RIG = "eztrack";
const SEAT = "verify.sec";
const START = Date.parse("2031-03-04T16:05:41.008Z");
const MIN = 60_000;

type Posture = { kind: string; source: string | null; at: string | null; tool: string | null; toolStartedAt: string | null; toolConfirmed: boolean; otherOpenCalls: number; line: string };

function fixture(seatPosture: Posture | undefined) {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  const node = {
    logicalId: SEAT, podNamespace: "verify", nodeKind: "agent", runtime: "claude-code", lifecycleState: "running", sessionStatus: "running",
    canonicalSessionName: `verify-sec@${RIG}`, resolvedSpecName: null,
    activityState: { activity: "working", display: "working", needsInput: { count: 0, reason: null }, decidedBy: "activity oracle" },
    ...(seatPosture ? { seatPosture } : {}),
  };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/queue/list" || u.pathname === "/api/queue/human-updates") return app.request(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/rigs/summary") return Response.json([{ id: `${RIG}-id`, name: RIG, lifecycleState: "running" }]);
    if (u.pathname === `/api/rigs/${RIG}-id/nodes`) return Response.json([node]);
    if (u.pathname === "/api/queue/recent-transitions" || u.pathname === "/api/specs/library") return Response.json([]);
    if (u.pathname === "/api/health") return Response.json({ schema: "openrig.health-list/v0alpha1", total: 0, limit: 200, records: [], truncated: false, evaluatedAt: null });
    throw Error(`Unexpected fixture route ${u.pathname}`);
  }) as typeof fetch });
  const context = (scope: "rig" | "agent") => ({ section: "topology", viewTab: "table", drill: [
    { kind: "host", name: "fixture" }, { kind: "rig", name: RIG }, { kind: "pod", name: "verify" },
    ...(scope === "agent" ? [{ kind: "agent", name: SEAT }] : []),
  ] }) as ViewState;
  const read = (scope: "rig" | "agent") => hydrateSnapshot(client, undefined, null, null, RIG, context(scope));
  const render = (snap: FleetSnapshot, scope: "rig" | "agent", nowMs: number, cols = 160) => {
    const state = { ...createViewState({ instanceId: "fixture", getSnapshot: () => snap }).get(), ...context(scope) };
    return renderScreen(state, snap, { cols, rows: 100, nowMs }).lines.map(stripAnsi);
  };
  return { read, render };
}

const S = new Date(START).toISOString();
const busy: Posture = { kind: "busy", source: "runtime_hook", at: S, tool: "Bash", toolStartedAt: S, toolConfirmed: true, otherOpenCalls: 0, line: "busy: running Bash for 3 min (since 16:05Z)" };
const open: Posture = { kind: "unknown-open-turn", source: "runtime_hook", at: S, tool: "Bash", toolStartedAt: S, toolConfirmed: false, otherOpenCalls: 0, line: "unknown: Bash started 16:05Z, 20 min ago, no end recorded" };
const turn: Posture = { kind: "busy", source: "runtime_hook", at: S, tool: null, toolStartedAt: null, toolConfirmed: false, otherOpenCalls: 0, line: "busy: turn running, last hook PostToolUse 16:05Z" };
// verify-qa F1: busy from hc status (run-level) with an open call no hook confirms; the daemon serves toolConfirmed false.
const hcBusy: Posture = { kind: "busy", source: "hc_status", at: new Date(START - 1_000).toISOString(), tool: "Bash", toolStartedAt: S, toolConfirmed: false, otherOpenCalls: 0,
  line: "busy: working since 16:05Z (hc status); Bash started 16:05Z, 66 min ago, no end recorded" };
const twoOpen: Posture = { ...busy, otherOpenCalls: 1, line: "busy: running Bash for 3 min (since 16:05Z) +1 more" };

const seatRow = (lines: string[]) => lines.filter((l) => l.includes("sec") && l.includes("working"));

describe("the seat table names the running tool and how long it has run (workspaces-o9o.4)", () => {
  it("a seat 20 minutes into a Bash call reads ⚙ Bash 20m?, not a bare working (the hooks have not confirmed it for 15 min)", async () => {
    const f = fixture(open);
    const rows = seatRow(f.render(await f.read("rig"), "rig", START + 20 * MIN));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("⚙ Bash 20m?");
  });

  it("a confirmed call has no question mark, and the age follows the render clock", async () => {
    const f = fixture(busy);
    const snap = await f.read("rig");
    expect(seatRow(f.render(snap, "rig", START + 45_000))[0]).toContain("⚙ Bash 45s");
    expect(seatRow(f.render(snap, "rig", START + 3 * MIN))[0]).toContain("⚙ Bash 3m");
    expect(seatRow(f.render(snap, "rig", START + 3 * MIN))[0]).not.toContain("3m?");
    expect(seatRow(f.render(snap, "rig", START + 125 * MIN))[0]).toContain("⚙ Bash 2h 5m");
  });

  it("verify-qa F1: busy from hc status does not confirm the call: the question mark stays", async () => {
    const f = fixture(hcBusy);
    const row = seatRow(f.render(await f.read("rig"), "rig", START + 66 * MIN))[0]!;
    expect(row).toContain("⚙ Bash 66m?");
  });

  it("two calls open: the oldest, then +1", async () => {
    const f = fixture(twoOpen);
    expect(seatRow(f.render(await f.read("rig"), "rig", START + 3 * MIN))[0]).toContain("⚙ Bash 3m +1");
  });

  it("no open call (a turn running between tools) and no posture at all: no tool cell", async () => {
    for (const posture of [turn, undefined]) {
      const f = fixture(posture);
      const rows = seatRow(f.render(await f.read("rig"), "rig", START + 3 * MIN));
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toContain("⚙");
    }
  });

  it("without a render clock the tool is named with no age, never a made-up one", async () => {
    const f = fixture(busy);
    const row = seatRow(f.render(await f.read("rig"), "rig", 0))[0]!;
    expect(row).toContain("⚙ Bash");
    expect(row).not.toMatch(/⚙ Bash \d/);
  });

  it.each([84, 120, 160])("at %i columns no line overflows", async (cols) => {
    const f = fixture(open);
    for (const line of f.render(await f.read("rig"), "rig", START + 20 * MIN, cols)) expect(line.length).toBeLessThanOrEqual(cols);
  });
});

describe("the agent detail says it in words (workspaces-o9o.4)", () => {
  it("a confirmed call: tool, running time and start; the daemon's posture line verbatim", async () => {
    const f = fixture(busy);
    const text = f.render(await f.read("agent"), "agent", START + 3 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · running 3m · since \S/);
    expect(text).toContain("posture: busy: running Bash for 3 min (since 16:05Z)");
  });

  // workspaces-o9o.32: the tool line is in the TUI's zone and the posture line beside it is the daemon's UTC text; the tool line also names the
  // instant in the posture line's own form, so the two read as one start.
  it("the tool line names its start in the TUI's zone and in the posture line's UTC form", async () => {
    const confirmed = fixture(busy);
    const text = confirmed.render(await confirmed.read("agent"), "agent", START + 3 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · running 3m · since 2031-03-04 08:05:41 PST \(16:05Z\)/);
    expect(text).toContain("posture: busy: running Bash for 3 min (since 16:05Z)");
    const unconfirmed = fixture(open);
    const later = unconfirmed.render(await unconfirmed.read("agent"), "agent", START + 20 * MIN).join("\n").replace(/\s+/g, " ");
    expect(later).toMatch(/tool: Bash · started 2031-03-04 08:05:41 PST \(16:05Z\), 20m ago · no end recorded/);
  });

  it("the UTC form: the time alone on the clock's UTC day, the date otherwise or with no clock, nothing for a value that is not a time", () => {
    expect(postureClock(S, START + 3 * MIN)).toBe("16:05Z");
    expect(postureClock(S, START + 9 * 60 * MIN)).toBe("03-04 16:05Z");
    expect(postureClock(S, 0)).toBe("03-04 16:05Z");
    expect(postureClock("not a time", START)).toBeNull();
    expect(postureClock(null, START)).toBeNull();
  });

  it("past the start's UTC day, the UTC form carries its date, as the posture line's does", async () => {
    const f = fixture(open);
    const text = f.render(await f.read("agent"), "agent", START + 9 * 60 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · started 2031-03-04 08:05:41 PST \(03-04 16:05Z\), 9h ago · no end recorded/);
  });

  it("an unconfirmed call: started, how long ago, and no end recorded", async () => {
    const f = fixture(open);
    const text = f.render(await f.read("agent"), "agent", START + 20 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · started \S.*, 20m ago · no end recorded/);
    expect(text).toContain("posture: unknown: Bash started 16:05Z, 20 min ago, no end recorded");
  });

  it("verify-qa F1: hc busy with an unconfirmed call reads started and no end recorded, not running", async () => {
    const f = fixture(hcBusy);
    const text = f.render(await f.read("agent"), "agent", START + 66 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · started \S.*, 66m ago · no end recorded/);
    expect(text).not.toMatch(/tool: Bash · running/);
  });

  it("two calls open: the detail says +1 more", async () => {
    const f = fixture(twoOpen);
    const text = f.render(await f.read("agent"), "agent", START + 3 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).toMatch(/tool: Bash · running 3m · since \S.* · \+1 more/);
  });

  it("no open call: no tool field, the posture line still shown", async () => {
    const f = fixture(turn);
    const text = f.render(await f.read("agent"), "agent", START + 3 * MIN).join("\n").replace(/\s+/g, " ");
    expect(text).not.toContain("tool:");
    expect(text).toContain("posture: busy: turn running, last hook PostToolUse 16:05Z");
  });
});
