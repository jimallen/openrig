import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPiRuntimeAvailable } from "../src/domain/rigspec-preflight.js";
import { execPreflightCommand } from "../src/adapters/preflight-exec.js";
import { daemonRuntimeProbe, seatRuntimeProbe } from "../src/adapters/seat-runtime-probe.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

// workspaces-o9o.65, reconciled in o9o.11. The relaunch preview said "Pi version 1.5.0 answered on the daemon's PATH"
// (~/.local/bin/pi) while every seat ran ~/.pi/agent/bin/pi 1.4.0: a seat's terminal is a login shell whose startup files put
// another directory first. The seat's PATH now comes from a SeatPathSource (in the daemon, the probe terminal of rig doctor, a
// login shell started the way a seat's is; its framing and its real shells are pinned in host-readiness*.test.ts). Here the
// source is given directly, with two fake Pi executables in a temp dir, so what this file pins is the one resolution rule.

const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function executable(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A daemon whose PATH finds one Pi, and a seat PATH that puts another Pi first (or has none, with `seatHasPi` false). Hermetic:
 *  only the fake folders, so a probe that loses its way lands on the daemon's fake Pi (1.5.0), never on a real Pi on the host. */
function host(seatHasPi = true): { daemonPi: string; seatPi: string; seatPath: string; daemonEnv: NodeJS.ProcessEnv } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o9o65-")));
  temps.push(root);
  const daemonPi = executable(path.join(root, "daemon-bin", "pi"), "echo 1.5.0");
  const seatPi = path.join(root, "seat-bin", "pi");
  if (seatHasPi) executable(seatPi, 'echo "pi 1.4.0"');
  else fs.mkdirSync(path.dirname(seatPi), { recursive: true });
  const seatPath = seatHasPi ? `${path.dirname(seatPi)}:${path.dirname(daemonPi)}` : path.dirname(seatPi);
  return { daemonPi, seatPi, seatPath, daemonEnv: { PATH: `${path.dirname(daemonPi)}:/usr/bin:/bin`, HOME: root } };
}

const piSpec: PodRigSpec = {
  version: "0.2", name: "o9o65", edges: [],
  pods: [{ id: "dev", label: "dev", edges: [], members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "pi", cwd: "." }] }],
};

describe("o9o.65: the preview names the Pi a seat will launch", () => {
  it("the probe answers with the Pi on the seat's PATH (its path and version), not the daemon's", async () => {
    const { seatPi, seatPath, daemonEnv } = host();
    const probe = seatRuntimeProbe({ seatPath: async () => seatPath, daemonEnv });
    expect(await probe("pi")).toEqual({ path: seatPi, output: "pi 1.4.0\n" });
  });

  it("the daemon-side probe answers with the daemon's Pi, by the same rule", async () => {
    const { daemonPi, daemonEnv } = host();
    expect(await daemonRuntimeProbe({ daemonEnv })("pi")).toEqual({ path: daemonPi, output: "1.5.0\n" });
  });

  it("the preflight's Pi notice names version 1.4.0 at the seat's executable, where the daemon's PATH would give 1.5.0", async () => {
    const { seatPi, seatPath, daemonEnv } = host();
    vi.stubEnv("PATH", daemonEnv["PATH"]!);
    const warnings: string[] = [];
    const errors = await verifyPiRuntimeAvailable(piSpec, execPreflightCommand, warnings, seatRuntimeProbe({ seatPath: async () => seatPath, daemonEnv }));
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Pi 1.4.0 at ${seatPi}, as a login shell started the way a seat's is resolves it`);
    expect(warnings[0]).not.toContain("1.5.0");
  });

  it("a seat PATH with no Pi says so for the seat's shell, and does not echo the PATH", async () => {
    const { seatPi, seatPath, daemonEnv } = host(false);
    vi.stubEnv("PATH", daemonEnv["PATH"]!);
    const warnings: string[] = [];
    const errors = await verifyPiRuntimeAvailable(piSpec, execPreflightCommand, warnings, seatRuntimeProbe({ seatPath: async () => seatPath, daemonEnv }));
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not found on the PATH of a login shell started the way a seat's is/);
    expect(warnings[0]).not.toContain(path.dirname(seatPi));
  });

  it("a seat PATH that cannot be read is unknown, never a guess and never the daemon's Pi", async () => {
    const { daemonEnv } = host();
    const probe = seatRuntimeProbe({ seatPath: async () => { throw new Error("the probe shell did not run"); }, daemonEnv });
    await expect(probe("pi")).rejects.toMatchObject({ code: "EPROTO", message: expect.stringContaining("could not be read (the probe shell did not run)") });
    const warnings: string[] = [];
    vi.stubEnv("PATH", daemonEnv["PATH"]!);
    await verifyPiRuntimeAvailable(piSpec, execPreflightCommand, warnings, probe);
    expect(warnings[0]).toMatch(/^Pi version unknown/);
    expect(warnings[0]).not.toContain("1.5.0");
  });
});
