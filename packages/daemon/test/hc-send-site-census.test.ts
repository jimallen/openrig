// hc cutover: every place the daemon sends text to a seat through SessionTransport, and what each does when the send ends
// unconfirmed on an hc seat (`waiting_on_person`, `delivery_outcome_unknown`: the core may still type it, and a core restart while it
// holds it loses it). The rule: every such send leaves an `indeterminate` row, the same one /send writes, which the sweep settles and
// `rig health` lists. A site not in this table fails the test until it is classified: a new sender must say how it meets the rule.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/** A call into the transport's `send` or `broadcast`: `sessionTransport.send(`, `transport.send(`, `this.sessionTransport.send(`, ... */
const SEND_CALL = /\b(?:session)?[tT]ransport!?\.(?:send|broadcast)\(|this\.deps\.send\(session\.name|this\.send\(session\.sessionName/g;

type Class =
  | "route-owns-row"          // the route writes the row after the send (ownsOutboxRow: true)
  | "transport-writes-row"    // no row of its own: SessionTransport records the unconfirmed send (recordUnconfirmedHcSend)
  | "row-exists-first"        // a row exists before the send (queue wake, committed ids) or under the delivery id
  | "caller-owns-row"         // the caller records the row itself (post-restart prompt, native fallback)
  | "typed-nothing";          // no text is typed (an Enter-only retry), so nothing can be lost

const SITES: Array<{ file: string; calls: number; class: Class; note: string }> = [
  { file: "routes/transport.ts", calls: 2, class: "route-owns-row", note: "/send and /broadcast record `indeterminate` themselves, as before" },
  { file: "startup.ts", calls: 6, class: "transport-writes-row", note: "sendVerify probe, post-restart wiring (its own row, idempotent under the delivery id), native fallback (ownsOutboxRow), native notice, watchdog (stable delivery id), model monitor (stable delivery id)" },
  { file: "domain/startup-orchestrator.ts", calls: 1, class: "typed-nothing", note: "submit-only Enter, empty text" },
  { file: "domain/claude-compaction-enforcer.ts", calls: 5, class: "transport-writes-row", note: "turn boundary, restore, compliance (the stages that advance on an unconfirmed send), prep, /compact" },
  { file: "domain/session-transport.ts", calls: 1, class: "transport-writes-row", note: "broadcast's per-recipient send; its route passes ownsOutboxRow" },
  { file: "domain/post-restart-notifier.ts", calls: 1, class: "caller-owns-row", note: "records the row under its fixed delivery id (the transport's write finds it)" },
  { file: "domain/queue-repository.ts", calls: 1, class: "row-exists-first", note: "wake intents: committed ids, or a delivery id whose row exists" },
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
    expect([...classes].sort()).toEqual(["caller-owns-row", "route-owns-row", "row-exists-first", "transport-writes-row", "typed-nothing"]);
  });

  it("only the sites that really record a row themselves say ownsOutboxRow: the two routes and the native fallback, and no other sender", () => {
    const owns = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const n = (readFileSync(file, "utf8").match(/ownsOutboxRow: true/g) ?? []).length;
      if (n > 0) owns.set(relative(SRC, file), n);
    }
    // The enforcer, watchdog, model monitor, sendVerify and the rest must NOT: their unconfirmed sends are the transport's to record.
    expect([...owns.entries()].sort()).toEqual([["routes/transport.ts", 2], ["startup.ts", 1]]);
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    expect(startup).toMatch(/send: \(f\) => sessionTransport\.send\(f\.sessionName, f\.body, \{ forceTmux: true, ownsOutboxRow: true/);
  });

  it("the daemon's sweep timer gives the sweep its cursor, so rows that never settle cannot starve newer ones (QA N5)", () => {
    const startup = readFileSync(join(SRC, "startup.ts"), "utf8");
    expect(startup).toContain("const hcSweepCursor = { offset: 0 };");
    expect(startup).toMatch(/sweepHcUnsettled\(\{[\s\S]{0,400}\}, 200, hcSweepCursor\)/);
  });
});
