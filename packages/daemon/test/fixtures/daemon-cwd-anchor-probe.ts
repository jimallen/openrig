// Child-only: models a daemon launched from a directory that is later deleted,
// then runs the production Codex profile preflight (verifyCodexProfileLoads
// through the real shell executor) against a synthetic `codex` on PATH.
import fs from "node:fs";
import path from "node:path";
import { execCommand } from "../../src/adapters/tmux-exec.js";
import { verifyCodexProfileLoads } from "../../src/domain/codex-profile-preflight.js";

const [root, mode] = process.argv.slice(2) as [string, "direct" | "imported"];
const launch = path.join(root, "launch");
fs.mkdirSync(launch);
process.chdir(launch);
// `rig daemon start` from here, then the directory is removed under the daemon.
if (mode === "direct") process.argv[1] = path.join(import.meta.dirname, "../../src/index.ts");
await import("../../src/daemon-cwd-anchor.js").catch(() => { /* absent at base */ });
fs.rmdirSync(launch);
process.env.PATH = path.join(root, "bin");
const result = await verifyCodexProfileLoads("rig-yolo", execCommand, 8_000, path.join(root, "codex-home"));
let cwd: string | null;
try { cwd = process.cwd(); } catch { cwd = null; }
console.log(JSON.stringify({ result, cwd }));
