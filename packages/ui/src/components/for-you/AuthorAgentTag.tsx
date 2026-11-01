// V1 attempt-3 Phase 4 — AuthorAgentTag.
//
// Per agent-chat-surface.md L13–L21 V1 default: click → topology seat
// detail. The tag is a Link, so right-click / cmd-click open the seat
// detail page in the usual way (URL preserved).

import { Link } from "@tanstack/react-router";
import { ActorMark, isHumanActor } from "../graphics/RuntimeMark.js";
import { parseSessionName } from "../../lib/session-name.js";

interface AuthorAgentTagProps {
  authorSession: string;
  rigId?: string;
  className?: string;
  testId?: string;
}

function parseSeat(authorSession: string): { logicalId: string; rigId: string | null } {
  // OPR.0.4.6.MH1 FR-8: the shared parse contract; non-canonical names
  // render whole as the logical id (no rig link target).
  const parsed = parseSessionName(authorSession);
  if (parsed.kind !== "canonical") return { logicalId: authorSession, rigId: null };
  return { logicalId: parsed.member, rigId: parsed.rig };
}

export function AuthorAgentTag({ authorSession, rigId, className, testId }: AuthorAgentTagProps) {
  const parsed = parseSeat(authorSession);
  const targetRigId = rigId ?? parsed.rigId;
  const humanActor = isHumanActor(authorSession);

  // If we can't resolve a rigId, just show the tag without a link.
  if (!targetRigId) {
    return (
      <span
        data-testid={testId ?? "author-agent-tag"}
        className={className ?? "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant"}
      >
        {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
        <span>{authorSession}</span>
      </span>
    );
  }

  return (
    <Link
      to="/topology/seat/$rigId/$logicalId"
      params={{ rigId: targetRigId, logicalId: encodeURIComponent(parsed.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      className={
        className ??
        "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant hover:text-on-surface hover:underline"
      }
    >
      {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
      <span>{authorSession}</span>
    </Link>
  );
}
