// workspaces-o9o.183: the production adapter for the domain's SlackTransport port (domain/gateway/slack/slack-api.ts). The domain
// holds no HTTP; this is the one place Slack's requests reach the platform fetch. Wired in startup.ts (the gateway subsystem and
// the human-readiness check), the gateway routes, and the CLI through the gateway-slack surface.
import type { SlackTransport } from "../domain/gateway/slack/slack-api.js";

export const slackHttpTransport: SlackTransport = (url, init) => fetch(url, init);
