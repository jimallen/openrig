// @vitest-environment node
// workspaces-eiv: seroval (critical: GHSA-mv8w-475r-vwqw and five more, all in fromJSON/fromCrossJSON deserialization) reaches
// the UI only through @tanstack/router-core's SSR serializer. OpenRig ships the UI as a client-only bundle, and the bundler drops
// that code, so no deserializer reaches a user. This pin keeps it so: a future switch to SSR, or a direct import, would put
// seroval's deserializer in the shipped bundle and fail here, and the advisory would apply again.
//
// The marker is a string seroval's deserializer paths throw and minification keeps: `Seroval Error (`. The positive control
// builds a fixture that imports seroval's fromJSON through the same vite pipeline and requires the marker to be found. Both builds
// run as production builds (see withScratch), and the fixture must come out minified, so the control reads the shipped shape.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";

const uiRoot = resolve(__dirname, "..");
/** seroval's deserializer error text: "Seroval Error (" in its production build, "Seroval caught an error" in its development one. */
const SEROVAL_DESERIALIZER = /Seroval Error \(|Seroval caught an error/g;

/** Every .js file under `dir`, concatenated. */
function bundleText(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => readdirSync(d).forEach((name) => {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p);
  });
  walk(dir);
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

/** A scratch folder inside the UI package, so the build resolves its node_modules; always removed. The build runs with
 *  NODE_ENV=production, as `npm run build` does: vitest sets it to "test", and vite would then resolve packages' development
 *  builds (measured: seroval's dev build, unminified), so the scan would not read what ships. Restored afterwards. */
async function withScratch<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(uiRoot, ".bundle-pin-"));
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { return await run(dir); } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the shipped UI bundle carries no seroval deserializer (workspaces-eiv)", () => {
  it("POSITIVE CONTROL: a bundle that imports seroval's fromJSON carries the marker", { timeout: 120_000 }, async () => {
    const js = await withScratch(async (dir) => {
      writeFileSync(join(dir, "entry.js"), `import { fromJSON } from "seroval";\nexport const run = (x) => fromJSON(x);\n`);
      await build({
        root: uiRoot, configFile: false, logLevel: "silent", publicDir: false, mode: "production",
        build: { outDir: join(dir, "out"), emptyOutDir: true, minify: true, lib: { entry: join(dir, "entry.js"), formats: ["es"], fileName: "fx" } },
      });
      return bundleText(join(dir, "out"));
    });
    expect(js.length).toBeGreaterThan(1000);
    expect(js).toContain("Seroval Error ("); // the production build of seroval, not its development one
    expect(js.match(SEROVAL_DESERIALIZER)?.length ?? 0).toBeGreaterThan(0);
  });

  it("the production UI build has none, while the router it comes through is in it", { timeout: 180_000 }, async () => {
    const js = await withScratch(async (dir) => {
      await build({ root: uiRoot, configFile: resolve(uiRoot, "vite.config.ts"), logLevel: "silent", mode: "production", build: { outDir: join(dir, "out"), emptyOutDir: true } });
      return bundleText(join(dir, "out"));
    });
    // The router-core code that imports seroval is bundled (its route options are read by name), so absence is not a wrong folder.
    expect(js.match(/beforeLoad/g)?.length ?? 0).toBeGreaterThan(0);
    expect(js.match(SEROVAL_DESERIALIZER) ?? []).toEqual([]);
    expect(/seroval/i.test(js)).toBe(false);
  });
});
