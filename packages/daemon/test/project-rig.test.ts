import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { applyProjectRig, prepareProjectRigWorkspaces, projectRigSlug, projectRigWorkspaceOwner, projectRigWorkspaceRecreatable, recreateProjectRigWorkspace, unprojectedProjectRigError } from "../src/domain/project-rig.js";

const SPEC = `version: "0.2"
name: team
project_rig: true
pods:
  - id: exec
    label: Exec
    members:
      - id: cos
        agent_ref: "local:agents/cos"
        runtime: claude-code
        cwd: "."
    edges: []
  - id: build
    label: Build
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: codex
        cwd: /somewhere/else
    edges: []
edges: []
`;

describe("applyProjectRig", () => {
  it("leaves a spec without project_rig untouched", () => {
    expect(applyProjectRig(SPEC.replace("project_rig: true\n", ""), "/p/x")).toEqual({ kind: "not_project_rig" });
    expect(applyProjectRig(SPEC.replace("project_rig: true", "project_rig: false"), "/p/x")).toEqual({ kind: "not_project_rig" });
    expect(applyProjectRig(SPEC.replace("project_rig: true", 'project_rig: "yes"'), "/p/x")).toEqual({ kind: "not_project_rig" });
  });

  it("refuses a launch without a project folder", () => {
    for (const cwd of [undefined, null, "", "   "]) {
      const r = applyProjectRig(SPEC, cwd);
      expect(r.kind).toBe("error");
      expect((r as { error: string }).error).toBe("team is a project rig: launch it into a project with --cwd <project folder>.");
    }
  });

  it("names the rig after the project and gives each member its own workspace folder", () => {
    const r = applyProjectRig(SPEC, "/work/My Project.v2/");
    expect(r.kind).toBe("project_rig");
    if (r.kind !== "project_rig") return;
    expect(r.rigName).toBe("my-project-v2");
    expect(r.projectRoot).toBe("/work/My Project.v2");
    expect(r.workspaceDirs).toEqual([
      "/work/My Project.v2/.workspaces/exec-cos",
      "/work/My Project.v2/.workspaces/build-impl",
    ]);
    const out = parseYaml(r.rigSpecYaml) as Record<string, any>;
    expect(out.name).toBe("my-project-v2");
    expect(out.project_rig).toBeUndefined();
    expect(out.pods[0].members[0].cwd).toBe("/work/My Project.v2/.workspaces/exec-cos");
    expect(out.pods[1].members[0].cwd).toBe("/work/My Project.v2/.workspaces/build-impl");
    expect(out.pods[1].members[0].runtime).toBe("codex");
  });

  it("resolves a relative project folder", () => {
    const r = applyProjectRig(SPEC, "rel/eztrack");
    expect(r.kind === "project_rig" && r.projectRoot).toBe(path.resolve("rel/eztrack"));
  });

  it("refuses the reserved kernel name and a name-less folder", () => {
    expect(applyProjectRig(SPEC, "/x/Kernel")).toEqual({ kind: "error", error: "team is a project rig, and 'kernel' is a reserved rig name; rename the project folder." });
    expect(applyProjectRig(SPEC, "/x/___").kind).toBe("error");
  });

  it("refuses two members that would share a workspace folder", () => {
    const clash = SPEC.replace("- id: build", "- id: exec-x").replace("label: Build", "label: B")
      .replace("id: impl", "id: impl").replace("- id: cos", "- id: x-impl");
    // exec.x-impl and exec-x.impl both map to exec-x-impl
    const r = applyProjectRig(clash, "/p/eztrack");
    expect(r).toEqual({ kind: "error", error: "team is a project rig, and members exec.x-impl and exec-x.impl would share the workspace folder .workspaces/exec-x-impl; rename one of them." });
  });

  it("refuses ids that would leave the workspaces folder or nest inside it", () => {
    const traversal = SPEC.replace("- id: exec", '- id: ".."').replace("- id: cos", '- id: "/../../escaped"');
    const r1 = applyProjectRig(traversal, "/p/eztrack");
    expect(r1.kind).toBe("error");
    expect((r1 as { error: string }).error).toContain("is not a usable workspace folder name");
    for (const bad of ['"a/b"', '"a b"', '"."']) {
      const r = applyProjectRig(SPEC.replace("- id: impl", `- id: ${bad}`), "/p/eztrack");
      expect(r.kind, bad).toBe("error");
    }
    for (const bad of ['"../.."', '"a/b"', '".."']) {
      const r = applyProjectRig(SPEC.replace("- id: build", `- id: ${bad}`), "/p/eztrack");
      expect(r.kind, `pod ${bad}`).toBe("error");
    }
  });

  it("refuses a member or pod without an id instead of skipping it", () => {
    expect(applyProjectRig(SPEC.replace("- id: impl", "- label: none"), "/p/eztrack")).toEqual({ kind: "error", error: "team is a project rig, and a member of pod build has no id." });
    expect(applyProjectRig(SPEC.replace("- id: build\n    label: Build", "- label: Build"), "/p/eztrack")).toEqual({ kind: "error", error: "team is a project rig, and a pod has no usable id or members." });
  });

  it("slug matches rig-here's rule", () => {
    expect(projectRigSlug("/a/eztrack")).toBe("eztrack");
    expect(projectRigSlug("/a/-Foo_Bar-")).toBe("foo-bar");
  });
});

