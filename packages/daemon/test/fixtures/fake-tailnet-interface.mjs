// OF-232 — makes the host look as if it had a Tailscale interface, so a test can tell a loopback-pinned daemon from one that
// follows the default bind plan on ANY machine (the default plan appends the first 100.64.0.0/10 address found among the
// interfaces). Loaded into a child with `node --import <this file>` (or NODE_OPTIONS). The address is not assigned to any
// interface: a daemon that tries to bind it fails with EADDRNOTAVAIL naming it, and one that stays on loopback never touches it.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

export const FAKE_TAILNET_ADDRESS = "100.64.0.1";
const real = os.networkInterfaces.bind(os);
os.networkInterfaces = () => ({
  // First, so it is the one the daemon's first-match probe finds even on a host with a real tailnet interface.
  // A name no real interface has: `...real()` below would otherwise overwrite this entry on a host whose own interface is tailscale0.
  "openrig-fake-tailnet0": [{ address: FAKE_TAILNET_ADDRESS, netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${FAKE_TAILNET_ADDRESS}/10` }],
  ...real(),
});
syncBuiltinESMExports();
