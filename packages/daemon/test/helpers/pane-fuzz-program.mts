// A plain program (not a runner) for runner-pane-guard.real.test.ts: writes 400 random escape-heavy texts, each in two writes split at
// a random place, either raw or through the real pane filter, then prints FUZZ-DONE and idles. What herdr-core makes of the bytes
// is the measurement.
import { createPaneFilter } from "../../src/adapters/runner-pane-guard.js";

const mode = process.argv[2];
const ESC = "\u001b";
const PIECES = [ESC, ESC, ESC, "]", "[", "P", "X", "^", "_", "\\", "7501;state=blocked:app=f", "\u0007", "\u0000", "\u0001", "\u0008", "\u000a", "\u000d", "\u0018", "\u001a", "\u001f", "\u007f", "\u009d", "\u0090", "\u009b", "\u009c", "a", " ", "~", "1", ";"];
let seed = 0x45f6;
const next = (): number => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const filter: (t: string) => string = mode === "filtered" ? createPaneFilter() : (t) => t;
for (let r = 0; r < 400; r++) {
  let s = "";
  const len = 5 + Math.floor(next() * 40);
  for (let i = 0; i < len; i++) s += PIECES[Math.floor(next() * PIECES.length)];
  const cut = Math.floor(next() * (s.length + 1));
  process.stdout.write(filter(s.slice(0, cut)));
  process.stdout.write(filter(s.slice(cut)));
}
process.stdout.write("FUZZ-DONE\n");
setInterval(() => {}, 1e6);