describe("prepareProjectRigWorkspaces", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-rig-"))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf-8" });

  it("fails when a folder cannot be created", () => {
    fs.writeFileSync(path.join(tmp, ".workspaces"), "a file, not a folder");
    expect(() => prepareProjectRigWorkspaces(tmp, [path.join(tmp, ".workspaces", "a-b")])).toThrow();
  });

  it("creates the folders without git", () => {
    const dirs = [path.join(tmp, ".workspaces", "a-b")];
    prepareProjectRigWorkspaces(tmp, dirs);
    expect(fs.statSync(dirs[0]!).isDirectory()).toBe(true);
  });

  it("hides the workspaces from git status, once, at the project's own path", () => {
    git("init", "-q");
    const project = path.join(tmp, "a[1]");
    const sibling = path.join(tmp, "a1");
    for (const p of [project, sibling]) fs.mkdirSync(path.join(p, ".workspaces", "x-y"), { recursive: true });
    for (const p of [project, sibling]) fs.writeFileSync(path.join(p, ".workspaces", "x-y", "f"), "");
    prepareProjectRigWorkspaces(project, [path.join(project, ".workspaces", "x-y")]);
    prepareProjectRigWorkspaces(project, [path.join(project, ".workspaces", "x-y")]);
    const exclude = fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n").filter((l) => l === "/a\\[1\\]/.workspaces/")).toHaveLength(1);
    const status = git("status", "--porcelain", "--untracked-files=all");
    expect(status).not.toContain("a[1]/");
    expect(status).toContain("a1/.workspaces/x-y/f");
  });

  it("anchors at the repo root when the project is the repo", () => {
    git("init", "-q");
    fs.writeFileSync(path.join(tmp, ".git", "info", "exclude"), "# existing");
    prepareProjectRigWorkspaces(tmp, [path.join(tmp, ".workspaces", "x-y")]);
    expect(fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf-8")).toBe("# existing\n/.workspaces/\n");
  });
});

// OF-124: restore may recreate exactly the folder `rig up` made for a seat of a project rig, and nothing else.
describe("the daemon-owned workspace of a project rig seat (OF-124)", () => {
  let tmp: string;
  let project: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-own-")); project = path.join(tmp, "My Project"); fs.mkdirSync(project); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const seatDir = () => path.join(project, ".workspaces", "dev-impl");

  it("owns <project>/.workspaces/<pod>-<member> for seat <pod>.<member> of the rig the project's name gives, and nothing near it", () => {
    expect(projectRigWorkspaceOwner("my-project", "dev.impl", seatDir())).toBe(project);
    const nearMisses: Array<[string, string, string]> = [
      ["another rig name", "other", seatDir()],
      ["another seat's folder", "my-project", path.join(project, ".workspaces", "dev-other")],
      ["not under .workspaces", "my-project", path.join(project, "elsewhere", "dev-impl")],
      ["one level too deep", "my-project", path.join(project, ".workspaces", "x", "dev-impl")],
      ["a traversal", "my-project", path.join(project, ".workspaces", "dev-impl", "..", "dev-impl") + "/../dev-impl"],
      ["a relative path", "my-project", ".workspaces/dev-impl"],
    ];
    for (const [what, rigName, cwd] of nearMisses) expect(projectRigWorkspaceOwner(rigName, "dev.impl", cwd), what).toBeNull();
    // Seat ids that applyProjectRig would never have made a folder for.
    for (const logicalId of ["dev-impl", "dev.impl.x", "dev.", ".impl", "dev..impl", "dev.im pl"]) expect(projectRigWorkspaceOwner("my-project", logicalId, seatDir()), logicalId).toBeNull();
    expect(projectRigWorkspaceOwner("", "dev.impl", seatDir())).toBeNull();
  });

  it("recreates the missing folder (and .workspaces) and keeps it out of git status, creating nothing else", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    expect(recreateProjectRigWorkspace("my-project", "dev.impl", seatDir())).toBe(true);
    expect(fs.statSync(seatDir()).isDirectory()).toBe(true);
    expect(fs.readdirSync(project).sort()).toEqual([".git", ".workspaces"]);
    expect(fs.readdirSync(path.join(project, ".workspaces"))).toEqual(["dev-impl"]);
    expect(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf-8")).toContain("/.workspaces/\n");
  });

  it("refuses, and creates nothing, when the project is gone, the folder is there already, or .workspaces is a link", () => {
    fs.rmSync(project, { recursive: true });
    expect(recreateProjectRigWorkspace("my-project", "dev.impl", seatDir())).toBe(false);
    expect(fs.existsSync(project)).toBe(false);

    fs.mkdirSync(seatDir(), { recursive: true });
    expect(projectRigWorkspaceRecreatable("my-project", "dev.impl", seatDir()), "already there").toBeNull();
    fs.writeFileSync(path.join(project, ".workspaces", "marker"), "x");
    fs.rmSync(seatDir(), { recursive: true });
    fs.writeFileSync(seatDir(), "a file where the folder should be");
    expect(projectRigWorkspaceRecreatable("my-project", "dev.impl", seatDir()), "a file is the person's to fix").toBeNull();

    fs.rmSync(path.join(project, ".workspaces"), { recursive: true });
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(project, ".workspaces"));
    expect(recreateProjectRigWorkspace("my-project", "dev.impl", seatDir())).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe("unprojectedProjectRigError", () => {
  it("names a spec that still carries project_rig, and nothing else", () => {
    expect(unprojectedProjectRigError({ name: "team", project_rig: true })).toBe("team is a project rig: launch it with rig up <spec> --cwd <project folder>.");
    expect(unprojectedProjectRigError({ name: "team", project_rig: false })).toBeNull();
    expect(unprojectedProjectRigError({ name: "team" })).toBeNull();
    expect(unprojectedProjectRigError({ name: "team", project_rig: "yes" })).toBeNull();
  });
});
