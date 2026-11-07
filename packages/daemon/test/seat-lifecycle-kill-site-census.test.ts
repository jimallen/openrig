// OF-235 census, kept as a test. The reconciler excuses a missing terminal only while the delivery guard's LIFECYCLE lease holds the seat
// (seat-identity-reconciler.ts, excusedByLifecycle). That is sound only if every place in the daemon that ends or respawns a seat's terminal runs under that lease.
// Instrument: every `.killSession(` / `.respawnPane(` call in packages/daemon/src outside adapters/ (the adapters define them), counted per file; and, for each file, the
// guard entry that takes the lease before it is reached. A new call site in any file fails the count; a removed guard entry fails the entry check. Whoever adds a site
// classifies it here: under a lifecycle entry, or a probe terminal that is never a seat (its label is not the seat label, so the reconciler never lists it).
// Production entrypoint: nothing new executes; this reads source text, so it is a BACKSTOP only: a lease entry made unreachable while its text stays passes it. The
// behaviour is pinned end to end in seat-identity-lifecycle-ops.real.test.ts (rig down, shrinkPod, removeNode, stop) and lifecycle-ops.real.test.ts (handover, launch --fresh,
// restore, relaunch, instantiate cleanup) and seat-restart-in-place-native.test.ts (in-place restart), where an unreachable entry fails (OF-241).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [relative(SRC, full)] : [];
  });
}

/** file -> [calls, the guard entries (exact source text) that put the lease on the seat before those calls run]. */
const CENSUS: Record<string, { calls: number; entries: string[]; note: string }> = {
  "domain/node-launcher.ts": { calls: 1, note: "launch rollback inside launchNode", entries: ["guard.lifecycle([node.id], () => this.launchNode("] },
  "domain/restore-orchestrator.ts": { calls: 2, note: "rollbackToZeroSession, inside restore / launchNodeTargets; and endEmptySeatShells (OF-259), inside restore: it runs under the lifecycle lease restore() takes on every seat of the rig, after the pre-restore snapshot, and re-reads the terminal (shell foreground, no descendant process) right before ending it", entries: ["guard.lifecycle(guardedIds, () => this.restore(", "guard.lifecycle(guardedIds, () => this.launchNodeTargets("] },
  "domain/rigspec-instantiator.ts": { calls: 2, note: "all-failed instantiate cleanup, twice", entries: ["guard.lifecycle(Object.values(nodeIdMap), cleanup)"] },
  "domain/seat-lifecycle-service.ts": { calls: 3, note: "killOlder, stopManagedTmuxSeat, the fresh-launch kill: reached from stopSeat, cleanSeat and launchFresh", entries: ["guard.lifecycle([resolved.nodeId], () => this.stopSeat(input))", "guard.lifecycle([resolved.nodeId], () => this.cleanSeat(input))", "guard.lifecycle([resolved.nodeId], () => this.launchFresh(input))"] },
  "domain/rig-lifecycle-service.ts": { calls: 2, note: "removeNode's two kills", entries: ["guard.lifecycle([node.node_id], () => this.removeNode(", "guard.lifecycle(ids, () => this.shrinkPod("] },
  "domain/rig-teardown.ts": { calls: 1, note: "rig down", entries: ["guard.lifecycle(ids, () => this.teardown("] },
  "domain/seat-restart-in-place.ts": { calls: 2, note: "the in-place restart's two respawns, entered from seat-lifecycle-service restartInPlace", entries: [] },
  "domain/successor-session-launcher.ts": { calls: 1, note: "the handover successor's respawn, entered from seat-handover-service", entries: [] },
  "domain/resume-metadata-refresher.ts": { calls: 1, note: "the metadata probe's own terminal (a probe label, never a seat)", entries: [] },
};
/** Entries that live in a caller's file, not the file that holds the call. */
const CALLER_ENTRIES: Array<[file: string, text: string]> = [
  ["domain/seat-lifecycle-service.ts", "guard.lifecycle([resolved.nodeId], run)"],
  ["domain/seat-handover-service.ts", "guard.lifecycle([node.id], () => this.handover(input))"],
];

describe("OF-235: every place that ends or respawns a seat's terminal runs under a lifecycle lease", () => {
  const sites = walk(SRC).filter((f) => !f.startsWith("adapters/")).flatMap((f) => {
    const n = (read(f).match(/\.(killSession|respawnPane)\(/g) ?? []).length;
    return n > 0 ? [[f, n] as const] : [];
  });

  it("the call sites are exactly the classified ones (a new one must be classified here)", () => {
    expect(sites.length, "files with a call: the population this census filtered").toBeGreaterThan(0);
    expect(Object.fromEntries(sites)).toEqual(Object.fromEntries(Object.entries(CENSUS).map(([f, c]) => [f, c.calls])));
  });

  it.each(Object.entries(CENSUS))("%s: its guard entries are still in the source", (file, c) => {
    for (const entry of c.entries) expect(read(file), `${file}: ${entry}`).toContain(entry);
  });

  it.each(CALLER_ENTRIES)("%s: the caller's guard entry is still in the source", (file, text) => {
    expect(read(file)).toContain(text);
  });
});
