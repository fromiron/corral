#!/usr/bin/env python3
"""Compare two revisions of a flow map and the runs recorded against each.

A regression is reported only where something that worked stopped working:
an expected end became unreachable, a state became a dead end, a failure lost
its recovery, or a run that reached a transition no longer does. Everything
else, including more or fewer actions, is a change for a person to judge.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze_flow import RECOVERY_ORDER, analyze, load_checked  # noqa: E402
from validate_flow import die, write_result  # noqa: E402

TRANSITION_FIELDS = ("from", "to", "action", "actor", "requires", "effects", "inputs", "visibility", "intent")
EFFORT_FIELDS = ("user_actions", "inputs", "screens")
LAYERS = (("intended", "intended"), ("as_built", "as-built"))


def by_id(items: list[dict[str, Any]], key: str = "id") -> dict[str, dict[str, Any]]:
    return {item[key]: item for item in items}


def keep_revision(runs: list[dict[str, Any]], revision: str | None) -> list[dict[str, Any]]:
    return runs if revision is None else [run for run in runs if run["revision"] == revision]


def latest_results(analysis: dict[str, Any]) -> dict[tuple[str, str, str], str]:
    """Latest step result per transition, input method, and viewport."""
    latest: dict[tuple[str, str, str], str] = {}
    for transition in analysis["transitions"]:
        for record in transition["records"]:
            latest[(transition["id"], record["input"], record["viewport"])] = record["result"]
    return latest


def latest_outcomes(analysis: dict[str, Any]) -> dict[tuple[str, str, str, str], str]:
    """Latest run outcome per journey, scenario, input method, and viewport."""
    latest: dict[tuple[str, str, str, str], str] = {}
    for journey in analysis["journeys"]:
        for run in journey["runs"]:
            latest[(journey["id"], run["scenario"], run["input"], run["viewport"])] = run["outcome"]
    return latest


def compare(
    before_flow: dict[str, Any],
    before_runs: list[dict[str, Any]],
    after_flow: dict[str, Any],
    after_runs: list[dict[str, Any]],
) -> dict[str, Any]:
    reasons = []
    if before_flow["map"] != after_flow["map"]:
        reasons.append(f"different maps: {before_flow['map']!r} and {after_flow['map']!r}")
    if before_flow["schema_version"] != after_flow["schema_version"]:
        reasons.append("different schema versions")
    if reasons:
        return {"comparable": False, "verdict": "not-comparable", "reasons": reasons}

    before = analyze(before_flow, before_runs)
    after = analyze(after_flow, after_runs)
    regressions: list[dict[str, Any]] = []
    improvements: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    not_compared: list[dict[str, Any]] = []

    # Structure.
    for kind, key in (("state", "states"), ("transition", "transitions"), ("journey", "journeys")):
        old, new = by_id(before_flow[key]), by_id(after_flow[key])
        for item_id in new:
            if item_id not in old:
                changes.append({"change": f"{kind}-added", "subject": item_id})
        for item_id in old:
            if item_id not in new:
                changes.append({"change": f"{kind}-removed", "subject": item_id})
    old_transitions, new_transitions = by_id(before_flow["transitions"]), by_id(after_flow["transitions"])
    for transition_id, new in new_transitions.items():
        old = old_transitions.get(transition_id)
        if old is None:
            continue
        fields = [name for name in TRANSITION_FIELDS if old.get(name) != new.get(name)]
        if fields:
            changes.append(
                {
                    "change": "transition-changed",
                    "subject": transition_id,
                    "fields": {name: {"before": old.get(name), "after": new.get(name)} for name in fields},
                }
            )

    # Journeys, scenario by scenario and layer by layer.
    critical = {item["id"]: item["critical"] for item in after_flow["journeys"]}
    old_journeys, new_journeys = by_id(before["journeys"]), by_id(after["journeys"])
    for journey_id, new_journey in new_journeys.items():
        old_journey = old_journeys.get(journey_id)
        if old_journey is None:
            continue
        old_scenarios, new_scenarios = by_id(old_journey["scenarios"]), by_id(new_journey["scenarios"])
        for scenario_id in old_scenarios:
            if scenario_id not in new_scenarios:
                changes.append({"change": "scenario-removed", "journey": journey_id, "subject": scenario_id})
        for scenario_id, new_scenario in new_scenarios.items():
            old_scenario = old_scenarios.get(scenario_id)
            if old_scenario is None:
                changes.append({"change": "scenario-added", "journey": journey_id, "subject": scenario_id})
                continue
            for field, layer in LAYERS:
                old, new = old_scenario[field], new_scenario[field]
                where = {
                    "journey": journey_id,
                    "scenario": scenario_id,
                    "layer": layer,
                    "critical": critical[journey_id],
                }
                if old is None or new is None:
                    if old is not new:
                        not_compared.append(
                            {**where, "reason": f"the {layer} layer has no transitions {'before' if old is None else 'after'}"}
                        )
                    continue
                if old["meets_expectation"] and not new["meets_expectation"]:
                    regressions.append({"regression": "expected-end-lost", **where, "expect": new_scenario["expect"]})
                elif new["meets_expectation"] and not old["meets_expectation"]:
                    improvements.append({"improvement": "expected-end-gained", **where, "expect": new_scenario["expect"]})

                for state_id in new["dead_ends"]:
                    if state_id not in old["dead_ends"] and state_id in old["reached_states"]:
                        regressions.append({"regression": "dead-end-added", **where, "subject": state_id})
                for state_id in old["dead_ends"]:
                    if state_id not in new["dead_ends"] and state_id in new["reached_states"]:
                        improvements.append({"improvement": "dead-end-removed", **where, "subject": state_id})

                old_failures = {item["state"]: item["recovery"] for item in old["failure_states"]}
                for failure in new["failure_states"]:
                    earlier = old_failures.get(failure["state"])
                    if earlier is None:
                        changes.append(
                            {"change": "failure-state-added", **where, "subject": failure["state"], "recovery": failure["recovery"]}
                        )
                        continue
                    delta = RECOVERY_ORDER.index(failure["recovery"]) - RECOVERY_ORDER.index(earlier)
                    detail = {"subject": failure["state"], "before": earlier, "after": failure["recovery"]}
                    if delta > 0:
                        regressions.append({"regression": "recovery-lost", **where, **detail})
                    elif delta < 0:
                        improvements.append({"improvement": "recovery-gained", **where, **detail})

                effort = {
                    name: {"before": old[name], "after": new[name]}
                    for name in EFFORT_FIELDS
                    if old[name] != new[name] and old[name] is not None and new[name] is not None
                }
                if effort:
                    changes.append({"change": "effort-changed", **where, "effort": effort})
                if old["route"] != new["route"] and old["route"] and new["route"]:
                    changes.append({"change": "route-changed", **where, "before": old["route"], "after": new["route"]})
                if old["mandatory_transitions"] != new["mandatory_transitions"]:
                    changes.append(
                        {
                            "change": "mandatory-steps-changed",
                            **where,
                            "before": old["mandatory_transitions"],
                            "after": new["mandatory_transitions"],
                        }
                    )

    # Recorded runs, compared only under the same input method and viewport.
    old_results, new_results = latest_results(before), latest_results(after)
    for key, result in new_results.items():
        earlier = old_results.get(key)
        detail = {"subject": key[0], "input": key[1], "viewport": key[2], "before": earlier, "after": result}
        if earlier is None:
            continue
        if earlier == "reached" and result != "reached":
            regressions.append({"regression": "run-result-lost", **detail})
        elif earlier != "reached" and result == "reached":
            improvements.append({"improvement": "run-result-gained", **detail})
    old_outcomes, new_outcomes = latest_outcomes(before), latest_outcomes(after)
    for key, outcome in new_outcomes.items():
        earlier = old_outcomes.get(key)
        detail = {"journey": key[0], "scenario": key[1], "input": key[2], "viewport": key[3]}
        if earlier is None:
            not_compared.append({**detail, "reason": "no earlier run under the same input method and viewport"})
        elif earlier == "success" and outcome != "success":
            regressions.append({"regression": "run-outcome-lost", **detail, "before": earlier, "after": outcome})
        elif earlier != "success" and outcome == "success":
            improvements.append({"improvement": "run-outcome-gained", **detail, "before": earlier, "after": outcome})
    for key in old_outcomes:
        if key not in new_outcomes:
            not_compared.append(
                {
                    "journey": key[0],
                    "scenario": key[1],
                    "input": key[2],
                    "viewport": key[3],
                    "reason": "no later run under the same input method and viewport",
                }
            )

    return {
        "comparable": True,
        "verdict": "regression" if regressions else "no-regression",
        "map": after_flow["map"],
        "runs": {"before": len(before_runs), "after": len(after_runs)},
        "regressions": regressions,
        "improvements": improvements,
        "changes": changes,
        "not_compared": not_compared,
        "limits": [
            "no-regression means none of the listed regression kinds occurred; it is not a release decision.",
            "Changes in effort, routes, and structure are listed for a person to judge; fewer actions is not automatically better.",
            "Run results are compared only under the same input method and viewport.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare two revisions of a flow map and their recorded runs, and report regressions."
    )
    parser.add_argument("before", type=Path, help="Earlier flow map (*.flow.json).")
    parser.add_argument("after", type=Path, help="Later flow map (*.flow.json).")
    parser.add_argument("--before-runs", type=Path, help="Runs directory for the earlier map. Defaults to 'runs' next to it.")
    parser.add_argument("--after-runs", type=Path, help="Runs directory for the later map. Defaults to 'runs' next to it.")
    parser.add_argument("--before-revision", help="Use only earlier runs recorded at this product revision.")
    parser.add_argument("--after-revision", help="Use only later runs recorded at this product revision.")
    parser.add_argument("--no-runs", action="store_true", help="Compare the maps only and ignore recorded runs.")
    parser.add_argument("--output", type=Path, help="Write the JSON result to this file.")
    args = parser.parse_args()

    before_flow, before_runs = load_checked(args.before, args.before_runs, args.no_runs)
    after_flow, after_runs = load_checked(args.after, args.after_runs, args.no_runs)
    try:
        result = compare(
            before_flow,
            keep_revision(before_runs, args.before_revision),
            after_flow,
            keep_revision(after_runs, args.after_revision),
        )
    except ValueError as exc:
        die(str(exc))
    write_result(result, args.output)
    return 0 if result["verdict"] == "no-regression" else 1


if __name__ == "__main__":
    raise SystemExit(main())
