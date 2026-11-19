// workspaces-o9o.183: the domain's Slack checks take their HTTP as a port (SlackTransport) and hold no default. `rig slack verify`
// hands them the production transport from the gateway-slack surface unless a test injects one. Both routes are pinned here:
// with no injection the surface's transport reaches every check; with one, the injected transport does and the surface's never.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES, mappedChannels, type SlackTransport } from "@openrig/daemon/gateway-slack";
import { slackCommand, type SlackDeps } from "../src/commands/slack.js";
import { slackSurfaceStub } from "./helpers/slack-surface.js";

const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })); process.exitCode = 0; });

function setup(injected?: SlackTransport) {
  const home = mkdtempSync(join(tmpdir(), "slack-verify-transport-"));
  homes.push(home);
  const seen: Array<{ check: string; transport: unknown }> = [];
  const surfaceTransport: SlackTransport = async () => { throw new Error("the surface transport is a sentinel here"); };
  const deps: SlackDeps = {
    home,
    log: () => {},
    ...(injected ? { fetchImpl: injected } : {}),
    surface: async () => slackSurfaceStub({
      loadConfig: () => ({
        enabled: false, inboundDestination: "operator-agent@kernel", outboundDestinations: [], sourceLabel: "vm", channel: "C1",
        requiredScopes: ["chat:write"], secretsEnvFile: null, queueUrl: null, minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT",
      }),
      resolveSecret: () => "bot-token-fixture",
      mappedChannels,
      verifyScopes: async (_token, _required, transport) => { seen.push({ check: "scopes", transport }); return { ok: true, granted: ["chat:write"], missing: [] }; },
      verifyChannelMembership: async (_token, _channel, transport) => { seen.push({ check: "membership", transport }); return { ok: true, isMember: true }; },
      slackHttpTransport: surfaceTransport,
      buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES,
    }),
  };
  return { deps, seen, surfaceTransport };
}

describe("rig slack verify hands the Slack checks a transport (o9o.183)", () => {
  it("with none injected, every check gets the surface's production transport", async () => {
    const { deps, seen, surfaceTransport } = setup();
    await slackCommand(deps).parseAsync(["node", "slack", "verify", "--json", "--actor", "test@rig"]);
    expect(seen.map((s) => s.check)).toEqual(["scopes", "membership"]);
    expect(seen.every((s) => s.transport === surfaceTransport)).toBe(true);
  });

  it("CONTROL: an injected transport reaches every check, and the surface's is never used", async () => {
    const injected: SlackTransport = async () => { throw new Error("injected sentinel"); };
    const { deps, seen, surfaceTransport } = setup(injected);
    await slackCommand(deps).parseAsync(["node", "slack", "verify", "--json", "--actor", "test@rig"]);
    expect(seen.map((s) => s.check)).toEqual(["scopes", "membership"]);
    expect(seen.every((s) => s.transport === injected)).toBe(true);
    expect(seen.some((s) => s.transport === surfaceTransport)).toBe(false);
  });
});
