// The NARROW `@openrig/daemon/hc` public surface: what the CLI needs to speak to the hc core and to label a seat's
// terminal, from the one place that defines it. The CLI used to restate these (version pin, protocol generation,
// socket path, seat label, terminal name, placement labels) because it could import only `*-surface` entries.
//
// Only pure values and the small socket client are exported. Not the host, the lifecycle, the identity reader, the
// core watch or the placement driver: those hold daemon state and belong to the daemon. Every module reached from
// here imports only Node builtins (net, os, path, crypto, child_process, fs) and each other; hc-surface.test.ts pins that.
export { SEAT_LABEL, hcTerminalName } from "./adapters/hc-seat.js";
export {
  HC_GENERATION, HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, resolveHcSocket,
  type HcHello, type HcTerminal,
} from "./adapters/hc-client.js";
export { HC_PINNED_VERSION } from "./adapters/hc-core-watch.js";
export {
  KERNEL_RIG, KERNEL_TAB, SPACE_LABEL, TAB_ID_SEPARATOR, TAB_LABEL,
  pickLead, placementLabels, planKernelTabs, planLabels, planRigTabs, rigOfSeat, rigSpaceId, rigTabId,
  type PlannedTab,
} from "./adapters/hc-placement.js";
