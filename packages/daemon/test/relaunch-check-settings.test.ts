// workspaces-o9o.64: a seat's spec may override the relaunch checks' defaults (RELAUNCH_CHECK_DEFAULTS) with a member field:
//   relaunch_checks:
//     handover_file: "NOTES-*.md"         # the seat's handover file: one "*", no "/" (default HANDOVER*.md)
//     ignore_children: [sccache, watchman] # processes the agent keeps running, added to the defaults; matched by name exactly
// The field is read at launch from the rig's recorded spec source (nothing is stored), and validated with the rest of the spec.
import { describe, expect, it } from "vitest";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { judgeChildren, newestHandoverFile, relaunchCheckSettingsFrom, DEFAULT_RELAUNCH_CHECK_SETTINGS, type RelaunchCheckPort } from "../src/domain/relaunch-checks.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow => ({ pid, ppid, executableName, command });

describe("o9o.64: the relaunch_checks member field", () => {
  it("a well-formed field gives the seat's settings; an absent one gives the defaults", () => {
    expect(relaunchCheckSettingsFrom({ handover_file: "NOTES-*.md", ignore_children: ["sccache", "watchman"] }, "m"))
      .toEqual({ ok: true, settings: { handoverFile: { prefix: "NOTES-", suffix: ".md" }, ignoreChildren: ["sccache", "watchman"], source: "spec" } });
    expect(relaunchCheckSettingsFrom(undefined, "m")).toEqual({ ok: true, settings: DEFAULT_RELAUNCH_CHECK_SETTINGS });
    expect(DEFAULT_RELAUNCH_CHECK_SETTINGS).toMatchObject({ handoverFile: { prefix: "HANDOVER", suffix: ".md" }, ignoreChildren: [], source: "defaults" });
  });

  it.each([
    [{ handover_file: "NOTES.md" }, "m.relaunch_checks.handover_file"],
    [{ handover_file: "a/b*.md" }, "m.relaunch_checks.handover_file"],
    [{ handover_file: "**.md" }, "m.relaunch_checks.handover_file"],
    [{ handover_file: 7 }, "m.relaunch_checks.handover_file"],
    [{ ignore_children: "sccache" }, "m.relaunch_checks.ignore_children"],
    [{ ignore_children: ["ok", "has space"] }, "m.relaunch_checks.ignore_children[1]"],
    [{ ignore_children: ["../x"] }, "m.relaunch_checks.ignore_children[0]"],
    [{ ignore_children: [""] }, "m.relaunch_checks.ignore_children[0]"],
    [{ ignored_children: ["x"] }, "m.relaunch_checks.ignored_children"],
    [["x"], "m.relaunch_checks"],
  ])("a malformed field is refused with its path (%j)", (value, path) => {
    const parsed = relaunchCheckSettingsFrom(value, "m");
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.errors.join("\n")).toContain(path);
  });

  it("ignore_children adds to the expected processes, matched by exact name, never by an argument", () => {
    const rows = [row(10, 1, "claude", "claude"), row(11, 10, "sccache", "sccache --start-server"), row(12, 10, "node", "node ./build --cache sccache")];
    const settings = { handoverFile: { prefix: "HANDOVER", suffix: ".md" }, ignoreChildren: ["sccache"], source: "spec" as const };
    expect(judgeChildren(rows, 10, [], "claude-code", settings)).toMatchObject({
      verdict: "held", held: [{ pid: 12 }], ignored: [{ pid: 11, kind: "seat_spec" }],
    });
    // Without the seat's setting the same process is unfinished work.
    expect(judgeChildren(rows, 10, [], "claude-code")).toMatchObject({ verdict: "held", held: [{ pid: 11 }, { pid: 12 }] });
  });

  it("handover_file names which files are the seat's handover", () => {
    const port: RelaunchCheckPort = { leases: () => [], folderFiles: () => [
      { name: "HANDOVER.md", modifiedAt: "2026-11-17T10:00:00.000Z" }, { name: "NOTES-tuesday.md", modifiedAt: "2026-11-17T09:00:00.000Z" }] };
    const settings = { handoverFile: { prefix: "NOTES-", suffix: ".md" }, ignoreChildren: [], source: "spec" as const };
    expect(newestHandoverFile("/seat", port, settings)).toEqual({ path: "/seat/NOTES-tuesday.md", modifiedAt: "2026-11-17T09:00:00.000Z" });
    expect(newestHandoverFile("/seat", port)).toEqual({ path: "/seat/HANDOVER.md", modifiedAt: "2026-11-17T10:00:00.000Z" });
  });

  it("the rig spec accepts a well-formed field and refuses a malformed one at the member's path", () => {
    const spec = (relaunch: unknown) => ({ version: "0.2", name: "r", pods: [{ id: "dev", label: "Dev", members: [
      { id: "impl", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", relaunch_checks: relaunch }] }] });
    expect(RigSpecSchema.validate(spec({ handover_file: "NOTES-*.md", ignore_children: ["sccache"] })).errors).toEqual([]);
    expect(RigSpecSchema.validate(spec({ handover_file: "NOTES.md" })).errors.join("\n")).toContain("pods[0].members[0].relaunch_checks.handover_file");
  });
});
