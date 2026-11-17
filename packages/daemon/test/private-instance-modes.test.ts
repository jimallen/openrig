import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenRigInstance } from "../src/domain/instance-initialization.js";
import { nodeInstancePrivacy } from "../src/adapters/instance-privacy-fs.js";
import { securePrivateDb, securePrivateRoot } from "../src/domain/instance-privacy.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";
import { nodeTranscriptFiles } from "../src/adapters/node-transcript-files.js";

// workspaces-o9o.36: a seat's conversation (Pi session files, Codex rollouts, pane transcripts) holds full tool
// output, and on 2026-11-16 that output held a database password. Measured on Sparky that day: ~/.openrig 0755,
// state/ and transcripts/ 0775, session and transcript files 0664, because every OpenRig process runs under umask
// 0002. Anyone who could reach ~/.openrig could read every seat's conversation. These rows fail if OpenRig leaves
// an instance, or a transcript it writes, readable by anyone but its owner, or if keeping it private reaches past
// the instance.

const roots: string[] = [];
let savedUmask = 0;

beforeEach(() => {
  // The umask every OpenRig process measured on Sparky runs under (/proc/<pid>/status Umask: 0002).
  savedUmask = process.umask(0o002);
});

afterEach(() => {
  clearAllTranscriptRotationsForTest();
  process.umask(savedUmask);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openrig-private-modes-"));
  roots.push(root);
  return root;
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
}

function writeWithMode(path: string, content: string, fileMode: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, fileMode);
  return path;
}

/** Start the instance the way the daemon does, with the user's home outside the test root. */
function start(home: string, workspaceRoot: string, userHome: string) {
  return ensureOpenRigInstance({ home, workspaceRoot, privacy: nodeInstancePrivacy({ userHome }) });
}

