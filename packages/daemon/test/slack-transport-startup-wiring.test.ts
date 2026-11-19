// workspaces-09u (build-arch's nit on o9o.183): the daemon's composition root hands the production Slack transport
// (src/adapters/slack-http-transport.ts) to the domain at two startup sites, health readiness and the gateway subsystem's
// wire. The CLI side is pinned by slack-verify-transport.test.ts; this pins the daemon side the same way, by sentinel
// identity: the adapter module is replaced with a sentinel, the daemon is booted for real, and each site must hand the domain
// exactly that sentinel. Wiring any other transport at either site fails its own row.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackTransport } from "../src/domain/gateway/slack/slack-api.js";
import type { SlackWireOpts } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { ExecFn } from "../src/adapters/tmux.js";

type DiagnosisDeps = ConstructorParameters<typeof import("../src/domain/health-diagnosis.js").HealthDiagnosisService>[0];

const seen = vi.hoisted(() => ({
  sentinel: (async (url: string) => { throw new Error(`the startup-wiring sentinel transport was called for ${url}`); }),
  readinessTransports: [] as unknown[],
  wireTransports: [] as unknown[],
  diagnosisDeps: [] as unknown[],
}));

vi.mock("../src/adapters/slack-http-transport.js", () => ({ slackHttpTransport: seen.sentinel }));

vi.mock("../src/domain/health-context.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/health-context.js")>();
  return {
    ...original,
    healthHumanReadiness: async (...args: Parameters<typeof original.healthHumanReadiness>) => {
      seen.readinessTransports.push(args[4]);
      return { ready: false, reason: "startup-wiring fixture: readiness is not computed here" };
    },
  };
});

vi.mock("../src/domain/health-diagnosis.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/health-diagnosis.js")>();
  class RecordingHealthDiagnosisService extends original.HealthDiagnosisService {
    constructor(deps: DiagnosisDeps) {
      super(deps);
      seen.diagnosisDeps.push(deps);
    }
  }
  return { ...original, HealthDiagnosisService: RecordingHealthDiagnosisService };
});

vi.mock("../src/domain/gateway/slack/slack-subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/gateway/slack/slack-subsystem.js")>();
  return {
    ...original,
    buildSlackGatewayWire: (opts: SlackWireOpts) => {
      seen.wireTransports.push(opts.transport);
      return original.buildSlackGatewayWire(opts);
    },
  };
});

const tmuxExec: ExecFn = async () => "";

describe("workspaces-09u: the daemon's startup sites hand the domain the production Slack transport", () => {
  let close: (() => void) | undefined;
  let diagnosis: DiagnosisDeps | undefined;

  beforeAll(async () => {
    process.env.OPENRIG_NO_KERNEL = "1";
    const { createDaemon } = await import("../src/startup.js");
    const { db } = await createDaemon({ tmuxExec });
    close = () => db.close();
    diagnosis = seen.diagnosisDeps.at(-1) as DiagnosisDeps | undefined;
  }, 30_000);

  afterAll(() => {
    close?.();
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("positive control: the sentinel is not a working transport, so an identity match cannot be a coincidence", async () => {
    const transport: SlackTransport = seen.sentinel;
    await expect(transport("https://slack.com/api/auth.test")).rejects.toThrow(/startup-wiring sentinel/);
  });

  it("health readiness: the diagnosis service's readiness check passes the adapter's transport to the domain", async () => {
    expect(diagnosis?.humanReadiness, "createDaemon builds a HealthDiagnosisService with a humanReadiness check").toBeTypeOf("function");
    await diagnosis!.humanReadiness!("human@startup-wiring");
    expect(seen.readinessTransports).toHaveLength(1);
    expect(seen.readinessTransports[0]).toBe(seen.sentinel);
  });

  it("gateway subsystem: the Slack wire is built with the adapter's transport", () => {
    expect(seen.wireTransports.length, "the gateway subsystem built its Slack wire at boot").toBeGreaterThan(0);
    for (const transport of seen.wireTransports) expect(transport).toBe(seen.sentinel);
  });
});
