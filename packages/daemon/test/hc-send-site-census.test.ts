// Seat Messaging S1: every place the daemon sends text to a seat, how its row commits before the write (invariant 1) and what id each
// attempt carries (invariant 2). An unconfirmed send on an hc seat settles its row `indeterminate`, which the sweep settles and `rig
// health` lists. A site not in these tables fails the test until it is classified: a new sender must say how it meets the rules.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/** A call into the transport's `send` or `broadcast`: `sessionTransport.send(`, `transport.send(`, `this.sessionTransport.send(`, ... */
const SEND_CALL = /\b(?:session)?[tT]ransport!?\.(?:send|broadcast)\(|this\.deps\.send\(session\.name|this\.send\(session\.sessionName/g;

type Class =
  | "transport-commits-row"   // SessionTransport.send commits the row before the attempt and settles it after
  | "row-exists-first"        // a row exists before the send (queue wake, the native fallback's failed-over rows)
  | "typed-nothing"           // no text is typed (an Enter-only retry), so there is no message
  | "pump-owns-row";          // S4: on a gated seat the consumer commits the row and the pump carries it; the call counted here is the ungated path, until S5

const SITES: Array<{ file: string; calls: number; class: Class; id: string; note: string }> = [
  { file: "routes/transport.ts", calls: 2, class: "transport-commits-row", id: "caller's (`rig send --id`), else minted once per request; a fan-out's is `<id>:<seat>`", note: "/send and /broadcast" },
  { file: "startup.ts", calls: 6, class: "transport-commits-row", id: "sendVerify probe, native notice: minted, one attempt. post-restart: post-restart-<seq>-<node>. watchdog: guard-watchdog-<occurrence>, handed to the pump on a gated seat, which is `ok` at commit. model monitor: guard-model-<occurrence>-<target>. native fallback: row-exists-first, its rows' ids", note: "sendVerify probe, post-restart wiring, native fallback (ownsOutboxRow), native notice, watchdog, model monitor" },
  { file: "domain/startup-orchestrator.ts", calls: 1, class: "typed-nothing", id: "none: submit-only, the text's row is the carried one", note: "submit-only Enter, empty text" },
  { file: "domain/claude-compaction-enforcer.ts", calls: 5, class: "transport-commits-row", id: "seat-msg-compaction-<attempt>-<prep|compact|turn_boundary|restore_prompt|compliance_prompt>", note: "the three post-compact stages, prep, /compact (a Command: no message state, the enforcer keeps its retry)" },
  { file: "domain/session-transport.ts", calls: 1, class: "transport-commits-row", id: "<id>:<seat>, or minted per recipient", note: "broadcast's per-recipient send" },
  { file: "domain/post-restart-notifier.ts", calls: 1, class: "pump-owns-row", id: "post-restart-<seq>-<node>; gated: accepted at the restore. ungated: the row stays open between its own retries", note: "the wiring in startup.ts" },
  { file: "domain/queue-repository.ts", calls: 1, class: "row-exists-first", id: "wake-intent-*, or guard-nudge-<qitem>-<hash>", note: "wake intents: committed ids; a plain nudge goes through the transport's row under its fixed id. On a seat the pump serves both go to the pump, which owns their retries; the ladder reads the row and sends nothing (S4d)" },
];

/** Text written past SessionTransport. Not S1's (Jim, via the lead, 2026-11-01): these 8 paths move in S4 and keep their own loops until
 *  then, with no row and no stable id. Census counts `.sendText(` in the file. */
const DIRECT_TEXT: Array<{ file: string; kinds: string[]; sendText: number; stage: "S4" }> = [
  { file: "domain/seat-handover-service.ts", kinds: ["handover-rebuild", "handover-restore"], sendText: 2, stage: "S4" },
  { file: "domain/startup-orchestrator.ts", kinds: ["startup"], sendText: 1, stage: "S4" },
  { file: "domain/resume-metadata-refresher.ts", kinds: ["resume-probe"], sendText: 1, stage: "S4" },
  { file: "adapters/claude-code-adapter.ts", kinds: ["startup"], sendText: 1, stage: "S4" },
  { file: "adapters/codex-runtime-adapter.ts", kinds: ["startup"], sendText: 1, stage: "S4" },
  { file: "adapters/pi-runtime-adapter.ts", kinds: ["startup"], sendText: 1, stage: "S4" },
  { file: "adapters/stub-runtime-adapter.ts", kinds: ["startup"], sendText: 1, stage: "S4" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("every daemon send into SessionTransport is classified", () => {
  const found = new Map<string, number>();
  for (const file of sourceFiles(SRC)) {
    const n = (readFileSync(file, "utf8").match(SEND_CALL) ?? []).length;
    if (n > 0) found.set(relative(SRC, file), n);
  }
  const known = new Map(SITES.map((s) => [s.file, s.calls]));

  it("the census finds exactly the classified sites, file by file (a new or removed call fails here)", () => {
    expect([...found.entries()].sort()).toEqual([...known.entries()].sort());
  });

  it("has a positive control: the population is not empty and sums to the classified total (17)", () => {
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBe(17);
    expect(SITES.reduce((a, s) => a + s.calls, 0)).toBe(17);
  });

  it("every class is one the rule names", () => {
    const classes = new Set(SITES.map((s) => s.class));
    expect([...classes].sort()).toEqual(["pump-owns-row", "row-exists-first", "transport-commits-row", "typed-nothing"]);
  });

  it("only the native fallback says ownsOutboxRow: its rows exist, and the sweeper settles them", () => {
    const owns = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const n = (readFileSync(file, "utf8").match(/ownsOutboxRow: true/g) ?? []).length;
      if (n > 0) owns.set(relative(SRC, file), n);
    }
    expect([...owns.entries()].sort()).toEqual([["startup.ts", 1]]);
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    expect(startup).toMatch(/send: \(f\) => sessionTransport\.send\(f\.sessionName, f\.body, \{ forceTmux: true, ownsOutboxRow: true/);
  });

  it("the 8 direct text paths are the classified ones, each stays S4's, and none has taken a row yet", () => {
    expect(DIRECT_TEXT.reduce((a, d) => a + d.kinds.length, 0)).toBe(8); // handover 2, orchestrator 1, adapters 4, probe 1
    for (const site of DIRECT_TEXT) {
      const source = readFileSync(join(SRC, site.file), "utf8");
      expect((source.match(/\.sendText\(/g) ?? []).length, site.file).toBe(site.sendText);
      expect(site.stage).toBe("S4");
      expect(source, site.file).not.toContain("seat-messaging/message-ledger");
    }
  });

  it("no other daemon file writes text to a seat past the transport (positive control: the population is the S4 sites plus the implementations)", () => {
    const implementations = new Set(["adapters/tmux.ts", "adapters/hc-adapter.ts", "adapters/hc-input.ts", "domain/session-transport.ts", "routes/terminal-ws.ts", "terminal/TerminalSessionBroker.ts"]);
    const writers = sourceFiles(SRC).map((f) => relative(SRC, f)).filter((f) => /\.sendText\(/.test(readFileSync(join(SRC, f), "utf8")));
    expect(writers.filter((f) => !implementations.has(f)).sort()).toEqual(DIRECT_TEXT.map((d) => d.file).sort());
  });

  it("startup persists the enforcer's stages and binds a watchdog fire to its occupant", () => {
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    expect(startup).toContain("stageStore: new CompactionStageStore(db)");
    // A watchdog fire is bound to its occupant, so the generation gate can hold at attempt time, later than fire (design-delivery-s4 N5).
    expect(startup).toMatch(/actorSession: "watchdog@system"[^\n]*occupantGeneration: sessionRegistry\.currentOccupantGenerationForSession\(targetSession\)/);
  });

  it("post-restart commits to the pump itself on a gated seat, and the two consumers' checks are registered before the pump starts (S4b, S4c)", () => {
    expect((readFileSync(join(SRC, "domain/post-restart-notifier.ts"), "utf8").match(/handOff\.accept\(/g) ?? []).length).toBe(1);
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    const started = startup.indexOf("messagePump.start();");
    for (const prefix of ["post-restart-", "guard-watchdog-"]) {
      const at = startup.indexOf(`messageObligations.register("${prefix}"`);
      expect(at, prefix).toBeGreaterThan(0);
      expect(at, prefix).toBeLessThan(started);
    }
    // Re-derived after the hand-off exists: before it, a gated seat's prompt would take the ungated loop.
    expect(startup.indexOf("postRestart.rederiveFromLog()")).toBeGreaterThan(started);
    // Dropped, a threshold fire is recorded ahead of the commit again, and a crash between them loses it with no test to say so.
    expect(startup).toContain("pumpCarries: (session) => tmuxAdapter.messageHandOff?.takes(session) === true,");
  });

  it("every retrying caller freezes its body, so a rebuilt stamp is not an identity conflict", () => {
    const files: Array<[string, number]> = [["startup.ts", 2], ["domain/queue-repository.ts", 1], ["domain/post-restart-notifier.ts", 2], ["domain/claude-compaction-enforcer.ts", 3]];
    for (const [file, n] of files) expect((readFileSync(join(SRC, file), "utf8").match(/freezeBody: true/g) ?? []).length, file).toBe(n);
  });

  it("the daemon's sweep timer gives the sweep its cursor, so rows that never settle cannot starve newer ones (QA N5)", () => {
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    expect(startup).toContain("const hcSweepCursor = { offset: 0 };");
    expect(startup).toMatch(/sweepHcUnsettled\(\{[\s\S]{0,400}\}, 200, hcSweepCursor\)/);
  });
});
