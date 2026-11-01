import { describe, expect, it } from "vitest";
import { HcError, HcOutcomeUnknownError, HcUnavailableError } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import {
  HcIdentity, hcTerminalRef, optionLabelKey, sessionEnvLabels, SESSION_ENV_LABEL_PREFIX, SESSION_ENV_PRESENT_PREFIX,
} from "../src/adapters/hc-identity.js";
import { FakeHc, notFound, terminal } from "./helpers/hc-fake-client.js";

const seat = (name: string, extra: Parameters<typeof terminal>[0] = {}) =>
  terminal({ ...extra, labels: { [SEAT_LABEL]: name, ...extra.labels } });
const unreachable = () => { throw new HcUnavailableError("down"); };
const lost = () => { throw new HcOutcomeUnknownError("lost", "terminal.get"); };
const getting = (t: ReturnType<typeof terminal> | (() => unknown)) => ({ "terminal.get": typeof t === "function" ? t : () => t });
const listing = (...terminals: ReturnType<typeof terminal>[]) => ({ "terminal.list": () => ({ terminals, hidden_finished: 0 }) });

describe("hcTerminalRef: what a tmux-style target means", () => {
  const hashed = hcTerminalName("dev-impl@my-rig");
  it("maps a seat's canonical name to its hc name", () => {
    expect(hcTerminalRef("dev-impl@my-rig")).toBe(hashed);
  });
  it("reads tmux's exact forms of a session as the seat", () => {
    for (const form of ["=dev-impl@my-rig", "=dev-impl@my-rig:", "dev-impl@my-rig:", "dev-impl@my-rig:0", "=dev-impl@my-rig:0.0"]) expect(hcTerminalRef(form)).toBe(hashed);
  });
  it("keeps an address, local or on a machine", () => {
    expect(hcTerminalRef("t7")).toBe("t7");
    expect(hcTerminalRef("spk/t12")).toBe("spk/t12");
  });
  it("keeps every address hc mints, which are base 30 (digits and bcdfghjkmnpqrstvwxyz): the 20th terminal is t1b", () => {
    // Measured on a private core: addresses run t1..t19, t1b, t1c, t1d, t1f ... t1t0 across 1,000 terminals. Taken as decimal
    // only, each of these named a seat that does not exist, and a seat past its 19th terminal could not be found by address.
    for (const address of ["t19", "t1b", "t1c", "t1d", "t1f", "t1g", "t1h", "t1j", "t1k", "t1m", "t1n", "t1p", "t1q", "t1r", "t1s", "t1t", "t1v", "t1w", "t1x", "t1y", "t1z", "t7x", "t10p", "t1t0", "spk/t1b"]) {
      expect(hcTerminalRef(address), address).toBe(address);
    }
  });
  it("names nothing for a tmux id, a window or pane that cannot exist, or no name", () => {
    for (const none of ["%3", "@1", "$2", "dev-impl@my-rig:1", "dev-impl@my-rig:0.1", "", "=", ":"]) expect(hcTerminalRef(none), none).toBeNull();
  });
  it("does not take a seat named like a word starting with t for an address", () => {
    // A letter outside hc's alphabet (a vowel, or l) cannot be part of an address. (A bare word made only of the alphabet, such as
    // `tmp`, reads as one: canonical seat names have an `@`.)
    for (const word of ["t7a", "tester", "tools", "task1", "t7e", "tl", "t-7", "T7"]) expect(hcTerminalRef(word), word).toBe(hcTerminalName(word));
  });
});

