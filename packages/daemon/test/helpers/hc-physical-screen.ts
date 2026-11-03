// The terminal's PHYSICAL rows, as a late observer is painted them: `hc read` joins wrapped rows into one logical line and trims blank
// rows, so it cannot show a rule that wraps or a stale row after a reflow. An observer attach (watch only: it never types or resizes)
// is sent the whole screen first, row by row with CR LF, a wrapped row on its own row (measured, hc 0.1.17).
import { HcAttach } from "../../src/adapters/hc-attach.js";

export async function physicalRows(socketPath: string, terminal: string, settleMs = 700): Promise<string[]> {
  let paint = "";
  const observer = await new HcAttach(socketPath).open(
    { terminal, cols: 80, rows: 24, observe: true },
    { onData: (bytes) => { paint += bytes.toString("utf8"); }, onEnd: () => undefined },
  );
  await new Promise((r) => setTimeout(r, settleMs));
  await observer.detach();
  // After the last "home" the screen's rows follow, separated by CR LF; the paint closes with a cursor position and attribute resets.
  const body = paint.slice(paint.lastIndexOf("\u001b[H") + 3);
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?!]*[ -/]*[@-~]`, "g");
  const osc = new RegExp(`${String.fromCharCode(27)}\\][^\u0007${String.fromCharCode(27)}]*(\u0007|${String.fromCharCode(27)}\\\\)`, "g");
  const rows = body.split("\r\n").map((row) => row.replace(osc, "").replace(csi, "").replace(new RegExp(`${String.fromCharCode(27)}[78]`, "g"), ""));
  return rows;
}
