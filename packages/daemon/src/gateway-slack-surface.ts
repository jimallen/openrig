// S10 — the narrow @openrig/daemon/gateway-slack surface: exactly what the CLI's surviving
// config verbs (`rig slack setup/status/verify/channel-map`) consume after the relay cutover re-homed the
// slack modules into the daemon. Same dep-rail pattern as gateway-protocol / human-registry:
// the CLI lazy-imports this at invocation; nothing else is exported.

export {
  loadConfig,
  saveConfig,
  configPathFor,
  staticReadiness,
  DEFAULT_CONFIG,
  type SlackConnectorConfig,
  type ReadinessItem,
} from "./domain/gateway/slack/config.js";
export { resolveSecret, checkEnvFilePermissions } from "./domain/gateway/slack/secrets.js";
export {
  mappedChannels,
  validateChannelMap,
  setChannelMapEntry,
  removeChannelMapEntry,
  type ChannelMapEntry,
  type MappedChannel,
} from "./domain/gateway/slack/channel-map.js";
export {
  buildSlackAppManifest,
  CANONICAL_MANIFEST_SOURCES,
  type SlackAppManifest,
  type SlackManifestBundle,
} from "./domain/gateway/slack/manifest.js";
export { FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES } from "./domain/gateway/slack/capabilities.js";
export { runChannelOperation, channelStateDigest, type ChannelActor } from "./domain/gateway/channel-operations.js";
// workspaces-o9o.183: the domain's Slack checks take their HTTP as a port; the CLI's `rig slack verify` gets the production
// transport here (an adapter: the surface is outside the domain).
export { slackHttpTransport } from "./adapters/slack-http-transport.js";
export {
  verifyScopes,
  verifyChannelMembership,
  type SlackTransport,
  type ScopeVerdict,
} from "./domain/gateway/slack/slack-api.js";
