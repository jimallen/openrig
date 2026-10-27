import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";
import { damagedRowsIn, damagedRowsNotice, describeSavedRowRefusal, unreadableHeldIn } from "../src/lib/damaged-rows.js";
import { composeAttentionRollup, renderInstanceList, renderInstanceShow, renderStatus } from "../src/commands/workflow-render.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OF-136: the daemon serves a saved row with a damaged JSON column flagged `unreadable: [columns]` (OF-117). The CLI used to
 * print such a row as an ordinary one (a blank where the tags were). These pins run the real commands against a stubbed
 * daemon and read what a person sees: stdout unchanged, the damage named on stderr, no "healthy"/"proven empty" claim.
 */

interface Reply { status: number; data: unknown }

let out: string[];
let err: string[];

/** Exact key first, then a key ending in `*` that is a prefix of the request. */
function reply(routes: Record<string, Reply>, method: string, path: string): Reply {
  const exact = routes[`${method} ${path}`];
  if (exact) return exact;
  const wild = Object.keys(routes).find((k) => k.endsWith("*") && `${method} ${path}`.startsWith(k.slice(0, -1)));
  return (wild ? routes[wild] : undefined) ?? { status: 404, data: { error: `unrouted ${method} ${path}` } };
}

function deps(routes: Record<string, Reply>): StatusDeps {
  return {
    lifecycleDeps: {} as StatusDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (path: string) => reply(routes, "GET", path)),
      post: vi.fn(async (path: string) => reply(routes, "POST", path)),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
}

async function run(argv: string[], routes: Record<string, Reply>): Promise<void> {
  const d = deps(routes);
  const program = createProgram({ queueDeps: d, workflowDeps: d, watchdogDeps: d, seatDeps: d });
  program.exitOverride();
  await program.parseAsync(["node", "rig", ...argv]);
}

