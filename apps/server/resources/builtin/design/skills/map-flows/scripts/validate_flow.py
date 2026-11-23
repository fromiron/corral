#!/usr/bin/env python3
"""Validate a flow map and the runs recorded against it.

The validator checks the declared contract: identifiers, references, guard
literals, evidence rules, and the continuity of each recorded run. It never
opens the product, so a valid map is not evidence that a journey works.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, NoReturn

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

SCHEMA_VERSION = "1.0"
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DOTTED_ID_RE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$")

STATE_KINDS = ("screen", "overlay", "inline", "external")
STATE_ROLES = ("step", "failure")
ACTORS = ("user", "system")
VISIBILITIES = ("persistent", "contextual", "disclosed")
INTENTS = ("approved", "proposed", "none")
# A map holds static evidence only. `measured` is earned by a recorded run.
MAP_EVIDENCE_STATES = ("observed", "inferred", "unknown")
EVIDENCE_SOURCES = ("design", "documentation", "code", "screenshot", "live")
EXPECTATIONS = ("success", "exit")
DEFAULT_SCENARIO = "default"

RUN_METHODS = ("browser-automation", "automated-test", "manual")
RUN_INPUTS = ("pointer", "keyboard", "touch", "assistive-technology")
STEP_RESULTS = ("reached", "diverged", "blocked", "unmapped")
RUN_OUTCOMES = ("success", "failure", "blocked", "abandoned")


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load_object(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON in {path} at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(data, dict):
        die(f"{path}: top-level JSON value must be an object")
    return data


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def parse_literal(literal: str) -> tuple[str, bool]:
    """Split a guard literal such as `signed-in` or `!signed-in`."""
    if literal.startswith("!"):
        return literal[1:], False
    return literal, True


def check_literals(
    value: Any, facts: set[str], label: str, errors: list[str], allow_negation: bool = True
) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        errors.append(f"{label} must be an array of fact literals")
        return []
    seen: dict[str, bool] = {}
    for literal in value:
        fact, positive = parse_literal(literal)
        if not positive and not allow_negation:
            errors.append(f"{label}: {literal!r} must name a fact without '!'")
        if fact not in facts:
            errors.append(f"{label}: {literal!r} names an undeclared fact")
        elif fact in seen and seen[fact] != positive:
            errors.append(f"{label}: {fact!r} is both required true and false")
        seen[fact] = positive
    return list(value)


def check_evidence(
    value: Any, label: str, errors: list[str], warnings: list[str], required: bool
) -> str:
    if value is None and not required:
        return "unknown"
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object with a state")
        return "unknown"
    state = value.get("state")
    if state == "measured":
        errors.append(
            f"{label}.state cannot be 'measured' in a map; record a run that reaches the transition"
        )
        return "unknown"
    if state not in MAP_EVIDENCE_STATES:
        errors.append(f"{label}.state must be one of {list(MAP_EVIDENCE_STATES)}")
        return "unknown"
    if state in ("observed", "inferred"):
        if value.get("source") not in EVIDENCE_SOURCES:
            errors.append(f"{label}.source must be one of {list(EVIDENCE_SOURCES)} when state is {state}")
        if not nonempty_string(value.get("ref")):
            errors.append(f"{label}.ref must point to the inspected material when state is {state}")
        if state == "observed" and not nonempty_string(value.get("revision")):
            warnings.append(f"{label}: observed evidence has no revision, so its freshness cannot be checked")
    for field in ("ref", "revision", "note"):
        if field in value and not isinstance(value[field], str):
            errors.append(f"{label}.{field} must be a string")
    return str(state)


def journey_scenarios(journey: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the default scenario followed by the declared ones, with resolved facts."""
    base = [fact for fact in journey.get("start_facts") or [] if isinstance(fact, str)]
    scenarios = [
        {
            "id": DEFAULT_SCENARIO,
            "description": "",
            "facts": sorted(set(base)),
            "expect": journey.get("expect", "success"),
        }
    ]
    for scenario in journey.get("scenarios") or []:
        if not isinstance(scenario, dict):
            continue
        facts = set(base)
        for literal in scenario.get("facts") or []:
            if not isinstance(literal, str):
                continue
            fact, positive = parse_literal(literal)
            if positive:
                facts.add(fact)
            else:
                facts.discard(fact)
        scenarios.append(
            {
                "id": scenario.get("id"),
                "description": scenario.get("description", ""),
                "facts": sorted(facts),
                "expect": scenario.get("expect", "success"),
            }
        )
    return scenarios


