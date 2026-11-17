import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPiRuntimeAvailable, type SeatRuntimeProbe } from "../src/domain/rigspec-preflight.js";
import { execPreflightCommand } from "../src/adapters/preflight-exec.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

// workspaces-o9o.65. The relaunch preview said "Pi version 1.5.0 answered on the daemon's PATH" (~/.local/bin/pi) while every
// seat ran ~/.pi/agent/bin/pi 1.4.0: a seat's terminal is the daemon's SHELL as a LOGIN shell, whose profile puts another
// directory first. Here a fake login shell does the same with two fake Pi executables in a temp dir.

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

/** A daemon whose PATH finds one Pi, and a login shell whose profile puts another Pi first (or none, with `seatHasPi` false). */
function host(seatHasPi = true): { daemonPi: string; seatPi: string; daemonEnv: NodeJS.ProcessEnv } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o9o65-")));
  temps.push(root);
  const daemonPi = executable(path.join(root, "daemon-bin", "pi"), "echo 1.5.0");
  const seatPi = path.join(root, "seat-bin", "pi");
  if (seatHasPi) executable(seatPi, 'echo "pi 1.4.0"');
  else fs.mkdirSync(path.dirname(seatPi), { recursive: true });
  // A login shell's profile, read only when it runs as a login shell (-l): it puts the seat's directory first, and with no Pi there
  // leaves the daemon's directory out. Run without -l it keeps the daemon's PATH, so the probe must ask a LOGIN shell.
  const seatPath = seatHasPi ? `${path.dirname(seatPi)}:${process.env["PATH"]}` : `${path.dirname(seatPi)}:/usr/bin:/bin`;
  const loginShell = executable(path.join(root, "login-shell"),
    `if [ "$1" = "-l" ]; then shift; PATH="${seatPath}"; export PATH; fi\nexec /bin/sh "$@"`);
  return { daemonPi, seatPi, daemonEnv: { ...process.env, PATH: `${path.dirname(daemonPi)}:${process.env["PATH"]}`, SHELL: loginShell } };
}

/** The probe module is new in this change; loaded dynamically so this file also runs (and fails on the symptom) without it. */
async function probeFor(daemonEnv: NodeJS.ProcessEnv): Promise<SeatRuntimeProbe | undefined> {
  try {
    const mod = await import("../src/adapters/seat-runtime-probe.js");
    return mod.seatRuntimeProbe({ daemonEnv });
  } catch {
    return undefined;
  }
}

const piSpec: PodRigSpec = {
  version: "0.2", name: "o9o65", edges: [],
  pods: [{ id: "dev", label: "dev", edges: [], members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "pi", cwd: "." }] }],
};

describe("o9o.65: the preview names the Pi a seat will launch", () => {
  it("the probe answers with the seat's Pi (its path and version), not the daemon's", async () => {
    const { seatPi, daemonEnv } = host();
    const probe = await probeFor(daemonEnv);
    expect(probe, "seat-runtime-probe exists").toBeDefined();
    expect(await probe!("pi")).toEqual({ path: seatPi, output: "pi 1.4.0\n" });
  });

  it("the preflight's Pi notice names version 1.4.0 at the seat's executable, where the daemon's PATH would give 1.5.0", async () => {
    const { seatPi, daemonEnv } = host();
    vi.stubEnv("PATH", daemonEnv["PATH"]!);
    vi.stubEnv("SHELL", daemonEnv["SHELL"]!);
    const warnings: string[] = [];
    const errors = await verifyPiRuntimeAvailable(piSpec, execPreflightCommand, warnings, await probeFor(daemonEnv));
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Pi 1.4.0 at ${seatPi}, as a non-interactive login shell resolves it`);
    expect(warnings[0]).not.toContain("1.5.0");
  });

  it("a seat PATH with no Pi says so for the seat's shell, and does not echo the PATH", async () => {
    const { seatPi, daemonEnv } = host(false);
    vi.stubEnv("PATH", daemonEnv["PATH"]!);
    vi.stubEnv("SHELL", daemonEnv["SHELL"]!);
    const warnings: string[] = [];
    const errors = await verifyPiRuntimeAvailable(piSpec, execPreflightCommand, warnings, await probeFor(daemonEnv));
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not found on the PATH of a non-interactive login shell/);
    expect(warnings[0]).not.toContain(path.dirname(seatPi));
  });
});
