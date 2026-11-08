// OF-279: a Pi launch whose declared provider has no credential is refused before Pi starts, so a fixture that starts the REAL
// runner with a model names a (dummy) stored key for that provider in the seat's own agent dir. Dummy value; never a real login.
import fs from "node:fs";
import { piSeatPaths } from "../../src/adapters/pi-runner-protocol.js";
import nodePath from "node:path";

export function seedPiFixtureCredential(stateRoot: string, session: string, provider: string): void {
  const { agentDir } = piSeatPaths(stateRoot, session);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(nodePath.join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "dummy-fixture-key" } }), { mode: 0o600 });
}
