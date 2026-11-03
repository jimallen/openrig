// OF-213: a Pi seat names itself. Production consequence: before this, the Pi runner's hc terminal had title "" and the Herdr pane
// header read only "pi-runner <cwd>", so nothing in the pane said which seat was which (measured live on t37 verify-qa@eztrack),
// while a Claude seat's title is its session name. The real-core proof (what hc records as the title) is runner-title.real.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRunnerHcTitleSink, hcTitleRecord, seatBannerLine } from "../src/adapters/runner-hc-title.js";
import { PI_RUNNER_ERROR_MARKER, PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";

// Restated here on purpose (not imported from the module): the wire form hc was measured to take as the terminal's title.
const OSC2 = (title: string) => `\u001b]2;${title}\u001b\\`;

describe("the title record", () => {
  it("is ESC ] 2 ; <session name> ESC \\", () => {
    expect(hcTitleRecord("verify-qa@eztrack")).toBe(OSC2("verify-qa@eztrack"));
  });
  it.each(["", "a\u001bb", "a\u0007b", "a\nb", "a\u009cb", "a\u007fb", "x".repeat(129)])("refuses a title a terminal parser would cut or reinterpret (%j)", (title) => {
    expect(() => hcTitleRecord(title)).toThrow();
  });
  it("writes a non-ASCII session name as UTF-8, unchanged", () => {
    const record = hcTitleRecord("prüfer@team");
    expect(record).toBe(OSC2("prüfer@team"));
    // Restated bytes: ESC ] 2 ; p r <c3 bc> f e r @ t e a m ESC \
    expect(Buffer.from(record, "utf8").toString("hex")).toBe("1b5d323b70" + "72c3bc" + "66657240" + "7465616d" + "1b5c");
  });
  it.each([
    ["U+202A", "\u202a"], ["U+202B", "\u202b"], ["U+202C", "\u202c"], ["U+202D", "\u202d"], ["U+202E", "\u202e"],
    ["U+2066", "\u2066"], ["U+2067", "\u2067"], ["U+2068", "\u2068"], ["U+2069", "\u2069"], ["U+2028", "\u2028"], ["U+2029", "\u2029"],
  ])("refuses a title with %s, which reorders or breaks what a person reads", (_name, ch) => {
    expect(() => hcTitleRecord(`seat${ch}name`)).toThrow();
  });
  it.each(["\u2027", "\u202f", "\u2065", "\u206a"])("accepts the neighbours of those ranges (%j)", (ch) => {
    expect(hcTitleRecord(`a${ch}b`)).toBe(OSC2(`a${ch}b`));
  });
  it("accepts the longest title", () => {
    expect(hcTitleRecord("x".repeat(128))).toBe(OSC2("x".repeat(128)));
  });
});

describe("the title sink", () => {
  it("does not exist for a terminal herdr-core does not host (no HC_TERMINAL_ID, or an empty one)", () => {
    expect(createRunnerHcTitleSink({}, () => undefined, "s@r")).toBeUndefined();
    expect(createRunnerHcTitleSink({ HC_TERMINAL_ID: "" }, () => undefined, "s@r")).toBeUndefined();
  });
  it("writes the seat's session name once per call", () => {
    const out: string[] = [];
    createRunnerHcTitleSink({ HC_TERMINAL_ID: "t1" }, (t) => out.push(t), "verify-qa@eztrack")!();
    expect(out).toEqual([OSC2("verify-qa@eztrack")]);
  });
  it("survives a pane that throws, and a title it refuses", () => {
    expect(() => createRunnerHcTitleSink({ HC_TERMINAL_ID: "t1" }, () => { throw new Error("EPIPE"); }, "s@r")!()).not.toThrow();
    const out: string[] = [];
    createRunnerHcTitleSink({ HC_TERMINAL_ID: "t1" }, (t) => out.push(t), "bad\u001bname")!();
    expect(out, "a refused title writes nothing").toEqual([]);
  });
});

describe("the seat banner", () => {
  it("is the session name, the runtime and the model between rules", () => {
    expect(seatBannerLine({ sessionName: "verify-qa@eztrack", runtime: "pi", model: "openai-codex/gpt-6-luna:medium" }))
      .toBe("── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──");
  });
  it("leaves the model out when the launch named none", () => {
    expect(seatBannerLine({ sessionName: "s@r", runtime: "omp" })).toBe("── s@r · omp ──");
  });
  it("is one line and carries none of the markers the daemon looks for on a Pi pane", () => {
    const line = seatBannerLine({ sessionName: "verify-qa@eztrack", runtime: "pi", model: "m/x:medium" });
    expect(line).not.toContain("\n");
    for (const marker of ["[pi-runner]", "[omp-runner]", "READY", "EXITED", "ERROR", "[openrig-msg"]) expect(line).not.toContain(marker);
  });
});

// The deployed path: the real runner main() as the program of an hc-hosted terminal (HC_TERMINAL_ID set), against an offline fake pi.
describe.skipIf(process.platform === "win32")("the real runner writes the title and the banner first", () => {
  async function runnerOutput(extraEnv: Record<string, string>, sessionName: string): Promise<string> {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "of213-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const sessionFile = path.join(temp, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const cmd=JSON.parse(line); if(cmd.type==='get_state') console.log(JSON.stringify({type:'response',id:cmd.id,success:true,
data:{sessionFile:${JSON.stringify(sessionFile)},sessionId:'offline'}}));
});\n`, { mode: 0o700 });
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", sessionName, "--state-root", path.join(temp, "state"), "--cwd", temp,
      "--launch-id", "of213", "--no-approve", "--model", "openai-codex/gpt-6-luna:medium"], {
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home"), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    try {
      const by = Date.now() + 20_000;
      while (!output.includes(PI_RUNNER_READY_MARKER) && !output.includes(PI_RUNNER_ERROR_MARKER) && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
      expect(output).toContain(PI_RUNNER_READY_MARKER);
      await new Promise((r) => setTimeout(r, 400));     // the idle status record follows the READY line
      return output;
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once("exit", () => r()); });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  it("in an hc terminal: the title record, then the banner, before anything else the runner prints", async () => {
    const out = await runnerOutput({ HC_TERMINAL_ID: "t9" }, "verify-qa@eztrack");
    expect(out.startsWith(`${OSC2("verify-qa@eztrack")}── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──\n[pi-runner] seat verify-qa@eztrack:`), JSON.stringify(out.slice(0, 200))).toBe(true);
    expect(out.split("\u001b]2;").length - 1, "the title is written once").toBe(1);
  }, 40_000);

  it("in an hc terminal: the status record names the seat as its app, not \"pi-runner\" (what the pane header shows)", async () => {
    const out = await runnerOutput({ HC_TERMINAL_ID: "t9" }, "verify-qa@eztrack");
    expect(out).toContain("\u001b]7501;state=idle:app=verify-qa.eztrack\u001b\\");
    expect(out).not.toContain("app=pi-runner");
  }, 40_000);

  it("outside an hc terminal: the banner, and no escape bytes at all", async () => {
    const out = await runnerOutput({}, "verify-qa@eztrack");
    expect(out.startsWith("── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──\n")).toBe(true);
    expect(out).not.toContain("\u001b");
  }, 40_000);
});
