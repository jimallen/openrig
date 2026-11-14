// OF-289: a command written inside parentheses in operator text is set off (setOff), so a paste of it is the command and not the
// `)` and the sentence after it. The pure surfaces run their hostile-name table through real `sh`; the census holds every other
// `(rig ...` in the daemon and CLI sources to the sites deliberately left, so a new undelimited one fails here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeNoticeText } from "../src/domain/native-inbox-settlement.js";
import { modelLoopStartBody } from "../src/domain/seat-model-error-loop-notice.js";
import { untrustedSpecSourceRemedy } from "../src/domain/seat-startup-source.js";
import { HcUnsettledHealthSource } from "../src/domain/hc-unsettled-health.js";
import { createDefaultRestoreRig } from "../src/domain/crash-cart-conductor.js";
import { describeAmbiguousSessionName } from "../src/domain/session-name-matches.js";
import Database from "better-sqlite3";
import { setOffCommands, rigWords, closesCleanly } from "./helpers/shell-argv.js";

const HOSTILE = ["dev@rig", "my seat@rig", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x", "a`b", "a`b'c", "x``y'z"];

/** The set-off commands of `text` as rig words, each checked to close cleanly; `<placeholder>` words are kept as written. */
function commandsIn(text: string): string[][] {
  const commands = setOffCommands(text);
  for (const command of commands) expect(closesCleanly(text, command), `${command} closes cleanly in: ${text}`).toBe(true);
  return commands.map((c) => rigWords(c.replace(/<([A-Za-z.-]+)>/g, "PLACEHOLDER_$1")).map((w) => w.replace(/^PLACEHOLDER_(.+)$/, "<$1>")));
}

describe("parenthesised commands that name a seat or rig paste as their own words (OF-289)", () => {
  it.each(HOSTILE)("the native delivery notice for %j: rig capture names exactly that seat", (seat) => {
    const text = nativeNoticeText({ outboxId: "o-1", destinationSession: seat, nativeWrittenAt: null }, "was not confirmed delivered.");
    const from = text.slice(text.indexOf("Before resending"));
    expect(commandsIn(from)).toEqual([["capture", seat]]);
  });

  it.each(HOSTILE)("the model-error loop notice for %j: capture, ps --nodes and health are each set off", (session) => {
    const body = modelLoopStartBody("dev@rig", session, { count: 3, total: 11, since: "2026-11-14T00:00:00Z", lastAt: "2026-11-14T00:10:00Z", lastError: "terminated" });
    const look = body.split("\n").find((l) => l.startsWith("Look: "))!;
    expect(commandsIn(look)).toEqual([["capture", session], ["ps", "--nodes"], ["health"]]);
  });

  it.each(HOSTILE)("the untrusted spec source remedy for rig %j: spec-source set and show name exactly that rig", (rig) => {
    const text = untrustedSpecSourceRemedy(rig);
    const from = text.slice(text.indexOf("instead: "));
    expect(commandsIn(from)).toEqual([["spec-source", "set", rig, "<path-to-rig.yaml>", "--operator", "<address>"], ["spec-source", "show", rig]]);
  });
});

describe("OF-289 review: the hc unsettled notice, the crash-cart remediation and the ambiguous-session advice", () => {
  it.each(HOSTILE)("the hc unsettled notice for seat %j: capture and retire-unsettled-send name exactly that seat and row", (seat) => {
    const id = "outbox-9";
    const source = new HcUnsettledHealthSource(() => [{ outboxId: id, destination: seat, since: "2026-11-14 00:00:00" }], () => new Date("2026-11-14T01:00:00Z"));
    const notice = source.coverage()[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    const reason = notice.reason;
    const from = reason.slice(reason.indexOf("Check the seat"));
    expect(commandsIn(from)).toEqual([["capture", seat], ["seat", "retire-unsettled-send", seat, id, "--reason", "<what you found>"]]);
  });

  it.each(HOSTILE)("crash-cart with no usable snapshot for rig %j: rig snapshot names exactly that rig", async (rig) => {
    const r = await createDefaultRestoreRig({ findLatestRestoreUsable: () => null, restore: async () => { throw new Error("not called"); } })(rig);
    expect(commandsIn(r.remediation!)).toEqual([["snapshot", rig]]);
  });

  /** The rigs table describeAmbiguousSessionName reads (each rig's name and archived_at), with both candidate rigs in it. */
  const rigsDb = (archived: boolean): Database.Database => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE rigs (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived_at TEXT)");
    for (const id of ["r-1", "r-2"]) db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, 'w', ?)").run(id, archived ? "2026-11-01" : null);
    return db;
  };
  const twoRigs = [{ id: "s1", node_id: "n1", session_name: "dev@w", rig_id: "r-1" }, { id: "s2", node_id: "n2", session_name: "dev@w", rig_id: "r-2" }];

  it("an ambiguous session among live rigs: stop, archive and archive --force are each set off", () => {
    const text = describeAmbiguousSessionName(rigsDb(false), "dev@w", twoRigs);
    const from = text.slice(text.indexOf("To resolve it"));
    expect(commandsIn(from)).toEqual([["down", "<rigId>"], ["archive", "<rigId>"], ["archive", "<rigId>", "--force"]]);
  });

  it("an ambiguous session among archived rigs: unarchive is set off", () => {
    const text = describeAmbiguousSessionName(rigsDb(true), "dev@w", twoRigs);
    const from = text.slice(text.indexOf("unarchive the one"));
    expect(commandsIn(from)).toEqual([["unarchive", "<rigId>"]]);
  });
});

