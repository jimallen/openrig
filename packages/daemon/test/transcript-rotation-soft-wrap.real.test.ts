// workspaces-o9o.28 review (1), on a real tmux server (a private socket directory, never the operator's): a credential
// wider than its pane is soft-wrapped by tmux over two rows. Transcript rotation captured without joining wrapped rows, so
// the transcript file held the token as two fragments, each too short for the redaction policy, and both survived
// redactTranscriptContent. Rotation now captures with wrapped rows joined (`capture-pane -J`) on every capture path: the
// batched chain, a single session's own read, and a host that cannot batch.
//
// The fixture secret is built at runtime: no credential-shaped literal sits in this file (CoS rule, 2026-11-16).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, type TranscriptHost } from "../src/domain/transcript-rotation.js";
import { redactTranscriptContent } from "../src/domain/transcript-redaction.js";
import { nodeTranscriptFiles } from "../src/adapters/node-transcript-files.js";

const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** 26 characters: at a pane width of 16 it wraps as `sk-` + 13 and 10 more, each under the policy's `sk-` + 16 floor. */
const SECRET = ["s", "k-"].join("") + "o9o28wrap" + "Q".repeat(14);
/** The leading fragment an unjoined capture leaves in the file after redaction. */
const FRAGMENT = SECRET.slice(0, 12);
const WIDTH = 16;

describe.skipIf(!HAS_TMUX || process.platform === "win32")("transcript rotation joins soft-wrapped rows before anything redacts them (real tmux)", () => {
  // Set only once each step succeeds, so cleanup never acts on a half-made fixture: with no private env, a bare
  // `tmux kill-server` would inherit this process's environment and could reach a LIVE server.
  let base: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let adapter: TmuxAdapter;
  const tmux = (...args: string[]) => {
    if (!env) throw new Error("no private tmux environment: refusing to run tmux against an inherited server");
    return execFileSync("tmux", args, { env, encoding: "utf8" });
  };

  beforeAll(async () => {
    const root = realpathSync(mkdtempSync("/tmp/o9o28-"));
    base = root;
    const privateEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMUX_TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh" };
    env = privateEnv;
    // The argv path, as the daemon wires it; the shell path is pinned against it by tmux-argv-legacy-equivalence.
    adapter = new TmuxAdapter(
      async () => { throw new Error("shell path unused"); },
      undefined,
      (argv) => new Promise((resolve, reject) => {
        execFile(argv[0]!, argv.slice(1), { env: privateEnv, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
      }),
    );
    const script = join(root, "print.sh");
    writeFileSync(script, `printf 'starting deploy\\n%s\\ndone\\n' '${SECRET}'\nexec sleep 600\n`);
    for (const name of ["o9o28-one", "o9o28-a", "o9o28-b", "o9o28-plain"]) {
      tmux("new-session", "-d", "-s", name, "-x", String(WIDTH), "-y", "20", `/bin/sh ${script}`);
    }
    for (let i = 0; i < 100 && !tmux("capture-pane", "-p", "-t", "=o9o28-plain:").includes("done"); i++) await new Promise((r) => setTimeout(r, 50));
    // The positive control: unjoined, the pane really does hold the secret as two rows that survive redaction.
    const unjoined = tmux("capture-pane", "-p", "-t", "=o9o28-plain:");
    expect(unjoined).not.toContain(SECRET);
    expect(redactTranscriptContent(unjoined)).toContain(FRAGMENT);
  });

  afterEach(() => {
    clearAllTranscriptRotationsForTest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (env) { try { tmux("kill-server"); } catch { /* already gone */ } }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const rotateAndRead = async (host: TranscriptHost, sessions: string[]): Promise<string[]> => {
    const files = sessions.map((s) => join(base!, `${s}.log`));
    sessions.forEach((s, i) => startTranscriptRotation(nodeTranscriptFiles(), host, s, files[i]!, { lines: 50, pollIntervalMs: 60_000 }));
    for (let i = 0; i < 100 && !files.every((f) => existsSync(f)); i++) await new Promise((r) => setTimeout(r, 50));
    return files.map((f) => readFileSync(f, "utf8"));
  };

  const expectJoinedAndRedacted = (content: string) => {
    expect(content, "the capture holds the secret whole").toContain(SECRET);
    const redacted = redactTranscriptContent(content);
    expect(redacted).not.toContain(FRAGMENT);
    expect(redacted).toContain("[REDACTED]");
  };

  it("one session (its own read inside the batch path)", async () => {
    const [content] = await rotateAndRead(adapter, ["o9o28-one"]);
    expectJoinedAndRedacted(content!);
  });

  it("two sessions in one tick (the batched chain)", async () => {
    const batched = vi.spyOn(adapter, "capturePanesContent");
    const contents = await rotateAndRead(adapter, ["o9o28-a", "o9o28-b"]);
    expect(batched).toHaveBeenCalled();
    for (const content of contents) expectJoinedAndRedacted(content);
  });

  it("a host that cannot batch (per-target reads only)", async () => {
    const host: TranscriptHost = { capturePaneContent: (...a) => adapter.capturePaneContent(...a) };
    const [content] = await rotateAndRead(host, ["o9o28-plain"]);
    expectJoinedAndRedacted(content!);
  });
});
