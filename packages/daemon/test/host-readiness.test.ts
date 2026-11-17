// workspaces-o9o.11: the domain core of `rig doctor`'s host rows, through in-memory fakes of its ports.
import { statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  HostReadinessService,
  judgeRuntimePaths,
  judgeSeatShell,
  judgeSpecRoots,
  parseShellFacts,
  probeScript,
  sightRuntimes,
  type HostReadinessIo,
  type RuntimeSighting,
  type SeatShellProbeTerminal,
} from "../src/domain/host-readiness.js";
import type { PathJudgeIo } from "../src/domain/codex-mcp-servers.js";
import { hostReadinessRoutes } from "../src/routes/host-readiness.js";

const ME = 4242;
const N = "0123456789abcdef0123456789abcdef";

function sights(sightings: Partial<Record<string, Partial<RuntimeSighting>>>): RuntimeSighting[] {
  return ["claude-code", "codex", "pi", "omp"].map((runtime) => ({ runtime, found: "", version: "", ...sightings[runtime] }));
}
const SEAT_PATH = "/seat/bin:/usr/bin";

const row = (rows: ReturnType<typeof judgeRuntimePaths>, name: string) => rows.find((r) => r.name === name);

describe("runtime paths: the program a seat's shell finds against the daemon's", () => {
  it("fails a used runtime the seat's shell cannot find while the daemon can, and names the folder to add", () => {
    const rows = judgeRuntimePaths(sights({}), sights({ pi: { found: "/home/u/.local/bin/pi", version: "1.5.0" } }), new Set(["pi"]), SEAT_PATH);
    expect(rows.map((r) => r.name)).toEqual(["seat_runtime_pi"]);
    expect(rows[0]).toMatchObject({ status: "fail" });
    expect(rows[0]!.message).toContain("/home/u/.local/bin/pi (1.5.0)");
    expect(rows[0]!.fix).toContain("/home/u/.local/bin");
  });

  it("only warns about that when no spec says the runtime is used", () => {
    const rows = judgeRuntimePaths(sights({}), sights({ pi: { found: "/opt/pi", version: "1" } }), null, SEAT_PATH);
    expect(row(rows, "seat_runtime_pi")?.status).toBe("warn");
  });

  it("warns when the seat and the daemon find different copies (path or version)", () => {
    const seat = sights({ pi: { found: "/home/u/.pi/agent/bin/pi", version: "1.4.0" } });
    expect(row(judgeRuntimePaths(seat, sights({ pi: { found: "/home/u/.local/bin/pi", version: "1.5.0" } }), null, SEAT_PATH), "seat_runtime_pi")?.status).toBe("warn");
    expect(row(judgeRuntimePaths(seat, sights({ pi: { found: "/home/u/.pi/agent/bin/pi", version: "1.5.0" } }), null, SEAT_PATH), "seat_runtime_pi")?.status).toBe("warn");
    expect(row(judgeRuntimePaths(seat, sights({ pi: { found: "/home/u/.pi/agent/bin/pi", version: "1.4.0" } }), null, SEAT_PATH), "seat_runtime_pi")?.status).toBe("pass");
  });

  it("warns when only the seat finds it (preflight will say it is missing)", () => {
    const rows = judgeRuntimePaths(sights({ codex: { found: "/opt/codex", version: "0.1" } }), sights({}), null, SEAT_PATH);
    expect(row(rows, "seat_runtime_codex")?.status).toBe("warn");
  });

  it("passes an alias or function in the login shell, which the daemon's PATH cannot show", () => {
    const rows = judgeRuntimePaths(sights({ "claude-code": { found: "alias claude='claude --x'" } }), sights({}), null, SEAT_PATH);
    expect(row(rows, "seat_runtime_claude_code")?.status).toBe("pass");
  });

  it("a runtime installed nowhere fails when used and is skipped when not", () => {
    expect(row(judgeRuntimePaths(sights({}), sights({}), new Set(["omp"]), SEAT_PATH), "seat_runtime_omp")?.status).toBe("fail");
    expect(row(judgeRuntimePaths(sights({}), sights({}), null, SEAT_PATH), "seat_runtime_omp")?.status).toBe("skipped");
  });

  it("a runtime whose lookup failed is skipped with the reason, never judged missing", () => {
    const r = row(judgeRuntimePaths(sights({ pi: { unknown: "the PATH of a seat's login shell could not be read" } }), sights({}), new Set(["pi"]), SEAT_PATH), "seat_runtime_pi");
    expect(r).toMatchObject({ status: "skipped", reason: "the PATH of a seat's login shell could not be read" });
  });

  it("names the seat's PATH when the seat cannot find what the daemon can", () => {
    expect(row(judgeRuntimePaths(sights({}), sights({ pi: { found: "/d/pi" } }), null, SEAT_PATH), "seat_runtime_pi")?.reason).toBe(`The seat's shell PATH: ${SEAT_PATH}`);
  });

  it("with a spec, only the runtimes it uses get a row", () => {
    expect(judgeRuntimePaths(sights({}), sights({}), new Set(["codex"]), SEAT_PATH).map((r) => r.name)).toEqual(["seat_runtime_codex"]);
  });
});

