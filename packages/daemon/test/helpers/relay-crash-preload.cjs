"use strict";
// Kills the relay with SIGKILL around the seen store's atomic create, so a test observes a hook that really died, not one that
// returned an error. RELAY_CRASH=before: the record was never made. RELAY_CRASH=after: it was made, and the decision never printed.
// RELAY_CRASH=fail-second: no crash, the second create of a wake group fails as a full disk does.
const fs = require("node:fs");
const when = process.env.RELAY_CRASH;
const link = fs.linkSync;
let links = 0;
fs.linkSync = function crashingLink(from, to) {
  links += 1;
  if (when === "fail-second" && links === 2) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  if (when === "before") process.kill(process.pid, "SIGKILL");
  link.call(fs, from, to);
  if (when === "after") process.kill(process.pid, "SIGKILL");
};
