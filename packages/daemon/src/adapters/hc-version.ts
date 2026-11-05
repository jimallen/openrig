// Which hc versions this build accepts: ONE rule, used by every site that judges an hc version (the core watch's `verifyHello`,
// the runtime verifier, and the CLI's `rig setup`, `rig doctor` and `rig preflight` through tmux-health.ts).
//
// A leaf module on purpose: it imports nothing, so `@openrig/daemon/hc` (hc-surface.ts) can re-export it to the CLI without
// pulling anything heavy in (hc-surface.test.ts pins the closure).
//
// Jim, 2026-11-01: the Herdr app updates hc by itself, so an exact pin would refuse a core the app just installed and stop
// OpenRig managing seats. The rule instead accepts the tested releases' own minor line, warns when the version is not one of the tested
// ones, and refuses what could have changed the protocol: another major, another minor, or a release older than the floor.

/** The hc releases this build was tested against, oldest first: the `*.real.test.ts` files and the daemon suite ran on a private
 *  core of each (0.1.17: the full daemon suite and the code-point sweep on Sparky, OF-241). A version is added only after that run. */
export const HC_TESTED_VERSIONS = ["0.1.16", "0.1.17"] as const;

/** The newest tested release: the one install hints and fixes name ("Install hc ${HC_TESTED_VERSION}"), and the minor line the
 *  rule accepts. */
export const HC_TESTED_VERSION = HC_TESTED_VERSIONS[HC_TESTED_VERSIONS.length - 1]!;

/** The tested set as prose for messages: "0.1.16 and 0.1.17". */
const TESTED_SET_TEXT = HC_TESTED_VERSIONS.join(" and ");

/** The oldest release of the tested minor line that is accepted (0.1.15 is the version the spikes and most of the suite were
 *  written on). Anything below it, in the same minor, is refused. */
export const HC_OLDEST_ACCEPTED_VERSION = "0.1.15";

export type HcVersionJudgement =
  /** Exactly one of the tested versions. */
  | { verdict: "tested"; version: string }
  /** Accepted, not tested: the same major.minor, at or above the floor. `warning` names the version and the tested set. */
  | { verdict: "untested"; version: string; warning: string }
  /** Refused: malformed, another major or minor, or below the floor. */
  | { verdict: "refused"; version: string; reason: string };

/** Canonical `major.minor.patch` only: no sign, no leading zeros, no pre-release or build suffix, no whitespace. A string that
 *  is not exactly that is malformed, because a version this build cannot order cannot be called the same minor line. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parse(version: string): readonly [number, number, number] | null {
  const m = VERSION_PATTERN.exec(version);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : null;
}

const TESTED = parse(HC_TESTED_VERSION)!;
const FLOOR = parse(HC_OLDEST_ACCEPTED_VERSION)!;

export function judgeHcVersion(version: string): HcVersionJudgement {
  const parts = parse(version);
  if (parts === null) {
    return { verdict: "refused", version, reason: `hc version ${JSON.stringify(version)} is not major.minor.patch, so it cannot be compared with the tested hc ${TESTED_SET_TEXT}` };
  }
  const [major, minor, patch] = parts;
  if (major !== TESTED[0] || minor !== TESTED[1]) {
    return { verdict: "refused", version, reason: `hc ${version} is not on the ${TESTED[0]}.${TESTED[1]} line this build is tested on (hc ${TESTED_SET_TEXT}); a new major or minor can change the protocol` };
  }
  if (patch < FLOOR[2]) {
    return { verdict: "refused", version, reason: `hc ${version} is older than the oldest accepted release, hc ${HC_OLDEST_ACCEPTED_VERSION} (this build is tested on hc ${TESTED_SET_TEXT})` };
  }
  if ((HC_TESTED_VERSIONS as readonly string[]).includes(version)) return { verdict: "tested", version };
  return {
    verdict: "untested", version,
    warning: `hc ${version} is accepted but untested: this build is tested on hc ${TESTED_SET_TEXT}, and a release of the same minor line is expected to work`,
  };
}

/** The version token of `hc --version` output (`hc 0.1.16`): the first word after `hc`, exactly as printed, so a suffix such as
 *  `-rc1` stays on it and judgeHcVersion calls it malformed instead of reading the numbers in front of it. Null when there is none. */
export function parseHcVersionOutput(output: string): string | null {
  return /\bhc\s+(\S+)/.exec(output)?.[1] ?? null;
}