beforeEach(() => {
  out = []; err = [];
  vi.stubEnv("OPENRIG_SESSION_NAME", "");
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { err.push(String(chunk)); return true; });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

const stdout = () => out.join("\n");
const stderr = () => err.join("\n");

const GOOD_Q = { qitemId: "qitem-good", state: "pending", tags: ["a"] };
const BAD_Q = { qitemId: "qitem-bad-1111", state: "pending", tags: null, chainOfRecord: null, unreadable: ["tags", "chain_of_record"] };

describe("OF-136 queue / inbox / outbox lists name a damaged row", () => {
  const cases: Array<{ argv: string[]; route: string; noun: string }> = [
    { argv: ["queue", "list", "--json"], route: "GET /api/queue/list*", noun: "queue item" },
    { argv: ["queue", "overdue", "--all-rigs", "--json"], route: "GET /api/queue/overdue*", noun: "queue item" },
    { argv: ["queue", "undelivered", "--all-rigs", "--json"], route: "GET /api/queue/undelivered*", noun: "queue item" },
  ];
  for (const c of cases) {
    it(`${c.argv.slice(0, 2).join(" ")}: stdout is the daemon's list unchanged, stderr names the row, its columns and what to do`, async () => {
      const body = [GOOD_Q, BAD_Q];
      await run(c.argv, { [c.route]: { status: 200, data: body } });
      expect(stdout()).toBe(JSON.stringify(body));
      expect(stderr()).toContain("DAMAGED: 1 queue item could not be read in full");
      expect(stderr()).toContain("qitem-bad-1111: tags, chain_of_record not readable JSON");
      expect(stderr()).toContain("UNKNOWN, not \"none\"");
      expect(stderr()).toContain("Repair or remove the saved row");
      expect(stderr()).not.toContain("qitem-good");
      expect(process.exitCode).toBeUndefined();
    });
  }

  it("queue list (plain output): the pretty JSON is unchanged and the damage is still named", async () => {
    await run(["queue", "list"], { "GET /api/queue/list*": { status: 200, data: [BAD_Q] } });
    expect(stdout()).toBe(JSON.stringify([BAD_Q], null, 2));
    expect(stderr()).toContain("qitem-bad-1111");
  });

  it("queue whoami names a damaged row among the caller's recent active items", async () => {
    const body = { session: "me@r", asDestination: { pending: 2, inProgress: 0, blocked: 0, recent: [GOOD_Q, BAD_Q] }, asSource: { total: 0 } };
    await run(["queue", "whoami", "--session", "me@r", "--json"], { "GET /api/queue/whoami*": { status: 200, data: body } });
    expect(stdout()).toBe(JSON.stringify(body));
    expect(stderr()).toContain("qitem-bad-1111: tags, chain_of_record");
    expect(stderr()).not.toContain("qitem-good");
  });

  it("a list with no damaged row prints nothing extra (negative control)", async () => {
    await run(["queue", "list", "--json"], { "GET /api/queue/list*": { status: 200, data: [GOOD_Q] } });
    expect(stderr()).toBe("");
  });

  it("inbox-pending names a damaged inbox entry and says absorbing it is refused", async () => {
    const body = [{ inboxId: "inbox-bad", tags: null, unreadable: ["tags"] }, { inboxId: "inbox-ok", tags: [] }];
    await run(["queue", "inbox-pending", "dest@r", "--json"], { "GET /api/queue/inbox/pending*": { status: 200, data: body } });
    expect(stdout()).toBe(JSON.stringify(body));
    expect(stderr()).toContain("1 inbox entry could not be read in full");
    expect(stderr()).toContain("inbox-bad: tags");
    expect(stderr()).toContain("refuses to absorb it");
    expect(stderr()).not.toContain("inbox-ok");
  });

  it("outbox-list names a damaged outbox entry", async () => {
    const body = [{ outboxId: "out-bad", unreadable: ["tags", "guard_binding"] }];
    await run(["queue", "outbox-list", "me@r", "--json"], { "GET /api/queue/outbox/list*": { status: 200, data: body } });
    expect(stderr()).toContain("1 outbox entry could not be read in full");
    expect(stderr()).toContain("out-bad: tags, guard_binding");
  });
});

describe("OF-136 a refused action on a damaged row says so in words", () => {
  const refusal = {
    error: "Saved queue_items row qitem-bad-1111 is damaged: tags is not readable JSON. Repair or remove the row.",
    code: "saved_row_unreadable", table: "queue_items", rowId: "qitem-bad-1111", columns: ["tags"],
  };

  it("queue show: the 422 body stays on stdout, stderr says what, the consequence and what to do, exit 1", async () => {
    await run(["queue", "show", "qitem-bad-1111", "--json"], { "GET /api/queue/qitem-bad-1111": { status: 422, data: refusal } });
    expect(stdout()).toBe(JSON.stringify(refusal));
    expect(stderr()).toContain("The queue_items row qitem-bad-1111 is damaged: tags is not readable JSON.");
    expect(stderr()).toContain("Nothing was changed.");
    expect(stderr()).toContain("Repair or remove that saved row, then retry.");
    expect(process.exitCode).toBe(1);
  });

  it("queue claim: the same words (an action is refused, not retried as a guess)", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    await run(["queue", "claim", "qitem-bad-1111", "--json"], { "POST /api/queue/qitem-bad-1111/claim": { status: 422, data: refusal } });
    expect(stderr()).toContain("The queue_items row qitem-bad-1111 is damaged");
    expect(process.exitCode).toBe(1);
  });

  it("an ordinary 422 or 404 is not rewritten as a damaged-row refusal (negative control)", async () => {
    await run(["queue", "show", "qitem-x", "--json"], { "GET /api/queue/qitem-x": { status: 422, data: { error: "nope", code: "something_else" } } });
    expect(stderr()).not.toContain("damaged");
  });

  it("describeSavedRowRefusal needs the daemon's code, not just a 422-shaped body", () => {
    expect(describeSavedRowRefusal({ error: "x", table: "queue_items", rowId: "q", columns: ["tags"] })).toBeNull();
    expect(describeSavedRowRefusal(null)).toBeNull();
    expect(describeSavedRowRefusal(refusal)?.fact).toContain("qitem-bad-1111");
  });
});

