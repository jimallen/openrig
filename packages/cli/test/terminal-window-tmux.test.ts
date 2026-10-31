import { expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "../src/client.js";
import { defaultWindowDeps, openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

// The window opener used to build a tmux viewer session (new-session, split-window, respawn-pane, resize-window, ...)
// when Herdr was absent or `--provider tmux` was asked. That viewer is gone: a seat is itself the pane Herdr shows,
// placed by label. These pins hold the CLI to that: whatever the view's size, the opener starts no tmux, and the one
// desktop launch it makes runs Herdr, not a tmux client.

function fixture(seatCount: number, pageSize: number) {
  const panes = Array.from({ length: seatCount }, (_, index) => ({ seat: `pod-m${index}@rig${index % 2}`, label: `m${index}`, paneCommand: `hc attach pod-m${index}` }));
  const pages = Array.from({ length: Math.ceil(seatCount / pageSize) }, (_, index) => panes.slice(index * pageSize, (index + 1) * pageSize));
  const composed = { id: "fixture", opened: panes, pages, absent: [], degraded: [] };
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true, opened: panes.map(pane => pane.seat), absent: [], degraded: [], pages: pages.length } }));
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview")
    ? { planId: "fixture", status: { launch: { socketPath: "/fixture/herdr.sock" } }, composed }
    : { providers: [{ liveness: { alive: true } }] } }));
  const client = { baseUrl: "http://localhost:7433", get, post } as unknown as DaemonClient;
  const executed: string[] = [];
  const launched: string[] = [];
  const deps: WindowDeps = {
    herdrConfig: () => "/fixture/private herdr.toml",
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" }, exists: () => false,
    exec: async (file, args) => {
      executed.push([file, ...args].join(" "));
      if (args.includes("--version")) return "herdr 0.9.3";
      if (file === "/bin/sh") return "/fixture/bin/herdr";
      if (file === "/usr/bin/osascript") { launched.push(args[2]!); return "window"; }
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => "fixture",
  };
  return { client, deps, post, executed, launched, panes };
}

it.each([[1, 16], [3, 1], [19, 16]])("opens %i seats in pages of %i through the daemon and starts no tmux", async (count, pageSize) => {
  const f = fixture(count, pageSize);
  const result = await openTerminalWindow(f.client, "saved:fixture", undefined, f.deps);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "herdr", opened: f.panes.map(pane => pane.seat), pages: Math.ceil(count / pageSize) });
  expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:fixture", provider: "herdr", expectedPlan: "fixture" }, { timeoutMs: 45_000 });
  expect(f.executed.filter(line => path.basename(line.split(" ")[0]!) === "tmux" || /\btmux\b/.test(line.replace(/-u TMUX\b/g, "")))).toEqual([]);
  expect(f.launched).toHaveLength(1);
  expect(f.launched[0]).toContain("'/fixture/bin/herdr'");
  expect(f.launched[0]).not.toMatch(/attach-session/);
});

it("states each seat's space and tab by label for the rigs it opened", async () => {
  const f = fixture(3, 16);
  const result = await openTerminalWindow(f.client, "saved:fixture", undefined, f.deps);
  const placed = result.notes?.find(note => note.startsWith("Seats are placed by label"));
  expect(placed).toContain("rig:rig0/cos holds pod-m0@rig0");
  expect(placed).toContain("rig:rig0/team holds pod-m2@rig0");
  expect(placed).toContain("rig:rig1/cos holds pod-m1@rig1");
});

it("does not ask a hosting tmux pane for its width", async () => {
  // A tmux that records being run, first on PATH, with the person's TMUX and TMUX_PANE set: the old probe's trigger.
  const dir = mkdtempSync(path.join(tmpdir(), "tw-trip-"));
  const marker = path.join(dir, "ran");
  writeFileSync(path.join(dir, "tmux"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\necho 100\n`);
  chmodSync(path.join(dir, "tmux"), 0o755);
  const saved = { PATH: process.env["PATH"], TMUX: process.env["TMUX"], TMUX_PANE: process.env["TMUX_PANE"] };
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    process.env["PATH"] = `${dir}:${saved.PATH ?? ""}`;
    process.env["TMUX"] = "/tmp/tmux-fixture/default,1,0";
    process.env["TMUX_PANE"] = "%1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    await defaultWindowDeps().columns!();
    expect(existsSync(marker)).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
    rmSync(dir, { recursive: true, force: true });
  }
});
