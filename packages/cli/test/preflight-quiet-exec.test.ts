// A probe run by the preflight's execSync with no stdio would have Node copy the probe's stderr to the terminal. The
// probe still needs that text to tell a missing hc from a broken one, so it must arrive in the thrown error and
// nowhere else.
import { describe, it, expect, vi, afterEach } from "vitest";
import { quietPreflightExec } from "../src/system-preflight.js";
import { HC_PINNED_VERSION, probeHcInstallAsync } from "../src/tmux-health.js";

const node = JSON.stringify(process.execPath);
const failWith = (text: string) => `${node} -e "process.stderr.write(${JSON.stringify(text).replaceAll('"', '\\"')}); process.exit(1)"`;

describe("quietPreflightExec", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps a failing probe's stderr off the terminal and in the error", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const refusal = "hc: cannot reach the core at /private/tmp/hc/default.sock (No such file or directory)";
    await expect(quietPreflightExec(failWith(refusal))).rejects.toThrow(/cannot reach the core/);
    expect(writes.join("")).not.toContain("cannot reach the core");
  });

  it("still lets the hc probe tell a missing hc from an hc that answers", async () => {
    const run = (stderr: string) => probeHcInstallAsync(async () => quietPreflightExec(failWith(stderr)));
    expect(await run("hc: command not found")).toMatchObject({ code: "not_installed", installed: false, detail: expect.stringContaining("command not found") });
    const answers = probeHcInstallAsync(async () => quietPreflightExec(`${node} -e "process.stdout.write('hc ${HC_PINNED_VERSION}')"`));
    expect(await answers).toMatchObject({ code: "pinned", installed: true, version: HC_PINNED_VERSION });
  });
});
