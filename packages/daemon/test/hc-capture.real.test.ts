import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HcClient, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { HcCapture, ObserverModeProbe } from "../src/adapters/hc-capture.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

const rows = (text: string | null) => (text ?? "").split("\n").filter((line, i, all) => !(i === all.length - 1 && line === ""));
const NUMBERED = (n: number) => `i=1; while [ $i -le ${n} ]; do printf 'L%04d\\n' $i; i=$((i+1)); done`;

/** What `terminal.read` gives, measured against a private hc core: the facts HcCapture's contract rests on. */
describe.skipIf(!HC)("HcCapture against a private hc core", () => {
  const core = new PrivateCore();
  let capture: HcCapture;
  const settled = (seat: string, word: string) => waitUntil(async () => (await capture.capturePaneContent(seat, 5)) ?? "", (text) => text.includes(word), `${word} in ${seat}`);

  beforeAll(async () => {
    core.start();
    capture = new HcCapture(core.client);
    await core.runSeat("n300@rig", `${NUMBERED(300)}; sleep 600`);
    await core.runSeat("wrap@rig", "printf 'HEAD\\n'; printf '%0500d\\n' 7; printf 'trail   \\n'; printf '   lead\\n\\nTAIL\\n'; sleep 600");
    await core.runSeat("style@rig", "printf '\\033[31mRED\\033[0m \\033[2mFAINT\\033[0m plain\\n'; sleep 600");
    await core.runSeat("alt@rig", "printf 'before\\n\\033[?1049h\\033[HALT-SCREEN row\\n'; sleep 600");
    await core.runSeat("done@rig", `${NUMBERED(1500)}; exit 3`);
    await core.runSeat("quiet@rig", "sleep 600");
    await settled("n300@rig", "L0300");
    await settled("wrap@rig", "TAIL");
    await settled("style@rig", "plain");
    await settled("alt@rig", "ALT-SCREEN");
    await waitUntil(async () => (await core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName("done@rig") })).state, (state) => state === "finished", "done@rig finished");
  }, 30_000);

  afterAll(() => core.stop());

  it("counts lines as history above the screen: asking for 20 more gives 20 more rows", async () => {
    const screen = rows(await capture.capturePaneScreen("n300@rig"));
    const more = rows(await capture.capturePaneContent("n300@rig", 20));
    expect(more.length - screen.length).toBe(20);
    expect(more.at(-1)).toBe("L0300");
    expect(screen.at(-1)).toBe("L0300");
  });

  it("reads all the history of a live terminal, in order, when asked for more than there is", async () => {
    const all = rows(await capture.capturePaneHistory("n300@rig"));
    expect(all).toEqual(Array.from({ length: 300 }, (_, i) => `L${String(i + 1).padStart(4, "0")}`));
    expect(rows(await capture.capturePaneContent("n300@rig", 100_000))).toEqual(all);
  });

  it("newline-terminates the text and reads a screen of nothing as null", async () => {
    expect((await capture.capturePaneContent("n300@rig", 5))?.endsWith("L0300\n")).toBe(true);
    await expect(capture.capturePaneContent("quiet@rig", 20)).resolves.toBeNull();
    await expect(capture.capturePaneScreen("quiet@rig")).resolves.toBeNull();
  });

  it("returns a soft-wrapped line as one line, drops trailing spaces and keeps leading ones and interior blank rows", async () => {
    const out = rows(await capture.capturePaneContent("wrap@rig", 20));
    expect(out).toEqual(["HEAD", `${"0".repeat(499)}7`, "trail", "   lead", "", "TAIL"]);
  });

  it("reads plain text, with no escapes, and answers null when escapes are asked for", async () => {
    await expect(capture.capturePaneContent("style@rig", 20)).resolves.toBe("RED FAINT plain\n");
    await expect(capture.capturePaneContent("style@rig", 20, { escapeSequences: true })).resolves.toBeNull();
  });

  it("returns the screen of a full-screen app, but not its history, which it does not have", async () => {
    expect(await capture.capturePaneContent("alt@rig", 20)).toContain("ALT-SCREEN row");
    await expect(capture.capturePaneHistory("alt@rig")).resolves.toBeNull();
  });

  it("reads what a finished terminal left, at most 1,000 history rows, and no whole history from it", async () => {
    const left = rows(await capture.capturePaneContent("done@rig", 100_000));
    expect(left.at(-1)).toBe("L1500");
    expect(left.length).toBeLessThan(1500);
    expect(left).not.toContain("L0001");
    await expect(capture.capturePaneHistory("done@rig")).resolves.toBeNull();
  });

  it("batches seats and marks one hc does not have as missing", async () => {
    const out = await capture.capturePanesContent(["n300@rig", "wrap@rig", "nobody@rig"], 5);
    expect(out?.get("n300@rig")?.text).toContain("L0300\n");
    expect(out?.get("wrap@rig")?.text).toContain("TAIL\n");
    expect(out?.get("nobody@rig")).toMatchObject({ text: null, missing: true });
    expect(out?.get("n300@rig")?.capturedAt).toBeInstanceOf(Date);
  });

  /** A background loop that changes the app's screen every second. */
  const CHURN = "(i=0; while :; do i=$((i+1)); printf '\\033[HROW%s ' $i; sleep 1; done) & ";
  /** The wheel events a stub full-screen app (alternate screen, mouse reporting) received: SGR mouse reports, `ESC [ <`. */
  const stub = async (seat: string, body: string) => {
    const received = join(core.root, `${seat.split("@")[0]}-stdin`);
    await core.runSeat(seat, `: > ${received}; printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[H\\033[2JROW1\\n\\033]7501;state=idle:app=t\\033\\\\'; ${body}stty raw -echo; exec cat >> ${received}`);
    await waitUntil(async () => (await capture.capturePaneScreen(seat)) ?? "", (text) => text.includes("ROW1"), `${seat} screen`);
    return () => readFileSync(received, "latin1");
  };

  it("positive control: a raw history read of an idle full-screen app that reports the mouse does inject wheel events, a screen read does not", async () => {
    // Measured on hc 0.1.15: terminal.read with lines > 0 reads such an app "stitched", by sending it wheel events (about 2.5 s the first time).
    // This is the defect HcCapture avoids; the instrument must be able to see it or the zero below proves nothing.
    const bytes = await stub("control@rig", "");
    const ref = hcTerminalName("control@rig");
    await core.client.call("terminal.read", { terminal: ref, lines: 0 });
    await new Promise((r) => setTimeout(r, 500));
    expect(bytes()).toBe("");
    await core.client.call("terminal.read", { terminal: ref, lines: 20 });
    await waitUntil(async () => bytes(), (text) => text.includes("\u001b[<6"), "wheel events from the raw history read");
    // The churning stub is no less able to receive them, or its zero below would prove nothing.
    const churning = await stub("controlchurn@rig", CHURN);
    // w14: on a screen that changes every second a raw read takes about 10 s and answers `complete: false`.
    await core.client.call("terminal.read", { terminal: hcTerminalName("controlchurn@rig"), lines: 20 }, { timeoutMs: 40_000 });
    await waitUntil(async () => churning(), (text) => text.includes("\u001b[<6"), "wheel events from the raw read of a churning app");
  }, 80_000);

  it("sends a full-screen app that reports the mouse no wheel events, however often it is polled for history", async () => {
    // Idle app, and an app whose screen changes every second (w14: that case made every raw read inject 600 to 4,700 events and take 10 s).
    const idle = await stub("mouse@rig", "");
    const churn = await stub("churn@rig", CHURN);
    const both = ["mouse@rig", "churn@rig"];
    const started = Date.now();
    for (let poll = 0; poll < 6; poll++) {
      for (const seat of both) {
        expect(await capture.capturePaneContent(seat, 1000)).toContain("ROW");
        expect(await capture.capturePaneHistory(seat)).toBeNull();
      }
      const batch = await capture.capturePanesContent(both, 80);
      expect(batch?.get("mouse@rig")?.text).toContain("ROW1");
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(Date.now() - started).toBeGreaterThan(3000);  // the churning app changed its screen under the polls
    expect(idle()).toBe("");
    expect(churn()).toBe("");
  }, 60_000);

  it("reads a terminal's modes from an observer's first paint: plain, alternate screen alone, alternate screen with the mouse, finished, absent", async () => {
    const probe = new ObserverModeProbe(new HcAttach(core.client.socketPath));
    const modes = (seat: string) => probe.modesOf(hcTerminalName(seat));
    await expect(modes("n300@rig")).resolves.toEqual({ altScreen: false, mouse: false });
    await expect(modes("alt@rig")).resolves.toEqual({ altScreen: true, mouse: false });
    await expect(modes("mouse@rig")).resolves.toEqual({ altScreen: true, mouse: true });
    await expect(modes("done@rig")).resolves.toEqual({ altScreen: false, mouse: false });
    await expect(modes("nobody@rig")).resolves.toBeNull();
  });

  it("reads null where the core is not running", async () => {
    const gone = new HcCapture(new HcClient(`${core.root}/no-such.sock`));
    await expect(gone.capturePaneContent("n300@rig")).resolves.toBeNull();
    await expect(gone.capturePanesContent(["n300@rig"])).resolves.toBeNull();
  });
});
