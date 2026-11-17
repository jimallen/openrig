import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const serverMock = { prependListener: vi.fn() };
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

// OF-208: the real helper, wrapped in a spy so a test can see what startServer hands it.
vi.mock("../src/domain/simulator-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/simulator-lifecycle.js")>();
  return { ...actual, enableRealSimctlIfAllowed: vi.fn(actual.enableRealSimctlIfAllowed) };
});

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

    it("startServer hands the helper its own request flag and the daemon's resolved home (the decision itself is unit-tested)", async () => {
      const { startServer } = await import("../src/index.js");
      const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
      const lifecycle = await import("../src/domain/simulator-lifecycle.js");
      const spy = vi.mocked(lifecycle.enableRealSimctlIfAllowed);

      spy.mockClear();
      await startServer(7441, { realSimctl: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toMatchObject({ requested: true, openrigHome: OPENRIG_HOME, userHome: expect.any(String) });
      expect(spy.mock.calls[0]![0]).toHaveProperty("enableRealSimctl", enable);

      spy.mockClear();
      await startServer(7441);
      expect(spy.mock.calls[0]![1]).toMatchObject({ requested: undefined });
    });
  });

  it("workspaces-o9o.36: daemon start makes the instance private to its owner (home 0700, a 0664 session file 0600)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
    const sessions = path.join(OPENRIG_HOME, "state", "pi", "verify-ops@openrig", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const session = path.join(sessions, "a.jsonl");
    fs.writeFileSync(session, "{}\n");
    fs.chmodSync(session, 0o664);
    fs.chmodSync(OPENRIG_HOME, 0o755);
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect({ home: fs.statSync(OPENRIG_HOME).mode & 0o777, session: fs.statSync(session).mode & 0o777 })
      .toEqual({ home: 0o700, session: 0o600 });
  });

  it("workspaces-o9o.36: daemon start makes a transcripts root configured outside the instance private (dirs 0700, files 0600)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-external-transcripts-"));
    try {
      const transcripts = path.join(base, "transcripts");
      const rigDir = path.join(transcripts, "openrig");
      fs.mkdirSync(rigDir, { recursive: true });
      const transcript = path.join(rigDir, "verify-ops@openrig.log");
      fs.writeFileSync(transcript, "pane text\n");
      fs.chmodSync(transcript, 0o664);
      fs.chmodSync(rigDir, 0o775);
      fs.chmodSync(transcripts, 0o775);
      vi.stubEnv("OPENRIG_TRANSCRIPTS_PATH", transcripts);
      const { startServer } = await import("../src/index.js");

      await startServer(7441);

      const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
      expect({ root: modeOf(transcripts), rigDir: modeOf(rigDir), transcript: modeOf(transcript) })
        .toEqual({ root: 0o700, rigDir: 0o700, transcript: 0o600 });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // workspaces-o9o.74: a db configured outside the home (db.path -> OPENRIG_DB), in a folder of its own, is made private at start.
  it("startServer makes an external db's own folder 0700 and its db files 0600", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "o9o74-db-"));
    try {
      const dir = path.join(base, "db");
      fs.mkdirSync(dir);
      const db = path.join(dir, "openrig.sqlite");
      fs.writeFileSync(db, "db");
      fs.writeFileSync(`${db}-wal`, "wal");
      fs.chmodSync(db, 0o664);
      fs.chmodSync(`${db}-wal`, 0o664);
      fs.chmodSync(dir, 0o775);
      vi.stubEnv("OPENRIG_DB", db);
      const { startServer } = await import("../src/index.js");

      await startServer(7441);

      const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
      expect({ dir: modeOf(dir), db: modeOf(db), wal: modeOf(`${db}-wal`) }).toEqual({ dir: 0o700, db: 0o600, wal: 0o600 });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(base, { recursive: true, force: true });
    }
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
