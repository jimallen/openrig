// Preload for of119-pi-runner-main-wiring.test.ts: runs the REAL pi-runner main() with (a) Date.now running 200x faster, so
// the alive tick's wall-clock cadence (60 s) is due at its first 5 s check, and (b) every fs.renameSync logged to
// $WIRING_RENAME_LOG, so the test can see that the sidecar is replaced through a rename. Nothing else is changed.
import fs from "node:fs";

const realNow = Date.now.bind(Date);
const t0 = realNow();
Date.now = () => t0 + (realNow() - t0) * 200;

const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (process.env.WIRING_RENAME_LOG) fs.appendFileSync(process.env.WIRING_RENAME_LOG, `${from} -> ${to}\n`);
  return rename(from, to);
};
