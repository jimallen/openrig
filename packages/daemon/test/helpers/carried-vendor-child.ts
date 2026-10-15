// Child process for the rows of bundle-carried-vendor-guard.test.ts that would HANG on a regression.
//
// The parent runs this under a timeout and SIGKILLs it, so a blocked read FAILS the test instead of hanging the
// vitest worker. Usage: node --import tsx carried-vendor-child.ts <mode> <dir> <staging> [fifo]
//   project         vendorProjectDir(<dir>)
//   pack            vendorContextPackDir(<dir>)
//   project-swap    vendorProjectDir(<dir>), swapping <dir>/project.yaml for a symlink to <fifo> (NO writer)
//                   right after the daemon stats it (the stat-then-read window)
//   pack-swap       vendorContextPackDir(<dir>), swapping <dir>/identity/who.md for a symlink to <fifo> likewise
// Prints one JSON line {ok, name, message, fired}; exits 0 whenever the call returned or threw.
import fs from "node:fs";
import path from "node:path";
import { vendorContextPackDir } from "../../src/domain/bundle-carried-context-pack.js";
import { vendorProjectDir } from "../../src/domain/bundle-carried-project.js";
import { VendoredFileRefused } from "../../src/domain/vendored-file-guard.js";

const [mode, dir, staging, fifo] = process.argv.slice(2) as [string, string, string, string | undefined];
let fired = false;
if (mode.endsWith("-swap")) {
  const target = mode === "project-swap" ? path.join(dir, "project.yaml") : path.join(dir, "identity", "who.md");
  const realStat = fs.statSync;
  (fs as { statSync: unknown }).statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const result = (realStat as (...a: unknown[]) => unknown)(p, ...rest);
    if (!fired && String(p) === fs.realpathSync(target)) {
      fired = true;
      const real = fs.realpathSync(target);
      fs.unlinkSync(real);
      fs.symlinkSync(fifo!, real);
    }
    return result;
  }) as typeof fs.statSync;
}
const report = (o: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify({ ...o, fired })}\n`); process.exit(0); };
try {
  if (mode.startsWith("project")) vendorProjectDir(dir, staging);
  else vendorContextPackDir(dir, staging);
  report({ ok: true });
} catch (error) {
  report({ ok: false, refused: error instanceof VendoredFileRefused, name: (error as Error).name, message: (error as Error).message });
}