def validate_map(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    if data.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION!r}")
    if not isinstance(data.get("map"), str) or not ID_RE.fullmatch(data["map"]):
        errors.append("map must be a lowercase hyphen-case identifier")
    for field in ("title", "product"):
        if not nonempty_string(data.get(field)):
            errors.append(f"{field} must be a non-empty string")
    if "scope" in data and not isinstance(data["scope"], str):
        errors.append("scope must be a string")

    facts: set[str] = set()
    raw_facts = data.get("facts", [])
    if not isinstance(raw_facts, list):
        errors.append("facts must be an array")
        raw_facts = []
    for index, item in enumerate(raw_facts):
        label = f"facts[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        fact_id = item.get("id")
        if not isinstance(fact_id, str) or not ID_RE.fullmatch(fact_id):
            errors.append(f"{label}.id must be a lowercase hyphen-case identifier")
            continue
        if fact_id in facts:
            errors.append(f"{label}.id {fact_id!r} is duplicated")
        facts.add(fact_id)
        if not nonempty_string(item.get("description")):
            errors.append(f"{label}.description must say what the fact means")

    states: dict[str, dict[str, Any]] = {}
    raw_states = data.get("states")
    if not isinstance(raw_states, list) or not raw_states:
        errors.append("states must be a non-empty array")
        raw_states = []
    for index, item in enumerate(raw_states):
        label = f"states[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        state_id = item.get("id")
        if not isinstance(state_id, str) or not ID_RE.fullmatch(state_id):
            errors.append(f"{label}.id must be a lowercase hyphen-case identifier")
            continue
        label = f"states[{state_id}]"
        if state_id in states:
            errors.append(f"{label}: duplicate state id")
        states[state_id] = item
        if item.get("kind") not in STATE_KINDS:
            errors.append(f"{label}.kind must be one of {list(STATE_KINDS)}")
        if item.get("role", "step") not in STATE_ROLES:
            errors.append(f"{label}.role must be one of {list(STATE_ROLES)}")
        if not nonempty_string(item.get("label")):
            errors.append(f"{label}.label must be a non-empty string")
        if "route" in item and not nonempty_string(item["route"]):
            errors.append(f"{label}.route must be a non-empty string when present")
        check_evidence(item.get("evidence"), f"{label}.evidence", errors, warnings, required=False)

    transitions: dict[str, dict[str, Any]] = {}
    touched: set[str] = set()
    raw_transitions = data.get("transitions")
    if not isinstance(raw_transitions, list) or not raw_transitions:
        errors.append("transitions must be a non-empty array")
        raw_transitions = []
    for index, item in enumerate(raw_transitions):
        label = f"transitions[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        transition_id = item.get("id")
        if not isinstance(transition_id, str) or not DOTTED_ID_RE.fullmatch(transition_id):
            errors.append(f"{label}.id must be lowercase words joined by '.' or '-'")
            continue
        label = f"transitions[{transition_id}]"
        if transition_id in transitions:
            errors.append(f"{label}: duplicate transition id")
        transitions[transition_id] = item
        for end in ("from", "to"):
            target = item.get(end)
            if target not in states:
                errors.append(f"{label}.{end} {target!r} is not a declared state")
            else:
                touched.add(target)
        if not nonempty_string(item.get("action")):
            errors.append(f"{label}.action must describe what the user or system does")
        actor = item.get("actor")
        if actor not in ACTORS:
            errors.append(f"{label}.actor must be one of {list(ACTORS)}")
        check_literals(item.get("requires"), facts, f"{label}.requires", errors)
        effects = check_literals(item.get("effects"), facts, f"{label}.effects", errors)
        inputs = item.get("inputs")
        if inputs is not None and (not isinstance(inputs, int) or isinstance(inputs, bool) or inputs < 0):
            errors.append(f"{label}.inputs must be a non-negative integer")
        visibility = item.get("visibility")
        if visibility is not None:
            if visibility not in VISIBILITIES:
                errors.append(f"{label}.visibility must be one of {list(VISIBILITIES)}")
            elif actor == "system":
                warnings.append(f"{label}: visibility describes a user action and is ignored for a system step")
        intent = item.get("intent")
        if intent not in INTENTS:
            errors.append(f"{label}.intent must be one of {list(INTENTS)}")
        state = check_evidence(item.get("evidence"), f"{label}.evidence", errors, warnings, required=True)
        if intent == "none" and state == "unknown":
            errors.append(
                f"{label}: a transition with no design intent needs observed or inferred evidence; "
                "otherwise it is invented"
            )
        if item.get("from") == item.get("to") and not effects:
            warnings.append(f"{label}: a self-loop without effects changes nothing")

    journeys: dict[str, dict[str, Any]] = {}
    entries: set[str] = set()
    raw_journeys = data.get("journeys")
    if not isinstance(raw_journeys, list) or not raw_journeys:
        errors.append("journeys must be a non-empty array")
        raw_journeys = []
    for index, item in enumerate(raw_journeys):
        label = f"journeys[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        journey_id = item.get("id")
        if not isinstance(journey_id, str) or not ID_RE.fullmatch(journey_id):
            errors.append(f"{label}.id must be a lowercase hyphen-case identifier")
            continue
        label = f"journeys[{journey_id}]"
        if journey_id in journeys:
            errors.append(f"{label}: duplicate journey id")
        journeys[journey_id] = item
        for field in ("user", "goal", "success_condition"):
            if not nonempty_string(item.get(field)):
                errors.append(f"{label}.{field} must be a non-empty string")
        entry = item.get("entry")
        if entry not in states:
            errors.append(f"{label}.entry {entry!r} is not a declared state")
        else:
            entries.add(entry)
        success = item.get("success")
        if not isinstance(success, list) or not success:
            errors.append(f"{label}.success must list at least one state")
        else:
            for state_id in success:
                if state_id not in states:
                    errors.append(f"{label}.success names undeclared state {state_id!r}")
                elif states[state_id].get("role", "step") == "failure":
                    errors.append(f"{label}.success state {state_id!r} cannot be a failure state")
        exits = item.get("exits", [])
        if not isinstance(exits, list):
            errors.append(f"{label}.exits must be an array of state ids")
        else:
            for state_id in exits:
                if state_id not in states:
                    errors.append(f"{label}.exits names undeclared state {state_id!r}")
                elif isinstance(success, list) and state_id in success:
                    errors.append(f"{label}.exits state {state_id!r} is already a success state")
        if not isinstance(item.get("critical"), bool):
            errors.append(f"{label}.critical must be true or false")
        if item.get("expect", "success") not in EXPECTATIONS:
            errors.append(f"{label}.expect must be one of {list(EXPECTATIONS)}")
        check_literals(item.get("start_facts"), facts, f"{label}.start_facts", errors, allow_negation=False)
        baseline = item.get("baseline_run")
        if baseline is not None and not nonempty_string(baseline):
            errors.append(f"{label}.baseline_run must be a run id or null")
        scenario_ids: set[str] = set()
        scenarios = item.get("scenarios", [])
        if not isinstance(scenarios, list):
            errors.append(f"{label}.scenarios must be an array")
            scenarios = []
        for position, scenario in enumerate(scenarios):
            scenario_label = f"{label}.scenarios[{position}]"
            if not isinstance(scenario, dict):
                errors.append(f"{scenario_label} must be an object")
                continue
            scenario_id = scenario.get("id")
            if not isinstance(scenario_id, str) or not ID_RE.fullmatch(scenario_id):
                errors.append(f"{scenario_label}.id must be a lowercase hyphen-case identifier")
            elif scenario_id == DEFAULT_SCENARIO:
                errors.append(f"{scenario_label}.id {DEFAULT_SCENARIO!r} is reserved for start_facts alone")
            elif scenario_id in scenario_ids:
                errors.append(f"{scenario_label}.id {scenario_id!r} is duplicated")
            else:
                scenario_ids.add(scenario_id)
            if not nonempty_string(scenario.get("description")):
                errors.append(f"{scenario_label}.description must say what differs in this scenario")
            if scenario.get("expect", "success") not in EXPECTATIONS:
                errors.append(f"{scenario_label}.expect must be one of {list(EXPECTATIONS)}")
            if not scenario.get("facts"):
                errors.append(f"{scenario_label}.facts must change at least one fact")
            check_literals(scenario.get("facts"), facts, f"{scenario_label}.facts", errors)

    unknowns = data.get("unknowns")
    if not isinstance(unknowns, list) or any(not nonempty_string(item) for item in unknowns):
        errors.append("unknowns must be an array of non-empty strings; use [] when nothing is open")

    for state_id in states:
        if state_id not in touched and state_id not in entries:
            warnings.append(f"states[{state_id}]: no transition enters or leaves this state")

    # Structural reachability, ignoring guards: a state no journey can ever enter.
    outgoing: dict[str, list[str]] = {}
    for item in transitions.values():
        if item.get("from") in states and item.get("to") in states:
            outgoing.setdefault(item["from"], []).append(item["to"])
    seen = set(entries)
    frontier = list(entries)
    while frontier:
        for target in outgoing.get(frontier.pop(), []):
            if target not in seen:
                seen.add(target)
                frontier.append(target)
    for state_id in states:
        if state_id not in seen and state_id in touched:
            warnings.append(f"states[{state_id}]: not reachable from any journey entry")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "map": data.get("map"),
        "counts": {
            "facts": len(facts),
            "states": len(states),
            "transitions": len(transitions),
            "journeys": len(journeys),
        },
    }