describe("sightings through the one runtime probe", () => {
  const enoent = (name: string) => Object.assign(new Error(`'${name}' is not on the PATH of a seat's login shell`), { code: "ENOENT" });
  it("takes the probe's path and the first line of --version", async () => {
    const out = await sightRuntimes(async (name) => ({ path: `/bin/${name}`, output: `\n${name} 1.2.3\nmore\n` }));
    expect(out.find((r) => r.runtime === "pi")).toEqual({ runtime: "pi", found: "/bin/pi", version: "pi 1.2.3" });
  });
  it("a program not on PATH is still a sighting when the seat's shell runs that name as an alias", async () => {
    const out = await sightRuntimes(async (name) => { throw enoent(name); }, [
      { runtime: "claude-code", found: "alias claude='claude --x'", version: "" },
      { runtime: "pi", found: "/stale/pi", version: "" },
    ]);
    expect(out.find((r) => r.runtime === "claude-code")).toEqual({ runtime: "claude-code", found: "alias claude='claude --x'", version: "" });
    expect(out.find((r) => r.runtime === "pi")).toEqual({ runtime: "pi", found: "", version: "" });
  });
  it("any other failure is unknown", async () => {
    const out = await sightRuntimes(async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); });
    expect(out.every((r) => r.unknown === "timed out" && r.found === "")).toBe(true);
  });
});

describe("the probe script and what it writes", () => {
  const framed = (body: string, nonce = N) => `noise before\nOPENRIG-DOCTOR-BEGIN ${nonce}\n${body}OPENRIG-DOCTOR-END ${nonce}\nruntime\tpi\t/after/pi\t9\n`;

  it("reads every runtime line inside the frame, and a runtime with no line as not found", () => {
    const parsed = parseShellFacts(framed("shell\t/bin/zsh\npath\t/a:/b\nruntime\tpi\t/a/pi\tpi 1.4.0\nruntime\tclaude\t\t\nnoise\n"), N)!;
    expect(parsed.shell).toBe("/bin/zsh");
    expect(parsed.path).toBe("/a:/b");
    expect(parsed.runtimes.find((r) => r.runtime === "pi")).toEqual({ runtime: "pi", found: "/a/pi", version: "pi 1.4.0" });
    expect(parsed.runtimes.find((r) => r.runtime === "codex")).toEqual({ runtime: "codex", found: "", version: "" });
  });

  it("ignores everything outside this run's frame, and reads no frame as unknown, never as not installed", () => {
    expect(parseShellFacts("runtime\tpi\t/evil/pi\t6\n", N)).toBeNull();
    expect(parseShellFacts(framed("runtime\tpi\t/a/pi\t1\n", "f".repeat(32)), N)).toBeNull();
    expect(parseShellFacts(`OPENRIG-DOCTOR-BEGIN ${N}\nruntime\tpi\t/a/pi\t1\n`, N)).toBeNull();
    expect(parseShellFacts(`OPENRIG-DOCTOR-END ${N}\nOPENRIG-DOCTOR-BEGIN ${N}\n`, N)).toBeNull();
    expect(parseShellFacts(framed("runtime\tpi\t/a/pi\t1\n"), N)!.runtimes.find((r) => r.runtime === "pi")!.found).toBe("/a/pi");
  });

  it("refuses a nonce that is not lowercase hex, so it cannot break the script's quoting", () => {
    expect(() => probeScript("/r", "x'; rm -rf /; '")).toThrow();
  });

  it("calls every utility through command, so an rc alias or function cannot answer for it", () => {
    const script = probeScript("/r", N);
    for (const tool of ["printf", "head", "tr", "mv"]) {
      const uses = script.match(new RegExp(`(?:^|[\\s;(|$])${tool}\\b`, "g")) ?? [];
      const guarded = script.match(new RegExp(`command ${tool}\\b`, "g")) ?? [];
      expect(guarded.length, tool).toBeGreaterThan(0);
      expect(uses.length, tool).toBe(guarded.length);
    }
  });

  it("writes `started` first and renames the facts into place only when complete", () => {
    const script = probeScript("/tmp/x'y", N);
    expect(script.split("\n")[0]).toBe(`_or_d='/tmp/x'\\''y'`);
    expect(script.split("\n")[1]).toBe(`: > "$_or_d/started"`);
    expect(script.trimEnd().endsWith(`> "$_or_d/facts.tmp" && command mv "$_or_d/facts.tmp" "$_or_d/facts"`)).toBe(true);
  });
});

