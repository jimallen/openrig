// workspaces-o9o.77 — `node --import ./scripts/seat-path-preload.mjs --test ...`: the repo's own scripts tests run with a seat's
// PATH-head folders removed (scripts/seat-path.mjs), as the vitest setup does for the package suites. Every test process the
// runner starts inherits the cleaned PATH.
import { withoutSeatPath } from "./seat-path.mjs";

if (process.env.PATH !== undefined) process.env.PATH = withoutSeatPath(process.env.PATH);
