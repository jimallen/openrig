import { HC as TestHC, PrivateCore as TestPrivateCore } from "../hc-private-core.js";
import { HC as HelperHC, PrivateCore as HelperPrivateCore } from "../helpers/hc-private-core.js";

const helper = process.argv[2];
const core = helper === "test"
  ? new TestPrivateCore("o163")
  : helper === "helpers"
    ? new HelperPrivateCore()
    : (() => { throw new Error(`unknown helper: ${helper}`); })();

const hcPath = helper === "test" ? TestHC : HelperHC;

process.stdout.write(`${JSON.stringify({
  type: "root",
  helper,
  pid: process.pid,
  root: core.root,
  env: core.env,
  hcPath,
})}\n`);

try {
  core.start();
  await core.client.call("terminal.run", {
    argv: ["/bin/sh", "-c", "exec sleep 600"],
    name: "o9o163-owner-kill-child",
    cwd: core.root,
    no_parent: true,
    no_notify: true,
    outlive_parent: true,
  });
  process.stdout.write(`${JSON.stringify({ type: "ready", helper, pid: process.pid })}\n`);
  setInterval(() => {}, 60_000);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: "error", helper, pid: process.pid, error: String(error) })}\n`);
  process.exitCode = 1;
}
