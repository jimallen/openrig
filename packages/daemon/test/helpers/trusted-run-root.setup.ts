// OF-225(a). Removes the run root `trustedBaseFolder()` made for this test file's scaffolds, in the worker, after the file's tests.
// The root's own `process.exit` hook never fires in a vitest worker (see `removeTrustedRunRoots`). Order against a test's own
// scaffold cleanup does not matter: the removal is recursive and forced, and a scaffold removed twice is just gone.
import { afterAll } from "vitest";
import { removeTrustedRunRoots } from "./trusted-run-root.js";

afterAll(() => { removeTrustedRunRoots(); });
