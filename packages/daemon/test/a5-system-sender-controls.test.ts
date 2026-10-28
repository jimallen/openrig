// a5 review F1: OF-169 reaches the system senders that go through SessionTransport.send. `send` itself is unchanged (it
// is the `rig send` entry), so each sender strips C0/C1 controls except TAB/LF/CR from the text it composes. The
// compaction enforcer's sites are pinned in claude-compaction-enforcer.test.ts. Nothing here imports the rule under
// test: the controls are literals.
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { formatWatchdogDeliveryMessage } from "../src/domain/watchdog-policy-engine.js";
import { ModelDivergenceMonitor, type PinnedSeat } from "../src/domain/model-divergence/model-divergence-monitor.js";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

describe("watchdog message (startup.ts: formatWatchdogDeliveryMessage feeds SessionTransport.send)", () => {
  it("loses controls from the job's message, keeps TAB, LF and CR, and keeps the wrapper", () => {
    const out = formatWatchdogDeliveryMessage(
      { policy: "periodic-reminder", jobId: "job-1" } as Parameters<typeof formatWatchdogDeliveryMessage>[0],
      "check\u0003 the queue\u001b[31m\n\tthen\rreply\u0085",
    );
    expect(out).toBe("[OpenRig watchdog scheduler · policy: periodic-reminder · job: job-1]\ncheck the queue[31m\n\tthen\rreply");
  });
  it("is idempotent, so a retained body replayed by startup.ts is unchanged", () => {
    const source = { policy: "p", jobId: "j" } as Parameters<typeof formatWatchdogDeliveryMessage>[0];
    const once = formatWatchdogDeliveryMessage(source, "a\u0003b");
    expect(formatWatchdogDeliveryMessage(source, once.split("\n").slice(1).join("\n"))).toBe(once);
  });
});

describe("model monitor message (startup.ts sendToSession)", () => {
  const SEAT: PinnedSeat = { nodeId: "n1", sessionName: "dev-impl@r", rigId: "rig-1", rigName: "r", runtime: "codex", pinnedModel: "gpt-5.1-codex-mini", generation: "gen-1" };
  it("an effective model read from a record cannot put controls into any proclamation sent to a seat", async () => {
    const sent: string[] = [];
    const monitor = new ModelDivergenceMonitor({
      listPinnedSeats: () => [SEAT],
      readEffectiveModel: () => ({ ok: true as const, model: "gpt\u0003-5.\u001b[2J4-mini" }),
      sendToSession: async (_target, message) => { sent.push(message); return { ok: true }; },
      resolveOrchSeats: () => ["orch-lead@r"], resolveOperatorSeat: () => "operator-admin@kernel", resolveOversightSeat: () => "watch-lead@oversight",
      recordProclamation: () => {}, warn: () => {},
    });
    await monitor.checkOnce();
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(m, JSON.stringify(m)).not.toMatch(CONTROL);
    expect(sent.every((m) => m.includes("gpt-5.[2J4-mini"))).toBe(true);
  });
});

describe("queue nudge envelope (queue-repository: wrapNudgeEnvelope, both construction sites)", () => {
  function harness() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const calls: Array<{ session: string; text: string }> = [];
    const transport: QueueNudgeTransport = { async send(session: string, text: string) { calls.push({ session, text }); return { ok: true, verified: true }; } };
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachTransport(transport);
    repo.attachOutbox(new OutboxHandler(db));
    return { db, repo, calls };
  }
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const header = (text: string) => text.split("\n").slice(0, text.split("\n").indexOf("---")).join("\n");

  it("frozen wake envelope (create): From and To lose controls", async () => {
    const h = harness();
    try {
      await h.repo.create({ sourceSession: "lead\u0003@rig", destinationSession: "dev\u001b@rig", body: "work" });
      await vi.waitFor(() => expect(h.calls).toHaveLength(1));
      const head = header(h.calls[0]!.text);
      expect(head).toContain("From: lead@rig");
      expect(head).toContain("To: dev@rig");
      expect(head).not.toMatch(CONTROL);
      expect(h.calls[0]!.text).not.toMatch(CONTROL);
    } finally { await settle(); h.db.close(); }
  });

  it("direct nudge (maybeNudge): From and To lose controls, and a person's bodyOverride keeps every byte", async () => {
    const h = harness();
    try {
      const row = await h.repo.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "work", nudge: false });
      const decision = "decide\u0003 yes\u001b[1m\tnow\r";
      await h.repo.maybeNudge(row.qitemId, "dev\u001b@rig", undefined, "lead\u0003@rig", decision);
      expect(h.calls).toHaveLength(1);
      const text = h.calls[0]!.text;
      expect(header(text)).toContain("From: lead@rig");
      expect(header(text)).toContain("To: dev@rig");
      expect(header(text)).not.toMatch(CONTROL);
      const lines = text.split("\n");
      const body = lines.slice(lines.indexOf("---") + 1, lines.lastIndexOf("---")).join("\n");
      expect(body).toBe(decision);
    } finally { await settle(); h.db.close(); }
  });
});
