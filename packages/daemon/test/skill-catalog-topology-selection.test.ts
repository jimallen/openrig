// workspaces-o9o.30: the reconcile dry run (`apply: false`) reports the reconciling owner's topology selection as the
// ownership manifest records it and as this loadout would record it. Seats that share a cwd keep each other's skills, so
// `recorded` is that ONE owner's row, never the folder's union, and the dry run writes nothing.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function catalogWith(ids: string[]): { catalog: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "o9o30-topology-"));
  roots.push(root);
  const catalog = join(root, "skills");
  const cwd = join(root, "seat");
  mkdirSync(cwd, { recursive: true });
  for (const id of ids) {
    mkdirSync(join(catalog, id), { recursive: true });
    writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
  }
  writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "c"]]) {
    execFileSync("git", ["-C", root, ...args]);
  }
  return { catalog, cwd };
}

describe("workspaces-o9o.30: the reconcile dry run's topology selection", () => {
  it("is the reconciling owner's own recorded row, not another owner's in the same cwd, and writes nothing", () => {
    const f = catalogWith(["alpha", "beta", "gamma", "shared"]);
    const reconcile = (owner: string, topologySkills: string[], apply: boolean) => {
      const resolved = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills });
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
      return reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "claude-code", cwd: f.cwd, topologyOwner: owner, apply });
    };
    expect(reconcile("a@rig", ["alpha", "gamma"], true).ok).toBe(true);
    const other = reconcile("b@rig", ["shared"], true);
    expect(other.ok).toBe(true);
    const manifestBefore = readFileSync(other.manifestPath, "utf8");

    const dry = reconcile("a@rig", ["beta", "alpha"], false);

    expect(dry.ok).toBe(true);
    expect(dry.topologySelection).toEqual({ owner: "a@rig", recorded: ["alpha", "gamma"], planned: ["alpha", "beta"] });
    expect(readFileSync(other.manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("is empty for an owner the manifest has never recorded", () => {
    const f = catalogWith(["alpha"]);
    const resolved = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["alpha"] });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));

    const dry = reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "codex", cwd: f.cwd, topologyOwner: "new@rig", apply: false });

    expect(dry.topologySelection).toEqual({ owner: "new@rig", recorded: [], planned: ["alpha"] });
  });
});