describe("OF-136 workflow instances and specs", () => {
  const DAMAGED_INSTANCE = {
    instanceId: "WF-BAD", workflowName: "conveyor", status: "failed", createdAt: "2026-10-27T10:00:00.000Z",
    currentFrontier: [], currentStepId: null, hopCount: 3,
    unreadable: ["current_frontier_json"],
    // exactly what the daemon serves for it: a healthy-looking verdict kept only to preserve the shape
    deadline: { state: "healthy", evidence: null },
    unknowns: ["Saved current_frontier_json of instance WF-BAD is not readable JSON, so its frontier, packets and deadline are unknown (not empty)."],
  };
  const HEALTHY = { instanceId: "WF-OK", workflowName: "conveyor", status: "active", createdAt: "2026-10-27T10:00:00.000Z", currentStepId: "build", currentFrontier: ["Q1"], hopCount: 1, deadline: { state: "healthy", evidence: null } };

  it("workflow list: the row says DAMAGED with its columns, not 'failed' or a step, and the footer names it", async () => {
    await run(["workflow", "list"], { "GET /api/workflow/list": { status: 200, data: [DAMAGED_INSTANCE, HEALTHY] } });
    const bad = out.find((l) => l.includes("WF-BAD"))!;
    expect(bad).toContain("▲ DAMAGED (current_frontier_json)");
    expect(bad).not.toContain("▲ failed");
    expect(bad).toContain("(unknown)");
    expect(out.find((l) => l.includes("WF-OK"))).not.toContain("DAMAGED");
    expect(stderr()).toContain("DAMAGED: 1 workflow instance could not be read in full");
    expect(stderr()).toContain("WF-BAD: current_frontier_json");
  });

  it("workflow list --json: stdout is the daemon's body unchanged; stderr names the instance", async () => {
    await run(["workflow", "list", "--json"], { "GET /api/workflow/list": { status: 200, data: [DAMAGED_INSTANCE, HEALTHY] } });
    expect(stdout()).toBe(JSON.stringify([DAMAGED_INSTANCE, HEALTHY]));
    expect(stderr()).toContain("WF-BAD: current_frontier_json");
  });

  it("workflow status never says 'proven empty' while an instance is damaged, and offers no route/resume/abort for it", async () => {
    await run(["workflow", "status"], { "GET /api/workflow/list": { status: 200, data: [DAMAGED_INSTANCE, HEALTHY] } });
    expect(stdout()).not.toContain("proven empty");
    expect(stdout()).toContain("WF-BAD");
    expect(stdout()).toContain("damaged");
    expect(stdout()).toContain("do not route, resume or abort it");
    expect(stdout()).not.toContain("rig workflow route WF-BAD --to");
    expect(stdout()).not.toContain("rig workflow resume WF-BAD");
  });

  it("composeAttentionRollup: a damaged instance is one 'damaged' row; the healthy one is only counted", () => {
    const rollup = composeAttentionRollup([DAMAGED_INSTANCE, HEALTHY]);
    expect(rollup.attention).toHaveLength(1);
    expect(rollup.attention[0]).toMatchObject({ instanceId: "WF-BAD", classes: ["damaged"] });
    expect(renderStatus(rollup).join("\n")).not.toContain("proven empty");
    expect(rollup.counts).toMatchObject({ total: 2, failed: 1, active: 1 });
  });

  it("renderInstanceShow headlines a damaged instance before anything else", () => {
    const lines = renderInstanceShow(DAMAGED_INSTANCE);
    expect(lines[1]).toContain("▲ DAMAGED: saved current_frontier_json not readable JSON");
    expect(lines[1]).toContain("UNKNOWN, not empty or healthy");
    expect(lines[2]).toContain("Do not route, resume or abort it");
  });

  it("renderInstanceList: a readable instance renders exactly as before (no marker, step shown)", () => {
    const text = renderInstanceList([HEALTHY]).join("\n");
    expect(text).not.toContain("DAMAGED");
    expect(text).toContain("build");
  });

  it("workflow show on a damaged instance (daemon refuses, HTTP 422) says why and exits 1", async () => {
    const refusal = { error: "Saved workflow_instances row WF-BAD is damaged: current_frontier_json is not readable JSON. Repair or remove the row.", code: "saved_row_unreadable", table: "workflow_instances", rowId: "WF-BAD", columns: ["current_frontier_json"] };
    await run(["workflow", "show", "WF-BAD"], { "GET /api/workflow/WF-BAD": { status: 422, data: refusal } });
    expect(stderr()).toContain("The workflow_instances row WF-BAD is damaged: current_frontier_json is not readable JSON.");
    expect(stderr()).toContain("Nothing was changed.");
    expect(process.exitCode).toBe(1);
  });

  it("workflow specs --json: stdout is the daemon's body unchanged; stderr names the damaged spec", async () => {
    const body = { specs: [
      { name: "ok-spec", version: "1", isBuiltIn: false },
      { name: "bad-spec", version: "2", isBuiltIn: false, unreadable: ["steps_json"] },
    ] };
    await run(["workflow", "specs", "--json"], { "GET /api/workflow/specs": { status: 200, data: body } });
    expect(stdout()).toBe(JSON.stringify(body));
    expect(stderr()).toContain("1 workflow spec could not be read in full");
    expect(stderr()).toContain("bad-spec v2: steps_json");
    expect(stderr()).not.toContain("ok-spec");
  });

  it("a non-list marker on an instance still renders DAMAGED in the list and the rollup", () => {
    const odd = { ...DAMAGED_INSTANCE, unreadable: "frontier" } as unknown as Parameters<typeof renderInstanceList>[0][number];
    expect(renderInstanceList([odd]).join("\n")).toContain("▲ DAMAGED (frontier)");
    expect(composeAttentionRollup([odd]).attention[0]).toMatchObject({ classes: ["damaged"] });
  });

  it("workflow specs: a damaged spec is marked on its line and named on stderr", async () => {
    const specs = [
      { name: "ok-spec", version: "1", purpose: null, targetRig: null, coordinationTerminalTurnRule: "x", sourcePath: "/s/ok.yaml", cachedAt: "t", isBuiltIn: false },
      { name: "bad-spec", version: "2", purpose: null, targetRig: null, coordinationTerminalTurnRule: "x", sourcePath: "/s/bad.yaml", cachedAt: "t", isBuiltIn: false, unreadable: ["steps_json"] },
    ];
    await run(["workflow", "specs"], { "GET /api/workflow/specs": { status: 200, data: { specs } } });
    expect(out.find((l) => l.startsWith("bad-spec"))).toContain("▲ DAMAGED (steps_json)");
    expect(out.find((l) => l.startsWith("ok-spec"))).not.toContain("DAMAGED");
    expect(stderr()).toContain("1 workflow spec could not be read in full");
    expect(stderr()).toContain("bad-spec v2: steps_json");
  });
});

