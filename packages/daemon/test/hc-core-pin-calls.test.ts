import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_GENERATION, HcClient, HcError, checkHcHello, type HcHello } from "../src/adapters/hc-client.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { CoreSizeSource } from "../src/adapters/hc-viewer.js";
import { pinCallsToCore } from "../src/adapters/hc-core-watch.js";
import { HC_TESTED_VERSION } from "../src/adapters/hc-version.js";

// Security review F5: the core pin (version, core id) was a startup gate and a log line. After startup a swapped core was still
// served. Now every hello this build makes to the pinned socket passes the pin, for calls, attach and the size watch alike.

const hello = (over: Partial<HcHello> = {}, framed = false): HcHello => ({
  generation: HC_GENERATION, version: HC_TESTED_VERSION, core: { id: "core-1", name: "n" }, framed, methods: [], features: [], ...over,
});

const scratch: { dir: string; server: Server }[] = [];
const lifts: (() => void)[] = [];
/** A fake core: answers hello with `answer`, and counts every other method it is asked. */
async function fakeCore(answer: HcHello): Promise<{ path: string; asked: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "hc-pin-"));
  const path = join(dir, "c.sock");
  const asked: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)) as { id: number; method: string };
        buffer = buffer.slice(end + 1);
        if (message.method === "hello") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer })}\n`);
        else { asked.push(message.method); socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`); }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  scratch.push({ dir, server });
  return { path, asked };
}
afterEach(async () => {
  for (const lift of lifts.splice(0)) lift();
  for (const { dir, server } of scratch.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

const watchOf = (coreId: string | undefined) => ({ pinnedCoreId: () => coreId });

describe("a pinned core, after startup", () => {
  it("serves a call to the core that was pinned", async () => {
    const core = await fakeCore(hello());
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    await expect(new HcClient(core.path).call("terminal.list")).resolves.toEqual({ ok: true });
    expect(core.asked).toEqual(["terminal.list"]);
  });

  it("refuses a call once the core runs another hc version, and sends nothing", async () => {
    const core = await fakeCore(hello({ version: "0.1.14" }));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    await expect(new HcClient(core.path).call("terminal.list")).rejects.toMatchObject({ name: "HcError", kind: "unsupported_version" });
    expect(core.asked).toEqual([]);
  });

  it.each(["0.1.15", "0.1.17", "0.1.99"])("serves a call to a core that moved to hc %s (accepted, not the tested version): the same version rule as the watch", async (version) => {
    const core = await fakeCore(hello({ version }));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    await expect(new HcClient(core.path).call("terminal.list")).resolves.toEqual({ ok: true });
    expect(core.asked).toEqual(["terminal.list"]);
  });

  it.each(["0.2.0", "0.2.16", "1.1.16", "0.1.16-rc1"])("refuses a call once the core runs hc %s (another minor, another major, malformed)", async (version) => {
    const core = await fakeCore(hello({ version }));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    await expect(new HcClient(core.path).call("terminal.list")).rejects.toMatchObject({ name: "HcError", kind: "unsupported_version" });
    expect(core.asked).toEqual([]);
  });

  it("refuses a call once another core answers (core_changed), and sends nothing", async () => {
    const core = await fakeCore(hello({ core: { id: "core-2", name: "n" } }));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    const err = await new HcClient(core.path).call("terminal.get", { terminal: "t1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcError);
    expect(err).toMatchObject({ kind: "core_changed" });
    expect(core.asked).toEqual([]);
  });

  it("follows the core id the watch pins later: unpinned at first (core was down at start), checked once the watch has seen one", async () => {
    const core = await fakeCore(hello({ core: { id: "core-2", name: "n" } }));
    const state: { id: string | undefined } = { id: undefined };
    lifts.push(pinCallsToCore(core.path, { pinnedCoreId: () => state.id }));
    await expect(new HcClient(core.path).call("terminal.list")).resolves.toEqual({ ok: true });
    state.id = "core-1";
    await expect(new HcClient(core.path).call("terminal.list")).rejects.toMatchObject({ kind: "core_changed" });
  });

  it("refuses an attach and a size watch the same way, before they ask for anything", async () => {
    const core = await fakeCore(hello({ version: "0.1.14" }, true));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    const noop = { onData: () => {}, onEnd: () => {} };
    await expect(new HcAttach(core.path).open({ terminal: "s-x", cols: 80, rows: 24, observe: true }, noop)).rejects.toMatchObject({ kind: "unsupported_version" });
    await expect(new CoreSizeSource(core.path).watch("s-x", { size: () => {}, lost: () => {} })).rejects.toMatchObject({ kind: "unsupported_version" });
    expect(core.asked).toEqual([]);
  });

  it("leaves the core watch's own probes alone, so it can still see and name a refused core", async () => {
    const core = await fakeCore(hello({ version: "0.1.14" }));
    lifts.push(pinCallsToCore(core.path, watchOf("core-1")));
    await expect(new HcClient(core.path, undefined, false).hello()).resolves.toMatchObject({ version: "0.1.14" });
  });

  it("is a pin on that socket only, and can be lifted", async () => {
    const core = await fakeCore(hello({ version: "0.1.14" }));
    const other = await fakeCore(hello({ version: "0.1.14" }));
    const lift = pinCallsToCore(core.path, watchOf("core-1"));
    await expect(new HcClient(other.path).call("terminal.list")).resolves.toEqual({ ok: true });  // control: no pin for this socket
    await expect(new HcClient(core.path).call("terminal.list")).rejects.toBeInstanceOf(HcError);
    lift();
    await expect(new HcClient(core.path).call("terminal.list")).resolves.toEqual({ ok: true });
    expect(() => checkHcHello(core.path, hello({ version: "9" }))).not.toThrow();
  });
});

describe("startup", () => {
  it("pins the calls to the core it connected to", () => {
    const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const hcCoreWatch = hcClient \? await connectHcCore\(\{ socketPath: hcClient\.socketPath, client: hcClient, onCoreVersion: [^\n]*\}\) : undefined;\s*[^\n]*\n\s*if \(hcClient && hcCoreWatch\) pinCallsToCore\(hcClient\.socketPath, hcCoreWatch\);/);
  });
});