describe("the seat shell row", () => {
  it("fails a shell that never ran the typed command, quoting what it showed and naming the fix", () => {
    const r = judgeSeatShell({ kind: "did_not_run", shell: "/bin/zsh", waitedMs: 10_000, paneTail: "[oh-my-zsh] Would you like to update? [Y/n]" });
    expect(r.status).toBe("fail");
    expect(r.message).toContain("did not run a typed command within 10 s");
    expect(r.reason).toContain("[Y/n]");
    expect(r.fix).toContain("$SHELL -l");
  });
  it("skips, not passes, when no probe terminal could be started", () => {
    expect(judgeSeatShell({ kind: "unavailable", reason: "x" }).status).toBe("skipped");
  });
});

/** A fake of the path judge's reads: every path is a directory owned by ME with mode 755 unless listed. */
function judgeIo(over: Record<string, { mode?: number; uid?: number } | "missing">): PathJudgeIo {
  const stats = (p: string): Stats => {
    const o = over[p];
    if (o === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    // A real Stats of a real directory (so isDirectory/isSymbolicLink are the real methods), with the fields the judge reads set.
    const st = statSync(tmpdir());
    st.uid = o?.uid ?? ME;
    st.mode = 0o040000 | (o?.mode ?? 0o755);
    st.dev = 1;
    st.ino = p.length;
    return st;
  };
  return {
    lstat: stats,
    stat: stats,
    realpath: (p) => { if (over[p] === "missing") throw new Error("ENOENT"); return p; },
    uid: () => ME,
    tempRoots: () => [],
  };
}

describe("spec folders: judged by the rule a launch applies to a spec source", () => {
  const trust = { roots: () => ["/h/.agents-release", "/h/.openrig/specs"], exactDepthRoot: () => "/h/.openrig/shared-docs/rigs" };

  it("fails a group-writable spec folder and names it", () => {
    const r = judgeSpecRoots(trust, judgeIo({ "/h/.openrig/specs": { mode: 0o775 }, "/h/.agents-release": "missing" }));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("/h/.openrig/specs is writable by group or others");
    expect(r.fix).toContain("chmod go-w");
  });

  it("fails a spec folder under a parent another user owns", () => {
    const r = judgeSpecRoots(trust, judgeIo({ "/h": { uid: 1001 }, "/h/.agents-release": "missing" }));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("owned by uid 1001");
  });

  it("passes protected folders, counting the ones that exist, including the shared-docs rigs folder", () => {
    const r = judgeSpecRoots(trust, judgeIo({ "/h/.agents-release": "missing" }));
    expect(r).toMatchObject({ status: "pass", message: "2 of the 3 spec folders exist, and none is writable by group or others." });
  });
});

function fakeIo(files: Map<string, string>, clock = { t: 0 }): HostReadinessIo & { removed: string[]; redacted: string[] } {
  const removed: string[] = [];
  const redacted: string[] = [];
  let n = 0;
  return {
    removed,
    redacted,
    makeResultDir: () => `/r/${++n}`,
    nonce: () => N,
    readText: (p) => files.get(p) ?? null,
    removeDir: (p) => { removed.push(p); },
    sleep: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    shell: () => "/bin/zsh",
    redact: (text) => { redacted.push(text); return text.replace("SECRET", "[redacted]"); },
  };
}

function fakeTerminal(onSend?: () => void, create: { ok: true } | { ok: false; code: string; message: string } = { ok: true }): SeatShellProbeTerminal & { killed: string[]; sent: Array<{ command: string; options?: { sourceInPane?: boolean } }> } {
  const killed: string[] = [];
  const sent: Array<{ command: string; options?: { sourceInPane?: boolean } }> = [];
  return {
    killed,
    sent,
    createProbeSession: async () => create,
    sendShellCommand: async (_t, command, _b, options) => { sent.push({ command, options }); onSend?.(); return { ok: true }; },
    capturePaneContent: async () => "[Y/n] SECRET\n\n",
    killSession: async (name) => { killed.push(name); },
  };
}

/** The one runtime probe, faked: the seat finds /seat/pi, the daemon /daemon/pi, both 1.0. */
function probes() {
  return {
    seatRuntimeProbeOn: vi.fn((_path: string) => async (name: string) => {
      if (name !== "pi") throw Object.assign(new Error("no"), { code: "ENOENT" });
      return { path: "/seat/pi", output: "pi 1.0\n" };
    }),
    daemonRuntimeProbe: async (name: string) => {
      if (name !== "pi") throw Object.assign(new Error("no"), { code: "ENOENT" });
      return { path: "/daemon/pi", output: "pi 1.0\n" };
    },
  };
}

const trustAllMissing = { roots: () => [] as string[], exactDepthRoot: () => "/nowhere", io: judgeIo({ "/nowhere": "missing" }) };

describe("the probe service", () => {
  it("reports did_not_run when the typed command never starts, with the redacted screen, and removes the terminal", async () => {
    const files = new Map<string, string>();
    const io = fakeIo(files);
    const terminal = fakeTerminal();
    const service = new HostReadinessService({ terminal, io, specSourceTrust: trustAllMissing, homeDir: "/h", startMs: 1000, finishMs: 1000, ...probes() });
    const outcome = await service.probeSeatShell();
    expect(outcome).toMatchObject({ kind: "did_not_run", shell: "/bin/zsh", paneTail: "[Y/n] [redacted]" });
    expect(io.redacted).toEqual(["[Y/n] SECRET"]);
    expect(terminal.killed).toHaveLength(1);
    expect(io.removed).toEqual(["/r/1"]);
    expect(terminal.sent[0]!.options).toEqual({ sourceInPane: true });
  });

  it("reports what the shell saw when it ran, and compares it with the daemon's own run", async () => {
    const files = new Map<string, string>();
    const io = fakeIo(files);
    const terminal = fakeTerminal(() => {
      files.set("/r/1/started", "");
      files.set("/r/1/facts", `OPENRIG-DOCTOR-BEGIN ${N}\nshell\t/bin/zsh\npath\t/seat-shell-path\nruntime\tpi\t/seat/pi\t\nOPENRIG-DOCTOR-END ${N}\n`);
    });
    const probe = probes();
    const service = new HostReadinessService({ terminal, io, specSourceTrust: trustAllMissing, homeDir: "/h", ...probe });
    const { rows } = await service.report({ seatShell: true, runtimes: ["pi"] });
    expect(rows.map((r) => [r.name, r.status])).toEqual([["seat_shell", "pass"], ["seat_runtime_pi", "warn"], ["spec_source_folders", "pass"]]);
    expect(probe.seatRuntimeProbeOn).toHaveBeenCalledWith("/seat-shell-path");
    expect(terminal.killed).toHaveLength(1);
  });

  it("a Claude the seat's shell runs only as an alias passes, from the shell's own sighting", async () => {
    const files = new Map<string, string>();
    const terminal = fakeTerminal(() => {
      files.set("/r/1/started", "");
      files.set("/r/1/facts", `OPENRIG-DOCTOR-BEGIN ${N}\npath\t/p\nruntime\tclaude\talias claude='claude --x'\t\nOPENRIG-DOCTOR-END ${N}\n`);
    });
    const service = new HostReadinessService({ terminal, io: fakeIo(files), specSourceTrust: trustAllMissing, homeDir: "/h", ...probes() });
    const { rows } = await service.report({ seatShell: true, runtimes: ["claude-code"] });
    expect(rows.find((r) => r.name === "seat_runtime_claude_code")).toMatchObject({ status: "pass", message: "A seat's login shell runs claude as alias claude='claude --x'." });
  });

  it("does not run the runtime comparison when the shell did not run", async () => {
    const probe = probes();
    const service = new HostReadinessService({ terminal: fakeTerminal(), io: fakeIo(new Map()), specSourceTrust: trustAllMissing, homeDir: "/h", startMs: 400, ...probe });
    const { rows } = await service.report({ seatShell: true, runtimes: null });
    expect(rows.map((r) => [r.name, r.status])).toEqual([["seat_shell", "fail"], ["seat_runtimes", "skipped"], ["spec_source_folders", "pass"]]);
    expect(probe.seatRuntimeProbeOn).not.toHaveBeenCalled();
  });

  it("seatPath gives the probe shell's PATH, and rejects (never guesses) when the shell did not run", async () => {
    const files = new Map<string, string>();
    const terminal = fakeTerminal(() => {
      files.set("/r/1/started", "");
      files.set("/r/1/facts", `OPENRIG-DOCTOR-BEGIN ${N}\npath\t/from/the/terminal\nOPENRIG-DOCTOR-END ${N}\n`);
    });
    const ran = new HostReadinessService({ terminal, io: fakeIo(files), specSourceTrust: trustAllMissing, homeDir: "/h", ...probes() });
    expect(await ran.seatPath()).toBe("/from/the/terminal");
    const stuck = new HostReadinessService({ terminal: fakeTerminal(), io: fakeIo(new Map()), specSourceTrust: trustAllMissing, homeDir: "/h", startMs: 400, ...probes() });
    await expect(stuck.seatPath()).rejects.toThrow(/did not run a typed command/);
  });

  it("is unavailable, and types nothing, when no probe terminal can be made", async () => {
    const terminal = fakeTerminal(undefined, { ok: false, code: "guard_target_managed", message: "no" });
    const service = new HostReadinessService({ terminal, io: fakeIo(new Map()), specSourceTrust: trustAllMissing, homeDir: "/h", ...probes() });
    expect(await service.probeSeatShell()).toEqual({ kind: "unavailable", reason: "guard_target_managed: no" });
    expect(terminal.sent).toHaveLength(0);
  });

  it("with seatShell false starts no terminal and says the rows were skipped", async () => {
    const terminal = fakeTerminal();
    const create = vi.spyOn(terminal, "createProbeSession");
    const service = new HostReadinessService({ terminal, io: fakeIo(new Map()), specSourceTrust: trustAllMissing, homeDir: "/h", ...probes() });
    const { rows } = await service.report({ seatShell: false, runtimes: null });
    expect(create).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ name: "seat_shell", status: "skipped" });
  });
});