def walk_run(run: dict[str, Any], flow: dict[str, Any]) -> dict[str, Any]:
    """Replay a run against its map.

    Returns continuity errors, the state the run ended in, and every reached
    step whose guard the map says was not satisfied.
    """
    states = {item["id"]: item for item in flow["states"]}
    transitions = {item["id"]: item for item in flow["transitions"]}
    journey = next((item for item in flow["journeys"] if item["id"] == run.get("journey")), None)
    errors: list[str] = []
    if journey is None:
        return {"errors": [f"journey {run.get('journey')!r} is not in the map"], "final_state": None, "guard_mismatches": []}
    scenario_id = run.get("scenario", DEFAULT_SCENARIO)
    scenario = next((item for item in journey_scenarios(journey) if item["id"] == scenario_id), None)
    if scenario is None:
        return {"errors": [f"scenario {scenario_id!r} is not declared for journey {journey['id']!r}"], "final_state": None, "guard_mismatches": []}

    current = journey["entry"]
    facts = set(scenario["facts"])
    mismatches: list[dict[str, Any]] = []
    steps = run.get("steps") if isinstance(run.get("steps"), list) else []
    for index, step in enumerate(steps):
        label = f"steps[{index}]"
        if not isinstance(step, dict):
            errors.append(f"{label} must be an object")
            continue
        result = step.get("result")
        if result not in STEP_RESULTS:
            errors.append(f"{label}.result must be one of {list(STEP_RESULTS)}")
            continue
        if not nonempty_string(step.get("evidence")):
            errors.append(f"{label}.evidence must say what was seen that supports the result")
        landed = step.get("landed")
        if landed is not None and landed not in states:
            errors.append(f"{label}.landed {landed!r} is not a declared state")
            continue

        if result == "unmapped":
            if step.get("transition") is not None:
                errors.append(f"{label}: an unmapped step cannot name a transition")
            if not nonempty_string(step.get("action")):
                errors.append(f"{label}.action must describe the action the map does not contain")
            origin = step.get("from")
            if origin not in states:
                errors.append(f"{label}.from {origin!r} is not a declared state")
            elif origin != current:
                errors.append(f"{label}: starts at {origin!r}, but the run was at {current!r}")
            if landed is None:
                errors.append(f"{label}.landed is required for an unmapped step")
            else:
                current = landed
            continue

        transition = transitions.get(step.get("transition"))
        if transition is None:
            errors.append(f"{label}.transition {step.get('transition')!r} is not in the map")
            continue
        if transition["from"] != current:
            errors.append(
                f"{label}: {transition['id']!r} starts at {transition['from']!r}, but the run was at {current!r}"
            )
        if result == "reached":
            if landed is not None and landed != transition["to"]:
                errors.append(f"{label}: reached means landing on {transition['to']!r}; use diverged for {landed!r}")
            unmet = [
                literal
                for literal in transition.get("requires") or []
                if (parse_literal(literal)[0] in facts) != parse_literal(literal)[1]
            ]
            if unmet:
                mismatches.append({"step": index, "transition": transition["id"], "unmet": unmet})
            for literal in transition.get("effects") or []:
                fact, positive = parse_literal(literal)
                if positive:
                    facts.add(fact)
                else:
                    facts.discard(fact)
            current = transition["to"]
        elif result == "diverged":
            if landed is None:
                errors.append(f"{label}.landed is required when the step diverged")
            elif landed == transition["to"]:
                errors.append(f"{label}: landing on {landed!r} is reached, not diverged")
            else:
                current = landed
        elif landed is not None and landed != current:
            errors.append(f"{label}: a blocked step stays at {current!r}")
    return {"errors": errors, "final_state": current, "guard_mismatches": mismatches, "journey": journey}


