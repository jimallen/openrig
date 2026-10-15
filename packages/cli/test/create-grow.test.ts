import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { RigDeps } from "../src/commands/rig.js";

function lifecycleDeps(): LifecycleDeps {
  const state: DaemonState = {
    pid: 123,
    port: 7433,
    db: "test.sqlite",
    startedAt: "2026-08-31T00:00:00Z",
  };
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(run: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    const oldExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await run();
    } finally {
      console.log = oldLog;
      console.error = oldError;
    }
    const exitCode = process.exitCode;
    process.exitCode = oldExitCode;
    resolve({ logs, exitCode });
  });
}

function deps(client: Partial<DaemonClient>): StatusDeps {
  return {
    lifecycleDeps: lifecycleDeps(),
    clientFactory: () => client as DaemonClient,
  };
}

const library = [{
  kind: "agent",
  name: "orchestrator",
  sourceType: "builtin",
  sourcePath: "/opt/openrig/specs/agents/orchestration/orchestrator/agent.yaml",
}];

afterEach(() => vi.restoreAllMocks());

describe("rig create", () => {
  it("creates one launched seat from the shipped agent without user-authored YAML", async () => {
    let sentYaml = "";
    let sentHeaders: Record<string, string> | undefined;
    const client = {
      get: vi.fn(async () => ({ status: 200, data: library })),
      postText: vi.fn(async (_path, yaml, _contentType, headers) => {
        sentYaml = yaml;
        sentHeaders = headers;
        return {
          status: 201,
          data: {
            rigId: "rig-1",
            specName: "alpha",
            specVersion: "0.2",
            nodes: [{ logicalId: "main.lead", status: "launched", sessionName: "main-lead@alpha" }],
          },
        };
      }),
    };

    const program = createProgram({ createDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "create", "alpha", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.postText).toHaveBeenCalledWith(
      "/api/rigs/import",
      expect.any(String),
      "text/yaml",
      { "X-Rig-Root": "/work", "X-Cwd-Override": "/work" },
      { timeoutMs: 120_000 },
    );
    const spec = parseYaml(sentYaml);
    expect(spec).toEqual({
      version: "0.2",
      name: "alpha",
      pods: [{
        id: "main",
        label: "Main",
        members: [{
          id: "lead",
          agent_ref: "path:/opt/openrig/specs/agents/orchestration/orchestrator",
          runtime: "claude-code",
          profile: "default",
          cwd: "/work",
        }],
        edges: [],
      }],
      edges: [],
    });
    expect(sentHeaders).toEqual({ "X-Rig-Root": "/work", "X-Cwd-Override": "/work" });
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      rigId: "rig-1",
      pod: "main",
      seat: "main.lead",
    });
  });

  it("fails plainly when the shipped default agent is unavailable", async () => {
    const client = {
      get: vi.fn(async () => ({ status: 200, data: [] })),
      postText: vi.fn(),
    };
    const program = createProgram({ createDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "create", "alpha"]));

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("shipped default agent is unavailable");
    expect(client.postText).not.toHaveBeenCalled();
  });
});

