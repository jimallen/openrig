// OF-87: a Ctrl-C byte inside a pasted message must not abort a live Pi or OMP agent. The deployed runner builds
// its pane editor through wirePiRunnerInput (pi-runner.ts main, for both runtimes); these rows drive that function
// with the real line editor and a real RunnerCore, and read the RPC commands the runner would send to the agent.
// Production consequence: a person pasting text that happens to hold an ETX byte (a terminal capture, a binary-ish
// log) used to stop the agent's turn mid-work and split the paste into three messages.
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { RunnerCore, wirePiRunnerInput, type RunnerIo } from "../src/adapters/pi-runner.js";

const START = "\u001b[200~";
const END = "\u001b[201~";
const ETX = "\u0003";

function wired() {
  const rpc: Record<string, unknown>[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => rpc.push(cmd), mirrorLine: () => undefined, mirrorAppend: () => undefined,
    postActivity: () => undefined, writeSidecar: () => undefined, now: () => "2026-10-27T10:00:00Z",
  };
  const core = new RunnerCore(io, { sessionName: "devpi-a@some-rig", launchId: "l1" });
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const editor = wirePiRunnerInput(core, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  const commands = () => rpc.filter((c) => ["prompt", "steer", "follow_up", "abort"].includes(String(c.type)));
  return { input, editor, commands };
}

describe("OF-87: the Pi/OMP runner editor treats ETX inside a paste as text", () => {
  it("a paste holding an ETX byte is one prompt, byte included, and no abort is sent", () => {
    const t = wired();
    try {
      t.input.write(START + "one" + ETX + "\nline two" + END + "\r");
      expect(t.commands()).toEqual([{ type: "prompt", message: "one" + ETX + "\nline two" }]);
    } finally { t.editor.close(); }
  });

  it("control: a real Ctrl-C key press (outside any paste) still aborts the agent", () => {
    const t = wired();
    try {
      t.input.write("half typed" + ETX);
      expect(t.commands()).toEqual([{ type: "abort" }]);
    } finally { t.editor.close(); }
  });

  it("control: an ETX arriving right after the paste closes is a real Ctrl-C and aborts", () => {
    const t = wired();
    try {
      t.input.write(START + "kept" + END + ETX);
      expect(t.commands()).toEqual([{ type: "abort" }]);
    } finally { t.editor.close(); }
  });
});