describe("HcIdentity listing", () => {
  it("lists a seat per terminal that carries the seat label, by the label's name", async () => {
    const hc = new FakeHc(listing(seat("qa@rig", { address: "t1", created_ms: 1_700_000_123_999 }), terminal({ address: "t2" }), seat("dev@rig", { address: "t3" })));
    const sessions = await new HcIdentity(hc).listSessions();
    expect(sessions).toEqual([
      { name: "qa@rig", windows: 1, created: "1700000123", attached: false },
      { name: "dev@rig", windows: 1, created: "1700000123", attached: false },
    ]);
  });
  it("does not take a terminal with an empty seat label for a seat", async () => {
    const hc = new FakeHc(listing(terminal({ labels: { [SEAT_LABEL]: "" } })));
    await expect(new HcIdentity(hc).listSessions()).resolves.toEqual([]);
  });
  it("throws when the core cannot be reached, never an empty list that reads as no seats", async () => {
    await expect(new HcIdentity(new FakeHc({ "terminal.list": unreachable })).listSessions()).rejects.toBeInstanceOf(HcUnavailableError);
  });
  it("lists the one pane of a seat by address, with the terminal's size and the foreground's directory", async () => {
    const hc = new FakeHc(getting(seat("qa@rig", { address: "t9", cols: 91, rows: 28 })));
    const panes = await new HcIdentity(hc).listPanes("=qa@rig");
    expect(panes).toEqual([{ id: "t9", index: 0, cwd: "/work/sub", width: 91, height: 28, active: true }]);
    expect(hc.calls).toEqual([{ method: "terminal.get", params: { terminal: hcTerminalName("qa@rig") } }]);
  });
  it("falls back to the terminal's own directory when nothing is in the foreground", async () => {
    const hc = new FakeHc(getting(seat("qa@rig", { foreground: null })));
    await expect(new HcIdentity(hc).listPanes("qa@rig")).resolves.toMatchObject([{ cwd: "/work" }]);
  });
  it("lists no pane for a terminal that is not there, or has finished, or a tmux pane id", async () => {
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).listPanes("gone@rig")).resolves.toEqual([]);
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished" })))).listPanes("a@r")).resolves.toEqual([]);
    const hc = new FakeHc({});
    await expect(new HcIdentity(hc).listPanes("%3")).resolves.toEqual([]);
    expect(hc.calls).toEqual([]);
  });
  it("throws for a pane list the core could not give", async () => {
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).listPanes("a@r")).rejects.toBeInstanceOf(HcUnavailableError);
    await expect(new HcIdentity(new FakeHc(getting(lost))).listPanes("a@r")).rejects.toBeInstanceOf(HcOutcomeUnknownError);
  });
  it("lists one window, index 0, named by the seat", async () => {
    const hc = new FakeHc(getting(seat("qa@rig")));
    await expect(new HcIdentity(hc).listWindows("=qa@rig")).resolves.toEqual([{ index: 0, name: "qa@rig", panes: 1, active: true }]);
  });
  it("lists no window for a seat that is not there, or has finished", async () => {
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).listWindows("gone@rig")).resolves.toEqual([]);
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished" })))).listWindows("a@r")).resolves.toEqual([]);
  });
});

describe("HcIdentity pane identity", () => {
  it("reads the pid of a live terminal", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { pid: 777 })))).getPanePid("t1")).resolves.toBe(777);
  });
  it("reads no pid from a finished terminal, whose pid the OS may have reused", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished", pid: 777, foreground: null })))).getPanePid("t1")).resolves.toBeNull();
  });
  it("reads no pid when there is none, it is not positive, or the terminal is not there", async () => {
    for (const pid of [null, 0, -1]) await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { pid })))).getPanePid("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).getPanePid("t1")).resolves.toBeNull();
  });
  it("reads null, as tmux does, when the core cannot be asked; and still throws a bug", async () => {
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).getPanePid("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(lost))).getPanePid("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(() => { throw new TypeError("bug"); }))).getPanePid("t1")).rejects.toBeInstanceOf(TypeError);
  });
  it("reads the foreground process name", async () => {
    const fg = { pid: 9, name: " claude ", argv: ["claude"], cwd: "/" };
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { foreground: fg })))).getPaneCommand("t1")).resolves.toBe("claude");
  });
  it("reads no command from a finished terminal, an empty name, or an unreachable core", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished" })))).getPaneCommand("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { foreground: { pid: 1, name: "  ", argv: [], cwd: "/" } })))).getPaneCommand("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).getPaneCommand("t1")).resolves.toBeNull();
  });
  it("reads a finished terminal as dead, a live one as not", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished" })))).isPaneDead("t1")).resolves.toBe(true);
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r")))).isPaneDead("t1")).resolves.toBe(false);
  });
  it("reads a terminal that is not there as dead, as a missing tmux pane proves the cutover", async () => {
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).isPaneDead("t1")).resolves.toBe(true);
  });
  it("never reads a core that cannot be asked as dead", async () => {
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).isPaneDead("t1")).resolves.toBe(false);
    await expect(new HcIdentity(new FakeHc(getting(lost))).isPaneDead("t1")).resolves.toBe(false);
  });
  it("reads every live terminal's pid and command at once, keyed by address, seat or not", async () => {
    const hc = new FakeHc(listing(
      seat("a@r", { address: "t1", pid: 11 }),
      terminal({ address: "t2", pid: 22, foreground: { pid: 22, name: "vim", argv: ["vim"], cwd: "/" } }),
      terminal({ address: "t3", pid: null }),
      terminal({ address: "t4", pid: 44, foreground: null }),
    ));
    const all = await new HcIdentity(hc).readAllPaneProcesses();
    expect([...(all ?? [])]).toEqual([["t1", { pid: 11, command: "sh" }], ["t2", { pid: 22, command: "vim" }], ["t4", { pid: 44, command: null }]]);
  });
  it("reads null for the batch when the core cannot be read", async () => {
    await expect(new HcIdentity(new FakeHc({ "terminal.list": unreachable })).readAllPaneProcesses()).resolves.toBeNull();
  });
});