describe("an OpenRig instance is private to its owner (workspaces-o9o.36)", () => {
  it("a fresh instance home and its private roots are 0700 and config.json 0600", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    const result = start(home, join(home, "workspace"), join(root, "user-home"));
    expect(result.ok).toBe(true);
    const observed = Object.fromEntries(
      ["", "state", "transcripts", "logs", "secrets", "backups", "specs", "run"].map((rel) => [rel || ".", mode(join(home, rel))]),
    );
    expect(observed).toEqual({
      ".": "0700", state: "0700", transcripts: "0700", logs: "0700", secrets: "0700", backups: "0700", specs: "0700", run: "0700",
    });
    expect(mode(join(home, "config.json"))).toBe("0600");
  });

  it("an existing instance written under umask 002 has group and other access removed at start, owner bits kept", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    // The shape measured on Sparky: a Pi session file, a pane transcript and a Codex rollout 0664 under 0775 dirs.
    const sessions = join(home, "state", "pi", "verify-ops@openrig", "sessions");
    const session = writeWithMode(join(sessions, "2026-11-16T11-00-00.jsonl"), "{\"tool_output\":\"a seat's tool output\"}\n", 0o664);
    const transcriptDir = join(home, "transcripts", "openrig");
    const transcript = writeWithMode(join(transcriptDir, "verify-ops@openrig.log"), "pane text\n", 0o664);
    const codexSession = writeWithMode(join(home, "codex-seats", "queue-worker@kernel", "sessions", "rollout.jsonl"), "{}\n", 0o664);
    for (const dir of [join(home, "state"), sessions, join(home, "transcripts"), transcriptDir]) chmodSync(dir, 0o775);
    chmodSync(home, 0o755);

    expect(start(home, join(home, "workspace"), join(root, "user-home")).ok).toBe(true);

    expect({
      home: mode(home), sessionsDir: mode(sessions), session: mode(session),
      transcriptDir: mode(transcriptDir), transcript: mode(transcript), codexSession: mode(codexSession),
    }).toEqual({
      home: "0700", sessionsDir: "0700", session: "0600",
      transcriptDir: "0700", transcript: "0600", codexSession: "0600",
    });
  });

  it("an executable the owner runs stays executable by the owner: handover release.sh and rig-bin/git", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    // openrig-23's release script on stu lives at ~/.openrig/handover/<dir>/release.sh; seats exec rig-bin/git.
    const release = writeWithMode(join(home, "handover", "deploy-d0303ca8-20261116T0302", "release.sh"), "#!/bin/sh\n", 0o775);
    const git = writeWithMode(join(home, "rig-bin", "git"), "#!/bin/sh\n", 0o755);
    const hook = writeWithMode(join(home, "state", "claude-activity-hooks", "activity-relay.cjs"), "// hook\n", 0o775);

    expect(start(home, join(home, "workspace"), join(root, "user-home")).ok).toBe(true);

    expect({ release: mode(release), git: mode(git), hook: mode(hook) })
      .toEqual({ release: "0700", git: "0700", hook: "0700" });
  });

  it("never follows a symlink: a linked file and a linked directory outside the instance keep their modes", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    // The shape on Sparky: state/pi/<seat>/agent/auth.json links to ~/.pi/agent/auth.json.
    const linkedFile = writeWithMode(join(root, "pi-agent", "auth.json"), "{}\n", 0o644);
    const linkedDir = join(root, "codex-home");
    const insideLinkedDir = writeWithMode(join(linkedDir, "config.toml"), "x = 1\n", 0o664);
    chmodSync(linkedDir, 0o775);
    mkdirSync(join(home, "state", "pi", "s@r", "agent"), { recursive: true });
    symlinkSync(linkedFile, join(home, "state", "pi", "s@r", "agent", "auth.json"));
    mkdirSync(join(home, "codex-seats", "s@r"), { recursive: true });
    symlinkSync(linkedDir, join(home, "codex-seats", "s@r", "mcp-oauth-locks"));

    expect(start(home, join(home, "workspace"), join(root, "user-home")).ok).toBe(true);

    expect({ linkedFile: mode(linkedFile), linkedDir: mode(linkedDir), insideLinkedDir: mode(insideLinkedDir), home: mode(home) })
      .toEqual({ linkedFile: "0644", linkedDir: "0775", insideLinkedDir: "0664", home: "0700" });
  });

  it("never walks outside the home: a workspace root configured beside it and the home's parent keep their modes", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    const workspace = join(root, "shared-workspace");
    const workspaceFile = writeWithMode(join(workspace, "notes.md"), "notes\n", 0o664);
    chmodSync(workspace, 0o775);
    const sibling = writeWithMode(join(root, "sibling.txt"), "x\n", 0o664);
    chmodSync(root, 0o775);

    expect(start(home, workspace, join(root, "user-home")).ok).toBe(true);

    expect({ root: mode(root), sibling: mode(sibling), workspace: mode(workspace), workspaceFile: mode(workspaceFile), home: mode(home) })
      .toEqual({ root: "0775", sibling: "0664", workspace: "0775", workspaceFile: "0664", home: "0700" });
  });

  it("refuses a home that is the user's own home directory or above it before writing anything, and changes nothing", () => {
    const root = freshRoot();
    const userHome = join(root, "users", "jim");
    const project = writeWithMode(join(userHome, "project", "README.md"), "readme\n", 0o664);
    chmodSync(userHome, 0o755);

    for (const home of [userHome, join(root, "users")]) {
      const result = start(home, join(home, "workspace"), userHome);
      expect({ ok: result.ok, conflict: result.conflicts.map((c) => c.path), created: result.createdPaths })
        .toEqual({ ok: false, conflict: [home], created: [] });
      expect({ config: existsSync(join(home, "config.json")), state: existsSync(join(home, "state")) })
        .toEqual({ config: false, state: false });
    }
    expect({ userHome: mode(userHome), project: mode(project) }).toEqual({ userHome: "0755", project: "0664" });
  });

  it("refuses the user's home reached through a symlink: an aliased parent and an aliased home", () => {
    const root = freshRoot();
    const userHome = join(root, "users", "jim");
    const project = writeWithMode(join(userHome, "project", "README.md"), "readme\n", 0o664);
    chmodSync(userHome, 0o755);
    symlinkSync(join(root, "users"), join(root, "alias"));
    symlinkSync(userHome, join(root, "home-link"));

    for (const home of [join(root, "alias", "jim"), join(root, "home-link"), join(root, "alias")]) {
      const result = start(home, join(home, "workspace"), userHome);
      expect({ home, ok: result.ok, conflict: result.conflicts.map((c) => c.path) }).toEqual({ home, ok: false, conflict: [home] });
    }
    expect({ userHome: mode(userHome), project: mode(project), config: existsSync(join(userHome, "config.json")) })
      .toEqual({ userHome: "0755", project: "0664", config: false });
  });

  it("a home its owner cannot enter (0600) is opened to 0700 for its owner, and its contents made private", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    const session = writeWithMode(join(home, "state", "pi", "s@r", "sessions", "a.jsonl"), "{}\n", 0o664);
    chmodSync(home, 0o600);

    expect(start(home, join(home, "workspace"), join(root, "user-home")).ok).toBe(true);

    expect({ home: mode(home), session: mode(session), config: mode(join(home, "config.json")) })
      .toEqual({ home: "0700", session: "0600", config: "0600" });
  });

  it("a dry run changes no modes", () => {
    const root = freshRoot();
    const home = join(root, ".openrig");
    const session = writeWithMode(join(home, "state", "pi", "s@r", "sessions", "a.jsonl"), "{}\n", 0o664);
    const result = ensureOpenRigInstance({ home, workspaceRoot: join(home, "workspace"), dryRun: true, privacy: nodeInstancePrivacy({ userHome: join(root, "user-home") }) });
    expect(result.ok).toBe(true);
    expect(mode(session)).toBe("0664");
  });
});

