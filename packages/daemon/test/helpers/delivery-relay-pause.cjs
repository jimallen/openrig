// OF-229. Pauses the relay for good right after it links its gate record into a `seen` folder, and says so by creating DELIVERY_LINKED_FLAG.
// The stub seat kills the relay there: the text is on its stdout and the record is on disk, and the process never exits. Nothing else changes.
const fs = require("node:fs");
const path = require("node:path");
const link = fs.linkSync;
fs.linkSync = function patched(from, to) {
  link.call(fs, from, to);
  if (path.basename(path.dirname(String(to))) === "seen" && process.env.DELIVERY_LINKED_FLAG) {
    fs.writeFileSync(process.env.DELIVERY_LINKED_FLAG, "");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  }
};
