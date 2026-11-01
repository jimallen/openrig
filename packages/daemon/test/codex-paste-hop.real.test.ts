// S2, the Codex last hop on a private hc core with a stub Codex TUI (no Codex here; s0 M4, M5 and M8 are the real-agent evidence).
// The fake client assumes what `terminal.read` shows and what a press does; this reads a real core's screen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexPasteHop } from "../src/adapters/codex-paste-hop.js";
import { codexSeatGate, reconcileCodexSeatGate } from "../src/adapters/codex-seat-gate.js";
import { HookSeenStore, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { resolveHcSocket, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { messageId, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

const TUI = fileURLToPath(new URL("./helpers/stub-codex-tui.cjs", import.meta.url));
const RELAY = fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));
const NONCE = "0123456789abcdef0123";
const marker = (id: string) => `[openrig-msg ${id}:${NONCE}]`;

describe.skipIf(!HC)("the Codex hop on a real core, stub Codex", () => {
  const core = new PrivateCore();
  let home: string;
  let input: HcInput;
  let hop: CodexPasteHop;
  let serial = 0;

  beforeAll(() => {
    core.start();
    home = mkdtempSync(join(tmpdir(), "codex-hop-"));
    input = new HcInput(core.client, new HcAttach(resolveHcSocket(core.env, core.env.HOME)));
    hop = new CodexPasteHop(core.client, input);
  });
  afterAll(() => {
    core.stop();
    rmSync(home, { recursive: true, force: true });
  });

  async function seat(relay = RELAY): Promise<{ name: string; rollout: string; prompts: () => string[] }> {
    serial += 1;
    const name = `hop${serial}@rig`;
    const rollout = join(home, `rollout-${serial}.jsonl`);
    await core.client.call("terminal.run", {
      argv: [process.execPath, TUI], name: hcTerminalName(name), labels: { [SEAT_LABEL]: name }, cwd: home, no_parent: true, no_notify: true, outlive_parent: true,
      env: { STUB_RELAY: relay, STUB_ROLLOUT: rollout, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: "n", OPENRIG_RUNTIME: "codex" },
    });
    const terminal = () => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(name) });
    await waitUntil(terminal, (t) => t.status?.state === "idle", "stub ready");
    await waitUntil(() => screen(name), (s) => s.includes("Ask Codex to do anything"), "stub painted");
    return { name, rollout, prompts: () => existsSync(rollout) ? readFileSync(rollout, "utf8").trim().split("\n") : [] };
  }
  const screen = async (name: string) => (await core.client.call<{ text: string }>("terminal.read", { terminal: hcTerminalName(name), lines: 200 })).text;
  const attempt = (name: string, id: string, body: string) => hop.attempt({ ids: [messageId(id)], seat: name, body, messageClass: "content", lane: 2 } satisfies SeatMessage);
  const count = async (read: () => string[], n: number) => waitUntil(async () => read().length, (c) => c === n, `${n} rollout records`);

  it("sends a message, and the repeat is dropped by the gate", async () => {
    const s = await seat();
    const body = `one\n${marker("a")}`;
    await expect(attempt(s.name, "a", body)).resolves.toEqual({ kind: "sent" });
    await count(s.prompts, 1);
    await waitUntil(() => screen(s.name), (t) => t.includes("Ask Codex to do anything"), "composer clean");
    await expect(attempt(s.name, "a", body)).resolves.toEqual({ kind: "sent" });
    await waitUntil(() => screen(s.name), (t) => t.includes("Ask Codex to do anything"), "composer clean after the block");
    await new Promise((r) => setTimeout(r, 300));
    expect(s.prompts()).toHaveLength(1);
  }, 40_000);

  it("a staged short paste (the Enter lost) gets Enter only: one prompt, not two copies", async () => {
    const s = await seat();
    const body = `one\n${marker("a")}`;
    await input.sendText(s.name, body);
    await waitUntil(() => screen(s.name), (t) => t.includes(marker("a")), "staged");
    await expect(attempt(s.name, "a", body)).resolves.toEqual({ kind: "sent" });
    await count(s.prompts, 1);
    expect(JSON.parse(s.prompts()[0]!).payload.content[0].text).toBe(body);
  }, 40_000);

  it("a staged long paste, collapsed with its marker hidden, is a draft: its length could be a person's", async () => {
    const s = await seat();
    const body = `${"x".repeat(1500)}\n${marker("a")}`;
    await input.sendText(s.name, body);
    const shown = await waitUntil(() => screen(s.name), (t) => t.includes("[Pasted Content"), "collapsed");
    expect(shown).not.toContain("openrig-msg");
    await expect(attempt(s.name, "a", body)).resolves.toEqual({ kind: "paused", reason: "draft" });
    expect(s.prompts()).toEqual([]);
  }, 40_000);

  it("a person's draft holds the attempt: nothing is added or submitted", async () => {
    const s = await seat();
    await input.sendText(s.name, "half a thought", undefined, { bracketed: false });
    await waitUntil(() => screen(s.name), (t) => t.includes("half a thought"), "draft");
    await expect(attempt(s.name, "a", `one\n${marker("a")}`)).resolves.toEqual({ kind: "paused", reason: "draft" });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.prompts()).toEqual([]);
    expect(await screen(s.name)).toContain("› half a thought");
  }, 40_000);

  it("a hook that really crashes fails open in the seat; the lookup finds the prompt, and no second copy goes", async () => {
    const broken = join(home, "broken-relay.cjs");
    writeFileSync(broken, "this is not ( javascript\n");
    const s = await seat(broken);
    const body = `one\n${marker("a")}`;
    await attempt(s.name, "a", body);
    await count(s.prompts, 1);
    const store = new HookSeenStore(seatGateRoot(home));
    const relayEnv = { PATH: process.env.PATH, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: s.name, OPENRIG_NODE_ID: "n", OPENRIG_RUNTIME: "codex" };
    execFileSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "SessionStart" }), env: relayEnv });
    const gate = codexSeatGate({ store, nonceOf: () => NONCE, rolloutPathOf: () => s.rollout });
    await expect(gate.lookup(s.name, messageId("a"))).resolves.toMatchObject({ kind: "seen" });
    expect(reconcileCodexSeatGate(store, s.name, s.rollout)).toEqual({ received: [{ id: "a", nonce: NONCE }], cleared: [], unsettled: [] });
    const hookRun = execFileSync(process.execPath, [RELAY], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: body }), encoding: "utf8", env: relayEnv,
    });
    expect(hookRun).toContain('"block"');
  }, 40_000);
});
