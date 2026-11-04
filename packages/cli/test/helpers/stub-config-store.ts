// A ConfigStore double that resolves a fixed config. RiggedConfig has ~30 sections; a command under
// test reads two or three, so the fixture lists those (checked against RiggedConfig's own shapes)
// and the rest are absent, exactly as in the hand-rolled doubles this replaces.
import type { ConfigStore, RiggedConfig } from "../../src/config-store.js";

export function stubConfigStore(config: Partial<RiggedConfig>): Pick<ConfigStore, "resolve"> {
  return { resolve: () => config as RiggedConfig };
}