describe("rig grow", () => {
  it("infers the only pod and adds one launched seat through the existing member ingress", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 201,
        data: {
          ok: true,
          result: {
            podNamespace: "main",
            node: { logicalId: "main.worker", status: "launched", sessionName: "main-worker@alpha" },
          },
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/pods/main/members",
      {
        member: {
          id: "worker",
          agent_ref: "path:/opt/openrig/specs/agents/orchestration/orchestrator",
          runtime: "claude-code",
          profile: "default",
          cwd: "/work",
        },
        rigRoot: "/work",
      },
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      rigName: "alpha",
      pod: "main",
      seat: "main.worker",
    });
  });

  it("adds several seats to an existing pod without YAML", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, body: { member: { id: string } }) => ({
        status: 201,
        data: {
          ok: true,
          result: {
            podNamespace: "main",
            node: {
              logicalId: `main.${body.member.id}`,
              status: "launched",
              sessionName: `main-${body.member.id}@alpha`,
            },
          },
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker", "qa", "--pod", "main", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/rigs/rig-1/pods/main/members",
      expect.objectContaining({ member: expect.objectContaining({ id: "worker" }) }),
      { timeoutMs: 120_000 },
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/api/rigs/rig-1/pods/main/members",
      expect.objectContaining({ member: expect.objectContaining({ id: "qa" }) }),
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      pod: "main",
      seats: ["main.worker", "main.qa"],
    });
  });

  it("reports every outcome when existing-pod batch growth partially mutates", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, body: { member: { id: string } }) => body.member.id === "lead"
        ? {
            status: 409,
            data: {
              ok: false,
              message: "Member main.lead already exists. Pick a different member id.",
            },
          }
        : {
            status: 201,
            data: {
              ok: true,
              result: {
                podNamespace: "main",
                node: {
                  logicalId: "main.worker",
                  status: "launched",
                  sessionName: "main-worker@alpha",
                },
              },
            },
          }),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "lead", "worker", "--pod", "main"]));

    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("[FAIL] main.lead");
    expect(output).toContain("already exists");
    expect(output).toContain("[OK] main.worker");
    expect(output).toContain("main-worker@alpha");
  });

  it("adds a new pod with several seats without YAML", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (_path: string, _body: Record<string, unknown>) => {
        return {
          status: 201,
          data: {
            ok: true,
            status: "ok",
            podNamespace: "review",
            nodes: [
              { logicalId: "review.reviewer", status: "launched", sessionName: "review-reviewer@alpha" },
              { logicalId: "review.qa", status: "launched", sessionName: "review-qa@alpha" },
            ],
          },
        };
      }),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review", "--cwd", "/work", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledWith(
      "/api/rigs/rig-1/expand",
      expect.objectContaining({
        pod: {
          id: "review",
          label: "review",
          members: [
            expect.objectContaining({ id: "reviewer" }),
            expect.objectContaining({ id: "qa" }),
          ],
          edges: [],
        },
        rigRoot: "/work",
      }),
      { timeoutMs: 120_000 },
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      pod: "review",
      seats: ["review.reviewer", "review.qa"],
    });
  });

  it("preserves node outcomes and retry guidance for partial new-pod growth", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 207,
        data: {
          ok: true,
          status: "partial",
          podNamespace: "review",
          nodes: [
            { logicalId: "review.reviewer", status: "launched", sessionName: "review-reviewer@alpha" },
            { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
          ],
          warnings: ["review.qa needs attention"],
          retryTargets: ["review.qa"],
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review"]));

    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("[OK] review.reviewer");
    expect(output).toContain("[FAIL] review.qa");
    expect(output).toContain("harness launch failed");
    expect(output).toContain("review.qa needs attention");
    expect(output).toContain("rig launch rig-1 review.qa");
  });

  it("keeps partial new-pod JSON actionable", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async () => ({
        status: 207,
        data: {
          ok: true,
          status: "partial",
          podNamespace: "review",
          nodes: [
            { logicalId: "review.reviewer", status: "launched" },
            { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
          ],
          retryTargets: ["review.qa"],
        },
      })),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "reviewer", "qa", "--new-pod", "review", "--json"]));

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      nodes: [
        { logicalId: "review.reviewer", status: "launched" },
        { logicalId: "review.qa", status: "failed", error: "harness launch failed" },
      ],
      retryTargets: ["review.qa"],
    });
  });

  it("requires --pod when the target is ambiguous", async () => {
    const client = {
      get: vi.fn(async () => ({
        status: 200,
        data: [
          { rigName: "alpha", podNamespace: "main" },
          { rigName: "alpha", podNamespace: "review" },
        ],
      })),
      post: vi.fn(),
    };

    const program = createProgram({ growDeps: deps(client) });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "grow", "rig-1", "worker"]));

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Choose a pod with --pod");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("registers both public verbs", () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toContain("create");
    expect(names).toContain("grow");
  });
});

