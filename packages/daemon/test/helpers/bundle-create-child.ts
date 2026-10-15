// Child process for the no-writer FIFO row of bundle-create-vendor-guard.test.ts.
//
// A regression that reads a FIFO with no writer BLOCKS FOREVER inside a synchronous read. In the vitest worker
// that would hang the whole run; here it hangs only this child, which the parent kills on a timeout, so the
// regression FAILS the test instead. Usage: node --import tsx bundle-create-child.ts <tmpDir>
// Prints one JSON line {status, body} for POST /api/bundles/create against <tmpDir>/rig.yaml.
import path from "node:path";
import { Hono } from "hono";
import { bundleRoutes } from "../../src/routes/bundles.js";

const tmpDir = process.argv[2]!;
// The real route, mounted bare (no database): a refusal never reaches the parts of the handler that need one.
const app = new Hono();
app.route("/api/bundles", bundleRoutes);
const res = await app.request("/api/bundles/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ specPath: path.join(tmpDir, "rig.yaml"), bundleName: "vg", bundleVersion: "0.1.0", outputPath: path.join(tmpDir, "vg.rigbundle") }),
});
process.stdout.write(`${JSON.stringify({ status: res.status, body: await res.text() })}\n`);
process.exit(0);