def validate_run(run: dict[str, Any], flow: dict[str, Any]) -> dict[str, Any]:
    """Validate one run against a map that already passed validate_map."""
    errors: list[str] = []
    warnings: list[str] = []
    if run.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION!r}")
    if not isinstance(run.get("run"), str) or not DOTTED_ID_RE.fullmatch(run["run"]):
        errors.append("run must be lowercase words joined by '.' or '-'")
    if run.get("map") != flow.get("map"):
        errors.append(f"map must be {flow.get('map')!r}")
    if not isinstance(run.get("recorded_at"), str) or not DATE_RE.fullmatch(run["recorded_at"]):
        errors.append("recorded_at must be an ISO 8601 date or date-time")
    if not nonempty_string(run.get("revision")):
        errors.append("revision must name the product revision inspected, or 'unknown'")
    elif run["revision"] == "unknown":
        warnings.append("revision is unknown, so this run cannot be compared with a later revision")
    if run.get("method") not in RUN_METHODS:
        errors.append(f"method must be one of {list(RUN_METHODS)}")
    if not nonempty_string(run.get("tool")):
        errors.append("tool must name what performed the actions")
    environment = run.get("environment")
    if not isinstance(environment, dict):
        errors.append("environment must be an object")
    else:
        for field in ("target", "viewport"):
            if not nonempty_string(environment.get(field)):
                errors.append(f"environment.{field} must be a non-empty string")
        if environment.get("input") not in RUN_INPUTS:
            errors.append(f"environment.input must be one of {list(RUN_INPUTS)}")
        if "locale" in environment and not nonempty_string(environment["locale"]):
            errors.append("environment.locale must be a non-empty string when present")
    if not isinstance(run.get("steps"), list) or not run["steps"]:
        errors.append("steps must be a non-empty array")
    limitations = run.get("limitations")
    if not isinstance(limitations, list) or any(not nonempty_string(item) for item in limitations):
        errors.append("limitations must be an array of non-empty strings; use [] when there are none")

    outcome = run.get("outcome")
    if outcome not in RUN_OUTCOMES:
        errors.append(f"outcome must be one of {list(RUN_OUTCOMES)}")

    walk = walk_run(run, flow)
    errors.extend(walk["errors"])
    journey = walk.get("journey")
    final_state = walk["final_state"]
    steps = run.get("steps") if isinstance(run.get("steps"), list) else []
    if journey is not None and final_state is not None and not walk["errors"]:
        roles = {item["id"]: item.get("role", "step") for item in flow["states"]}
        if outcome == "success":
            if final_state not in journey["success"]:
                errors.append(f"outcome is success, but the run ended at {final_state!r}")
            if not nonempty_string(run.get("success_evidence")):
                errors.append("success_evidence must say how the success condition was confirmed")
        elif final_state in journey["success"]:
            errors.append(f"the run ended at success state {final_state!r}, but outcome is {outcome!r}")
        if outcome == "failure" and roles.get(final_state) != "failure":
            errors.append(f"outcome is failure, but {final_state!r} is not a failure state")
        if outcome == "blocked" and steps and isinstance(steps[-1], dict) and steps[-1].get("result") != "blocked":
            errors.append("outcome is blocked, but the last step was not blocked")
    return {
        "run": run.get("run"),
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "guard_mismatches": walk["guard_mismatches"],
        "final_state": final_state,
    }