describe("rig grow --culture and --agent-ref", () => {
  const ORCHESTRATOR_REF = "path:/opt/openrig/specs/agents/orchestration/orchestrator";

  function growClient(): { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
    return {
      get: vi.fn(async (path: string) => path.includes("specs/library")
        ? { status: 200, data: library }
        : { status: 200, data: [{ rigName: "alpha", podNamespace: "main" }] }),
      post: vi.fn(async (path: string, body: { member?: { id: string }; pod?: { members: Array<{ id: string }> } }) => path.endsWith("/expand")
        ? {
            status: 201,
            data: {
              ok: true,
              status: "ok",
              podNamespace: "review",
              nodes: body.pod!.members.map((m) => ({ logicalId: `review.${m.id}`, status: "launched" })),
            },
          }
        : {
            status: 201,
            data: { ok: true, result: { podNamespace: "main", node: { logicalId: `main.${body.member!.id}`, status: "launched" } } },
          }),
    };
  }

  async function run(client: ReturnType<typeof growClient>, ...args: string[]) {
    const program = createProgram({ growDeps: deps(client as unknown as Partial<DaemonClient>) });
    program.exitOverride();
    // A commander parse error (an option the command does not know) must surface as a failed run, not as a
    // promise captureLogs never settles.
    return captureLogs(async () => {
      try {
        await program.parseAsync(["node", "rig", "grow", "rig-1", ...args]);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
  }

  it("sends --culture as an absolute cultureFile on every seat, resolved from the caller's cwd and not from --cwd", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/operator");
    const client = growClient();
    const { exitCode } = await run(client, "worker", "qa", "--pod", "main", "--cwd", "/work", "--culture", "rig/CULTURE.md", "--json");

    expect(exitCode).toBeUndefined();
    expect(client.post).toHaveBeenCalledTimes(2);
    for (const call of client.post.mock.calls) {
      expect(call[1]).toMatchObject({ cultureFile: "/operator/rig/CULTURE.md", rigRoot: "/work" });
    }
    cwdSpy.mockRestore();
  });

  it("sends an absolute --culture as typed", async () => {
    const client = growClient();
    await run(client, "worker", "--culture", "/rigs/mine/CULTURE.md", "--cwd", "/work", "--json");

    expect(client.post.mock.calls[0]![1]).toMatchObject({ cultureFile: "/rigs/mine/CULTURE.md" });
  });

  it("sends an empty --culture as typed, so the daemon refuses it rather than treating it as the cwd", async () => {
    const client = growClient();
    await run(client, "worker", "--culture", "", "--cwd", "/work", "--json");

    expect(client.post.mock.calls[0]![1]).toHaveProperty("cultureFile", "");
  });

  it("without --culture the request carries no cultureFile key and the seat keeps the orchestrator agent", async () => {
    const client = growClient();
    await run(client, "worker", "--cwd", "/work", "--json");

    const body = client.post.mock.calls[0]![1] as { member: { agent_ref: string } };
    expect(body).not.toHaveProperty("cultureFile");
    expect(body.member.agent_ref).toBe(ORCHESTRATOR_REF);
  });

  it("--culture alone changes nothing about the agent the seat gets", async () => {
    const client = growClient();
    await run(client, "worker", "--cwd", "/work", "--culture", "/rigs/mine/CULTURE.md", "--json");

    expect((client.post.mock.calls[0]![1] as { member: { agent_ref: string } }).member.agent_ref).toBe(ORCHESTRATOR_REF);
  });

  it("--agent-ref replaces the default agent for every seat and skips the library lookup", async () => {
    const client = growClient();
    const { logs } = await run(client, "worker", "qa", "--pod", "main", "--cwd", "/work", "--agent-ref", "path:/agents/reviewer", "--json");

    for (const call of client.post.mock.calls) {
      expect((call[1] as { member: { agent_ref: string } }).member.agent_ref).toBe("path:/agents/reviewer");
    }
    expect(client.get).not.toHaveBeenCalledWith(expect.stringContaining("specs/library"));
    expect(JSON.parse(logs.join("\n")).source).toBe("path:/agents/reviewer");
  });

  it("refuses an empty --agent-ref before any call", async () => {
    const client = growClient();
    const { logs, exitCode } = await run(client, "worker", "--agent-ref", " ", "--cwd", "/work");

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--agent-ref");
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refuses --culture with --new-pod before any call, because the expand route carries no culture file", async () => {
    const client = growClient();
    const { logs, exitCode } = await run(client, "reviewer", "--new-pod", "review", "--cwd", "/work", "--culture", "/rigs/mine/CULTURE.md");

    expect(exitCode).toBe(1);
    const text = logs.join("\n");
    expect(text).toContain("--culture is not supported with --new-pod");
    expect(text).toContain("rig grow --pod <pod> --culture");
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refuses an empty --culture with --new-pod too", async () => {
    const client = growClient();
    const { exitCode } = await run(client, "reviewer", "--new-pod", "review", "--culture", "");

    expect(exitCode).toBe(1);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("--agent-ref works with --new-pod and rides each member of the expand body", async () => {
    const client = growClient();
    const { exitCode } = await run(client, "reviewer", "qa", "--new-pod", "review", "--cwd", "/work", "--agent-ref", "path:/agents/reviewer", "--json");

    expect(exitCode).toBeUndefined();
    const body = client.post.mock.calls[0]![1] as { pod: { members: Array<{ agent_ref: string }> } };
    expect(body.pod.members.map((m) => m.agent_ref)).toEqual(["path:/agents/reviewer", "path:/agents/reviewer"]);
    expect(client.post.mock.calls[0]![1]).not.toHaveProperty("cultureFile");
  });
});

describe("rig spec show", () => {
  it("prints a reusable template without adding an MCP surface", async () => {
    const yaml = `version: "0.2"\nname: alpha\npods:\n  - id: main\n    label: Main\n    members:\n      - id: lead\n        agent_ref: path:/opt/agent\n        profile: default\n        runtime: codex\n        cwd: /work\n        session_source:\n          mode: fork\n          ref:\n            kind: native_id\n            value: old\n        starter_ref:\n          name: old\n    edges: []\nedges: []\n`;
    const client = {
      getText: vi.fn(async () => ({ status: 200, data: yaml })),
    };
    const rigDeps: RigDeps = {
      ...deps(client),
      readFile: vi.fn(),
      readCultureFile: vi.fn(),
    };
    const program = createProgram({ rigDeps });
    program.exitOverride();
    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "spec", "show", "rig-1", "--as-template", "--json"]));

    expect(exitCode).toBeUndefined();
    expect(client.getText).toHaveBeenCalledWith("/api/rigs/rig-1/spec");
    const template = JSON.parse(logs.join("\n"));
    expect(template.name).toBe("REPLACE-ME");
    expect(template.pods[0].members[0]).not.toHaveProperty("session_source");
    expect(template.pods[0].members[0]).not.toHaveProperty("starter_ref");
    expect(createProgram().commands.find((command) => command.name() === "spec")?.commands.map((command) => command.name()))
      .toContain("show");
  });
});
