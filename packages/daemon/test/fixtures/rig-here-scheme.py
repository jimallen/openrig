# FIXTURE COPY, not the product. Verbatim extracts of scripts/rig-here at ~/.agents commit 617f5cba01dbf858aa31b3e38d56f333f2c3b170
# (branch worktree-agent-ae4b7750a73a2873a), line ranges 452-454 (label constants), 463-464 (AppError), 471-475 (hc_name),
# 482-493 (workspace_label, tab_label, placement_labels), 728-731 (rig_tabs), 893-909 (pick_lead, split_seats).
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


def rig_tabs(alive):
    lead, rest = split_seats(alive)
    return [("cos", [lead["canonicalSessionName"]]), ("team", [n["canonicalSessionName"] for n in rest])]



def pick_lead(alive):
    """The Chief of Staff's seat (exec-cos@<rig>); else the first seat that looks
    like a lead (exec/cos/lead/orch); else the first seat."""
    return (next((n for n in alive if n["canonicalSessionName"].startswith("exec-cos@")), None)
            or next((n for n in alive
                     if re.search(r"(^|[.-])(exec|cos|lead|orch)[.-]", n["canonicalSessionName"])), None)
            or alive[0])


def split_seats(alive):
    """The one placement rule, for a launch and for a seat added later:
    (lead, rest). The lead (pick_lead) is alone in the CoS tab (Jim, 2026-10-12, relayed; the
    Engineering Manager that shared it went when the EM folded into the CoS, Jim, 2026-10-26);
    every other seat is in the team tab."""
    lead = pick_lead(alive)
    return lead, [n for n in alive if n is not lead]

