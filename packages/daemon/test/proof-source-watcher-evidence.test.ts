// workspaces-o9o.38, verify-qa review of 1fd4d67b2: evidence the adapter cannot read must fail closed. An entry it could
// not stat was skipped, so a symlink to a file behind a non-searchable directory (stat: EACCES; Node cannot watch it
// either, so its edits give no event) left the claim "watching". Gone entries (a dangling symlink) are still skipped:
// nobody can watch them. A failed read of /proc must give "unavailable" with a cause, not throw out of arming.
// Linux only (inotify, /proc), and not as root, which reads through the permissions these rows rely on.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { watchProofSources, type ProofSourceWatch } from "../src/domain/proof/source-watch.js";
import { nodeSourceTreeWatcher } from "../src/adapters/proof-source-watcher.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";

const open: ProofSourceWatch[] = [];
const made: string[] = [];
afterEach(() => {
  for (const watch of open.splice(0)) watch.close();
  for (const dir of made.splice(0)) {
    // Give back the permissions a row took away, so the tree can be removed.
    for (const locked of [path.join(dir, "outside", "locked")]) if (fs.existsSync(path.join(dir, "outside"))) fs.chmodSync(locked, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A legacy missions root (its workspace is `<root>/ws`) and a place outside the workspace. */
function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o38-evidence-"));
  made.push(root);
  const workspace = path.join(root, "ws");
  const missions = path.join(workspace, "missions");
  fs.mkdirSync(path.join(missions, "trial", "slices", "01-alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "outside", "locked"), { recursive: true });
  fs.writeFileSync(path.join(root, "outside", "locked", "target.md"), "x\n");
  return { root, workspace, missions };
}

function watch(missions: string, procSelf?: string): ProofSourceWatch {
  const db = createDb();
  migrate(db, [eventsSchema]);
  const w = watchProofSources(missions, () => {}, new EventBus(db), { watcher: nodeSourceTreeWatcher("linux", procSelf) });
  open.push(w);
  return w;
}

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("o9o.38 review: evidence the adapter cannot read fails closed (needs Linux, not root)", () => {
  it("a symlink to a file behind a non-searchable directory is unavailable with its cause, not watching", () => {
    const h = host();
    // Alone in the deepest directory, so Node arms every directory before it reaches the link. (Node stops arming at the
    // first entry it cannot watch, silently: an unwatchable entry earlier in read order leaves the rest unwatched too.)
    const link = path.join(h.missions, "trial", "slices", "01-alpha", "link.md");
    fs.symlinkSync(path.join(h.root, "outside", "locked", "target.md"), link);
    fs.chmodSync(path.join(h.root, "outside", "locked"), 0o600);
    expect(() => fs.statSync(link)).toThrow(/EACCES/);
    expect(watch(h.missions).observation()).toEqual({
      state: "unavailable",
      revision: "unavailable",
      cause: `the watch evidence could not be read: could not check ${link}: EACCES`,
    });
  });

  // workspaces-o9o.133: the adapter arms each directory itself, so one removed and created again must be armed again
  // (a stale entry for the old watch would leave the new directory unwatched, and the evidence would name it).
  it("a directory removed and created again is armed again: the claim returns to watching", async () => {
    const h = host();
    const slice = path.join(h.missions, "trial", "slices", "01-alpha");
    const w = watch(h.missions);
    expect(w.observation().state).toBe("watching");
    fs.rmSync(slice, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 300));
    fs.mkdirSync(path.join(slice, "proof"), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(nodeSourceTreeWatcher().unwatched(path.dirname(h.missions), true), "every directory holds a live watch").toEqual([]);
    await expect.poll(() => w.observation().state, { timeout: 5000 }).toBe("watching");
  });

  // workspaces-o9o.133 (verify-sec FAIL): a path removed and created again BEFORE the adapter's callback runs. The row above
  // waits 300 ms between the two, so the callback for the removal runs first; here nothing waits, which is what an editor's
  // atomic replace or a `git checkout` does. The new directory (or the link's new target) must be watched, and an edit in it
  // seen, after every replacement.
  const settle = async (adapter: ReturnType<typeof nodeSourceTreeWatcher>, tree: string): Promise<string[]> => {
    const until = Date.now() + 2000;
    let gaps = adapter.unwatched(tree, true) ?? [];
    while (gaps.length > 0 && Date.now() < until) { await new Promise((r) => setTimeout(r, 20)); gaps = adapter.unwatched(tree, true) ?? []; }
    return gaps;
  };
  const seen = async (events: string[], mark: number): Promise<boolean> => {
    const until = Date.now() + 1000;
    while (events.length <= mark && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    return events.length > mark;
  };

  it("a directory replaced with no pause, 10 times: every replacement is armed and an edit inside it is seen", async () => {
    const h = host();
    const dir = path.join(h.missions, "proofs");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    const adapter = nodeSourceTreeWatcher("linux");
    const events: string[] = [];
    const w = adapter.watch(h.missions, { recursive: true }, (name) => events.push(String(name)), () => {});
    try {
      expect(await settle(adapter, h.missions), "positive control: the first tree is armed").toEqual([]);
      const rounds: Array<{ gaps: string[]; editSeen: boolean }> = [];
      for (let i = 0; i < 10; i++) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
        const gaps = await settle(adapter, h.missions);
        const mark = events.length;
        fs.writeFileSync(path.join(dir, "nested", "proof.md"), `proof-${i}\n`);
        rounds.push({ gaps, editSeen: await seen(events, mark) });
      }
      expect(rounds).toEqual(Array.from({ length: 10 }, () => ({ gaps: [], editSeen: true })));
    } finally { w.close(); }
  }, 60_000);

  it("a symlink replaced with no pause, 10 times: every new target is armed and an edit to it is seen", async () => {
    const h = host();
    const targets = Array.from({ length: 11 }, (_, i) => path.join(h.root, "outside", `target-${i}.md`));
    for (const [i, t] of targets.entries()) fs.writeFileSync(t, `start-${i}\n`);
    const link = path.join(h.missions, "proof.md");
    fs.symlinkSync(targets[0]!, link);
    const adapter = nodeSourceTreeWatcher("linux");
    const events: string[] = [];
    const w = adapter.watch(h.missions, { recursive: true }, (name) => events.push(String(name)), () => {});
    try {
      expect(await settle(adapter, h.missions), "positive control: the first link is armed").toEqual([]);
      const rounds: Array<{ gaps: string[]; editSeen: boolean }> = [];
      for (let i = 1; i < targets.length; i++) {
        fs.unlinkSync(link);
        fs.symlinkSync(targets[i]!, link);
        const gaps = await settle(adapter, h.missions);
        const mark = events.length;
        fs.appendFileSync(targets[i]!, `edit-${i}\n`);
        rounds.push({ gaps, editSeen: await seen(events, mark) });
      }
      expect(rounds).toEqual(Array.from({ length: 10 }, () => ({ gaps: [], editSeen: true })));
    } finally { w.close(); }
  }, 60_000);

  it("positive control: a dangling symlink is gone, not unreadable, and the claim stays watching", () => {
    const h = host();
    fs.symlinkSync(path.join(h.root, "outside", "nothing-here.md"), path.join(h.workspace, "dangling.md"));
    expect(watch(h.missions).observation().state).toBe("watching");
  });

  it("a /proc that cannot be read gives unavailable with its cause, and arming does not throw", () => {
    const h = host();
    const procSelf = path.join(h.root, "no-proc");
    expect(watch(h.missions, procSelf).observation()).toEqual({
      state: "unavailable",
      revision: "unavailable",
      cause: `the watch evidence could not be read: could not read this process's inotify watches from ${procSelf}: ENOENT`,
    });
  });
});
