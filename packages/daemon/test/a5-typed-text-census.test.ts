// a5 review F2: a census guard for text typed into a pane. Every non-comment `.sendText(` call and every
// `transport.send(` / `sessionTransport.send(` call in src/ is listed below with the class that says why it is safe
// (or why its text is not ours to alter). A new caller, or a removed one, fails here until it is classified, so a
// new bracketed-paste sender cannot appear without someone deciding what it may type. Counts are per file.
//   stripped   system or operator text; C0/C1 controls except TAB/LF/CR are removed before the pane (OF-169)
//   constant   a literal with no input
//   gated      the typed words must pass isTypedResumeWord ([A-Za-z0-9._@-]+)
//   person     a person's or agent's own message: rig send refuses only the paste-end marker (OF-148)
//   shell      a shell line the daemon builds, staged or quoted (OF-67)
//   handover   inertPacketText
//   impl       the sender's own implementation (delivery inside SessionTransport / TmuxAdapter)
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Row = { sendText: number; send: number; cls: string };
const CLASSIFIED: Record<string, Row> = {
  "adapters/claude-code-adapter.ts": { sendText: 1, send: 0, cls: "stripped" },
  "adapters/codex-runtime-adapter.ts": { sendText: 1, send: 0, cls: "stripped" },
  "adapters/pi-runtime-adapter.ts": { sendText: 1, send: 0, cls: "stripped" },
  "adapters/stub-runtime-adapter.ts": { sendText: 1, send: 0, cls: "stripped" },
  "adapters/tmux.ts": { sendText: 1, send: 0, cls: "shell" },
  "domain/claim-service.ts": { sendText: 1, send: 0, cls: "gated" },
  "domain/claude-compaction-enforcer.ts": { sendText: 0, send: 5, cls: "stripped (4 prompts) + constant (turn boundary)" },
  "domain/cmux-layout-service.ts": { sendText: 1, send: 0, cls: "shell" },
  "domain/node-cmux-service.ts": { sendText: 2, send: 0, cls: "shell" },
  "domain/queue-repository.ts": { sendText: 0, send: 1, cls: "stripped envelope + person body" },
  "domain/resume-metadata-refresher.ts": { sendText: 1, send: 0, cls: "gated" },
  "domain/seat-handover-service.ts": { sendText: 2, send: 0, cls: "handover" },
  "domain/session-transport.ts": { sendText: 3, send: 0, cls: "impl" },
  "domain/startup-orchestrator.ts": { sendText: 1, send: 1, cls: "stripped (typed text) + constant (guarded retry sends no text)" },
  "routes/transport.ts": { sendText: 0, send: 1, cls: "person" },
  "startup.ts": { sendText: 0, send: 5, cls: "stripped (watchdog, model monitor, native comms step 3's delivery notice via nativeNoticeText) + constant (attention probe) + replay (native comms step 3: the sweeper's tmux fallback re-sends a native message's accepted text through the same transport, so it keeps that message's class)" },
  "terminal/TerminalSessionBroker.ts": { sendText: 1, send: 0, cls: "person" },
};

describe("typed-text census (OF-169)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.isFile() && full.endsWith(".ts") ? [full] : [];
  });
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

  function measure(): Record<string, { sendText: number; send: number }> {
    const found: Record<string, { sendText: number; send: number }> = {};
    for (const file of walk(srcDir)) {
      let sendText = 0, send = 0;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (isComment(line)) continue;
        sendText += (line.match(/\.sendText\(/g) ?? []).length;
        send += (line.match(/[tT]ransport[!?]?\.send\(/g) ?? []).length;
      }
      if (sendText || send) found[path.relative(srcDir, file)] = { sendText, send };
    }
    return found;
  }

  it("every sender of pane text is classified, with its exact count, and nothing classified has gone", () => {
    const found = measure();
    const expected = Object.fromEntries(Object.entries(CLASSIFIED).map(([f, r]) => [f, { sendText: r.sendText, send: r.send }]));
    expect(found, "a new or removed sendText/transport.send caller: classify it in CLASSIFIED (and strip it, if it types system text)").toEqual(expected);
  });

  it("positive control: the census sees the known senders (a wrong filter would read zero)", () => {
    const found = measure();
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(15);
    expect(found["domain/startup-orchestrator.ts"]).toEqual({ sendText: 1, send: 1 });
  });
});
