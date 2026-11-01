// A Pi for a real runner, over RPC, with no model: it keeps each prompt in its session file and in `effects`, unless the `compacting` file
// exists, when it answers as Pi 1.4.0 does during compaction (s0 M6: `success: false`, nothing persisted).
import fs from "node:fs";
import path from "node:path";

export function fakePi(dir: string): { bin: string; session: string; effects: string; compacting: string } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const session = path.join(dir, "session.jsonl");
  const effects = path.join(dir, "effects.jsonl");
  const compacting = path.join(dir, "compacting");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0;
if (require("node:path").basename(process.argv[1]) === "omp") out({ type: "ready" });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile: ${JSON.stringify(session)}, sessionId: "offline", isStreaming: false } });
  if (cmd.type !== "prompt" && cmd.type !== "steer" && cmd.type !== "follow_up") return;
  if (fs.existsSync(${JSON.stringify(compacting)})) { out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry." }); return; }
  const message = { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: 1 };
  fs.appendFileSync(${JSON.stringify(session)}, JSON.stringify({ type: "message", id: "e" + (++n), message }) + "\\n");
  fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify(cmd.message) + "\\n");
  out({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { disposition: "started" } });
  out({ type: "message_start", message });
  out({ type: "message_end", message });
  out({ type: "agent_start" });
  out({ type: "agent_end", messages: [], willRetry: false });
});\n`;
  for (const name of ["pi", "omp"]) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "offline", timestamp: "2026-01-02T03:04:05.000Z", cwd: dir })}\n`);
  fs.writeFileSync(effects, "");
  return { bin, session, effects, compacting };
}
