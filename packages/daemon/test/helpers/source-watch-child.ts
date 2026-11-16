// workspaces-o9o.38: arm the daemon's proof source watch on one missions root, in a process of its own (so an
// LD_PRELOAD inotify shim reaches only this process), and print what observation() claims, and what it logged, as JSON.
import * as fs from "node:fs";
import * as path from "node:path";
import { watchProofSources } from "../../src/domain/proof/source-watch.js";
import { nodeSourceTreeWatcher } from "../../src/adapters/proof-source-watcher.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";

const missionsRoot = process.argv[2];
if (!missionsRoot) throw new Error("usage: source-watch-child.ts <missionsRoot>");
const db = createDb();
migrate(db, [eventsSchema]);
const bus = new EventBus(db);
const logs: string[] = [];
const watch = watchProofSources(missionsRoot, () => {}, bus, { watcher: nodeSourceTreeWatcher(), log: (message) => logs.push(message) });
// With a second argument, create that directory under the missions root after arming (a slice added later).
const lateDir = process.argv[3];
if (lateDir) setTimeout(() => fs.mkdirSync(path.join(missionsRoot, lateDir), { recursive: true }), 100);
// Give a recursive watcher time to arm its subdirectories and surface an 'error' if it is going to.
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ...watch.observation(), logs })}\n`);
  watch.close();
}, 600);