describe("HcIdentity window snapshot and activity", () => {
  const seats = () => listing(seat("a@r", { address: "t1" }), terminal({ address: "t2" }), seat("b@r", { address: "t3" }));
  it("names the seats, and the terminal each resolves to", async () => {
    const snapshot = await new HcIdentity(new FakeHc(seats()), { now: () => 5000 }).readSessionWindowSnapshot();
    expect(snapshot?.at).toBe(5000);
    expect([...snapshot!.sessions]).toEqual(["a@r", "b@r"]);
    expect([...snapshot!.targets]).toEqual([["a@r", "t1"], ["b@r", "t3"]]);
  });
  it("has no activity until a clock is given, so a consumer sees no signal and not idle", async () => {
    const snapshot = await new HcIdentity(new FakeHc(seats())).readSessionWindowSnapshot();
    expect(snapshot?.activity.size).toBe(0);
    await expect(new HcIdentity(new FakeHc(seats())).readAllSessionWindowActivity()).resolves.toEqual(new Map());
  });
  it("takes each seat's activity from the clock it was given, in whole seconds, leaving out a seat with no signal", async () => {
    const clock = (t: ReturnType<typeof terminal>) => (t.address === "t1" ? 1_700_000_000.9 : t.address === "t3" ? null : 99);
    const identity = new HcIdentity(new FakeHc(seats()), { activity: clock });
    await expect(identity.readAllSessionWindowActivity()).resolves.toEqual(new Map([["a@r", 1_700_000_000]]));
  });
  it("leaves out a clock reading that is not a positive number", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const identity = new HcIdentity(new FakeHc(seats()), { activity: () => bad });
      expect((await identity.readAllSessionWindowActivity())?.size, String(bad)).toBe(0);
    }
  });
  it("reuses a read younger than the age asked for, and reads again at age zero", async () => {
    let clock = 1000;
    const hc = new FakeHc(seats());
    const identity = new HcIdentity(hc, { now: () => clock });
    await identity.readSessionWindowSnapshot(500);
    clock = 1400;
    await identity.readSessionWindowSnapshot(500);
    expect(hc.count("terminal.list")).toBe(1);
    clock = 1500;
    await identity.readSessionWindowSnapshot(500);
    expect(hc.count("terminal.list")).toBe(2);
    await identity.readSessionWindowSnapshot(0);
    expect(hc.count("terminal.list")).toBe(3);
  });
  it("joins a read already in flight", async () => {
    const hc = new FakeHc({ "terminal.list": async () => { await new Promise((r) => setTimeout(r, 10)); return { terminals: [], hidden_finished: 0 }; } });
    const identity = new HcIdentity(hc);
    await Promise.all([identity.readSessionWindowSnapshot(0), identity.readSessionWindowSnapshot(0)]);
    expect(hc.count("terminal.list")).toBe(1);
  });
  it("does not keep a read that failed", async () => {
    let up = false;
    const hc = new FakeHc({ "terminal.list": () => { if (!up) throw new HcUnavailableError("down"); return { terminals: [], hidden_finished: 0 }; } });
    const identity = new HcIdentity(hc, { now: () => 1000 });
    await expect(identity.readSessionWindowSnapshot(10_000)).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    up = true;
    await expect(identity.readSessionWindowSnapshot(10_000)).resolves.not.toBeNull();
    expect(hc.count("terminal.list")).toBe(2);
  });
  it("reads one seat's last activity from the clock, null without one or for a finished terminal", async () => {
    const t = seat("a@r");
    await expect(new HcIdentity(new FakeHc(getting(t)), { activity: () => 1234.5 }).readPaneLastActivity("t1")).resolves.toBe(1234);
    await expect(new HcIdentity(new FakeHc(getting(t))).readPaneLastActivity("t1")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(seat("a@r", { state: "finished" }))), { activity: () => 1234 }).readPaneLastActivity("t1")).resolves.toBeNull();
  });
});

