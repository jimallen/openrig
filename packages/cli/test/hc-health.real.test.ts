// What hc-health.test.ts can only assume about a core, measured on a private one: its own HOME, HC_SESSION and XDG
// paths, never the machine's core. Skipped where hc is absent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_GENERATION, HC_TESTED_VERSION, classifyHcCore, parseHcVersion, probeHcInstall, readHcHello } from "../src/tmux-health.js";
import { resolveHcSocket } from "@openrig/daemon/hc";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** Restated from the rule's definition (same major.minor as 0.1.16, patch 15 or more), not imported from it. */
const accepts = (version: string | null): boolean => version !== null && /^0\.1\.(1[5-9]|[2-9]\d|\d{3,})$/.test(version);

describe.skipIf(!HC)("hc health against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "hcw1-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `w${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  const socket = resolveHcSocket(env, env.HOME);
  let started = false;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  });
  afterAll(() => {
    if (started) spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("`hc --version` starts no core, and with no core the socket read says so", async () => {
    const output = execFileSync(HC, ["--version"], { env, encoding: "utf8" });
    expect(parseHcVersion(output)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(socket)).toBe(false);
    expect(await readHcHello(socket)).toMatchObject({ kind: "no_core" });
    expect(existsSync(socket)).toBe(false);  // reading the socket did not start one either
  });

  it("probeHcInstall runs the real binary", () => {
    const probe = probeHcInstall((cmd) => execFileSync("sh", ["-c", cmd], { env, encoding: "utf8" }));
    expect(probe.installed).toBe(true);
    expect(probe.version).toBe(parseHcVersion(execFileSync(HC, ["--version"], { env, encoding: "utf8" })));
    // The same rule on the real binary's own version: the tested minor line from 0.1.15 up is accepted, and only the tested version is silent.
    expect(probe.code).toBe(accepts(probe.version) ? "pinned" : "version_mismatch");
    expect(probe.warning === undefined).toBe(probe.version === HC_TESTED_VERSION || !accepts(probe.version));
  });

  it("reads hello from a running core: this generation, and the version hc --version names", async () => {
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    started = true;
    const hello = await readHcHello(socket);
    expect(hello).toMatchObject({ kind: "hello", generation: HC_GENERATION });
    if (hello.kind !== "hello") throw new Error("unreachable");
    expect(hello.version).toBe(parseHcVersion(execFileSync(HC, ["--version"], { env, encoding: "utf8" })));
    expect(classifyHcCore(hello).code).toBe(accepts(hello.version) ? "available" : "version_mismatch");
  });

  it("a real core refuses another generation with kind unsupported_generation, which classifyHcCore reads", async () => {
    const reply = await new Promise<{ error?: { message: string; data?: { kind?: string } } }>((resolve, reject) => {
      const conn = createConnection(socket);
      let buffer = "";
      conn.setEncoding("utf8");
      conn.on("error", reject);
      conn.on("connect", () => conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: HC_GENERATION + 98, framed: false } })}\n`));
      conn.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) { conn.destroy(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
      });
    });
    expect(reply.error?.data?.kind).toBe("unsupported_generation");
    expect(classifyHcCore({ kind: "refused", refusal: reply.error!.data!.kind!, detail: reply.error!.message }).code).toBe("unsupported_generation");
  });
});
