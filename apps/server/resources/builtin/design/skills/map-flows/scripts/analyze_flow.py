#!/usr/bin/env python3
"""Analyze a flow map: routes, recovery, dead ends, and what the evidence covers.

Every figure is computed from the declared map and the recorded runs. The
analysis says whether a route exists in the map and which transitions a run
actually reached. It does not measure usability, comprehension, or conversion.
"""

from __future__ import annotations

import argparse
import heapq
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_flow import (  # noqa: E402
    DEFAULT_SCENARIO,
    add_run_arguments,
    check_baselines,
    die,
    journey_scenarios,
    load_object,
    load_runs,
    parse_literal,
    resolve_runs_dir,
    validate_map,
    write_result,
)

# Guards multiply the search space. Refuse to continue rather than truncate.
MAX_CONFIGURATIONS = 20000
RECOVERY_ORDER = ("recoverable", "exit-only", "trapped")
ACCESS_INPUTS = ("keyboard", "assistive-technology")
# Findings about something that does not work come before findings that ask for a decision.
SIGNAL_ORDER = (
    "goal-unreachable",
    "exit-missing",
    "dead-end",
    "failure-without-recovery",
    "run-drift",
    "guard-not-enforced",
    "mandatory-step-not-persistent",
    "critical-route-unverified",
    "unmapped-step",
    "unplanned-path",
    "awaiting-approval",
    "stale-evidence",
)

Config = tuple  # (state id, frozenset of true facts)


def unmet_literals(literals: list[str] | None, facts: frozenset) -> list[str]:
    return [
        literal
        for literal in literals or []
        if (parse_literal(literal)[0] in facts) != parse_literal(literal)[1]
    ]


def apply_effects(effects: list[str] | None, facts: frozenset) -> frozenset:
    updated = set(facts)
    for literal in effects or []:
        fact, positive = parse_literal(literal)
        if positive:
            updated.add(fact)
        else:
            updated.discard(fact)
    return frozenset(updated)


def explore(
    transitions: list[dict[str, Any]], entry: str, facts: list[str], terminal: set[str], skip: str | None = None
) -> tuple[dict[Config, tuple[int, int]], dict[Config, tuple[Config, str]], dict[Config, list[tuple[str, Config]]]]:
    """Search every configuration reachable from the entry.

    A configuration is a state plus the facts that are true there. Cost is
    (user actions, total steps), so a system step never counts as user effort.
    Terminal states end the journey and are not expanded.
    """
    by_source: dict[str, list[dict[str, Any]]] = {}
    for transition in transitions:
        by_source.setdefault(transition["from"], []).append(transition)

    start: Config = (entry, frozenset(facts))
    best: dict[Config, tuple[int, int]] = {start: (0, 0)}
    previous: dict[Config, tuple[Config, str]] = {}
    edges: dict[Config, list[tuple[str, Config]]] = {}
    heap: list[tuple[tuple[int, int], int, Config]] = [((0, 0), 0, start)]
    order = 1
    while heap:
        cost, _, config = heapq.heappop(heap)
        if config in edges:
            continue
        if len(edges) >= MAX_CONFIGURATIONS:
            raise ValueError(
                f"more than {MAX_CONFIGURATIONS} state and fact combinations are reachable; "
                "split the map or reduce the facts"
            )
        state, true_facts = config
        outgoing: list[tuple[str, Config]] = []
        if state not in terminal:
            for transition in by_source.get(state, []):
                if transition["id"] == skip or unmet_literals(transition.get("requires"), true_facts):
                    continue
                target: Config = (transition["to"], apply_effects(transition.get("effects"), true_facts))
                outgoing.append((transition["id"], target))
                step_cost = (cost[0] + (1 if transition["actor"] == "user" else 0), cost[1] + 1)
                if target not in best or step_cost < best[target]:
                    best[target] = step_cost
                    previous[target] = (config, transition["id"])
                    heapq.heappush(heap, (step_cost, order, target))
                    order += 1
        edges[config] = outgoing
    return best, previous, edges


def can_reach(edges: dict[Config, list[tuple[str, Config]]], targets: set[Config]) -> set[Config]:
    """Return every configuration from which one of the targets is reachable."""
    reverse: dict[Config, list[Config]] = {}
    for source, outgoing in edges.items():
        for _, target in outgoing:
            reverse.setdefault(target, []).append(source)
    found = set(targets)
    frontier = list(targets)
    while frontier:
        for source in reverse.get(frontier.pop(), []):
            if source not in found:
                found.add(source)
                frontier.append(source)
    return found