describe("HcIdentity options held as labels", () => {
  const OPT = "openrig.opt.rigged_node_id";
  it("maps a user option to a label and a built-in to nothing", () => {
    expect(optionLabelKey("@rigged_node_id")).toBe(OPT);
    for (const none of ["mouse", "status", "@", "@a=b", "@ spaced", "rigged_node_id"]) expect(optionLabelKey(none), none).toBeNull();
  });
  it("sets the label on the seat's terminal", async () => {
    const hc = new FakeHc({ "terminal.label": () => ({}) });
    await expect(new HcIdentity(hc).setSessionOption("=qa@rig", "@rigged_node_id", "n-1")).resolves.toEqual({ ok: true });
    expect(hc.calls).toEqual([{ method: "terminal.label", params: { terminal: hcTerminalName("qa@rig"), labels: { [OPT]: "n-1" } } }]);
  });
  it("clears an option by writing the empty value, which removes the label", async () => {
    const hc = new FakeHc({ "terminal.label": () => ({}) });
    await new HcIdentity(hc).setSessionOption("qa@rig", "@rigged_node_id", "");
    expect(hc.calls[0]?.params.labels).toEqual({ [OPT]: "" });
  });
  it("refuses a built-in option without asking the core", async () => {
    const hc = new FakeHc({});
    await expect(new HcIdentity(hc).setSessionOption("qa@rig", "mouse", "on")).resolves.toMatchObject({ ok: false, code: "unsupported_option" });
    expect(hc.calls).toEqual([]);
  });
  it("tells a missing seat from a core it could not reach or hear, and from a refusal", async () => {
    const set = (err: Error) => new HcIdentity(new FakeHc({ "terminal.label": () => { throw err; } })).setSessionOption("qa@rig", "@x", "v");
    await expect(set(notFound())).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    await expect(set(new HcUnavailableError("down"))).resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
    await expect(set(new HcOutcomeUnknownError("lost", "terminal.label"))).resolves.toMatchObject({ ok: false, code: "write_outcome_unknown" });
    await expect(set(new HcError("hc says: secret-value-text", "invalid_params", -32602))).resolves.toEqual({ ok: false, code: "unknown", message: "hc refused @x on qa@rig: invalid_params" });
  });
  it("reads an empty label as unset: hc keeps no label with an empty value", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("qa@rig", { labels: { [OPT]: "" } })))).readSessionOption("qa@rig", "@rigged_node_id")).resolves.toEqual({ ok: true, value: null });
  });
  it("reads a set option, an unset one as ok with null, and a missing seat as not ok", async () => {
    const read = (t: unknown) => new HcIdentity(new FakeHc({ "terminal.get": () => { if (t === null) throw notFound(); return t; } })).readSessionOption("qa@rig", "@rigged_node_id");
    await expect(read(seat("qa@rig", { labels: { [OPT]: "n-1" } }))).resolves.toEqual({ ok: true, value: "n-1" });
    await expect(read(seat("qa@rig"))).resolves.toEqual({ ok: true, value: null });
    await expect(read(null)).resolves.toMatchObject({ ok: false });
  });
  it("reads not ok, not unset, when the core cannot be reached", async () => {
    const unavailable = new HcIdentity(new FakeHc(getting(unreachable)));
    await expect(unavailable.readSessionOption("qa@rig", "@x")).resolves.toMatchObject({ ok: false });
    await expect(unavailable.getSessionOption("qa@rig", "@x")).resolves.toBeNull();
  });
  it("reads a built-in option as not ok", async () => {
    await expect(new HcIdentity(new FakeHc({})).readSessionOption("qa@rig", "mouse")).resolves.toMatchObject({ ok: false });
  });
  it("getSessionOption returns the value, or null when unset or the seat is missing", async () => {
    await expect(new HcIdentity(new FakeHc(getting(seat("qa@rig", { labels: { [OPT]: "n-1" } })))).getSessionOption("qa@rig", "@rigged_node_id")).resolves.toBe("n-1");
    await expect(new HcIdentity(new FakeHc(getting(seat("qa@rig")))).getSessionOption("qa@rig", "@rigged_node_id")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).getSessionOption("gone@r", "@rigged_node_id")).resolves.toBeNull();
  });
});

