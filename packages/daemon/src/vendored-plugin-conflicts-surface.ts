// workspaces-o9o.44 — narrow public surface for the vendored-plugin duplicate rule, so the daemon's plugin discovery
// and the cli-side `rig doctor` name the same ignored folders. Re-export only: no logic here.
// Lane rule: exports map + dist + cli tsconfig paths, all three.
export { findIgnoredVendoredPlugins } from "./adapters/vendored-plugin-folders.js";
export type { IgnoredVendoredPlugin } from "./domain/plugin-discovery-service.js";
