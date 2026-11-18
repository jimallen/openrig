// workspaces-o9o.163: the owner-death guard of a private hc core selects the core's processes by its runtime dir
// (XDG_RUNTIME_DIR=<root>/r). That entry is unique only while the runtime dir is inside the core's own fresh root, so the guard
// refuses any other, and the helper that builds it leaves no root behind when it is refused.
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PrivateCoreGuard } from "./helpers/private-core-guard.js";
import { PrivateCore } from "./hc-private-core.js";
import { hcScratchBase, hcScratchFallback } from "./helpers/hc-scratch.js";

describe("o9o.163: the private core guard selects only the core's own processes", () => {
  it("accepts a runtime dir inside the core's root, and refuses the root itself, a sibling with the same prefix, or any other dir", () => {
    const root = "/scratch/hc-x-abc";
    expect(() => new PrivateCoreGuard({ XDG_RUNTIME_DIR: `${root}/r` }, root, "t")).not.toThrow();
    for (const runtime of [root, `${root}-other/r`, "/scratch/shared-runtime", "/run/user/1000"]) {
      expect(() => new PrivateCoreGuard({ XDG_RUNTIME_DIR: runtime }, root, "t"), runtime).toThrow(/not inside the core's own root/);
    }
    expect(() => new PrivateCoreGuard({}, root, "t")).toThrow(/no XDG_RUNTIME_DIR/);
  });

  it("a PrivateCore whose extra env moves the runtime dir out of its root is refused, and its root is removed", () => {
    const tag = `gx${process.pid}`;
    const base = hcScratchBase(process.env, hcScratchFallback(tmpdir()));
    const mine = () => readdirSync(base).filter((name) => name.startsWith(`hc-${tag}-`));
    expect(mine()).toEqual([]);
    expect(() => new PrivateCore(tag, { XDG_RUNTIME_DIR: tmpdir() }, "/nonexistent/hc")).toThrow(/not inside the core's own root/);
    expect(mine()).toEqual([]);
  });
});
