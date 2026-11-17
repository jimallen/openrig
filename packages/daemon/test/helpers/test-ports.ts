// workspaces-o9o.81: the claim helper for TypeScript tests. The implementation is test-ports-core.mjs (plain ESM, shared with the node --test
// scripts under scripts/), typed by test-ports-core.d.mts.
export { TEST_PORT_CLAIMS_DIR, TEST_PORT_HOST, claimPort, claimTestPort, claimTestPortSync, probeFreePort, releasePort } from "./test-ports-core.mjs";
export type { ClaimOptions } from "./test-ports-core.mjs";