def nearest(best: dict[Config, tuple[int, int]], states: set[str]) -> Config | None:
    candidates = [config for config in best if config[0] in states]
    if not candidates:
        return None
    return min(candidates, key=lambda config: (best[config], sorted(config[1]), config[0]))


def layer_transitions(
    flow: dict[str, Any], overlay: dict[str, dict[str, Any]], layer: str
) -> list[dict[str, Any]]:
    """Select the transitions one layer of the analysis may use.

    `intended` is the design: every approved or proposed transition.
    `as-built` is the product as far as the evidence goes: a transition a run
    reached, or one with observed or inferred evidence that no run contradicts.
    """
    if layer == "intended":
        return [item for item in flow["transitions"] if item["intent"] in ("approved", "proposed")]
    kept = []
    for item in flow["transitions"]:
        results = set(overlay[item["id"]]["latest_by_input"].values())
        if "reached" in results or (not results and overlay[item["id"]]["static_evidence"] != "unknown"):
            kept.append(item)
    return kept


def analyze_layer(
    flow: dict[str, Any],
    journey: dict[str, Any],
    scenario: dict[str, Any],
    available: list[dict[str, Any]],
    overlay: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Analyze one scenario using only the transitions of one layer."""
    if not available:
        return None
    states = {item["id"]: item for item in flow["states"]}
    transitions = {item["id"]: item for item in available}
    success = set(journey["success"])
    exits = set(journey.get("exits") or [])
    terminal = success | exits

    best, previous, edges = explore(available, journey["entry"], scenario["facts"], terminal)
    goal = nearest(best, success)
    way_out = nearest(best, exits)
    expect = scenario["expect"]
    target = goal if expect == "success" else way_out

    route: list[str] = []
    if target is not None:
        config = target
        while config in previous:
            config, transition_id = previous[config]
            route.append(transition_id)
        route.reverse()

    mandatory: list[str] = []
    if target is not None:
        wanted = success if expect == "success" else exits
        for transition_id in dict.fromkeys(route):
            alternative, _, _ = explore(available, journey["entry"], scenario["facts"], terminal, skip=transition_id)
            if nearest(alternative, wanted) is None:
                mandatory.append(transition_id)

    can_succeed = can_reach(edges, {config for config in edges if config[0] in success})
    can_exit = can_reach(edges, {config for config in edges if config[0] in exits})
    reached_states = {config[0] for config in edges}

    dead_ends = [
        state_id
        for state_id in states
        if state_id not in terminal
        and any(
            config[0] == state_id and config not in can_succeed and config not in can_exit
            for config in edges
        )
    ]

    failures: list[dict[str, str]] = []
    for state_id, item in states.items():
        if item.get("role", "step") != "failure" or state_id not in reached_states:
            continue
        worst = 0
        for config in edges:
            if config[0] != state_id:
                continue
            rank = 0 if config in can_succeed else 1 if config in can_exit else 2
            worst = max(worst, rank)
        failures.append({"state": state_id, "recovery": RECOVERY_ORDER[worst]})

    unavailable: list[dict[str, Any]] = []
    for transition in available:
        if not transition.get("requires") or transition["from"] not in reached_states:
            continue
        configs = [config for config in edges if config[0] == transition["from"]]
        if all(unmet_literals(transition["requires"], config[1]) for config in configs):
            unavailable.append(
                {
                    "transition": transition["id"],
                    "from": transition["from"],
                    "unmet": unmet_literals(transition["requires"], configs[0][1]),
                }
            )

    user_steps = [transition_id for transition_id in route if transitions[transition_id]["actor"] == "user"]
    visited = [journey["entry"]] + [transitions[transition_id]["to"] for transition_id in route]
    route_evidence = {name: 0 for name in ("measured", "observed", "inferred", "unknown")}
    for transition_id in route:
        route_evidence[overlay[transition_id]["evidence_state"]] += 1
    found = target is not None
    return {
        "success_reachable": goal is not None,
        "exit_reachable": way_out is not None,
        "meets_expectation": found,
        "route": route,
        "route_states": visited if found else [],
        "route_evidence": route_evidence if found else None,
        "user_actions": len(user_steps) if found else None,
        "system_steps": len(route) - len(user_steps) if found else None,
        "inputs": sum(transitions[item].get("inputs") or 0 for item in user_steps) if found else None,
        "inputs_unrecorded": [item for item in user_steps if transitions[item].get("inputs") is None],
        "screens": len({state_id for state_id in visited if states[state_id]["kind"] == "screen"}) if found else None,
        "mandatory_transitions": mandatory,
        "unavailable_transitions": unavailable,
        "dead_ends": dead_ends,
        "failure_states": failures,
        "reached_states": [state_id for state_id in states if state_id in reached_states],
    }


def analyze_scenario(
    flow: dict[str, Any], journey: dict[str, Any], scenario: dict[str, Any], overlay: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Analyze the design and the product separately so one never stands in for the other."""
    return {
        "id": scenario["id"],
        "description": scenario["description"],
        "facts": scenario["facts"],
        "expect": scenario["expect"],
        "intended": analyze_layer(flow, journey, scenario, layer_transitions(flow, overlay, "intended"), overlay),
        "as_built": analyze_layer(flow, journey, scenario, layer_transitions(flow, overlay, "as-built"), overlay),
    }


def judged_layer(scenario: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """The layer a finding is raised on: the product when there is evidence, else the design."""
    if scenario["as_built"] is not None:
        return "as-built", scenario["as_built"]
    if scenario["intended"] is not None:
        return "intended", scenario["intended"]
    return None


def transition_evidence(
    flow: dict[str, Any], runs: list[dict[str, Any]], revision: str | None
) -> dict[str, dict[str, Any]]:
    """Overlay recorded runs on the static evidence of each transition."""
    ordered = sorted(runs, key=lambda run: (run.get("recorded_at", ""), run.get("run", "")))
    records: dict[str, list[dict[str, Any]]] = {item["id"]: [] for item in flow["transitions"]}
    for run in ordered:
        for step in run["steps"]:
            if step.get("transition") in records:
                records[step["transition"]].append(
                    {
                        "run": run["run"],
                        "result": step["result"],
                        "input": run["environment"]["input"],
                        "viewport": run["environment"]["viewport"],
                        "revision": run["revision"],
                        "recorded_at": run["recorded_at"],
                    }
                )

    overlay: dict[str, dict[str, Any]] = {}
    for transition in flow["transitions"]:
        latest: dict[str, dict[str, Any]] = {}
        for record in records[transition["id"]]:
            latest[record["input"]] = record
        results = {record["result"] for record in latest.values()}
        reached = [record for record in latest.values() if record["result"] == "reached"]
        static_state = transition["evidence"]["state"]
        state = "measured" if reached else static_state
        stale = None
        if revision is not None:
            if reached:
                stale = all(record["revision"] != revision for record in reached)
            elif static_state != "unknown":
                stale = transition["evidence"].get("revision") != revision

        if transition["intent"] != "approved":
            parity = "not-evaluated"
        elif results & {"blocked", "diverged"}:
            parity = "drift"
        elif reached:
            parity = "aligned"
        elif static_state == "unknown":
            parity = "not-inspected"
        else:
            parity = "unknown"
        overlay[transition["id"]] = {
            "id": transition["id"],
            "intent": transition["intent"],
            "evidence_state": state,
            "static_evidence": static_state,
            "stale": stale,
            "parity": parity,
            "latest_by_input": {name: latest[name]["result"] for name in sorted(latest)},
            "records": records[transition["id"]],
        }
    return overlay


def build_signals(
    flow: dict[str, Any],
    journeys: list[dict[str, Any]],
    overlay: dict[str, dict[str, Any]],
    runs: list[dict[str, Any]],
    guard_mismatches: list[dict[str, Any]],
    revision: str | None,
) -> list[dict[str, Any]]:
    """Turn the analysis into findings another skill or a person must judge."""
    transitions = {item["id"]: item for item in flow["transitions"]}
    signals: list[dict[str, Any]] = []

    def add(kind: str, subjects: list[str], summary: str, route_to: str | None = None, **detail: Any) -> None:
        signals.append({"signal": kind, "subjects": subjects, "summary": summary, "route_to": route_to, **detail})

    for journey in journeys:
        for scenario in journey["scenarios"]:
            judged = judged_layer(scenario)
            if judged is None:
                continue
            layer, result = judged
            where = {"journey": journey["id"], "scenario": scenario["id"], "layer": layer}
            designed = scenario["intended"] is not None and scenario["intended"]["meets_expectation"]
            if not result["meets_expectation"]:
                if layer == "as-built" and designed:
                    summary = (
                        "The design reaches the expected end, but the transitions known to exist "
                        "in the product do not."
                    )
                elif scenario["expect"] == "success":
                    summary = "No route reaches the success state."
                else:
                    summary = "The scenario expects a way out, but no exit state is reachable."
                kind = "goal-unreachable" if scenario["expect"] == "success" else "exit-missing"
                add(
                    kind,
                    journey["success"] if kind == "goal-unreachable" else [],
                    summary,
                    designed=layer == "as-built" and designed,
                    **where,
                )
            if result["dead_ends"]:
                add(
                    "dead-end",
                    result["dead_ends"],
                    "No route leads from these states to success or to an exit.",
                    "plan-structure",
                    **where,
                )
            for failure in result["failure_states"]:
                if failure["recovery"] != "recoverable":
                    detail = (
                        "The only way on is to leave the journey."
                        if failure["recovery"] == "exit-only"
                        else "There is no way on and no way out."
                    )
                    add(
                        "failure-without-recovery",
                        [failure["state"]],
                        f"No route leads from this failure back to success. {detail}",
                        "review-components",
                        recovery=failure["recovery"],
                        **where,
                    )
            if journey["critical"] and scenario["id"] == DEFAULT_SCENARIO:
                hidden = [
                    item
                    for item in result["mandatory_transitions"]
                    if transitions[item].get("visibility") in ("contextual", "disclosed")
                ]
                if hidden:
                    add(
                        "mandatory-step-not-persistent",
                        hidden,
                        "Every route to success passes through an action that is contextual or disclosed.",
                        "review-components",
                        **where,
                    )
                unverified = [item for item in result["route"] if overlay[item]["evidence_state"] != "measured"]
                if unverified:
                    add(
                        "critical-route-unverified",
                        unverified,
                        "No recorded run has reached these steps of a critical route.",
                        "verify-changes",
                        **where,
                    )

    # One finding per combination of inputs, so the same sentence is not repeated per transition.
    drift: dict[tuple[tuple[str, ...], tuple[str, ...]], list[str]] = {}
    for transition_id, item in overlay.items():
        latest = item["latest_by_input"]
        broken = tuple(sorted(name for name, result in latest.items() if result in ("blocked", "diverged")))
        if broken:
            working = tuple(sorted(name for name, result in latest.items() if result == "reached"))
            drift.setdefault((working, broken), []).append(transition_id)
    for (working, broken), subjects in drift.items():
        if working:
            summary = f"Reached with {', '.join(working)} input but not with {', '.join(broken)}."
        else:
            summary = f"The latest run with {', '.join(broken)} input did not reach the declared state."
        add(
            "run-drift",
            subjects,
            summary,
            "check-accessibility" if any(name in ACCESS_INPUTS for name in broken) else None,
            working=list(working),
            broken=list(broken),
        )

    for mismatch in guard_mismatches:
        add(
            "guard-not-enforced",
            [mismatch["transition"]],
            f"Run {mismatch['run']} reached this step although the map requires {', '.join(mismatch['unmet'])}. "
            "Either the product does not enforce the condition or the map is wrong.",
            run=mismatch["run"],
            unmet=mismatch["unmet"],
        )

    for run in runs:
        for step in run["steps"]:
            if step["result"] == "unmapped":
                add(
                    "unmapped-step",
                    [step["from"], step["landed"]],
                    f"Run {run['run']} performed an action the map does not contain: {step['action']}",
                    run=run["run"],
                    action=step["action"],
                )

    unplanned = [item["id"] for item in flow["transitions"] if item["intent"] == "none"]
    if unplanned:
        add(
            "unplanned-path",
            unplanned,
            "These paths exist in the product without a recorded design decision. Approve or remove them.",
        )
    proposed = [item["id"] for item in flow["transitions"] if item["intent"] == "proposed"]
    if proposed:
        add("awaiting-approval", proposed, "These transitions are design proposals that nobody has approved yet.")
    if revision is not None:
        stale = [transition_id for transition_id, item in overlay.items() if item["stale"]]
        if stale:
            add(
                "stale-evidence",
                stale,
                f"The evidence for these transitions was not gathered at revision {revision}.",
                "verify-changes",
                revision=revision,
            )
    signals.sort(key=lambda item: SIGNAL_ORDER.index(item["signal"]))
    return signals


def analyze(
    flow: dict[str, Any], runs: list[dict[str, Any]], revision: str | None = None, journey_id: str | None = None
) -> dict[str, Any]:
    """Analyze a validated map and its validated runs."""
    overlay = transition_evidence(flow, runs, revision)
    journeys: list[dict[str, Any]] = []
    for journey in flow["journeys"]:
        if journey_id is not None and journey["id"] != journey_id:
            continue
        journeys.append(
            {
                "id": journey["id"],
                "critical": journey["critical"],
                "entry": journey["entry"],
                "success": journey["success"],
                "exits": journey.get("exits") or [],
                "baseline_run": journey.get("baseline_run"),
                "scenarios": [
                    analyze_scenario(flow, journey, scenario, overlay) for scenario in journey_scenarios(journey)
                ],
                "runs": [
                    {
                        "run": run["run"],
                        "scenario": run.get("scenario", DEFAULT_SCENARIO),
                        "outcome": run["outcome"],
                        "input": run["environment"]["input"],
                        "viewport": run["environment"]["viewport"],
                        "revision": run["revision"],
                        "recorded_at": run["recorded_at"],
                        "baseline": run["run"] == journey.get("baseline_run"),
                        "stale": None if revision is None else run["revision"] != revision,
                    }
                    for run in sorted(runs, key=lambda item: (item["recorded_at"], item["run"]))
                    if run["journey"] == journey["id"]
                ],
            }
        )

    approved = [item for item in overlay.values() if item["intent"] == "approved"]
    parity = {name: 0 for name in ("aligned", "drift", "unknown", "not-inspected")}
    for item in approved:
        parity[item["parity"]] += 1
    evidence = {name: 0 for name in ("measured", "observed", "inferred", "unknown")}
    for item in overlay.values():
        evidence[item["evidence_state"]] += 1

    guard_mismatches = [
        {"run": run["run"], **mismatch} for run in runs for mismatch in run.get("_guard_mismatches", [])
    ]
    return {
        "map": flow["map"],
        "title": flow["title"],
        "revision": revision,
        "counts": {
            "states": len(flow["states"]),
            "transitions": len(flow["transitions"]),
            "journeys": len(journeys),
            "runs": len(runs),
        },
        "evidence": evidence,
        "parity": {"approved_transitions": len(approved), **parity},
        "journeys": journeys,
        "transitions": list(overlay.values()),
        "signals": build_signals(flow, journeys, overlay, runs, guard_mismatches, revision),
        "limits": [
            "The intended layer shows what the design allows. The as-built layer uses only transitions with evidence, and it is only as strong as that evidence.",
            "A transition counts as measured only when a recorded run reached it.",
            "Counts of actions, inputs, and screens describe effort; a lower count is not automatically a better experience.",
        ],
    }


def load_checked(
    map_path: Path, runs_dir: Path | None, no_runs: bool, files: list[Path] | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load a map and its runs, refusing to analyze anything that fails validation."""
    flow = load_object(map_path)
    result = validate_map(flow)
    if not result["valid"]:
        die(f"{map_path} is not a valid flow map: " + "; ".join(result["errors"]))
    resolved = resolve_runs_dir(map_path, runs_dir, no_runs)
    loaded = load_runs(flow, resolved, files)
    problems = [f"{item['path'].name}: " + "; ".join(item["result"]["errors"]) for item in loaded if not item["result"]["valid"]]
    if resolved is not None or files:
        check_baselines(flow, loaded, problems)
    if problems:
        die("recorded runs do not match the map: " + " | ".join(problems))
    runs = []
    for item in loaded:
        run = dict(item["data"])
        run["_guard_mismatches"] = item["result"]["guard_mismatches"]
        runs.append(run)
    return flow, runs


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze routes, recovery, dead ends, and evidence coverage in a flow map."
    )
    parser.add_argument("map", type=Path, help="Path to the flow map (*.flow.json).")
    add_run_arguments(parser)
    parser.add_argument("--journey", help="Analyze only this journey id.")
    parser.add_argument(
        "--revision",
        help="Product revision being reviewed. Evidence gathered at another revision is reported as stale.",
    )
    parser.add_argument("--output", type=Path, help="Write the JSON result to this file.")
    args = parser.parse_args()

    flow, runs = load_checked(args.map, args.runs_dir, args.no_runs, args.run)
    if args.journey is not None and args.journey not in {item["id"] for item in flow["journeys"]}:
        die(f"journey {args.journey!r} is not in the map")
    try:
        result = analyze(flow, runs, args.revision, args.journey)
    except ValueError as exc:
        die(str(exc))
    write_result(result, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
