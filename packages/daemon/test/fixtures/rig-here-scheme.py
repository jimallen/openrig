# FIXTURE COPY, not the product. Verbatim extracts of scripts/rig-here at ~/.agents commit 55b7dae046b41010a05a2789f56e2650dc3eafe6
# (branch rig-here-cos-own-tab), line ranges 543-545 (label constants), 557-558 (AppError), 565-568 (hc_name),
# 576-587 (workspace_label, tab_label, placement_labels), 1142-1165 (LEAD_TAB, LEGACY_TABS, seat_pod, rig_tabs),
# 1349 (COS_PREFIX), 1416-1432 (pick_lead, split_seats).
# rig-here lives in another repository, so this copy is how hc-placement-scheme.test.ts holds the two schemes equal.
# When rig-here's scheme changes, re-copy these ranges and the test says what diverged.
import hashlib
import re


SEAT_LABEL = "openrig.seat"
SPACE_LABEL = "herdr.space"
TAB_LABEL = "herdr.tab"


class AppError(RuntimeError):
    pass


def hc_name(seat):
    """The hc terminal name of a seat (hcTerminalName in the fork's hc-seat.ts): hc names are 1 to 32 of a-z 0-9 - _ .,
    which `verify-qa@eztrack` is not, so the name is a digest and the canonical name rides in the openrig.seat label."""
    return "s-" + hashlib.sha256(seat.encode()).hexdigest()[:24]


def workspace_label(rig):
    return f"rig:{rig}"


def tab_label(rig, tab):
    return f"rig:{rig}/{tab}"


def placement_labels(rig, tab):
    if not rig or "/" in rig or not tab or "/" in tab:
        raise AppError(f"rig {rig!r} and tab {tab!r} must be non-empty names without '/'")
    return {SPACE_LABEL: workspace_label(rig), TAB_LABEL: tab_label(rig, tab)}


LEAD_TAB = "cos"  # the lead's own tab (Jim, 2026-11-14 ~19:15Z: the CoS gets its own tab again)
LEGACY_TABS = ("team",)  # the layout before one tab per pod (THE LAYOUT): closed once empty, unless the plan names it


def seat_pod(seat):
    """The pod of a seat, which names its tab. `seat` is a `rig ps --nodes` row or a canonical session name
    <pod>-<member>@<rig>: the row's podNamespace when the name starts with it (a pod name may hold a `-`), else the part
    of the name before the first `-` (the whole name before `@` when it has none)."""
    name = seat if isinstance(seat, str) else seat["canonicalSessionName"]
    local = name.split("@", 1)[0]
    pod = None if isinstance(seat, str) else seat.get("podNamespace")
    if isinstance(pod, str) and pod and local.startswith(pod + "-"):
        return pod
    return local.split("-", 1)[0]


def rig_tabs(alive, cos=None):
    """THE LAYOUT's rule, as [(tab name, [session, ...]), ...]: the lead alone in `cos`, first; then one tab per pod for
    every other seat, the pods in the order they first appear. (A pod itself named `cos` shares that tab, the lead first.)"""
    lead, rest = split_seats(alive, cos)
    pods = {}
    for n in rest:
        pods.setdefault(seat_pod(n), []).append(n["canonicalSessionName"])
    return [(LEAD_TAB, [lead["canonicalSessionName"]] + pods.pop(LEAD_TAB, []))] + list(pods.items())


COS_PREFIX = "exec-cos@"


def pick_lead(alive, cos=None):
    """The Chief of Staff's seat (`cos`: cos_sessions, else the sessions named exec-cos@<rig>); else the first seat that
    looks like a lead (exec/cos/lead/orch); else the first seat."""
    if cos is None:
        cos = {n["canonicalSessionName"] for n in alive if n["canonicalSessionName"].startswith(COS_PREFIX)}
    return (next((n for n in alive if n["canonicalSessionName"] in cos), None)
            or next((n for n in alive
                     if re.search(r"(^|[.-])(exec|cos|lead|orch)[.-]", n["canonicalSessionName"])), None)
            or alive[0])


def split_seats(alive, cos=None):
    """The one placement rule, for a launch and for a seat added later:
    (lead, rest). The lead (pick_lead) is alone in the cos tab; every other seat is in its pod's tab (rig_tabs; Jim,
    2026-11-14, relayed by openrig-23)."""
    lead = pick_lead(alive, cos)
    return lead, [n for n in alive if n is not lead]