describe("OF-136 watchdog history and held outbox", () => {
  it("watchdog status names a history entry whose notes are unreadable", async () => {
    const body = { job: { jobId: "J1" }, recentHistory: [{ historyId: "H-bad", evaluationNotes: null, unreadable: ["evaluation_notes"] }, { historyId: "H-ok", evaluationNotes: {} }] };
    await run(["watchdog", "status", "J1", "--json"], { "GET /api/watchdog/J1/status": { status: 200, data: body } });
    expect(stdout()).toBe(JSON.stringify(body));
    expect(stderr()).toContain("1 watchdog history entry could not be read in full");
    expect(stderr()).toContain("H-bad: evaluation_notes");
    expect(stderr()).not.toContain("H-ok");
  });

  it("seat held-messages names damaged entries and the held rows listed under no seat", async () => {
    const body = { items: [{ outboxId: "held-1", unreadable: ["tags"] }], total: 1, unreadableHeld: ["held-9"] };
    await run(["seat", "held-messages", "dev@r", "--json"], { "GET /api/seat/held-messages/*": { status: 200, data: body } });
    expect(stdout()).toBe(JSON.stringify(body));
    expect(stderr()).toContain("held-1: tags");
    expect(stderr()).toContain("1 held outbox entry could not be read in full");
    expect(stderr()).toContain("held-9: guard_binding");
    expect(stderr()).toContain("listed under no seat");
  });
});

describe("OF-136 helpers", () => {
  it("damagedRowsIn reads the list from the body or a named key, and ignores an empty or non-list marker", () => {
    expect(damagedRowsIn([{ qitemId: "a", unreadable: ["tags"] }])).toEqual([{ id: "a", columns: ["tags"] }]);
    expect(damagedRowsIn({ items: [{ outboxId: "b", unreadable: ["tags"] }] }, "items")).toEqual([{ id: "b", columns: ["tags"] }]);
    expect(damagedRowsIn({ items: [{ outboxId: "b", unreadable: ["tags"] }] })).toEqual([]);
    // absent, null, "" and [] are readable; any other present marker is damage (fails toward showing)
    expect(damagedRowsIn([{ qitemId: "c", unreadable: [] }, { qitemId: "e" }, { qitemId: "f", unreadable: null }, { qitemId: "g", unreadable: "" }])).toEqual([]);
    expect(damagedRowsIn([{ qitemId: "d", unreadable: "tags" }])).toEqual([{ id: "d", columns: ["tags"] }]);
    expect(damagedRowsIn([{ qitemId: "h", unreadable: [""] }, { qitemId: "i", unreadable: true }, { qitemId: "j", unreadable: {} }]))
      .toEqual([{ id: "h", columns: ["unknown columns"] }, { id: "i", columns: ["unknown columns"] }, { id: "j", columns: ["unknown columns"] }]);
    expect(damagedRowsIn("nope")).toEqual([]);
  });

  it("a spec row is named by name and version", () => {
    expect(damagedRowsIn([{ name: "s", version: "3", unreadable: ["roles_json"] }])).toEqual([{ id: "s v3", columns: ["roles_json"] }]);
  });

  it("unreadableHeldIn lists ids as guard_binding damage; absent or malformed is none", () => {
    expect(unreadableHeldIn({ unreadableHeld: ["x", 4, "y"] })).toEqual([{ id: "x", columns: ["guard_binding"] }, { id: "y", columns: ["guard_binding"] }]);
    expect(unreadableHeldIn({})).toEqual([]);
    expect(unreadableHeldIn(null)).toEqual([]);
  });

  it("the notice pluralises and prints nothing for no rows", () => {
    expect(damagedRowsNotice("queue item", [])).toEqual([]);
    const two = damagedRowsNotice("queue item", [{ id: "a", columns: ["tags"] }, { id: "b", columns: ["tags"] }]).join("\n");
    expect(two).toContain("2 queue items could not be read");
    expect(two).toContain("Do not act on them");
  });
});
