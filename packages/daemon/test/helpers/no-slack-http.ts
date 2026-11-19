// workspaces-o9o.183: the domain's Slack checks take their HTTP as a required port (SlackTransport). A test whose path must not
// reach Slack hands in this one: any call fails loudly instead of going to the network.
import type { SlackTransport } from "../../src/domain/gateway/slack/slack-api.js";

export const noSlackHttp: SlackTransport = async (url) => {
  throw new Error(`no Slack HTTP in this test (called for ${url})`);
};
