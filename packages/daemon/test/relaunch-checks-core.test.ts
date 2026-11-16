// workspaces-o9o.8: the relaunch checks' domain core (judged on recorded process rows and in-memory ports) and the lease store adapter
// (on a temp folder, never ~/.openrig).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { blockingChecks, judgeChildren, judgeLeases, newestHandoverFile, type RelaunchCheckPort } from "../src/domain/relaunch-checks.js";
import { nodeRelaunchChecks, SeatLeaseStore } from "../src/adapters/seat-lease-store.js";

const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow => ({ pid, ppid, executableName, command });

describe("o9o.8 core: the agent's children", () => {
  it("a shell between the pane and the agent is not the agent: the agent's own build under it is held", () => {
    const rows = [row(100, 1, "zsh", "-zsh"), row(101, 100, "claude", "claude"), row(102, 101, "bash", "bash -c make"), row(103, 102, "make", "make")];
    expect(judgeChildren(rows, 100, [])).toEqual({ verdict: "held", held: [{ pid: 102, name: "bash", command: "bash -c make" }], ignored: [], overridden: false });
  });

  it("the agent's own executable beneath it (a launcher re-running the runtime) is the agent, and its children are judged", () => {
    const rows = [row(200, 1, "codex", "codex"), row(201, 200, "codex", "/opt/codex/bin/codex resume x"), row(202, 201, "cargo", "cargo build")];
    expect(judgeChildren(rows, 200, [])).toMatchObject({ verdict: "held", held: [{ pid: 202, name: "cargo" }] });
  });

  it("a pane with only shells has no agent and nothing held", () => {
    expect(judgeChildren([row(300, 1, "bash", "bash")], 300, [])).toEqual({ verdict: "clear", ignored: [] });
  });

  it("an empty process table (the lister failed) cannot be judged", () => {
    expect(judgeChildren([], 400, [])).toMatchObject({ verdict: "unknown" });
  });

  it("--despite lease does not override held children", () => {
    const checks = { lease: judgeLeases(() => [], ["lease"]), children: judgeChildren([row(500, 1, "claude", "claude"), row(501, 500, "zsh", "zsh -c x")], 500, ["lease"]) };
    expect(blockingChecks(checks)).toEqual(["children"]);
  });
});

describe("o9o.8 core: the newest handover file", () => {
  const port = (files: Array<{ name: string; modifiedAt: string }>): RelaunchCheckPort => ({ leases: () => [], folderFiles: () => files });

  it("the newest by modification time, not by name, among HANDOVER*.md only", () => {
    const picked = newestHandoverFile("/seat", port([
      { name: "HANDOVER-2026-11-16-notes.md", modifiedAt: "2026-11-15T10:00:00.000Z" },
      { name: "HANDOVER.md", modifiedAt: "2026-11-16T10:00:00.000Z" },
      { name: "HANDOVER.txt", modifiedAt: "2026-11-17T10:00:00.000Z" },
      { name: "MY-HANDOVER.md", modifiedAt: "2026-11-17T10:00:00.000Z" },
    ]));
    expect(picked).toEqual({ path: "/seat/HANDOVER.md", modifiedAt: "2026-11-16T10:00:00.000Z" });
  });

  it("none", () => {
    expect(newestHandoverFile("/seat", port([{ name: "NOTES.md", modifiedAt: "2026-11-16T10:00:00.000Z" }]))).toBeNull();
  });
});

describe("o9o.8 adapter: the seat lease store", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o8-store-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("a lease is a private file (0600 in a 0700 folder), counted while its holder is alive and reported stale once it is gone", () => {
    const alive = new Set([4242]);
    const store = new SeatLeaseStore(root, (pid) => alive.has(pid));
    expect(store.acquire("dev-impl@rig", { holder: "ui-test-host", pid: 4242 })).toMatchObject({ ok: true });
    const dir = nodePath.join(root, encodeURIComponent("dev-impl@rig"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nodePath.join(dir, "ui-test-host.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["ui-test-host.json"]);
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, alive: true }]);
    alive.delete(4242);
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, alive: false }]);
  });

  it("a seat with no leases has none; a folder that cannot be read, or a file that is not a lease, throws (the check then warns)", () => {
    const store = new SeatLeaseStore(root);
    expect(store.leases("dev-impl@rig")).toEqual([]);
    const dir = nodePath.join(root, encodeURIComponent("dev-impl@rig"));
    fs.mkdirSync(dir);
    fs.writeFileSync(nodePath.join(dir, "broken.json"), "{}");
    expect(() => store.leases("dev-impl@rig")).toThrow(/not a lease/);
    expect(judgeLeases(() => store.leases("dev-impl@rig"), [])).toMatchObject({ verdict: "unknown" });
  });

  it("a holder that is not a plain name never names a file outside the seat's folder", () => {
    const store = new SeatLeaseStore(root);
    expect(store.acquire("dev-impl@rig", { holder: "../../escape", pid: 4242 })).toMatchObject({ ok: false, code: "invalid_lease_holder" });
    expect(store.release("dev-impl@rig", "../../escape")).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("the node port lists only the files in a seat's folder", () => {
    fs.writeFileSync(nodePath.join(root, "HANDOVER.md"), "x");
    fs.mkdirSync(nodePath.join(root, "HANDOVER-dir.md"));
    expect(nodeRelaunchChecks(new SeatLeaseStore(root)).folderFiles(root).map((file) => file.name)).toEqual(["HANDOVER.md"]);
  });
});
