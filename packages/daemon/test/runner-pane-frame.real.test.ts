// OF-213 (widened): the Pi runner's pane has a console. Jim: "It looks just like Output rather than a terminal with an input." The real
// runner is the program of a terminal on a PRIVATE hc core (own HOME, HC_SESSION and XDG paths via helpers/hc-scratch.ts; the host's
// core and app are never contacted), against an offline fake `pi`. The rows read the core's own screen and scrollback.
//
// Not proven here: the Herdr app's drawing of the pane (openrig-8f's shot, live), a real Pi, a resize of the pane (the sequence is pinned in
// runner-pane-frame.test.ts; hc has no resize call in this suite).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { panePi, until, type PanePi } from "./helpers/pi-runner-pane.js";

const RULE = "── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ";
const BANNER = "── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──";
const MARKER = (id: string) => `[openrig-msg ${id}:${"a".repeat(16)}]`;

describe.skipIf(!findHc())("a Pi seat's pane is a console, through a private hc core", () => {
  let scratch: HcScratch;
  let temp: string;
  let pi: PanePi;
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  /** The last two rows of the screen: the rule and the input row. */
  const bottom = async (t: string) => { const s = await pi.screen(t); return { rule: s[s.length - 2]!, input: s[s.length - 1]! }; };
  const count = (rows: string[], needle: string) => rows.filter((l) => l.includes(needle)).length;
  const exactly = (rows: string[], line: string) => rows.filter((l) => l.trimEnd() === line).length;

  beforeAll(async () => {
    scratch = startHcScratch();
    temp = fs.mkdtempSync(path.join(scratch.root, "pane-"));
    pi = panePi(scratch, temp);
    await pi.start("seat", "verify-qa@eztrack");
    await until(() => pi.screen("seat"), (s) => s.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the READY marker");
  }, 90_000);
  afterAll(() => { scratch?.cleanup(); });

  it("the rule names the seat and an empty input line sits under it, with the output above", async () => {
    const screen = await pi.screen("seat");
    const { rule, input } = await bottom("seat");
    expect(rule.startsWith(RULE)).toBe(true);
    expect(rule.endsWith("─")).toBe(true);
    expect(input.trim()).toBe("❯");
    expect(screen.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the runner's own lines are above, in the format they had").toBe(true);
  }, 30_000);

  it("typed text shows on the input line, Enter sends it to Pi once, and the line is empty again", async () => {
    await pi.keys("seat", ["h", "e", "l", "l", "o", "space", "t", "h", "e", "r", "e"]);
    const typed = await until(() => bottom("seat"), (b) => b.input.includes("hello there"), "the typed text on the input line");
    expect(typed.input.trim()).toBe("❯ hello there");
    expect(typed.rule.startsWith(RULE)).toBe(true);
    expect(pi.received(), "nothing is sent before Enter").toEqual([]);
    await pi.keys("seat", ["enter"]);
    await until(async () => pi.received(), (r) => r.length === 1, "Pi to receive the line");
    expect(pi.received()).toEqual([["prompt", "hello there"]]);
    const after = await until(() => bottom("seat"), (b) => b.input.trim() === "❯", "the input line to empty");
    expect(after.input.trim()).toBe("❯");
    await until(() => get("seat"), (t) => t.status?.state === "idle" && t.turn === 1, "the turn to end");
    const history = await pi.history("seat");
    expect(count(history, "you ▸ hello there"), "the message shows once, as the runner's own line").toBe(1);
    expect(count(history, "❯ hello there"), "the typed line was never written into the output").toBe(0);
  }, 60_000);

  it("the rule and the input line stay at the bottom while 300 lines scroll past; the scrollback keeps every line once", async () => {
    await scratch.client().call("terminal.send", { terminal: "seat", text: "flood the pane" }, { timeoutMs: 20_000 });
    await until(() => get("seat"), (t) => t.status?.state === "idle" && t.turn === 2, "the flooding turn to end");
    const screen = await pi.screen("seat");
    expect(screen.some((l) => l.includes("flood line 299")), "the last flood line is on the screen").toBe(true);
    expect(screen.some((l) => l.includes("flood line 0\n") || l.endsWith("flood line 0")), "the first has scrolled off the screen").toBe(false);
    const { rule, input } = await bottom("seat");
    expect(rule.startsWith(RULE)).toBe(true);
    expect(input.trim()).toBe("❯");
    const history = await pi.history("seat");
    for (const n of [0, 1, 150, 298, 299]) expect(exactly(history, `[pi:err] flood line ${n}`), `flood line ${n} in the scrollback`).toBe(1);
    expect(count(history, "❯"), "the input row is not copied into the scrollback").toBe(1);
    expect(count(history, RULE), "nor the rule, beyond the banner printed once at the start").toBe(2);
  }, 90_000);

  it("a typed, unsent line survives output arriving: it stays on the input line", async () => {
    await pi.keys("seat", ["d", "r", "a", "f", "t"]);
    await until(() => bottom("seat"), (b) => b.input.includes("draft"), "the draft");
    await scratch.client().call("terminal.send", { terminal: "seat", text: "ping" }, { timeoutMs: 20_000 }).catch(() => undefined);
    await until(() => get("seat"), (t) => t.status?.state === "idle" && t.turn >= 3, "the turn to end");
    expect((await bottom("seat")).input.trim()).toBe("❯");
  }, 60_000);

  const paste = (id: string, body: string) => scratch.client().call("terminal.send", { terminal: "seat", text: `${body}\n${MARKER(id)}` }, { timeoutMs: 30_000 });
  const idle = (turn: number) => until(() => get("seat"), (t) => t.status?.state === "idle" && t.turn >= turn, `idle at turn ${turn}`, 40_000);

  it("a rig message pasted through the gate is taken once and leaves no copy in the input line or the output; a refused repeat leaves nothing visible", async () => {
    const turnBefore = (await get("seat")).turn ?? 0;
    const before = pi.received().length;
    await paste("m-1", "Message one: please acknowledge.");
    await idle(turnBefore + 1);
    expect(pi.received().slice(before)).toEqual([["prompt", "Message one: please acknowledge."]]);
    const after = await bottom("seat");
    expect(after.input.trim(), "the input line is empty after the paste was taken").toBe("❯");
    expect(after.rule.startsWith(RULE)).toBe(true);
    let history = await pi.history("seat");
    expect(count(history, "you ▸ Message one: please acknowledge."), "shown once, by the runner").toBe(1);
    expect(count(history, "Message one: please acknowledge."), "and nowhere else: the paste was not echoed").toBe(1);
    expect(count(history, MARKER("m-1")), "the marker is not shown").toBe(0);

    // The same message again: the gate refuses it. Nothing of its text may be left on the pane.
    await paste("m-1", "Message one: please acknowledge.");
    history = await until(() => pi.history("seat"), (h) => count(h, "repeat dropped: m-1") === 1, "the runner to say it dropped the repeat");
    expect(pi.received().slice(before), "Pi was not given it twice").toEqual([["prompt", "Message one: please acknowledge."]]);
    expect(count(history, "Message one: please acknowledge."), "the refused repeat left no echo").toBe(1);
    const refused = await bottom("seat");
    expect(refused.input.trim(), "and the input line is empty").toBe("❯");
  }, 90_000);

  it("a rig message pasted during a busy turn steers Pi, with the rule and an empty input line intact", async () => {
    const turn = (await get("seat")).turn ?? 0;
    const before = pi.received().length;
    await scratch.client().call("terminal.send", { terminal: "seat", text: "slow work please" }, { timeoutMs: 20_000 });
    await until(() => get("seat"), (t) => t.status?.state === "working", "the seat to be busy", 10_000);
    await paste("m-2", "Message two: sent while busy.");
    await until(async () => pi.received().slice(before), (r) => r.length === 2, "Pi to receive both");
    expect(pi.received().slice(before)).toEqual([["prompt", "slow work please"], ["steer", "Message two: sent while busy."]]);
    const mid = await bottom("seat");
    expect(mid.rule.startsWith(RULE)).toBe(true);
    expect(mid.input.trim()).toBe("❯");
    await idle(turn + 1);
    const history = await pi.history("seat");
    expect(count(history, "you (steer) ▸ Message two: sent while busy.")).toBe(1);
    expect(count(history, "Message two: sent while busy.")).toBe(1);
  }, 90_000);

  it("escape sequences in Pi's output cannot move the region or wipe the rule and input line: the frame is intact and later output lands below", async () => {
    const turn = (await get("seat")).turn ?? 0;
    await scratch.client().call("terminal.send", { terminal: "seat", text: "hostile output please" }, { timeoutMs: 20_000 });
    await idle(turn + 1);
    await scratch.client().call("terminal.send", { terminal: "seat", text: "after the hostile line" }, { timeoutMs: 20_000 });
    await idle(turn + 2);
    const screen = await pi.screen("seat");
    const at = (needle: string) => screen.findIndex((l) => l.includes(needle));
    expect(at("hostile-visible"), "positive control: the line reached the pane as plain text").toBeGreaterThan(-1);
    expect(at("you ▸ after the hostile line")).toBeGreaterThan(at("hostile-visible"));
    expect(at("you ▸ hostile output please")).toBeLessThan(at("hostile-visible"));
    const { rule, input } = await bottom("seat");
    expect(rule.startsWith(RULE)).toBe(true);
    expect(input.trim()).toBe("❯");
    expect(screen.slice(0, screen.length - 2).some((l) => l.includes("──") && l.trim() !== BANNER), "no copy of the rule above the frame").toBe(false);
  }, 90_000);

  it("what the runner prints on stderr (here, that Pi could not be started) goes into the output region too, above the rule and the input line", async () => {
    await pi.start("nopi", "verify-qa@eztrack", { noPi: true });
    const screen = await until(() => pi.screen("nopi"), (s) => s.some((l) => l.includes("failed to spawn pi")), "the spawn error");
    const at = screen.findIndex((l) => l.includes("failed to spawn pi"));
    const ruleAt = screen.findIndex((l) => l.startsWith(RULE) && l.includes("── ───────")); // the rule row (the banner has no fill)
    expect(ruleAt, "the rule is on the pane").toBeGreaterThan(-1);
    expect(at, "the error is in the output region, above the rule (the runner exited, so the frame was given back after it)").toBeLessThan(ruleAt);
  }, 60_000);
});
