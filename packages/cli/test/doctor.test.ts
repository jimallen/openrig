import { describe, it, expect, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { Command } from "commander";
import { doctorCommand, runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { HC_GENERATION, HC_PINNED_VERSION, type HcHelloOutcome } from "../src/tmux-health.js";

const defaultConfig = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: "/tmp/openrig/openrig.sqlite" },
  transcripts: { enabled: true, path: "/tmp/openrig/transcripts" },
};

function makeDeps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => {
      if (cmd === "hc --version") return "hc 0.1.16\n";
      return "";
    },
    checkPort: async () => true,
    configStore: { resolve: () => defaultConfig },
    platform: "darwin",
    mkdirp: () => {},
    checkWritable: () => {},
    readHcHello: async () => ({ kind: "no_core", detail: "fixture: no core" }),
    ...overrides,
  };
}

describe("runDoctorChecks", () => {
  it("monorepo command-dir base resolves via the same daemon root seam as daemon start", () => {
    const deps = makeDeps({
      baseDir: "/Users/example/code/openrig/packages/cli/src/commands",
      exists: (p) =>
        p === "/Users/example/code/openrig/packages/daemon/dist/index.js"
        || p === "/Users/example/code/openrig/packages/ui/dist/index.html",
    });

    const { checks } = runDoctorChecks(deps);
    expect(checks.find((c) => c.name === "daemon_dist")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "ui_dist")?.status).toBe("pass");
  });

  it("daemon dist found -> pass", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("dist/index.js") || p.endsWith("index.html") });
    const { checks } = runDoctorChecks(deps);
    const daemonCheck = checks.find((c) => c.name === "daemon_dist");
    expect(daemonCheck?.status).toBe("pass");
  });

  it("daemon dist missing -> fail with guidance", () => {
    const deps = makeDeps({ exists: () => false });
    const { checks } = runDoctorChecks(deps);
    const daemonCheck = checks.find((c) => c.name === "daemon_dist");
    expect(daemonCheck?.status).toBe("fail");
    expect(daemonCheck?.reason).toBeTruthy();
    expect(daemonCheck?.fix).toBeTruthy();
  });

  it("UI dist found -> pass", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("index.html") || p.endsWith("dist/index.js") });
    const { checks } = runDoctorChecks(deps);
    const uiCheck = checks.find((c) => c.name === "ui_dist");
    expect(uiCheck?.status).toBe("pass");
  });

  it("UI dist missing -> fail with guidance", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("dist/index.js") }); // daemon exists but not UI
    const { checks } = runDoctorChecks(deps);
    const uiCheck = checks.find((c) => c.name === "ui_dist");
    expect(uiCheck?.status).toBe("fail");
    expect(uiCheck?.reason).toContain("UI");
    expect(uiCheck?.fix).toBeTruthy();
  });

  const hcExec = (hc: () => string) => (cmd: string) => {
    if (cmd === "hc --version") return hc();
    return "";
  };

  it("hc installed at the pinned version -> pass, naming the version", () => {
    const { checks } = runDoctorChecks(makeDeps({ exec: hcExec(() => `hc ${HC_PINNED_VERSION}\n`) }));
    const hcCheck = checks.find((c) => c.name === "hc");
    expect(hcCheck?.status).toBe("pass");
    expect(hcCheck?.message).toBe(`hc ${HC_PINNED_VERSION}`);
  });

  it("hc of another version than the pin -> fail naming both versions", () => {
    const { checks } = runDoctorChecks(makeDeps({ exec: hcExec(() => "hc 0.1.14\n") }));
    const hcCheck = checks.find((c) => c.name === "hc");
    expect(hcCheck?.status).toBe("fail");
    expect(hcCheck?.message).toContain("not the pinned version");
    expect(hcCheck?.reason).toContain("0.1.14");
    expect(hcCheck?.reason).toContain(HC_PINNED_VERSION);
  });

  it("hc version output that cannot be read -> fail, not a pass", () => {
    const { checks } = runDoctorChecks(makeDeps({ exec: hcExec(() => "usage: hc\n") }));
    expect(checks.find((c) => c.name === "hc")?.status).toBe("fail");
  });

  it("hc missing -> fail with guidance", () => {
    const { checks } = runDoctorChecks(makeDeps({ exec: hcExec(() => { throw new Error("not found"); }) }));
    const hcCheck = checks.find((c) => c.name === "hc");
    expect(hcCheck?.status).toBe("fail");
    expect(hcCheck?.fix).toContain("Install hc");
  });

  it("there is no tmux check, no tmux mouse check, and no tmux command run", () => {
    const seen: string[] = [];
    const exec = hcExec(() => `hc ${HC_PINNED_VERSION}\n`);
    for (const platform of ["darwin", "linux"] as const) {
      const { checks } = runDoctorChecks(makeDeps({ platform, exec: (cmd) => { seen.push(cmd); return exec(cmd); } }));
      expect(checks.some((c) => c.name === "tmux" || c.name === "tmux_mouse")).toBe(false);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((cmd) => cmd.startsWith("tmux"))).toBe(false);
  });

  describe("the running core", () => {
    const core = async (readHcHello: () => Promise<HcHelloOutcome>, over: Partial<DoctorDeps> = {}) => {
      const { asyncChecks } = runDoctorChecks(makeDeps({ exec: hcExec(() => `hc ${HC_PINNED_VERSION}\n`), readHcHello, ...over }));
      return (await Promise.all(asyncChecks)).find((c) => c.name === "hc_core");
    };

    it("pass on the pinned version and this generation", async () => {
      const check = await core(async () => ({ kind: "hello", generation: HC_GENERATION, version: HC_PINNED_VERSION }));
      expect(check).toMatchObject({ status: "pass" });
      expect(check?.message).toContain(HC_PINNED_VERSION);
    });

    it("fail on another protocol generation, whether the core refuses or answers", async () => {
      const answers: HcHelloOutcome[] = [
        { kind: "hello", generation: HC_GENERATION + 1, version: HC_PINNED_VERSION },
        { kind: "refused", refusal: "unsupported_generation", detail: "this core speaks generation 2" },
      ];
      for (const answer of answers) {
        const check = await core(async () => answer);
        expect(check?.status, answer.kind).toBe("fail");
        expect(check?.message, answer.kind).toContain("protocol generation");
      }
    });

    it("fail on a core of another version", async () => {
      const check = await core(async () => ({ kind: "hello", generation: HC_GENERATION, version: "0.1.14" }));
      expect(check?.status).toBe("fail");
      expect(check?.reason).toContain("0.1.14");
    });

    it("fail on a core that does not answer", async () => {
      expect((await core(async () => ({ kind: "unreadable", detail: "no reply to hello in 3000 ms" })))?.status).toBe("fail");
    });

    it("pass, with a note, when no core runs: a doctor run starts none", async () => {
      const check = await core(async () => ({ kind: "no_core", detail: "no hc core at /x (ENOENT)" }));
      expect(check?.status).toBe("pass");
      expect(check?.message).toContain("No hc core running");
    });

    it("is not asked when hc itself is missing or the wrong version", async () => {
      const readHcHello = vi.fn(async (): Promise<HcHelloOutcome> => ({ kind: "no_core", detail: "x" }));
      const { asyncChecks } = runDoctorChecks(makeDeps({ exec: hcExec(() => "hc 0.1.14\n"), readHcHello }));
      expect((await Promise.all(asyncChecks)).some((c) => c.name === "hc_core")).toBe(false);
      expect(readHcHello).not.toHaveBeenCalled();
    });
  });

  it("runs no cmux command and reports no cmux check (cmux was removed); positive control: the hc probe still ran", async () => {
    const seen: string[] = [];
    const urls: string[] = [];
    const deps = makeDeps({
      exec: (cmd: string) => { seen.push(cmd); return cmd === "hc --version" ? "hc 0.1.16\n" : ""; },
      checkPort: async () => false,
      fetch: async (url: string) => { urls.push(url); return { ok: true, json: async () => ({}) } as Response; },
    });
    const { checks, asyncChecks } = runDoctorChecks(deps);
    const all = [...checks, ...(await Promise.all(asyncChecks))];

    expect(seen).toContain("hc --version");
    expect(seen.filter((c) => /cmux/i.test(c))).toEqual([]);
    expect(urls.filter((u) => /cmux/i.test(u))).toEqual([]);
    expect(all.filter((c) => /cmux/i.test(c.name))).toEqual([]);
  });

  it.each([
    ["v20.20.2", "fail"],
    ["v22.22.1", "pass"],
    ["v23.11.1", "fail"],
    ["v24.21.0", "pass"],
    ["v25.8.0", "fail"],
    ["v26.1.0", "warn"],
  ] as const)("Node %s → node_version %s", (version, status) => {
    const saved = process.version;
    Object.defineProperty(process, "version", { value: version, writable: true });
    try {
      const { checks } = runDoctorChecks(makeDeps());
      const nodeCheck = checks.find((c) => c.name === "node_version");
      expect(nodeCheck?.status).toBe(status);
      if (status !== "pass") expect(nodeCheck?.message).toContain(status === "warn" ? "untested" : "not supported");
      if (status === "fail") expect(nodeCheck?.fix).toContain("Node 22 or 24");
    } finally {
      Object.defineProperty(process, "version", { value: saved, writable: true });
    }
  });

  it("Node version check passes on current Node", () => {
    const deps = makeDeps();
    const { checks } = runDoctorChecks(deps);
    const nodeCheck = checks.find((c) => c.name === "node_version");
    expect(nodeCheck?.status).toBe("pass");
  });

  it("writable_home missing -> fail with guidance", () => {
    const deps = makeDeps({
      checkWritable: () => {
        throw new Error("permission denied");
      },
    });
    const { checks } = runDoctorChecks(deps);
    const writableCheck = checks.find((c) => c.name === "writable_home");
    expect(writableCheck?.status).toBe("fail");
    expect(writableCheck?.message).toContain("Cannot write");
    expect(writableCheck?.fix).toContain("permissions");
  });

  it("port available -> pass", async () => {
    const deps = makeDeps({ checkPort: async () => true });
    const { portCheck } = runDoctorChecks(deps);
    const result = await portCheck;
    expect(result.status).toBe("pass");
  });

  it("port blocked by non-daemon process -> fail with guidance", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    try {
      const deps = makeDeps({ checkPort: async () => false });
      const { portCheck } = runDoctorChecks(deps);
      const result = await portCheck;
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("port");
      expect(result.fix).toContain("7433");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("port in use by OpenRig daemon -> pass", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    try {
      const deps = makeDeps({ checkPort: async () => false });
      const { portCheck } = runDoctorChecks(deps);
      const result = await portCheck;
      expect(result.status).toBe("pass");
      expect(result.message).toContain("OpenRig daemon");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("rig doctor", () => {
  function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
    return new Promise(async (resolve) => {
      const logs: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      const origExitCode = process.exitCode;
      process.exitCode = undefined;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      console.error = (...args: unknown[]) => logs.push(args.join(" "));
      try { await fn(); } finally {
        console.log = origLog;
        console.error = origErr;
      }
      const exitCode = process.exitCode;
      process.exitCode = origExitCode;
      resolve({ logs, exitCode });
    });
  }

  it("--json produces structured output", async () => {
    const deps = makeDeps();
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.healthy).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it("--json exits non-zero when writable state paths fail", async () => {
    const deps = makeDeps({
      checkWritable: () => {
        throw new Error("permission denied");
      },
    });
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    const writableCheck = parsed.checks.find((check: { name: string }) => check.name === "writable_home");
    expect(parsed.healthy).toBe(false);
    expect(writableCheck.status).toBe("fail");
    expect(exitCode).toBe(1);
  });

  it("wired via createProgram", async () => {
    const program = createProgram();
    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
  });

  // ===================================================================
  // SLICE-05 item-4 (D4b) — doctor hardcoded-target RED.
  // runDoctorChecks probes 127.0.0.1:DEFAULT_PORT(7433) for port/health and
  // consults configStore.resolve() ONLY for writable paths — so a healthy daemon
  // on a NON-default configured port is invisible to these checks (deterministic
  // false-negative). RED pins that the checks TARGET the configured daemon port;
  // default-port config is preserved.
  // ===================================================================
  it("Slice-05 D4b RED: doctor port/health must target the CONFIGURED host+port, not hardcoded 127.0.0.1:7433", async () => {
    const checkPortArgs: unknown[] = [];
    const fetchUrls: string[] = [];
    const deps = makeDeps({
      configStore: { resolve: () => ({ ...defaultConfig, daemon: { port: 8999, host: "10.0.0.5" } }) },
      // Widened test double (test-only): capture ALL args so we can prove the configured
      // HOST is passed, not only the port. Cast to the current (port)-only dep type.
      checkPort: ((...args: unknown[]) => {
        checkPortArgs.push(...args);
        return Promise.resolve(false); // in use = a daemon is there
      }) as unknown as (port: number) => Promise<boolean>,
      fetch: async (url: string) => {
        fetchUrls.push(url);
        return { ok: true, json: async () => ({ available: true }) } as unknown as { ok: boolean };
      },
    });
    const { portCheck, asyncChecks } = runDoctorChecks(deps);
    await portCheck;
    await Promise.all(asyncChecks ?? []);
    // checkPort must receive BOTH the configured port AND the configured host.
    expect(checkPortArgs).toContain(8999); // <-- RED: currently 7433
    expect(checkPortArgs).toContain("10.0.0.5"); // <-- RED: host is never passed to checkPort today
    // fetch must hit the configured host:port for healthz.
    expect(fetchUrls.some((u) => u.includes("http://10.0.0.5:8999/healthz"))).toBe(true); // <-- RED
    // and NO hardcoded default target anywhere.
    expect(fetchUrls.some((u) => u.includes("127.0.0.1:7433"))).toBe(false); // <-- RED
  });

  it("Slice-05 D4b preserve (GREEN): default-port config still targets 7433", async () => {
    const portArgs: number[] = [];
    const deps = makeDeps({ checkPort: async (port: number) => { portArgs.push(port); return true; } });
    const { portCheck } = runDoctorChecks(deps);
    await portCheck;
    expect(portArgs).toContain(7433);
  });
});
