// Child-process driver for send-file-process.test.ts. It runs the REAL `rig send` command with NO
// readStdin / readTextFile seam, so `--file -` exercises the production stdin guard and read loop on
// this process's actual fd 0. Only the daemon lookup is stubbed (a fixed port from the environment);
// the HTTP client is the production DaemonClient talking to the test's stub server.
import { Command } from "commander";
import { sendCommand, type SendDeps } from "../../src/commands/send.js";
import { DaemonClient } from "../../src/client.js";
import { STATE_FILE } from "../../src/daemon-lifecycle.js";

const port = Number(process.env["SEND_DRIVER_PORT"]);
if (!Number.isInteger(port) || port <= 0) throw new Error("SEND_DRIVER_PORT is required");

const deps: SendDeps = {
  lifecycleDeps: {
    spawn: () => { throw new Error("driver must not spawn a daemon"); },
    fetch: async () => ({ ok: true }),
    kill: () => true,
    readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" }) : null),
    writeFile: () => {},
    removeFile: () => {},
    exists: (p: string) => p === STATE_FILE,
    mkdirp: () => {},
    openForAppend: () => 3,
    isProcessAlive: () => true,
  },
  clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
};

const prog = new Command();
prog.exitOverride();
prog.addCommand(sendCommand(deps));
// The parent writes stdin only after this line, so the bytes arrive while the command is already reading
// (a pipe that is filled before the child starts is drained in one read and would hide a chunk-loop bug).
process.stdout.write("DRIVER-READY\n");
await prog.parseAsync(["node", "rig", "send", "dev-impl@my-rig", "--file", "-", "--raw"]);
