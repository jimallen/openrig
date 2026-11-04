import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const serverMock = { prependListener: vi.fn() };
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    signalListenersBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    serveMock.mockReset();
    serverMock.prependListener.mockReset();
    serveMock.mockReturnValue(serverMock);
    createDaemonMock.mockReset();
    createDaemonMock.mockResolvedValue({
      app: { fetch: vi.fn() },
      contextMonitor: { start: vi.fn(), stop: vi.fn() },
      deps: {},
      injectWebSocket: vi.fn(),
    });
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  afterEach(() => {
    // startServer installs shutdown handlers; keep this mock-only fixture isolated.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListenersBefore[signal].includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  it("binds the daemon to loopback", async () => {
    const { startServer } = await import("../src/index.js");

    const server = await startServer(7441);

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7441, hostname: "127.0.0.1" }),
      expect.any(Function)
    );
    expect(server).toBe(serverMock);
    expect(serverMock.prependListener).toHaveBeenCalledWith(
      "request", expect.any(Function),
    );
  });

  describe("OF-208 real simctl is switched on only by the production entrypoint on the user's own home", () => {
    const enable = vi.fn();
    const savedVitest = process.env["VITEST"];
    beforeEach(() => {
      enable.mockReset();
      createDaemonMock.mockResolvedValue({
        app: { fetch: vi.fn() },
        contextMonitor: { start: vi.fn(), stop: vi.fn() },
        deps: { simulatorLifecycle: { enableRealSimctl: enable, startSweepTimer: vi.fn() } },
        injectWebSocket: vi.fn(),
      });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      if (savedVitest === undefined) delete process.env["VITEST"]; else process.env["VITEST"] = savedVitest;
    });

    it("an imported startServer (no realSimctl request) never enables it", async () => {
      delete process.env["VITEST"];
      vi.stubEnv("NODE_ENV", "production");
      const { startServer } = await import("../src/index.js");
      await startServer(7441);
      expect(enable).not.toHaveBeenCalled();
    });

    it("the production entrypoint's request is refused under a test runner", async () => {
      const { startServer } = await import("../src/index.js");
      await startServer(7441, { realSimctl: true });
      expect(enable).not.toHaveBeenCalled();
    });

    it("the request is granted only when the daemon's home is the account's default (OPENRIG_HOME as resolved at import)", async () => {
      delete process.env["VITEST"];
      vi.stubEnv("NODE_ENV", "production");
      const { startServer } = await import("../src/index.js");
      const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
      const os = await import("node:os");
      const path = await import("node:path");
      await startServer(7441, { realSimctl: true });
      const isDefaultHome = path.resolve(OPENRIG_HOME) === path.resolve(path.join(os.userInfo().homedir, ".openrig"));
      expect(enable).toHaveBeenCalledTimes(isDefaultHome ? 1 : 0);
    });
  });

  it("does not require a terminal bearer token for the default loopback bind", async () => {
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBearerToken: null }),
    );
  });

  it("uses the daemon bearer token for terminal routes on explicit public binds", async () => {
    process.env.OPENRIG_BIND_HOST = "0.0.0.0";
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "daemon-token";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerToken: "daemon-token",
        terminalBearerToken: "daemon-token",
      }),
    );
  });
});
