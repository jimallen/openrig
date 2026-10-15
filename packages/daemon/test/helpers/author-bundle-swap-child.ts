// Child process for the no-writer swap row of bundle-create-author-tree.test.ts.
//
// Runs consumeAuthorBundleYaml over <sourceRoot> into <staging> and, between the guarded pass and the writes,
// swaps <sourceRoot>/skills/s/helper.txt for a symlink to a FIFO that has NO writer. A copy that re-reads the
// tree (cpSync) blocks forever on it; the parent kills this child on a timeout, so the regression FAILS the
// test instead of hanging vitest. Usage: node --import tsx author-bundle-swap-child.ts <sourceRoot> <staging> <fifo>
// Prints one JSON line {helper: <staged helper.txt text>, fired: <hook ran>, linked: <source helper.txt is a symlink>}.
import fs from "node:fs";
import path from "node:path";
import { consumeAuthorBundleYaml } from "../../src/routes/bundles.js";

const [sourceRoot, staging, fifo] = process.argv.slice(2) as [string, string, string];
let fired = false;
const helper = path.join(sourceRoot, "skills", "s", "helper.txt");
consumeAuthorBundleYaml(sourceRoot, staging, {
  afterGuardedPass: (declared) => {
    if (declared !== "skills/s") return;
    fs.unlinkSync(helper);
    fs.symlinkSync(fifo, helper);
    fired = true;
  },
});
process.stdout.write(`${JSON.stringify({ helper: fs.readFileSync(path.join(staging, "skills", "s", "helper.txt"), "utf-8"), fired, linked: fs.lstatSync(helper).isSymbolicLink() })}\n`);
process.exit(0);
