// workspaces-o9o.77: a seat's PATH head (its git worktree shim and its own rig) is kept out of every test run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSeatPathEntry, withoutSeatPath } from "./seat-path.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEAT_BIN = `/home/u/.openrig/run/seat-bin/${"a".repeat(64)}`;
const RIG_BIN = "/home/u/.openrig/rig-bin";

test("the two PATH-head folders of a seat are recognised wherever their OpenRig home is; others are not", () => {
  for (const dir of [RIG_BIN, `${RIG_BIN}/`, "/srv/other-home/rig-bin", SEAT_BIN, "/x/seat-bin/abc"]) assert.equal(isSeatPathEntry(dir), true, dir);
  for (const dir of ["/usr/bin", "/home/u/.openrig/rig-bin/sub", "/home/u/rig-binaries", "/home/u/seat-bin", "/home/u/.local/bin"]) assert.equal(isSeatPathEntry(dir), false, dir);
});

test("withoutSeatPath drops only those folders, keeps every other entry in order, and leaves undefined alone", () => {
  assert.equal(withoutSeatPath(`${SEAT_BIN}:${RIG_BIN}:/usr/local/bin:/usr/bin::/bin`), "/usr/local/bin:/usr/bin::/bin");
  assert.equal(withoutSeatPath("/usr/bin:/bin"), "/usr/bin:/bin");
  assert.equal(withoutSeatPath(undefined), undefined);
});

test("the scripts preload cleans PATH for the process it loads into, and the repo's scripts tests run with it", () => {
  const out = spawnSync(process.execPath, ["--import", path.join(root, "scripts/seat-path-preload.mjs"), "-e", "process.stdout.write(process.env.PATH)"], {
    encoding: "utf8", env: { PATH: `${SEAT_BIN}:${RIG_BIN}:/usr/bin:/bin` },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "/usr/bin:/bin");
  const testRepo = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["test:repo"];
  assert.match(testRepo, /node --test [^&]*--import \.\/scripts\/seat-path-preload\.mjs [^&]*scripts\/\*\.test\.mjs/);
});
