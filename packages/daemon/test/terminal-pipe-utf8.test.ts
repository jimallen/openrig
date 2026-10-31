import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { HcViewer } from "../src/adapters/hc-viewer.js";
import { TerminalSessionBroker, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";
import { isStreamHost } from "../src/terminal/HcStreamSession.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const EXPECTED = "UTF8_START:🚀 café 中文 :UTF8_END";

/** Polls until `read` answers what `ok` accepts; the ceiling only bounds a genuine hang. */
async function until<T>(read: () => T, ok: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function subscriber() {
  const sub = {
    sent: [] as string[], closed: [] as Array<{ code: number; reason: string }>,
    send(data: string) { sub.sent.push(data); },
    close(code: number, reason: string) { sub.closed.push({ code, reason }); },
    size() {},
    text: () => sub.sent.join(""),
  };
  return sub satisfies TerminalSubscriber & { text(): string };
}

// The live view's bytes arrive as frames of the core's stream, and a frame can end inside a multi-byte character. tmux's pipe file
// and its poll split the same way (the original pinned a 4-byte emoji cut across two polls); here the cut is across two writes of
// the program, and the broker's decoder must carry the half character to the next frame, for a live and for a late viewer.
describe.skipIf(!findHc())("terminal view keeps UTF-8 intact across writes, on a private hc core", () => {
  let scratch: HcScratch;
  let viewer: HcViewer;
  beforeAll(() => {
    scratch = startHcScratch();
    const input = () => new HcInput(scratch.client(), new HcAttach(scratch.socketPath));
    viewer = new HcViewer({
      socketPath: scratch.socketPath,
      input: {
        keys: (name, keys) => input().sendKeys(name, keys, undefined, { blocked: "allow" }),
        paste: (name, text) => input().sendText(name, text, undefined, { blocked: "allow" }),
      },
    });
  }, 60_000);
  afterAll(() => scratch?.cleanup());

  it("preserves a four-byte character split across two writes for live and late viewers", async () => {
    const seat = "unicode@fixture";
    const writer = join(scratch.root, "writer.cjs"), first = join(scratch.root, "first"), second = join(scratch.root, "second");
    writeFileSync(writer, `const fs=require('node:fs'); const bytes=Buffer.from('🚀'); let stage=0;
process.stdout.write('READY\\r\\n');
setInterval(()=>{ if(stage===0 && fs.existsSync(${JSON.stringify(first)})) {
process.stdout.write(Buffer.concat([Buffer.from('UTF8_START:'),bytes.subarray(0,2)])); stage=1;
} else if(stage===1 && fs.existsSync(${JSON.stringify(second)})) {
process.stdout.write(Buffer.concat([bytes.subarray(2),Buffer.from(' café 中文 :UTF8_END')])); stage=2;
} },10);`);
    await scratch.client().call("terminal.run", {
      argv: [process.execPath, writer], name: hcTerminalName(seat), labels: { [SEAT_LABEL]: seat }, cwd: scratch.root,
      no_parent: true, no_notify: true, outlive_parent: true,
    });
    const live = subscriber();
    const broker = new TerminalSessionBroker(seat, viewer);
    await broker.attach(live);
    try {
      await until(live.text, (text) => text.includes("READY"), "the first paint");
      writeFileSync(first, "ready");
      await until(live.text, (text) => text.includes("UTF8_START:"), "the first half");
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(second, "ready");
      await until(live.text, (text) => text.includes("UTF8_END"), "the second half");
      expect(live.text(), "the live viewer sees the character whole").toContain(EXPECTED);
      expect(live.text()).not.toContain("�");
      expect(live.closed).toEqual([]);
      const late = subscriber();
      await broker.attach(late);
      await until(late.text, (text) => text.includes("UTF8_END"), "the late viewer's paint");
      expect(late.text(), "a late viewer's history is also intact").toContain(EXPECTED);
      expect(late.text()).not.toContain("�");
    } finally { broker.dispose(); }
  }, 60_000);

  // Found by this conversion. TerminalBrokerRegistry is built in routes/terminal-ws.ts from the daemon's seat host (`tmux`), which is
  // an HcAdapter at runtime. The broker takes the stream path only for a host with `view`, which HcViewer has and HcAdapter does not
  // forward, so the production broker would fall back to pipe-pane, which hc refuses ("unsupported"). Delete `it.fails` when HcAdapter
  // (or terminal-ws) hands the registry the viewer.
  it.fails("the seat host the daemon builds the broker from is a stream host (DEFECT: HcAdapter does not forward view())", () => {
    expect(isStreamHost(new HcAdapter(scratch.client()))).toBe(true);
  });
});
