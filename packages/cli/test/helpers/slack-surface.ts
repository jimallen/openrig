// A SlackSurface (the lazily-imported daemon gateway surface behind `rig slack`) carrying only the
// members the verb under test calls. The surface has grown (channel-map members) since these doubles
// were written; the verbs they drive do not touch those members, so the fixture lists what it needs
// and the rest are absent.
import type { SlackDeps } from "../../src/commands/slack.js";

export type SlackSurface = Awaited<ReturnType<NonNullable<SlackDeps["surface"]>>>;

export function slackSurfaceStub(stubs: Partial<SlackSurface>): SlackSurface {
  return stubs as SlackSurface;
}
