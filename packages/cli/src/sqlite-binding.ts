// workspaces-o9o.180: better-sqlite3, loaded on first use and never at import. The CLI's Node and native-SQLite gate
// (node-runtime-gate.ts) runs before any command, but a static import of the binding anywhere in the entry's module graph
// loads it first: a binding built for another Node then crashes the CLI with a raw stack instead of the gate's fix.
// test/node-runtime-gate.test.ts fails when a static runtime import of better-sqlite3 returns to src.
import type DatabaseConstructor from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function sqlite(): typeof DatabaseConstructor {
  const ctor: typeof DatabaseConstructor = require("better-sqlite3");
  return ctor;
}
