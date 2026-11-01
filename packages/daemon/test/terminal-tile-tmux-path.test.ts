// #707 — a seat's tile must not depend on the terminal provider's PATH to find hc, and a pane that
// exits at once must not be reported as opened. The shell parsing below is real; no terminal
// provider, hc core or machine link is claimed, and the herdr replies are fakes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { ComposedPane, ComposedView, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

/** The hc terminal name of a seat, restated here (`s-` + the first 24 hex digits of sha-256 of the canonical name) so the pin does not import the recipe it pins. */
const hcName = (seat: string): string => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

const local = (seat: string, readOnly = false): ViewMemberInput => ({ seat, label: seat, tmuxSession: seat, host: null, readOnly, alive: true });

describe("#707 local tiles run the hc the daemon resolves", () => {
  it("a provider PATH without hc fails the bare command; the resolved path attaches, keeping --observe", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-707-"));
    const narrow = join(root, "provider-path"); // the provider's PATH: no hc here
    const elsewhere = join(root, "else where"); // where the daemon found hc (a space: the path must be quoted)
    mkdirSync(narrow);
    mkdirSync(elsewhere);
    const hc = join(elsewhere, "hc");
    writeFileSync(hc, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
    const argsFile = join(root, "args");
    const env = { PATH: narrow, OPR_ARGS: argsFile };
    try {
      for (const readOnly of [false, true]) {
        const bare = composeView("v", [local("seat'a", readOnly)], { resolveHost: () => null });
        // The reported failure: `sh: hc: command not found`, exit 127.
        expect(spawnSync("/bin/sh", ["-c", bare.opened[0]!.paneCommand], { env }).status).toBe(127);

        const resolved = composeView("v", [local("seat'a", readOnly)], { resolveHost: () => null, localHc: hc });
        execFileSync("/bin/sh", ["-c", resolved.opened[0]!.paneCommand], { env });
        expect(readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual(["attach", ...(readOnly ? ["--observe"] : []), "--", hcName("seat'a")]);
        expect(resolved.opened[0]!.readOnly).toBe(readOnly);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a machine tile runs the same local hc, which forwards over its machine link", () => {
    const remote: ViewMemberInput = { seat: "r", label: "r", tmuxSession: "t", host: "edge", readOnly: true, alive: true };
    const resolveHost = () => ({ id: "edge", transport: "ssh" as const, target: "fixture" });
    const withPath = composeView("v", [remote], { resolveHost, localHc: "/opt/homebrew/bin/hc" });
    expect(withPath.opened[0]!.paneCommand).toBe(`'/opt/homebrew/bin/hc' attach --observe -- 'edge/${hcName("t")}'`);
  });

  it("without a resolved path the composed view uses the bare hc token", () => {
    const members = [local("a"), local("b", true)];
    const before = composeView("v", members, { resolveHost: () => null });
    expect(JSON.stringify(composeView("v", members, { resolveHost: () => null, localHc: undefined }))).toBe(JSON.stringify(before));
    expect(before.opened.map((p) => p.paneCommand)).toEqual([`hc attach -- '${hcName("a")}'`, `hc attach --observe -- '${hcName("b")}'`]);
  });

  it("the removed tmux context fields change nothing: a path and server flags still compose a bare hc", () => {
    const members = [local("a")];
    const plain = composeView("v", members, { resolveHost: () => null });
    const legacy = composeView("v", members, { resolveHost: () => null, localTmux: "/usr/bin/tmux", localTmuxServer: ["-L", "x"] });
    expect(legacy.opened[0]!.paneCommand).toBe(plain.opened[0]!.paneCommand);
  });
});

class RecordingHerdr implements TerminalProvider {
  readonly name = "herdr";
  readonly panesPerPage = 16;
  last: ComposedView | null = null;
  async status() { return { provider: this.name, available: true, capabilities: {} }; }
  async liveness() { return { alive: true }; }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.last = view;
    return { provider: this.name, ok: true, opened: view.opened.map((p) => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
  }
}

function service(resolveLocalHc?: TerminalServiceDeps["resolveLocalHc"], resolveLocalTmux?: TerminalServiceDeps["resolveLocalTmux"]): { svc: TerminalService; herdr: RecordingHerdr } {
  const herdr = new RecordingHerdr();
  const rows = [{ canonicalSessionName: "a@r", attachmentType: "hc" as const, tmuxSession: "a@r", rigName: "r", logicalId: "pod.a" }];
  const deps = {
    resolveProvider: (n: string) => (n === "herdr" ? herdr : null),
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: (r: string) => (r === "r" ? rows : null),
    listPodSeats: () => null,
    listScopeSeats: () => null,
    listRigNames: () => ["r"],
    resolveHost: () => null,
    hasSession: () => true,
    ...(resolveLocalHc ? { resolveLocalHc } : {}),
    ...(resolveLocalTmux ? { resolveLocalTmux } : {}),
  } as TerminalServiceDeps;
  return { svc: new TerminalService(deps), herdr };
}

// The service hands the composer the hc path the daemon resolved, so a provider started with a narrower PATH still runs
// the attach (#707). Only an absolute path is used; the old tmux resolver is never read.
describe("#707 the service passes the resolved hc to the composer", () => {
  const cases: Array<[string, TerminalServiceDeps["resolveLocalHc"] | undefined, string]> = [
    ["an absolute path", () => "/usr/local/bin/hc", `'/usr/local/bin/hc' attach -- '${hcName("a@r")}'`],
    ["an absolute path from an async probe", async () => "/opt/homebrew/bin/hc", `'/opt/homebrew/bin/hc' attach -- '${hcName("a@r")}'`],
    ["a bare name", () => "hc", `hc attach -- '${hcName("a@r")}'`],
    ["nothing found", async () => null, `hc attach -- '${hcName("a@r")}'`],
    ["a failed probe", () => { throw new Error("probe failed"); }, `hc attach -- '${hcName("a@r")}'`],
    ["no resolver", undefined, `hc attach -- '${hcName("a@r")}'`],
  ];
  it.each(cases)("%s", async (_name, resolver, expected) => {
    const { svc, herdr } = service(resolver);
    const res = await svc.openView({ view: "rig:r" });
    expect(res.ok).toBe(true);
    expect(herdr.last!.opened[0]!.paneCommand).toBe(expected);
  });

  it("never reads the removed tmux resolver: its absolute path is not an hc", async () => {
    let tmuxCalls = 0;
    const { svc, herdr } = service(undefined, () => { tmuxCalls++; return "/usr/local/bin/tmux"; });
    const res = await svc.openView({ view: "rig:r" });
    expect(res.ok).toBe(true);
    expect(herdr.last!.opened[0]!.paneCommand).toBe(`hc attach -- '${hcName("a@r")}'`);
    expect(tmuxCalls).toBe(0);
  });

  it("resolves once, so the preview's plan still matches the open", async () => {
    let calls = 0;
    const { svc, herdr } = service(async () => { calls++; return "/usr/local/bin/hc"; });
    const preview = await svc.previewView({ view: "rig:r" }) as { planId: string };
    const res = await svc.openView({ view: "rig:r", expectedPlan: preview.planId });
    expect(res.code).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(herdr.last).not.toBeNull();
    expect(herdr.last!.opened[0]!.paneCommand).toBe(`'/usr/local/bin/hc' attach -- '${hcName("a@r")}'`);
    expect(calls).toBe(1);
  });
});
