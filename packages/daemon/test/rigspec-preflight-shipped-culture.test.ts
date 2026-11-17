// workspaces-o9o.98 (o9o.52 survivor C7): `rig up` preflight's own shipped: culture confinement, pinned alone. A shipped: culture_file
// whose path inside the install's specs folder is a link pointing OUT of it must be refused at preflight, not only later at the
// instantiator's resolve. The running install's specs folder is runningShippedSpecsRoot (builtin-startup-files.ts); this file points it at
// a fake install so the link can be planted without touching the real one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const fakeSpecs = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/domain/builtin-startup-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/builtin-startup-files.js")>();
  return { ...actual, runningShippedSpecsRoot: () => fakeSpecs.root };
});

import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

let base = "";
let seatCwd = "";
beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o98-c7-")));
  const specs = nodePath.join(base, "lib", "node_modules", "@openrig", "cli", "daemon", "specs");
  fs.mkdirSync(nodePath.join(specs, "rigs", "k", "culture"), { recursive: true });
  fs.writeFileSync(nodePath.join(specs, "rigs", "k", "culture", "CULTURE.md"), "# Kernel culture\n");
  fs.writeFileSync(nodePath.join(base, "outside.md"), "# not the install's\n");
  fs.symlinkSync(nodePath.join(base, "outside.md"), nodePath.join(specs, "rigs", "k", "escape.md"));
  seatCwd = nodePath.join(base, "seat");
  fs.mkdirSync(seatCwd);
  fakeSpecs.root = specs;
});
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

const noFiles: AgentResolverFsOps = { readFile: (p: string) => { throw new Error(`Not found: ${p}`); }, exists: () => false };
const yaml = (cultureFile: string) => {
  const spec: PodRigSpec = {
    version: "0.2", name: "c7-rig", cultureFile,
    pods: [{ id: "dev", label: "Dev", members: [{ id: "human", agentRef: "builtin:terminal", runtime: "terminal", profile: "none", cwd: seatCwd }], edges: [] }],
    edges: [],
  };
  return RigSpecCodec.serialize(spec);
};
const run = (cultureFile: string) => rigPreflight({ rigSpecYaml: yaml(cultureFile), rigRoot: "/project/rigs/c7", fsOps: noFiles as never });

describe("rig up preflight confines a shipped: culture_file to the running install's specs folder", () => {
  it("control: a shipped: culture inside the folder passes", async () => {
    const result = await run("shipped:rigs/k/culture/CULTURE.md");
    expect(result.errors).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it("a shipped: culture that is a link pointing out of the folder is refused at preflight", async () => {
    const result = await run("shipped:rigs/k/escape.md");
    expect(result.ready).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("shipped:rigs/k/escape.md");
    expect(result.errors[0]).toContain("a shipped: culture_file must stay inside it");
  });
});