def resolve_runs_dir(map_path: Path, runs_dir: Path | None, no_runs: bool) -> Path | None:
    if no_runs:
        return None
    if runs_dir is not None:
        if not runs_dir.is_dir():
            die(f"runs directory not found: {runs_dir}")
        return runs_dir
    default = map_path.parent / "runs"
    return default if default.is_dir() else None


def load_runs(
    flow: dict[str, Any], runs_dir: Path | None = None, files: list[Path] | None = None
) -> list[dict[str, Any]]:
    """Load every `*.run.json` in the directory, plus named files, that belongs to this map."""
    paths = sorted(runs_dir.glob("*.run.json")) if runs_dir is not None else []
    paths += [path for path in files or [] if path not in paths]
    loaded: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for path in paths:
        run = load_object(path)
        if run.get("map") != flow.get("map"):
            if files and path in files:
                die(f"{path} was recorded for map {run.get('map')!r}, not {flow.get('map')!r}")
            continue
        result = validate_run(run, flow)
        run_id = run.get("run")
        if isinstance(run_id, str) and run_id in seen:
            result["errors"].append(f"run id {run_id!r} is also used by {seen[run_id]}")
            result["valid"] = False
        elif isinstance(run_id, str):
            seen[run_id] = path.name
        loaded.append({"path": path, "data": run, "result": result})
    return loaded


