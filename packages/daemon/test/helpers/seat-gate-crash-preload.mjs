// Preload for seat-gate-crash.real.test.ts: runs a REAL runner process and SIGKILLs it, by its own hand, at one step of the
// gate, so the kill lands exactly there and not "about then". Nothing else is changed: `fs` is wrapped, and only the write
// that carries the named record reacts. The point comes from $GATE_CRASH as `<when>:<record>`:
//   before:<record>  dies before the record's bytes are written
//   torn:<record>    writes half the record, then dies (a crash mid-append)
//   after:<record>   dies after the fsync that made the record durable
// `$GATE_CRASH_DONE` names a file created just before the kill, which is how the test knows this death was the planned one.
import fs from "node:fs";

const point = process.env.GATE_CRASH ?? "";
const [when, record] = point.split(":");
const done = process.env.GATE_CRASH_DONE ?? "";
const die = () => {
  if (done) fs.closeSync(fs.openSync(done, "w"));
  process.kill(process.pid, "SIGKILL");
  for (;;) { /* the signal lands before this loop matters */ }
};

if (record) {
  const needle = `"op":"${record}"`;
  const writeSync = fs.writeSync;
  const fsyncSync = fs.fsyncSync;
  let armed = false;
  fs.writeSync = (fd, data, ...rest) => {
    if (typeof data === "string" && data.includes(needle)) {
      if (when === "before") die();
      if (when === "torn") { writeSync(fd, data.slice(0, Math.floor(data.length / 2))); die(); }
      if (when === "after") armed = true;
    }
    return writeSync(fd, data, ...rest);
  };
  fs.fsyncSync = (fd) => {
    fsyncSync(fd);
    if (armed) die();
  };
}