describe("POST /api/doctor/host", () => {
  function app(report = vi.fn(async () => ({ rows: [] }))) {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("hostReadiness" as never, { report } as never); await next(); });
    a.route("/api/doctor/host", hostReadinessRoutes());
    return { a, report };
  }

  it("defaults seatShell on and keeps only runtimes that launch a program", async () => {
    const { a, report } = app();
    const res = await a.request("/api/doctor/host", { method: "POST", body: JSON.stringify({ runtimes: ["pi", "terminal", "stub"] }) });
    expect(res.status).toBe(200);
    expect(report).toHaveBeenCalledWith({ seatShell: true, runtimes: ["pi"] });
  });

  it("passes seatShell false through, and refuses a malformed body", async () => {
    const { a, report } = app();
    await a.request("/api/doctor/host", { method: "POST", body: JSON.stringify({ seatShell: false }) });
    expect(report).toHaveBeenCalledWith({ seatShell: false, runtimes: null });
    expect((await a.request("/api/doctor/host", { method: "POST", body: "{" })).status).toBe(400);
    expect((await a.request("/api/doctor/host", { method: "POST", body: JSON.stringify({ seatShell: "yes" }) })).status).toBe(400);
    expect((await a.request("/api/doctor/host", { method: "POST", body: JSON.stringify({ runtimes: [1] }) })).status).toBe(400);
  });

  it("answers 503 when the daemon has no host readiness service", async () => {
    const a = new Hono();
    a.route("/api/doctor/host", hostReadinessRoutes());
    expect((await a.request("/api/doctor/host", { method: "POST" })).status).toBe(503);
  });
});