describe("the session environment, held as labels", () => {
  const TOKEN = "tok-3f9a-needle";
  const env = { OPENRIG_NODE_ID: "node-1", OPENRIG_SESSION_NAME: "qa@rig", OPENRIG_RUNTIME: "claude-code", CODEX_HOME: "/h/.codex", OPENRIG_URL: "http://127.0.0.1:7433", OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, OPENRIG_OCCUPANT_GENERATION: "  " };
  it("labels the identity values and only marks the presence of the rest", () => {
    const labels = sessionEnvLabels(env);
    expect(labels[`${SESSION_ENV_LABEL_PREFIX}OPENRIG_NODE_ID`]).toBe("node-1");
    expect(labels[`${SESSION_ENV_LABEL_PREFIX}CODEX_HOME`]).toBe("/h/.codex");
    expect(labels[`${SESSION_ENV_PRESENT_PREFIX}OPENRIG_URL`]).toBe("1");
    expect(labels[`${SESSION_ENV_PRESENT_PREFIX}OPENRIG_ACTIVITY_HOOK_TOKEN`]).toBe("1");
  });
  it("never puts a credential, or a blank value, in a label", () => {
    const labels = sessionEnvLabels(env);
    expect(JSON.stringify(labels)).not.toContain(TOKEN);
    expect(Object.keys(labels)).not.toContain(`${SESSION_ENV_LABEL_PREFIX}OPENRIG_ACTIVITY_HOOK_TOKEN`);
    expect(Object.keys(labels).filter((k) => k.includes("OPENRIG_OCCUPANT_GENERATION"))).toEqual([]);
  });
  it("reads back what the launch labelled", async () => {
    const t = seat("qa@rig", { labels: sessionEnvLabels(env) });
    const identity = new HcIdentity(new FakeHc(getting(t)));
    await expect(identity.getSessionEnv("qa@rig", "OPENRIG_NODE_ID")).resolves.toBe("node-1");
    await expect(identity.getSessionEnv("qa@rig", "OPENRIG_RUNTIME")).resolves.toBe("claude-code");
    await expect(identity.getSessionEnv("qa@rig", "OPENRIG_OCCUPANT_GENERATION")).resolves.toBeUndefined();
    await expect(identity.getSessionEnv("qa@rig", "OPENRIG_ACTIVITY_HOOK_TOKEN")).resolves.toBeUndefined();
  });
  it("reads an empty launch label as no value", async () => {
    const identity = new HcIdentity(new FakeHc(getting(seat("qa@rig", { labels: { [`${SESSION_ENV_LABEL_PREFIX}CODEX_HOME`]: "" } }))));
    await expect(identity.getSessionEnv("qa@rig", "CODEX_HOME")).resolves.toBeUndefined();
  });
  it("refuses a key that is not an environment name, without asking the core", async () => {
    const hc = new FakeHc({});
    await expect(new HcIdentity(hc).getSessionEnv("qa@rig", "lower")).rejects.toThrow("Invalid session environment key.");
    expect(hc.calls).toEqual([]);
  });
  it("throws, saying nothing of why, when the session environment cannot be read", async () => {
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).getSessionEnv("gone@r", "CODEX_HOME")).rejects.toThrow("Cannot read the session's launch environment.");
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).getSessionEnv("qa@rig", "CODEX_HOME")).rejects.toThrow("Cannot read the session's launch environment.");
  });
  it("tells a name that is present from one that is absent, from either label, and does not read the value", async () => {
    const identity = new HcIdentity(new FakeHc(getting(seat("qa@rig", { labels: sessionEnvLabels(env) }))));
    await expect(identity.hasSessionEnv("qa@rig", "OPENRIG_ACTIVITY_HOOK_TOKEN")).resolves.toBe(true);
    await expect(identity.hasSessionEnv("qa@rig", "OPENRIG_NODE_ID")).resolves.toBe(true);
    await expect(identity.hasSessionEnv("qa@rig", "RIGGED_URL")).resolves.toBe(false);
  });
  it("reads a value label alone as present, with no presence mark", async () => {
    const identity = new HcIdentity(new FakeHc(getting(seat("qa@rig", { labels: { [`${SESSION_ENV_LABEL_PREFIX}CODEX_HOME`]: "/h/.codex", [`${SESSION_ENV_LABEL_PREFIX}BLANK`]: "  " } }))));
    await expect(identity.hasSessionEnv("qa@rig", "CODEX_HOME")).resolves.toBe(true);
    await expect(identity.hasSessionEnv("qa@rig", "BLANK")).resolves.toBe(false);
  });
  it("reads null when the session cannot be inspected", async () => {
    await expect(new HcIdentity(new FakeHc(getting(() => { throw notFound(); }))).hasSessionEnv("gone@r", "X")).resolves.toBeNull();
    await expect(new HcIdentity(new FakeHc(getting(unreachable))).hasSessionEnv("qa@rig", "X")).resolves.toBeNull();
  });
});
