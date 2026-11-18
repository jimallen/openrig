// V1 attempt-3 Phase 5 P5-3 — For You feed subscription state hook.
//
// Reads the 5 feed.subscriptions.* allowlist keys from /api/config and
// provides a toggle function that writes back via /api/config/<key>.
// Per for-you-feed.md L144-L151:
//   - action_required is FORCED ON (cannot be disabled per L145; the
//     UI surface this hook drives never renders an interactive toggle
//     for that key).
//   - approvals / shipped / progress default ON.
//   - audit_log default OFF.
//
// SC-29 exception scope (declared in Phase 5 ACK §5 DRIFT P5-D2): same
// as Phase 4 ConfigStore allowlist exception; allowlist-only additions.

import { useSettings, useSetSetting } from "./useSettings.js";
import type { FeedCardKind } from "../lib/feed-classifier.js";
import { levelToToggles, type FeedLevel } from "../lib/feed-levels.js";

export interface FeedSubscriptionState {
  actionRequired: boolean;
  approvals: boolean;
  shipped: boolean;
  progress: boolean;
  auditLog: boolean;
}

export type FeedSubscriptionToggleKey =
  | "approvals"
  | "shipped"
  | "progress"
  | "auditLog";

const TOGGLE_KEY_TO_CONFIG_KEY: Record<FeedSubscriptionToggleKey, string> = {
  approvals: "feed.subscriptions.approvals",
  shipped: "feed.subscriptions.shipped",
  progress: "feed.subscriptions.progress",
  auditLog: "feed.subscriptions.audit_log",
};

const DEFAULTS: FeedSubscriptionState = {
  actionRequired: true,
  approvals: true,
  shipped: true,
  progress: true,
  auditLog: false,
};

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return fallback;
}

/** OPR.0.4.4.15 — a per-host consolidated-feed subscription (the G15-P1
 *  dynamic key class, enumerated additively by the daemon config list). */
export interface HostSubscription {
  hostId: string;
  enabled: boolean;
}

export interface UseFeedSubscriptionsResult {
  state: FeedSubscriptionState;
  /** Toggle a non-forced subscription. action_required is forced ON and
   *  cannot be toggled — calling toggle("actionRequired") is intentionally
   *  not part of the API. */
  toggle: (key: FeedSubscriptionToggleKey) => void;
  /** Apply a named level (OPR.0.4.1.27): writes the 4 toggleable kinds to the
   *  level's preset, writing ONLY the keys that change. action_required is
   *  floored ON and is never written. Presentation over the existing model. */
  setLevel: (level: FeedLevel) => void;
  /** OPR.0.4.4.15 — persisted per-host consolidated-feed subscriptions. */
  hostSubscriptions: HostSubscription[];
  /** True when ≥1 remote host subscription is enabled (the aggregated-
   *  polling switch — false = zero-config, today's wire untouched). */
  anyRemoteEnabled: boolean;
  /** Write one per-host subscription key (the dynamic class). */
  setHostSubscription: (hostId: string, enabled: boolean) => void;
  /** True when the underlying setSetting mutation is in flight. */
  isMutating: boolean;
  /** True when the daemon does not expose /api/config (legacy v0.2.0). */
  unavailable: boolean;
}

export function useFeedSubscriptions(): UseFeedSubscriptionsResult {
  const { data, error } = useSettings();
  const setSetting = useSetSetting();

  const settings = data?.settings as Record<string, { value: unknown } | undefined> | undefined;
  const unavailable = !!error || !settings;

  const state: FeedSubscriptionState = unavailable
    ? DEFAULTS
    : {
        actionRequired: readBool(
          settings?.["feed.subscriptions.action_required"]?.value,
          DEFAULTS.actionRequired,
        ),
        approvals: readBool(
          settings?.["feed.subscriptions.approvals"]?.value,
          DEFAULTS.approvals,
        ),
        shipped: readBool(
          settings?.["feed.subscriptions.shipped"]?.value,
          DEFAULTS.shipped,
        ),
        progress: readBool(
          settings?.["feed.subscriptions.progress"]?.value,
          DEFAULTS.progress,
        ),
        auditLog: readBool(
          settings?.["feed.subscriptions.audit_log"]?.value,
          DEFAULTS.auditLog,
        ),
      };

  const toggle = (toggleKey: FeedSubscriptionToggleKey) => {
    const configKey = TOGGLE_KEY_TO_CONFIG_KEY[toggleKey];
    const current = state[toggleKey];
    setSetting.mutate({
      key: configKey as Parameters<typeof setSetting.mutate>[0]["key"],
      value: current ? "false" : "true",
    });
  };

  // OPR.0.4.4.15 — per-host consolidated-feed subscriptions (the dynamic
  // key class). Enumerated additively by the daemon; absent/legacy daemons
  // degrade to an empty list (zero-config = today's behavior exactly).
  const hostSubscriptions: HostSubscription[] = data?.feedHostSubscriptions ?? [];
  const anyRemoteEnabled = hostSubscriptions.some((h) => h.enabled);
  const setHostSubscription = (hostId: string, enabled: boolean) => {
    setSetting.mutate({
      key: `feed.subscriptions.${hostId}.enabled` as Parameters<typeof setSetting.mutate>[0]["key"],
      value: enabled ? "true" : "false",
    });
  };

  const setLevel = (level: FeedLevel) => {
    const target = levelToToggles(level);
    (Object.keys(TOGGLE_KEY_TO_CONFIG_KEY) as FeedSubscriptionToggleKey[]).forEach((key) => {
      // Only write keys that actually change — action_required is not a toggle
      // key (TOGGLE_KEY_TO_CONFIG_KEY excludes it), so it is never touched.
      if (state[key] === target[key]) return;
      setSetting.mutate({
        key: TOGGLE_KEY_TO_CONFIG_KEY[key] as Parameters<typeof setSetting.mutate>[0]["key"],
        value: target[key] ? "true" : "false",
      });
    });
  };

  return {
    state,
    toggle,
    setLevel,
    hostSubscriptions,
    anyRemoteEnabled,
    setHostSubscription,
    isMutating: setSetting.isPending,
    unavailable,
  };
}

/** Map a feed card kind to its subscription state field. Used by the
 *  Feed component to filter out cards whose subscription is OFF. */
export function isCardKindSubscribed(
  kind: FeedCardKind,
  state: FeedSubscriptionState,
): boolean {
  switch (kind) {
    case "action-required":
      return state.actionRequired; // always true in V1 (forced ON)
    case "approval":
      return state.approvals;
    case "shipped":
      return state.shipped;
    case "progress":
      return state.progress;
    case "observation":
      return state.auditLog;
  }
}