describe("a pane transcript is private to its owner under a loose umask (workspaces-o9o.36)", () => {
  it("a transcript root configured outside the instance is created 0700 with its rig directory, and the boundary-marked transcript 0600", () => {
    const root = join(freshRoot(), "elsewhere", "transcripts");
    const store = new TranscriptStore({ files: nodeTranscriptFiles(), transcriptsRoot: root, enabled: true });
    expect(store.ensureTranscriptDir("openrig")).toBe(true);
    expect(store.writeBoundaryMarker("openrig", "verify-ops@openrig", "launch")).toBe(true);
    expect({
      root: mode(root),
      rigDir: mode(join(root, "openrig")),
      transcript: mode(store.getTranscriptPath("openrig", "verify-ops@openrig")),
    }).toEqual({ root: "0700", rigDir: "0700", transcript: "0600" });
  });

  it("an existing transcript root outside the instance is made private at start: dirs 0700, files 0600, symlinks not followed", () => {
    const base = freshRoot();
    const transcripts = join(base, "elsewhere", "transcripts");
    const transcript = writeWithMode(join(transcripts, "openrig", "verify-ops@openrig.log"), "pane text\n", 0o664);
    const outside = writeWithMode(join(base, "outside.txt"), "x\n", 0o644);
    symlinkSync(outside, join(transcripts, "openrig", "link.log"));
    chmodSync(join(transcripts, "openrig"), 0o775);
    chmodSync(transcripts, 0o775);

    const result = securePrivateRoot(transcripts, nodeInstancePrivacy({ userHome: join(base, "user-home") }));

    expect({ status: result.status, root: mode(transcripts), rigDir: mode(join(transcripts, "openrig")), transcript: mode(transcript), outside: mode(outside) })
      .toEqual({ status: "secured", root: "0700", rigDir: "0700", transcript: "0600", outside: "0644" });
  });

  it("the captured pane text the rotation writes is 0600 in a 0700 directory", async () => {
    const outputPath = join(freshRoot(), "rig", "verify-ops@openrig.log");
    const tmux = Object.assign(mockTmuxAdapter(), { capturePaneContent: async () => "captured pane text\n" });
    startTranscriptRotation(nodeTranscriptFiles(), tmux, "verify-ops@openrig", outputPath, { lines: 100, pollIntervalMs: 60_000 });
    for (let i = 0; i < 50 && !existsSync(outputPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stopTranscriptRotation("verify-ops@openrig");
    expect({ dir: mode(join(outputPath, "..")), transcript: mode(outputPath) }).toEqual({ dir: "0700", transcript: "0600" });
  });
});

// workspaces-o9o.74: a db configured outside the OpenRig home (db.path, exported as OPENRIG_DB) is private to its owner: the db and its
// SQLite sidecars are 0600, and its folder is 0700 only when it is OpenRig's own (it holds nothing but the db files). A shared folder
// (db.path = ~/Documents/openrig.sqlite) is left as it is and named; nothing below the folder is walked.
describe("o9o.74: an external db", () => {
  const port = (base: string) => nodeInstancePrivacy({ userHome: join(base, "user-home") });

  it("D1 a folder holding only the db and its sidecars is made 0700 and the db files 0600", () => {
    const base = freshRoot();
    const dir = join(base, "db");
    const db = writeWithMode(join(dir, "openrig.sqlite"), "db", 0o664);
    const wal = writeWithMode(join(dir, "openrig.sqlite-wal"), "wal", 0o664);
    const shm = writeWithMode(join(dir, "openrig.sqlite-shm"), "shm", 0o644);
    chmodSync(dir, 0o775);
    const result = securePrivateDb(db, port(base));
    expect(result).toMatchObject({ status: "secured", folder: "secured" });
    expect({ dir: mode(dir), db: mode(db), wal: mode(wal), shm: mode(shm) }).toEqual({ dir: "0700", db: "0600", wal: "0600", shm: "0600" });
  });

  it("D2 an empty folder the preflight created (no db yet) is OpenRig's own and is made 0700", () => {
    const base = freshRoot();
    const dir = join(base, "db");
    mkdirSync(dir);
    chmodSync(dir, 0o775);
    expect(securePrivateDb(join(dir, "openrig.sqlite"), port(base))).toMatchObject({ folder: "secured" });
    expect(mode(dir)).toBe("0700");
  });

  it("D3 a shared folder is left as it is and named; only the db files are made 0600", () => {
    const base = freshRoot();
    const dir = join(base, "Documents");
    const db = writeWithMode(join(dir, "openrig.sqlite"), "db", 0o664);
    const other = writeWithMode(join(dir, "taxes.pdf"), "x", 0o664);
    const sub = join(dir, "photos");
    mkdirSync(sub);
    const inner = writeWithMode(join(sub, "a.jpg"), "x", 0o644);
    chmodSync(sub, 0o775);
    chmodSync(dir, 0o775);
    const result = securePrivateDb(db, port(base));
    expect(result).toMatchObject({ status: "secured", folder: "shared" });
    expect({ dir: mode(dir), db: mode(db), other: mode(other), sub: mode(sub), inner: mode(inner) })
      .toEqual({ dir: "0775", db: "0600", other: "0664", sub: "0775", inner: "0644" });
  });

  it("D4 a db that is a symlink is never followed: its target keeps its mode", () => {
    const base = freshRoot();
    const target = writeWithMode(join(base, "elsewhere", "real.sqlite"), "db", 0o644);
    const dir = join(base, "db");
    mkdirSync(dir);
    symlinkSync(target, join(dir, "openrig.sqlite"));
    const sideTarget = writeWithMode(join(base, "elsewhere", "real.sqlite-wal"), "wal", 0o664);
    symlinkSync(sideTarget, join(dir, "openrig.sqlite-wal"));
    const result = securePrivateDb(join(dir, "openrig.sqlite"), port(base));
    expect({ target: mode(target), sideTarget: mode(sideTarget) }).toEqual({ target: "0644", sideTarget: "0664" });
    // verify-sec o9o.74 finding 2: never followed, but named, so the caller can say the target is exposed.
    expect(result.symlinks).toEqual([join(dir, "openrig.sqlite"), join(dir, "openrig.sqlite-wal")]);
  });

  it("D7 every db file ends exactly 0600, whatever owner bits it had (0700, 0744, 0400)", () => {
    const base = freshRoot();
    const dir = join(base, "db");
    const db = writeWithMode(join(dir, "openrig.sqlite"), "db", 0o700);
    const wal = writeWithMode(join(dir, "openrig.sqlite-wal"), "wal", 0o744);
    const shm = writeWithMode(join(dir, "openrig.sqlite-shm"), "shm", 0o400);
    securePrivateDb(db, port(base));
    expect({ db: mode(db), wal: mode(wal), shm: mode(shm) }).toEqual({ db: "0600", wal: "0600", shm: "0600" });
  });

  it("D5 a db folder that is the user's home is refused: the folder keeps its mode, the db is made 0600", () => {
    const base = freshRoot();
    const home = join(base, "user-home");
    const db = writeWithMode(join(home, "openrig.sqlite"), "db", 0o664);
    chmodSync(home, 0o755);
    expect(securePrivateDb(db, port(base))).toMatchObject({ folder: "refused" });
    expect({ home: mode(home), db: mode(db) }).toEqual({ home: "0755", db: "0600" });
  });

  it("D6 a db folder that does not exist changes nothing", () => {
    const base = freshRoot();
    expect(securePrivateDb(join(base, "nowhere", "openrig.sqlite"), port(base))).toMatchObject({ status: "missing", tightened: 0 });
  });
});