// The census. Each entry is a file and the text that follows its "(rig " (enough to tell the site apart), with why it stays.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LEFT: Array<{ file: string; after: string; why: string }> = [
  { file: "packages/daemon/src/domain/restore-orchestrator.ts", after: "seat launch --fresh would meet", why: "names a path that would also refuse; not advice to run it" },
  { file: "packages/daemon/src/domain/rigspec-instantiator.ts", after: "seat launch --fresh, or a restore", why: "names a launch that will be refused; not advice to run it" },
  { file: "packages/daemon/src/domain/health-detectors.ts", after: "down, rig seat stop)", why: "a detector threshold naming the supported stops" },
  { file: "packages/daemon/src/domain/review/compose.ts", after: "scope)", why: "a source label in a review, not a command" },
  { file: "packages/daemon/src/domain/seat-handover-service.ts", after: "context profile <pack>", why: "agent-facing handover packet" },
  { file: "packages/cli/src/commands/host.ts", after: "ps --json parses)", why: "says what a doctor check verified, not advice" },
  { file: "packages/cli/src/commands/down.ts", after: "ps --nodes --rig <rig>)", why: "help text with a <placeholder>" },
  { file: "packages/cli/src/commands/seat.ts", after: "capture <seat>), send again", why: "help text with a <placeholder>" },
  { file: "packages/cli/src/commands/seat.ts", after: "capture <seat>) and stop", why: "help text with a <placeholder>" },
  { file: "packages/cli/src/commands/scope.ts", after: "scope repair)", why: "the verified-by marker scope trust parses, not advice" },
  { file: "packages/cli/src/lib/scope/trust.ts", after: "scope create\\)", why: "the regex that reads the verified-by marker" },
  { file: "packages/cli/src/lib/scope/trust.ts", after: "scope repair\\)", why: "the regex that reads the verified-by marker" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Every "(rig <word>" in daemon and CLI source text outside comment lines, as file and the text after "(rig ". */
function parenthesisedRigCommands(): Array<{ file: string; after: string; line: number }> {
  const found: Array<{ file: string; after: string; line: number }> = [];
  for (const root of ["packages/daemon/src", "packages/cli/src"]) {
    for (const full of sourceFiles(path.join(REPO_ROOT, root))) {
      const file = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      readFileSync(full, "utf8").split("\n").forEach((text, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
        for (const m of text.matchAll(/\(rig (?=[a-z])/g)) found.push({ file, after: text.slice(m.index! + m[0].length), line: i + 1 });
      });
    }
  }
  return found;
}

describe("census: no command sits bare inside parentheses in operator text (OF-289)", () => {
  it("every (rig ... in daemon and CLI source is one of the sites deliberately left", () => {
    const unexpected = parenthesisedRigCommands().filter((f) => !LEFT.some((l) => l.file === f.file && f.after.startsWith(l.after)));
    expect(
      unexpected.map((f) => `${f.file}:${f.line}: (rig ${f.after.slice(0, 60)}`),
      "a command bare inside parentheses: wrap the command in setOff(...), or add a LEFT entry with a why",
    ).toEqual([]);
  });

  it("every site left is still there (a stale entry is removed, not kept)", () => {
    const found = parenthesisedRigCommands();
    expect(LEFT.filter((l) => !found.some((f) => f.file === l.file && f.after.startsWith(l.after)))).toEqual([]);
  });
});
