// pda runtime L3 (pda-runtime-design-9l, lane "L3 integration"): one hermetic end-to-end proof that a pda seat works
// through the whole shipped chain, with nothing replaced but pda itself.
//
// REAL: the built `rig` CLI, a real daemon process (`rig daemon start` -> createDaemon, temp OPENRIG_HOME, its own
// SQLite), a real tmux server on the harness's private socket (hermetic-env.ts: `tmux -S <scaffold>/tmux.sock`, the
// default socket is never reached), the real `rig up` / `send` / `capture` / `down` / `seat pda-release` commands, the
// real pda-runner process typed into the seat's pane, the real client and outbox, and the real stub runner for the
// non-pda seat. FAKE: pda, by L1a's loopback `fake-pda.ts` (real HTTP, real dedupe, real SSE), reached through a
// test-owned TCP gate so "pda restarts" without losing the fake's conversation, as a real pda keeps it in its SQLite.
// Nothing here touches a real pda, a live daemon, ~/.openrig, or any tmux server but the scaffold's.
//
// The rows share one daemon and one fixture, in order, as stub-cli-journeys does; a row's number is its design/brief
// number. Needs the CLI and daemon built (`npm run build -w packages/daemon -w packages/cli`): the pane runs the
// COMPILED runner from dist, exactly as production does.
//
// What a busy or stale sidecar does (read from session-transport, then pinned): a BUSY runner does not refuse a send
// (`running` proceeds with an advisory), so that row pins "goes in as a followUp"; a STALE sidecar (older than its
// alive window) is no answer, so today's pane logic decides, and a forged held head in an old sidecar is not believed.
// What refuses: a held head (needs_input), --dangerously-interact on a runner seat, and a dead runner (pane at a shell).
//
// Boundary, what this does NOT prove: pda itself. Every pda behaviour here is the fake's, written from pi-durable
// 1.3.0 declarations, so the real SSE framing, the real dedupe window, a restart with running tasks, token-file
// ownership and real Ollama Cloud costs are live-qualification rows (Q0-Q13). No tool output is streamed here, so the
// sanitiser and the exact-value redaction are pinned by their unit tests, not driven through a pane (live Q11).
// `--wait-for-idle` after 6 minutes of idle is unit-pinned (T27); row 9 (frames) waits out the 15 s hook window only.
// Row 10 reads /proc for process environments, so that surface is scanned on Linux only. Run on Linux (Sparky:
// tmux 3.4, node 22.23.2); not run on macOS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import Database from "better-sqlite3";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HermeticScaffold } from "./helpers/hermetic-env.js";
import { installTrustedScenario, prepareTrustedHermeticEnv } from "./helpers/trusted-scaffold.js";
import { runRig, spawnScenarioDaemon, type RigResult, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { startFakePda, nonAllowlisted, type FakePda } from "./helpers/fake-pda.js";
import { assistantEntry, assistantMessage, deltaEvent, messageEnd, messageStart, runEnd, runStart } from "./helpers/pda-real-shapes.js";
import { parsePdaRunnerState, pdaSeatPaths, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");
const podTemplate = resolve(here, "../../../docs/reference/templates/pda-seat/agent.yaml");

/** A valid pda token (43 base64url characters) that is also the canary: nothing else may contain it. */
const BEARER = "E2ECANARYbearer".padEnd(43, "Z");
const RIG = "pda-e2e";
const PDA_SEAT = `lab-research@${RIG}`;
const SENDER = "dev-impl@dev-pair-stub";
const STUB_SEAT = "dev-qa@dev-pair-stub";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(what: string, probe: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v) return v as NonNullable<T>;
    } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}${last ? ` (last error: ${String(last)})` : ""}`);
    await sleep(100);
  }
}

/** A test-owned TCP gate in front of the fake: the spec's base_url is the GATE's port, so "pda goes down and comes
 *  back" is the gate refusing and re-accepting on the same port while the fake keeps its conversation, as a real
 *  pda keeps its in a SQLite file. It forwards bytes and logs nothing (no header ever passes through test code). */
class Gate {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  readonly port: number;
  private constructor(port: number, private readonly target: number) { this.port = port; }
  static async open(target: number): Promise<Gate> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const gate = new Gate(port, target);
    await gate.up();
    return gate;
  }
  async up(): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target, "127.0.0.1");
      this.sockets.add(client); this.sockets.add(upstream);
      const drop = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on("error", drop); upstream.on("error", drop); client.on("close", drop); upstream.on("close", drop);
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((r, j) => { this.server!.once("error", j); this.server!.listen(this.port, "127.0.0.1", r); });
  }
  /** pda stops: the listener closes (connection refused) and every open connection dies without a stream_end. */
  async down(): Promise<void> {
    const s = this.server; this.server = null;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

describe("pda seat end to end: real daemon, real tmux (private socket), real runner, fake pda", () => {
  let scaffold: HermeticScaffold;
  let daemon: ScenarioDaemon;
  let fake: FakePda;
  let gate: Gate;
  let tokenFile: string;
  let specDir: string;
  let specPath: string;
  const launched: string[] = [];

  const cli = (args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 60_000): Promise<RigResult> =>
    runRig(args, { ...daemon.readEnv, OPENRIG_SESSION_NAME: SENDER, ...env }, rigBin, timeoutMs);
  const cliJson = async (args: string[]): Promise<any> => {
    const r = await cli(args);
    expect(r.code, JSON.stringify({ args, ...r })).toBe(0);
    return JSON.parse(r.stdout);
  };
  const paths = () => pdaSeatPaths(join(scaffold.openrigHome, "state", "pda"), PDA_SEAT);
  const sidecar = (): PdaRunnerState | null => {
    try { return parsePdaRunnerState(readFileSync(paths().runnerStatePath, "utf8")); } catch { return null; }
  };
  const captureText = async (seat = PDA_SEAT, lines = 400): Promise<string> => {
    const r = await cli(["capture", seat, "--lines", String(lines), "--json"]);
    expect(r.code, JSON.stringify(r)).toBe(0);
    const j = JSON.parse(r.stdout);
    return typeof j.content === "string" ? j.content : JSON.stringify(j);
  };
  const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
  const db = () => new Database(join(scaffold.stateDir, "scenario.db"), { readonly: true, fileMustExist: true });

  beforeAll(async () => {
    scaffold = prepareTrustedHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    fake = await startFakePda({ token: BEARER, agents: ["research"] });
    gate = await Gate.open(Number(new URL(fake.baseUrl).port));
    tokenFile = join(scaffold.root, "pda-token");
    writeFileSync(tokenFile, BEARER, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    // The daemon reads pda's token file PATH from this variable (resolvePdaTokenFile); it never opens the file.
    scaffold.env.OPENRIG_PDA_TOKEN_FILE = tokenFile;
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });

    specDir = join(scaffold.root, "spec");
    mkdirSync(join(specDir, "agents", "pda-seat"), { recursive: true });
    writeFileSync(join(specDir, "agents", "pda-seat", "agent.yaml"), readFileSync(podTemplate));
    specPath = join(specDir, `${RIG}.yaml`);
    writeFileSync(specPath, [
      `version: "0.2"`,
      `name: ${RIG}`,
      `pods:`,
      `  - id: lab`,
      `    label: Lab`,
      `    members:`,
      `      - id: research`,
      `        agent_ref: "local:agents/pda-seat"`,
      `        profile: default`,
      `        runtime: pda`,
      `        cwd: .`,
      `        pda:`,
      `          agent: research`,
      `          base_url: http://127.0.0.1:${gate.port}`,
      ``,
    ].join("\n"));
    mkdirSync(join(scaffold.root, "cwd"), { recursive: true });
    mkdirSync(join(scaffold.root, "stub-cwd"), { recursive: true });
    // The existing runtime in the same daemon: two stub seats (the sender's identity, and row 12's recipient).
    const stub = await runRig(["up", installTrustedScenario(scaffold, join(library, "dev-pair-stub.yaml")), "--cwd", join(scaffold.root, "stub-cwd"), "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
    expect(stub.code, JSON.stringify(stub)).toBe(0);
    launched.push("dev-pair-stub");
  }, 180_000);

  afterAll(async () => {
    try {
      if (daemon) for (const rig of launched) await cli(["down", rig, "--json", "--force"]).catch(() => undefined);
    } finally {
      await gate?.down().catch(() => undefined);
      await fake?.close().catch(() => undefined);
      if (daemon) await daemon.stop(); else scaffold?.cleanup();
    }
  }, 90_000);


  const SEND_BRIEF = ["First line of the brief", "  second line, indented", "third line"].join("\n");

  it("row 1: rig up launches the pda seat and it is READY through its sidecar, with no write to pda", async () => {
    const up = await cli(["up", specPath, "--cwd", join(scaffold.root, "cwd"), "--json", "--yes"], {}, 120_000);
    launched.push(RIG);
    expect(up.code, JSON.stringify(up)).toBe(0);
    const state = await until("the sidecar to say ready", () => { const s = sidecar(); return s?.ready ? s : null; });
    expect(state).toMatchObject({ agent: "research", baseUrl: `http://127.0.0.1:${gate.port}`, connected: true, busy: false, outboxPending: 0 });
    expect(state.launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await captureText()).toContain("[pda-runner] READY agent=research");
    // The launch is GET-only: health, the agent, the stream, the transcript. No message, no agent created.
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /health", "GET /agents/research", "GET /agents/research/events", "GET /agents/research/transcript",
    ]);
    expect(fake.postBodies).toEqual([]);
    // The setting is off: the runner was started without --usage-facts.
    expect((await runnerLines()).join("\n")).not.toContain("--usage-facts");
  }, 180_000);

  it("row 2: a multi-line rig send is exactly one pda submission under one requestId, and the reply is rendered", async () => {
    const sent = await cliJson(["send", PDA_SEAT, SEND_BRIEF, "--json"]);
    expect(sent).toMatchObject({ ok: true, sessionName: PDA_SEAT });
    const entry = await until("pda to admit the message", () => fake.entries("research")[0]);
    await sleep(1500); // a split on LF would arrive as more posts: give them time
    expect(fake.postBodies).toHaveLength(1);
    expect(fake.entries("research")).toHaveLength(1);
    const body = JSON.parse(fake.postBodies[0]!) as { content: string; mode: string; requestId: string };
    expect(body.mode).toBe("followUp");
    expect(body.requestId).toMatch(/^openrig\/[0-9A-Z]{26}\/[0-9a-f-]{36}\/1$/);
    expect(body.requestId).toBe(entry.requestId);
    expect(fake.postsByRequestId.get(body.requestId)).toBe(1);
    // All three lines, in order, with their line breaks and the indent: one message, not three.
    expect(body.content).toContain("First line of the brief\n  second line, indented\nthird line\n---");
    expect(body.content.startsWith(`From: ${SENDER}\nTo: ${PDA_SEAT}\n`)).toBe(true);

    fake.streamReply("research", ["Reply ", "from pda"]);
    const pane = await until("the reply on the pane", async () => { const c = await captureText(); return c.includes("Reply from pda") && c.includes("── idle ──") ? c : null; });
    expect(occurrences(pane, "Reply from pda")).toBe(1);
    expect(pane).toContain("[pda-runner] queued (submission 1)");
    expect(pane).toMatch(/you ▸ From: /);
    // The seat's own message is not echoed back as somebody else's (the envelope makes `other ▸` a multi-line block, so
    // the check is on the marker, not on a line holding the text).
    expect(pane).not.toContain("other ▸");
  }, 60_000);

  it("row 9 (frames): a reply that ends in a yes/no question does not make rig send refuse or wait: the runner's word decides, not the pane", async () => {
    const entriesBefore = fake.entries("research").length;
    fake.streamReply("research", ["Plan drafted.\nDo you want to proceed with the migration?\n[Y/n] "]);
    const pane = await until("the question on the pane, then idle", async () => {
      const c = await captureText();
      return c.includes("Do you want to proceed with the migration?") && c.lastIndexOf("── idle ──") > c.indexOf("Do you want to proceed") ? c : null;
    });
    expect(pane).toContain("[Y/n]");
    // The runner's own run_end hook is trusted for 15 s; after that the classifier consults the pane, and reads this
    // frame as a permission prompt (review F1). Wait the window out, so the only thing between the send and a refusal
    // is the runner's word: it says idle. A plain send goes through ...
    await sleep(16_500);
    const plain = await cli(["send", PDA_SEAT, "ANSWER-AFTER-THE-QUESTION", "--json"]);
    expect(plain.code, plain.stdout).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ ok: true });
    await until("the answer to reach pda", () => fake.entries("research").length === entriesBefore + 1);
    // ... and so does --wait-for-idle, at once (the classifier never reads this pane as idle: the wait would time out).
    const t0 = Date.now();
    const waited = await cli(["send", PDA_SEAT, "WAITED-AFTER-THE-QUESTION", "--wait-for-idle", "20", "--json"]);
    expect(waited.code, waited.stdout).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    await until("the waited message to reach pda", () => fake.entries("research").length === entriesBefore + 2);
  }, 90_000);

  it("row 4: another client's message appears in rig capture, as 'other', and is never sent back to pda", async () => {
    const posts = fake.postBodies.length;
    fake.injectOtherClientMessage("research", "OTHER-CLIENT-MARK from the laptop");
    const pane = await until("the other client's message on the pane", async () => { const c = await captureText(); return c.includes("OTHER-CLIENT-MARK") ? c : null; });
    expect(pane).toMatch(/other ▸ OTHER-CLIENT-MARK from the laptop/);
    expect(occurrences(pane, "OTHER-CLIENT-MARK")).toBe(1);
    expect(fake.postBodies).toHaveLength(posts);
  }, 60_000);

  it("row 5: pda restarts: the stream reconnects with no replay, and the message sent meanwhile is delivered once", async () => {
    const before = await captureText();
    const markers = ["First line of the brief", "Reply from pda", "OTHER-CLIENT-MARK"];
    const counts = markers.map((m) => occurrences(before, m));
    expect(counts.every((n) => n >= 1)).toBe(true); // positive control: the markers are on the pane to be counted
    const entriesBefore = fake.entries("research").length;
    const transcriptBefore = fake.transcriptOf("research").length;

    await gate.down();
    await until("the runner to notice pda is gone", () => sidecar()?.connected === false);
    // pda admits the first delivery and the connection dies with no reply: the retry must not make a second entry.
    fake.script({ action: "admit_then_drop" });
    const sent = await cliJson(["send", PDA_SEAT, "DURING-OUTAGE-MSG one line", "--json"]);
    expect(sent.ok).toBe(true);
    await until("the message to be saved in the outbox", () => sidecar()?.outboxPending === 1);
    expect(fake.entries("research")).toHaveLength(entriesBefore); // pda was unreachable: nothing arrived

    await gate.up();
    await until("the message to be delivered", () => fake.entries("research").length === entriesBefore + 1, 45_000);
    await until("the runner to reconnect", () => { const s = sidecar(); return s?.connected && s.outboxPending === 0 ? s : null; }, 45_000);
    const delivered = fake.entries("research")[entriesBefore]!;
    expect(delivered.content).toContain("DURING-OUTAGE-MSG one line");
    // admitted on the first delivery (dropped before the reply), re-sent under the SAME id: 2 posts, 1 entry.
    expect(fake.postsByRequestId.get(delivered.requestId)).toBe(2);
    expect(fake.entries("research").filter((e) => e.requestId === delivered.requestId)).toHaveLength(1);
    await sleep(1000);
    expect(fake.transcriptOf("research").length).toBe(transcriptBefore + 1);

    const after = await captureText();
    // An ordinary send shows twice on the pane (the pasted text, then the runner's `you ▸` echo): so must this one.
    const ordinarySendShows = counts[0]!;
    expect(after).toContain("[pda-runner] stream lost; reconnecting");
    expect(after).toContain("[pda-runner] reconnected");
    // No replay: everything rendered before the outage is still on the pane exactly as many times as before.
    expect(markers.map((m) => occurrences(after, m))).toEqual(counts);
    // The message's own entry is not echoed back as somebody else's: it shows as often as an ordinary send of it does.
    expect(after).not.toMatch(/other ▸ From: /);
    expect(occurrences(after, "DURING-OUTAGE-MSG")).toBe(ordinarySendShows);
  }, 120_000);

  // The hold rows share one held message: row 6 makes it, row 9 refuses against it, row 6 (release) delivers it.
  let held: { requestId: string; code: string } | undefined;
  let heldEntriesBefore = 0;

  it("row 6: six 500s hold the message: six attempts under one id, nothing admitted, and the sidecar and the pane say held", async () => {
    heldEntriesBefore = fake.entries("research").length;
    fake.script(...Array.from({ length: 6 }, () => ({ action: "status" as const, status: 500 })));
    await cliJson(["send", PDA_SEAT, "HELD-MSG one line", "--json"]);
    held = await until("the message to be held", () => sidecar()?.held ?? null, 60_000);
    expect(held.code).toBe("pda_message_held");
    expect(fake.postsByRequestId.get(held.requestId)).toBe(6);
    expect(fake.entries("research")).toHaveLength(heldEntriesBefore);
    const heldPane = await captureText();
    expect(heldPane).toContain("pda did not take the message");
    expect(heldPane).toContain("rig seat pda-release");
  }, 120_000);

  it("row 9 (held): a send to the held seat is refused with the runner's own reason, and no byte reaches the pane", async () => {
    expect(held, "row 6 must have held a message").toBeDefined();
    const refused = await cli(["send", PDA_SEAT, "NEXT-WHILE-HELD", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, reason: "target_needs_input", activity: { state: "needs_input", reason: "pda_message_held", evidenceSource: "runner_sidecar" } });
    await sleep(500);
    expect(fake.postsByRequestId.get(held!.requestId)).toBe(6);
    expect(occurrences(await captureText(), "NEXT-WHILE-HELD")).toBe(0);
  }, 60_000);

  it("row 9 (--dangerously-interact): refused for a runner seat, and the refusal never advises the override", async () => {
    expect(held, "row 6 must have held a message").toBeDefined();
    const forced = await cli(["send", PDA_SEAT, "FORCED-WHILE-HELD", "--dangerously-interact", "--reason", "drive it", "--json"]);
    expect(forced.code).not.toBe(0);
    const forcedBody = JSON.parse(forced.stdout) as { ok: boolean; sent: boolean; reason: string; error: string };
    expect(forcedBody).toMatchObject({ ok: false, sent: false, reason: "runner_input_no_override" });
    expect(forcedBody.error).toContain("rig seat pda-release");
    expect(forcedBody.error).not.toContain("--dangerously-interact");
    await sleep(500);
    expect(occurrences(await captureText(), "FORCED-WHILE-HELD")).toBe(0);
  }, 60_000);

  it("row 6 (release): rig seat pda-release delivers the held message once, under its own id", async () => {
    expect(held, "row 6 must have held a message").toBeDefined();
    const rel = await cli(["seat", "pda-release", PDA_SEAT, "--reason", "pda is back", "--json"]);
    expect(rel.code, JSON.stringify(rel)).toBe(0);
    expect(JSON.parse(rel.stdout)).toMatchObject({ ok: true, heldRequestId: held!.requestId, heldCode: "pda_message_held", runnerAlive: true });
    await until("the held message to be delivered", () => fake.entries("research").length === heldEntriesBefore + 1, 100_000);
    expect(fake.entries("research").filter((e) => e.requestId === held!.requestId)).toHaveLength(1);
    expect(fake.postsByRequestId.get(held!.requestId)).toBe(7);
    const cleared = await until("the hold to clear", () => { const s = sidecar(); return s && !s.held && s.outboxPending === 0 ? s : null; });
    expect(cleared.connected).toBe(true);
  }, 180_000);

  it("row 9 (stale): a sidecar older than the alive window is no answer: a forged held head refuses only while fresh", async () => {
    // OF-185. A forged file is believed or disbelieved by its age alone, but the real runner rewrites its sidecar every
    // 60 s with its own (empty) held head, which erases the forgery whenever a tick lands between our write and the
    // daemon's read; the CLI's latency under load is the width of that window. So the forgery is written right after a
    // tick, which leaves it a whole interval before the next one (pausing the runner is not an option: the daemon then
    // sees a non-running foreground process and refuses for another reason). If a tick still intervenes, the control
    // says so instead of reporting a send that "was not refused". The age arithmetic itself is pinned with an injected
    // clock in pda-runtime-adapter.test.ts ("a forged held head is believed only inside the alive window").
    const file = paths().runnerStatePath;
    const seenAlive = sidecar()?.aliveAt;
    await until("the runner's next alive tick, so the forgery has a whole 60 s interval", () => sidecar()?.aliveAt !== seenAlive, 90_000);
    const base = JSON.parse(readFileSync(file, "utf8")) as PdaRunnerState;
    const FORGED = "openrig/forged/launch/1";
    const forge = (aliveAt: string) => writeFileSync(file, JSON.stringify({
      ...base, aliveAt, held: { requestId: FORGED, code: "pda_message_held", at: aliveAt },
    }));
    const entriesBefore = fake.entries("research").length;
    try {
      forge(new Date().toISOString()); // control: the forgery is believed while it is fresh
      const fresh = await cli(["send", PDA_SEAT, "STALE-PROBE-FRESH", "--json"]);
      expect(sidecar()?.held?.requestId, "the forged head must still be the sidecar's content: a runner tick overwrote it before the daemon read it").toBe(FORGED);
      expect(fresh.code).not.toBe(0);
      expect(JSON.parse(fresh.stdout)).toMatchObject({ ok: false, reason: "target_needs_input", activity: { reason: "pda_message_held", evidenceSource: "runner_sidecar" } });
      expect(fake.entries("research")).toHaveLength(entriesBefore);

      forge(new Date(Date.now() - 10 * 60_000).toISOString()); // the same file, 10 minutes old: the runner's word has expired
      // Still-forged check: the stale half passes for the right reason only if the forged head is really on disk, with the
      // expired age, when the send is made. A runner tick that erased it would let the send through for another reason.
      expect(sidecar(), "the stale forgery must still be the sidecar's content: a runner tick overwrote it").toMatchObject({ held: { requestId: FORGED } });
      const stale = await cli(["send", PDA_SEAT, "STALE-PROBE-OLD", "--json"]);
      expect(stale.code, JSON.stringify(stale)).toBe(0);
      await until("the stale-probe message to reach pda", () => fake.entries("research").length === entriesBefore + 1);
    } finally {
      // The runner rewrites its sidecar when the message's entry arrives; put the original back only if it has not.
      const rewritten = await until("the runner to rewrite its sidecar", () => sidecar()?.held === undefined, 5_000).catch(() => false);
      if (!rewritten) writeFileSync(file, JSON.stringify({ ...base, aliveAt: new Date().toISOString() }));
    }
  }, 180_000); // up to 60 s for the tick, then the two sends

  const psAll = () => new Promise<string>((res, rej) => execFile("ps", ["-A", "-ww", "-o", "pid=,args="], { maxBuffer: 64 * 1024 * 1024 }, (e, o) => e ? rej(e) : res(o)));
  /** This scaffold's pda-runner processes: the argv names the scaffold's own state root. */
  const runnerLines = async (): Promise<string[]> => (await psAll()).split("\n").filter((l) => l.includes("pda-runner.js") && l.includes(scaffold.openrigHome));
  const runnerPids = async (): Promise<number[]> => (await runnerLines()).map((l) => Number(l.trim().split(/\s+/)[0]));
  const usageCount = (): number => {
    const d = db();
    try { return (d.prepare("SELECT count(*) AS n FROM pda_usage_entries").get() as { n: number }).n; } finally { d.close(); }
  };
  const sessionRow = () => {
    const d = db();
    try {
      return d.prepare(`SELECT s.resume_type AS type, s.resume_token AS token, n.pda_binding AS binding, s.status AS status
        FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE s.session_name = ? ORDER BY s.rowid DESC LIMIT 1`).get(PDA_SEAT) as { type: string; token: string; binding: string; status: string } | undefined;
    } finally { d.close(); }
  };
  const seatStatus = async (): Promise<string | undefined> => {
    const nodes = await cliJson(["ps", "--nodes", "--rig", RIG, "--json"]);
    return (nodes as Array<{ canonicalSessionName: string; sessionStatus: string }>).find((n) => n.canonicalSessionName === PDA_SEAT)?.sessionStatus;
  };

  // The runner holds back the last (token length - 1) characters of a streamed reply until more arrives (so a token
  // split across deltas is still caught): a first delta must be longer than that for its head to show mid-stream.
  const STREAM_ALPHA = `STREAM-ALPHA ${"·".repeat(150)} `;

  let bindingBefore: { type: string; token: string; binding: string } | undefined;
  let launchBefore = "";

  it("row 7 (binding): the seat's resume token and spec binding name the agent the spec named", () => {
    launchBefore = sidecar()!.launchId;
    bindingBefore = sessionRow();
    expect(bindingBefore?.type).toBe("pda_agent");
    expect(bindingBefore?.token).toBe(`http://127.0.0.1:${gate.port}/agents/research`);
    expect(JSON.parse(bindingBefore!.binding)).toEqual({ agent: "research", base_url: `http://127.0.0.1:${gate.port}` });
  });

  it("row 8 (handover): refused before anything is stopped or started", async () => {
    const handover = await cli(["seat", "handover", PDA_SEAT, "--reason", "e2e", "--json"]);
    expect(handover.code).not.toBe(0);
    expect(JSON.parse(handover.stdout)).toMatchObject({ ok: false, code: "handover_unsupported_runtime" });
    expect(handover.stdout).toContain("a pda seat has no handover");
    expect(sidecar()!.launchId).toBe(launchBefore);
    expect(await seatStatus()).toBe("running");
    expect(await runnerPids()).toHaveLength(1);
  }, 60_000);

  it("row 9 (runner gone): a runner killed without a trace leaves a ready sidecar and a shell; rig send types nothing", async () => {
    const pids = await runnerPids();
    expect(pids).toHaveLength(1);
    process.kill(pids[0]!, "SIGKILL");
    await until("the runner to be gone", async () => (await runnerPids()).length === 0);
    await sleep(800);
    expect(sidecar()).toMatchObject({ ready: true, launchId: launchBefore }); // the stale word the seam must not believe
    const typed = await cli(["send", PDA_SEAT, "RM-RF-MUST-NOT-BE-TYPED", "--json"]);
    expect(typed.code).not.toBe(0);
    const body = JSON.parse(typed.stdout) as { ok: boolean; sent: boolean; reason: string; error: string };
    // Two independent guards refuse this (the shell-foreground check before readiness, and the seam's own clause).
    expect(body).toMatchObject({ ok: false, sent: false });
    expect(["target_runtime_unverified", "target_runner_unverified"]).toContain(body.reason);
    expect(body.error).toContain("No text was sent");
    expect(occurrences(await captureText(), "RM-RF-MUST-NOT-BE-TYPED")).toBe(0);
  }, 60_000);

  let postsAtDown = 0;
  let requestsAtDown = 0;

  it("rows 7 + 8 (down, --fresh): rig down stops the seat; --fresh on the stopped seat is refused and starts nothing", async () => {
    postsAtDown = fake.postBodies.length;
    requestsAtDown = fake.requests.length;
    const down = await cli(["down", RIG, "--json"]);
    expect(down.code).toBe(0);
    expect(JSON.parse(down.stdout)).toMatchObject({ sessionsKilled: 1, errors: [] });
    expect(await seatStatus()).not.toBe("running");

    const fresh = await cli(["up", RIG, "--existing", "--fresh", "lab.research", "--json", "--yes"], {}, 120_000);
    expect(fresh.code).not.toBe(0);
    const freshBody = JSON.parse(fresh.stdout) as { rigResult: string; nodes: Array<{ logicalId: string; status: string; error?: string }> };
    expect(freshBody.rigResult).toBe("failed");
    expect(freshBody.nodes).toEqual([expect.objectContaining({ logicalId: "lab.research", status: "failed" })]);
    expect(freshBody.nodes[0]!.error).toContain("a pda seat has no fresh start");
    expect(freshBody.nodes[0]!.error).toContain("No session was started.");
    expect(await seatStatus()).not.toBe("running");
    expect(await runnerPids()).toEqual([]);
  }, 180_000);

  it("row 7 (restore): up --existing re-attaches the same agent, sends nothing, replays nothing; with usage.pda_cost_facts now on", async () => {
    // Control for row 11: the setting was off so far, so the runner ran without --usage-facts and the table
    // (migration 116) exists and is empty although replies were streamed.
    expect(usageCount()).toBe(0);
    const flip = await cli(["config", "set", "usage.pda_cost_facts", "true"]);
    expect(flip.code, JSON.stringify(flip)).toBe(0);

    const up = await cli(["up", RIG, "--existing", "--json", "--yes"], {}, 120_000);
    expect(up.code).toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ rigResult: "fully_restored", nodes: [{ logicalId: "lab.research", status: "resumed" }] });
    const again = await until("the restored runner to be ready", () => { const s = sidecar(); return s?.ready && s.launchId !== launchBefore ? s : null; });
    expect(again).toMatchObject({ agent: "research", baseUrl: `http://127.0.0.1:${gate.port}`, connected: true });
    expect((await runnerLines()).join("\n")).toContain("--usage-facts");
    expect(sessionRow()).toMatchObject({ type: "pda_agent", token: bindingBefore!.token, binding: bindingBefore!.binding });
    expect(fake.postBodies).toHaveLength(postsAtDown); // neither the refusals nor the restore wrote to pda
    expect(nonAllowlisted(fake.requests.slice(requestsAtDown))).toEqual([]);
    expect(await seatStatus()).toBe("running");
    // The conversation is not replayed into the new pane: the runner resumes from the cursor its predecessor left.
    const pane = await captureText();
    expect(pane).toContain("[pda-runner] READY agent=research");
    for (const old of ["Reply from pda", "OTHER-CLIENT-MARK", "First line of the brief", "HELD-MSG", "DURING-OUTAGE-MSG"]) {
      expect(pane, `the restored pane replays "${old}"`).not.toContain(old);
    }
    expect(pane).not.toContain("showing the newest");
  }, 180_000);

  it("rows 3 + 9 (busy): a streaming reply is visible before it ends, and a send while the runner is busy goes in as a followUp", async () => {
    const own = fake.entries("research").at(-1)!;
    fake.emit("research", runStart([own.submissionId]));
    await until("the sidecar to say busy", () => sidecar()?.busy === true);
    fake.emit("research", messageStart(assistantMessage([])));
    fake.emit("research", deltaEvent(STREAM_ALPHA));
    const mid = await until("the first delta on the pane", async () => { const c = await captureText(); return c.includes("STREAM-ALPHA") ? c : null; });
    // Visible NOW: the message has not ended, so the idle line cannot follow it.
    expect(mid.slice(mid.indexOf("STREAM-ALPHA"))).not.toContain("── idle ──");

    // Busy is advice, not a block (session-transport: running proceeds with an advisory): the send goes through, as a
    // followUp, never as a steer.
    const entriesBefore = fake.entries("research").length;
    const busy = await cli(["send", PDA_SEAT, "BUSY-SEND-MSG one line", "--json"]);
    expect(busy.code).toBe(0);
    expect(JSON.parse(busy.stdout)).toMatchObject({ ok: true, warning: expect.stringContaining("mid-task") });
    await until("the busy-time message to reach pda", () => fake.entries("research").length === entriesBefore + 1);
    const busyBody = JSON.parse(fake.postBodies.at(-1)!) as { mode: string; requestId: string };
    expect(busyBody.mode).toBe("followUp");
    // The restored runner mints its ids under its OWN launch id, never its predecessor's (review L1a N1: a reused launch
    // id could make a new message collide with an old one pda already holds).
    expect(busyBody.requestId.split("/")[2]).toBe(sidecar()!.launchId);
    expect(busyBody.requestId.split("/")[2]).not.toBe(launchBefore);

    fake.emit("research", deltaEvent("STREAM-BETA"));
    fake.emit("research", messageEnd(assistantEntry(900001, `${STREAM_ALPHA}STREAM-BETA`)));
    fake.emit("research", runEnd([own.submissionId]));
    const done = await until("the run to end", async () => { const c = await captureText(); return c.includes("STREAM-BETA") && c.lastIndexOf("── idle ──") > c.indexOf("STREAM-BETA") ? c : null; });
    expect(occurrences(done, "STREAM-ALPHA")).toBe(1);
    await until("the sidecar to say idle", () => sidecar()?.busy === false);
    // Let the first fact's post finish before the next run ends (row 11 asserts the rows; this is only a settle).
    await until("the first usage row", () => usageCount() >= 1, 20_000).catch(() => undefined);
  }, 120_000);

  it("row 11: with usage.pda_cost_facts on, usage rows are stored as own, a zero price is NULL, a priced entry keeps its price, a foreign run is 'other'", async () => {
    const second = fake.entries("research").at(-1)!;
    const priced = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
    fake.emit("research", runStart([second.submissionId]));
    fake.emit("research", messageEnd(assistantEntry(900002, "PRICED REPLY", { usage: priced })));
    fake.emit("research", runEnd([second.submissionId]));
    // One run at a time, so each row is attributable to one post. (Written when a fact queued behind an in-flight post
    // waited for the NEXT run_end; integ24a made the sink flush it as that post settles; pda-usage-sink-inflight-gap.test.ts.)
    await until("the second usage row", () => usageCount() >= 2, 20_000);
    const foreign = fake.injectOtherClientMessage("research", "FOREIGN-RUN-INPUT");
    fake.emit("research", runStart([foreign.submissionId]));
    fake.emit("research", messageEnd(assistantEntry(900003, "FOREIGN REPLY")));
    fake.emit("research", runEnd([foreign.submissionId]));
    await until("the third usage row", () => usageCount() >= 3, 20_000);
    const d = db();
    try {
      const rows = d.prepare(`SELECT entry_id, origin, cost_total, cost_basis, agent, seat_session, input_tokens, output_tokens
        FROM pda_usage_entries ORDER BY CAST(entry_id AS INTEGER)`).all();
      const seat = { agent: "research", seat_session: PDA_SEAT };
      expect(rows).toEqual([
        { entry_id: "900001", origin: "own", cost_total: null, cost_basis: "declared_zero_price", input_tokens: 1, output_tokens: 1, ...seat },
        { entry_id: "900002", origin: "own", cost_total: 0.25, cost_basis: "model_priced", input_tokens: 10, output_tokens: 5, ...seat },
        { entry_id: "900003", origin: "other", cost_total: null, cost_basis: "declared_zero_price", input_tokens: 1, output_tokens: 1, ...seat },
      ]);
    } finally { d.close(); }
  }, 120_000);

  it("row 12: an existing runtime in the same daemon is unaffected: a stub seat still gets a verified send", async () => {
    const posts = fake.postBodies.length;
    const marker = `stub-send-${randomUUID()}`;
    const receipt = await cliJson(["send", STUB_SEAT, marker, "--verify", "--json"]);
    expect(receipt.verified).toBe(true);
    expect((await captureText(STUB_SEAT)).replace(/\n/g, "")).toContain(marker);
    expect(await captureText(PDA_SEAT)).not.toContain(marker);
    // The stub send never touched pda. Asserted on this send's own marker, not on a bare post count: under heavy host
    // starvation a post of an EARLIER row (a late retry or release) can land inside this window and move the count
    // without the stub send having reached pda at all. A post carrying this marker is the only way it could.
    expect(fake.postBodies.slice(posts).filter((b) => b.includes(marker))).toEqual([]);
  }, 120_000);

  it("row 10: the token canary is in the token file and pda saw it, and nowhere else: tmux env, process argv and env, capture, sidecar, outbox, logs", async () => {
    // Positive controls first: the runner really authenticated with the canary, and the one file that holds it is the token file.
    expect(fake.authorizations.filter((a) => a === `Bearer ${BEARER}`).length).toBeGreaterThan(5);
    expect(readFileSync(tokenFile, "utf8")).toBe(BEARER);

    const tmux = (args: string[]) => new Promise<string>((res, rej) =>
      execFile("tmux", ["-S", scaffold.tmuxSocketPath, ...args], { env: scaffold.env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 }, (e, o) => e ? rej(e) : res(o)));
    const surfaces: Array<[string, string]> = [];
    surfaces.push(["tmux environment (global)", await tmux(["show-environment", "-g"])]);
    surfaces.push(["tmux environment (pda session)", await tmux(["show-environment", "-t", `=${PDA_SEAT}`])]);
    surfaces.push(["tmux scrollback (pda pane)", await tmux(["capture-pane", "-p", "-J", "-S", "-", "-t", `=${PDA_SEAT}:`])]);
    surfaces.push(["rig capture (pda seat)", await captureText(PDA_SEAT, 5000)]);
    surfaces.push(["process argv (ps -A)", await psAll()]);
    const seatDir = paths().seatRoot;
    for (const name of readdirSync(seatDir)) surfaces.push([`seat state: ${name}`, readFileSync(join(seatDir, name), "utf8")]);

    // The environment of every process that belongs to this scaffold (the daemon, the runner, the shells, the tmux server).
    const owned: number[] = [];
    if (existsSync("/proc/self/environ")) {
      for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
        try {
          const env = readFileSync(`/proc/${pid}/environ`, "utf8");
          if (env.includes(`OPENRIG_HOME=${scaffold.openrigHome}`) || env.includes(`HOME=${scaffold.home}\0`)) { owned.push(Number(pid)); surfaces.push([`environ of pid ${pid}`, env]); }
        } catch { /* not ours, or gone */ }
      }
      const runner = (await runnerPids())[0]!;
      expect(owned, "the runner's environment must be among the scanned ones").toContain(runner);
      expect(owned.length).toBeGreaterThanOrEqual(3);
    }

    for (const [name, text] of surfaces) {
      // A clean scan of nothing proves nothing. (A seat's message log is legitimately empty right after a restart compacts it.)
      if (!/^seat state: (outbox\.log|own-submissions\.json|rejected\.log|release\.request)$/.test(name)) {
        expect(text.length, `surface "${name}" is empty`).toBeGreaterThan(0);
      }
      expect(text.includes(BEARER), `the token canary appears in: ${name}`).toBe(false);
    }
    // Positive control that the scan reads real environments: the daemon's names the token FILE's path (never its value).
    expect(surfaces.map(([, t]) => t).join("\n")).toContain(`OPENRIG_PDA_TOKEN_FILE=${tokenFile}`);

    // Every regular file under the scaffold (daemon log, SQLite database and its WAL, outbox, sidecar, config): the
    // token file is the only one holding the canary.
    const holders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) { scanned++; if (readFileSync(full).includes(BEARER)) holders.push(full); }
      }
    };
    walk(scaffold.root);
    expect(scanned).toBeGreaterThan(20);
    expect(holders).toEqual([tokenFile]);
  }, 120_000);

  it("row 12 (fresh seam): the fresh-start decision pda changed for every runtime still lets a stub seat take a deliberate fresh start", async () => {
    const down = await cli(["down", "dev-pair-stub", "--json"]);
    expect(down.code, JSON.stringify(down)).toBe(0);
    // dev.impl has no captured resume token and waits for a decision (a stub fact, unrelated to pda); dev.qa is the one asked fresh.
    const fresh = await cli(["up", "dev-pair-stub", "--existing", "--fresh", "dev.qa", "--json", "--yes"], {}, 120_000);
    const body = JSON.parse(fresh.stdout) as { nodes: Array<{ logicalId: string; status: string; error?: string }> };
    const qa = body.nodes.find((n) => n.logicalId === "dev.qa");
    expect(qa, fresh.stdout).toMatchObject({ status: "fresh-primed" });
    expect(qa).not.toHaveProperty("error");
  }, 180_000);

  it("end: pda was only ever asked the five allowlisted things, and nothing was created, reset or aborted", () => {
    // Positive control: all five allowlisted routes were really exercised, so an empty "non-allowlisted" list is not an empty log.
    const used = new Set(fake.requests.map((r) => `${r.method} ${r.path.replace(/^\/agents\/[^/]+/, "/agents/:name")}`));
    expect([...used].sort()).toEqual([
      "GET /agents/:name", "GET /agents/:name/events", "GET /agents/:name/transcript", "GET /health", "POST /agents/:name/messages",
    ]);
    expect(nonAllowlisted(fake.requests)).toEqual([]);
  });
});
