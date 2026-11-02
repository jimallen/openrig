import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { daemonStartArgs, daemonStartExecOptions } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

describe("local startup target", () => {
  it("starts only the intended local daemon, leaving occupant selection to the user", () => {
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--host", "127.0.0.1", "--port", "17433",
    ]);
  });
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "does not turn %s into local startup authority", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("no local daemon was started");
    },
  );
  it("unavailable prerequisites permit inspection/retry but no recovery effects", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});

describe("the person's `s` key starts the daemon without the seat identity of the pane the TUI runs in", () => {
  // The kernel's TUI is a terminal node, so its shell carries a seat's identity; `rig daemon start` refuses a seat (packages/cli
  // seat-daemon-guard.ts), and this key is a person's keypress. The four names are restated here, as in that guard's test.
  const IDENTITY = ["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"];
  const pane = { PATH: "/bin", HOME: "/h", XDG_RUNTIME_DIR: "/run/x", OPENRIG_HOME: "/oh", OPENRIG_RUNTIME: "terminal",
    OPENRIG_SESSION_NAME: "human@kernel", OPENRIG_NODE_ID: "n1", RIGGED_SESSION_NAME: "human@kernel", RIGGED_NODE_ID: "n1" };
  it("drops exactly the four identity names, and keeps the rest (the runtime dir, the home, the instance)", () => {
    const { env } = daemonStartExecOptions(pane);
    for (const name of IDENTITY) expect(env, name).not.toHaveProperty(name);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", XDG_RUNTIME_DIR: "/run/x", OPENRIG_HOME: "/oh", OPENRIG_RUNTIME: "terminal" });
  });
  it("keeps the 30 s bound, and does not change the env it was given", () => {
    const before = { ...pane };
    expect(daemonStartExecOptions(pane).timeout).toBe(30_000);
    expect(pane).toEqual(before);
  });
});

describe("every place the TUI runs `rig daemon start` uses those options (main.ts is not importable, so its source is read)", () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts"), "utf8");
  // A positional predicate: every execFile call line that names the daemon-start argv, not a hand-listed set of three.
  const startCalls = main.split("\n").filter((line) => /execFile\(/.test(line) && /daemonStartArgs\(|startArgs\)|\["daemon", "start"\]/.test(line));
  it("finds the three start calls (positive control)", () => {
    expect(startCalls).toHaveLength(3);
  });
  it("each passes daemonStartExecOptions(process.env), none a bare { timeout }", () => {
    for (const line of startCalls) {
      expect(line).toContain("daemonStartExecOptions(process.env)");
      expect(line).not.toContain("{ timeout:");
    }
  });
});
