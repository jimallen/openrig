// workspaces-09u (CoS, after build-arch's nit on o9o.183): the third daemon site that hands the domain the production Slack
// transport is the gateway route GET /human/:entityId/readiness (src/routes/gateway.ts), which calls
// resolveHumanDeliveryReadiness with { slackTransport: slackHttpTransport } when no readiness override is given. Pinned by
// sentinel identity, as slack-transport-startup-wiring.test.ts pins the two startup sites: the adapter module is replaced
// with a sentinel, the route's production path runs, and the domain must receive exactly that sentinel. Wiring any other
// transport there fails this row. (Its own file: the human registry is mocked here, which the daemon boot there must not see.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { SlackTransport } from "../src/domain/gateway/slack/slack-api.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

const seen = vi.hoisted(() => ({
  sentinel: (async (url: string) => { throw new Error(`the gateway-route sentinel transport was called for ${url}`); }),
  transports: [] as unknown[],
}));

vi.mock("../src/adapters/slack-http-transport.js", () => ({ slackHttpTransport: seen.sentinel }));

const human: HumanFragment = {
  entityId: "founder",
  class: "human",
  displayName: "Founder",
  address: "founder@external",
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://founder", role: "primary", handle: "U1" }],
  prefs: { deliveryClass: "B" },
};

vi.mock("../src/domain/gateway/human-registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/gateway/human-registry.js")>();
  return { ...original, loadHumanRegistry: () => ({ ok: true as const, entities: [human] }) };
});

vi.mock("../src/domain/gateway/human-readiness.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/gateway/human-readiness.js")>();
  return {
    ...original,
    resolveHumanDeliveryReadiness: async (...args: Parameters<typeof original.resolveHumanDeliveryReadiness>) => {
      seen.transports.push(args[1].slackTransport);
      return { state: "fixture", ready: false };
    },
  };
});

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe("workspaces-09u: the gateway readiness route hands the domain the production Slack transport", () => {
  it("positive control: the sentinel is not a working transport, so an identity match cannot be a coincidence", async () => {
    const transport: SlackTransport = seen.sentinel;
    await expect(transport("https://slack.com/api/auth.test")).rejects.toThrow(/gateway-route sentinel/);
  });

  it("GET /human/:entityId/readiness (no readiness override) passes the adapter's transport to resolveHumanDeliveryReadiness", async () => {
    const home = mkdtempSync(join(tmpdir(), "09u-gateway-route-"));
    homes.push(home);
    const { gatewayRoutes } = await import("../src/routes/gateway.js");
    const app = new Hono<{ Variables: { gatewaySubsystem: { status: () => { state: string } } } }>();
    app.use("*", async (c, next) => {
      c.set("gatewaySubsystem", { status: () => ({ state: "active" }) });
      await next();
    });
    app.route("/", gatewayRoutes({ home }));
    const response = await app.request("/human/founder/readiness");
    expect(response.status, "the route's production path ran (registry mocked with one human)").toBe(200);
    expect(seen.transports).toHaveLength(1);
    expect(seen.transports[0]).toBe(seen.sentinel);
  });
});