def add_run_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--runs-dir",
        type=Path,
        help="Directory of *.run.json files. Defaults to the 'runs' directory next to the map, when present.",
    )
    group.add_argument("--no-runs", action="store_true", help="Ignore the runs directory.")
    parser.add_argument(
        "--run",
        type=Path,
        action="append",
        default=[],
        metavar="FILE",
        help="A run file to load in addition to the runs directory. Repeat for several.",
    )


def check_baselines(flow: dict[str, Any], runs: list[dict[str, Any]], errors: list[str]) -> None:
    by_id = {item["data"].get("run"): item["data"] for item in runs}
    for journey in flow["journeys"]:
        baseline = journey.get("baseline_run")
        if baseline is None:
            continue
        run = by_id.get(baseline)
        if run is None:
            errors.append(f"journeys[{journey['id']}].baseline_run {baseline!r} has no recorded run")
        elif run.get("journey") != journey["id"]:
            errors.append(f"journeys[{journey['id']}].baseline_run {baseline!r} was recorded for another journey")
        elif run.get("outcome") != "success":
            errors.append(
                f"journeys[{journey['id']}].baseline_run {baseline!r} ended in {run.get('outcome')!r}; "
                "a baseline is a run that reached success"
            )


def write_result(result: dict[str, Any], output: Path | None) -> None:
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a flow map (*.flow.json) and the runs recorded against it."
    )
    parser.add_argument("map", type=Path, help="Path to the flow map.")
    add_run_arguments(parser)
    parser.add_argument("--output", type=Path, help="Write the JSON result to this file.")
    args = parser.parse_args()

    flow = load_object(args.map)
    result = validate_map(flow)
    result["runs"] = []
    if result["valid"]:
        runs_dir = resolve_runs_dir(args.map, args.runs_dir, args.no_runs)
        runs = load_runs(flow, runs_dir, args.run)
        for item in runs:
            entry = dict(item["result"])
            entry["file"] = item["path"].name
            result["runs"].append(entry)
            if not entry["valid"]:
                result["errors"].append(f"{entry['file']}: run is invalid")
        if runs_dir is not None or args.run:
            check_baselines(flow, runs, result["errors"])
        elif any(journey.get("baseline_run") for journey in flow["journeys"]):
            result["warnings"].append("baseline_run was not checked because no runs were loaded")
        result["valid"] = not result["errors"]
    result["checked"] = "declared contract only; the product was not opened"
    write_result(result, args.output)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
