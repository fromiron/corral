#!/usr/bin/env python3
"""Validate the optional interaction-governance contract extension."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

EVIDENCE = {"observed", "measured", "inferred", "unknown"}
STATUS = {"pass", "fail", "unknown", "not-applicable"}
EXPECTATION = {
    "same-look-same-behavior",
    "different-behavior-distinguishable",
    "justified-exception",
}
IMPORTANCE = {"primary", "secondary", "destructive", "recovery", "utility"}
FREQUENCY = {"frequent", "occasional", "rare", "unknown"}
VISIBILITY = {"persistent", "contextual", "disclosed", "unavailable"}
CUES = {"proximity", "alignment", "similarity", "container"}
GOVERNANCE = {
    "central", "federated", "distributed", "solo", "hybrid", "unknown",
    "not-applicable",
}
SURFACES = {"design", "documentation", "code", "live", "split"}
TOP = {
    "artifact", "decision_context", "evidence", "affordance_mappings",
    "action_groups", "action_visibility", "grouping_decisions",
    "system_lifecycle", "findings", "accepted_risks", "unknowns",
}


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(value, dict):
        die("top-level JSON value must be an object")
    return value


def present(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[str] = []

    def error(message: str) -> None:
        errors.append(message)

    def records(name: str) -> list[dict[str, Any]]:
        value = data.get(name)
        if not isinstance(value, list):
            error(f"{name} must be an array")
            return []
        result = []
        for index, item in enumerate(value):
            if isinstance(item, dict):
                result.append(item)
            else:
                error(f"{name}[{index}] must be an object")
        return result

    def text(item: dict[str, Any], prefix: str, *names: str, empty: bool = False) -> None:
        for name in names:
            value = item.get(name)
            if not isinstance(value, str) or (not empty and not value.strip()):
                qualifier = "a string" if empty else "a non-empty string"
                error(f"{prefix}.{name} must be {qualifier}")

    def choice(item: dict[str, Any], prefix: str, name: str, values: set[str]) -> None:
        if item.get(name) not in values:
            error(f"{prefix}.{name} must be one of {sorted(values)}")

    def strings(
        value: Any,
        prefix: str,
        *,
        allow_empty: bool = True,
        values: set[str] | None = None,
    ) -> list[str]:
        if not isinstance(value, list) or (not allow_empty and not value):
            error(f"{prefix} must be an array of non-empty strings")
            return []
        if not all(present(item) for item in value):
            error(f"{prefix} must contain only non-empty strings")
            return []
        if len(value) != len(set(value)):
            error(f"{prefix} must not contain duplicates")
        if values is not None and set(value) - values:
            error(f"{prefix} contains unsupported values: {sorted(set(value) - values)}")
        return value

    def gate(item: dict[str, Any], prefix: str, label: str) -> None:
        if not isinstance(item.get("required"), bool):
            error(f"{prefix}.required must be boolean")
        choice(item, prefix, "status", STATUS)
        choice(item, prefix, "evidence_state", EVIDENCE)
        text(item, prefix, "evidence", empty=True)
        if item.get("required") is True and item.get("status") in {"fail", "unknown"}:
            blockers.append(f"{label}:{item['status']}")

    for name in sorted(TOP - data.keys()):
        error(f"{name} is required")
    extra = sorted(data.keys() - TOP)
    if extra:
        error(f"unsupported top-level fields: {extra}")
    for name in ("artifact", "decision_context"):
        if not present(data.get(name)):
            error(f"{name} must be a non-empty string")

    evidence = records("evidence")
    for index, item in enumerate(evidence):
        prefix = f"evidence[{index}]"
        text(item, prefix, "location")
        text(item, prefix, "notes", empty=True)
        choice(item, prefix, "evidence_state", EVIDENCE)

    affordances = records("affordance_mappings")
    seen: set[str] = set()
    for index, item in enumerate(affordances):
        prefix = f"affordance_mappings[{index}]"
        text(
            item, prefix, "id", "location", "visual_treatment", "perceived_role",
            "actual_behavior",
        )
        identifier = item.get("id")
        if present(identifier):
            if identifier in seen:
                error(f"{prefix}.id duplicates {identifier!r}")
            seen.add(identifier)
        choice(item, prefix, "expectation", EXPECTATION)
        gate(item, prefix, f"affordance:{identifier or index}")

    action_groups = records("action_groups")
    seen.clear()
    for index, item in enumerate(action_groups):
        prefix = f"action_groups[{index}]"
        text(item, prefix, "id", "location", "user_decision", "reading_and_focus_order")
        text(item, prefix, "priority_exception_reason", empty=True)
        identifier = item.get("id")
        if present(identifier):
            if identifier in seen:
                error(f"{prefix}.id duplicates {identifier!r}")
            seen.add(identifier)
        groups = {
            name: strings(item.get(name), f"{prefix}.{name}")
            for name in ("primary_actions", "secondary_actions", "destructive_actions")
        }
        all_actions = [action for group in groups.values() for action in group]
        if len(all_actions) != len(set(all_actions)):
            error(f"{prefix} assigns the same action to multiple priority groups")
        if item.get("status") == "pass" and len(groups["primary_actions"]) != 1:
            if not present(item.get("priority_exception_reason")):
                error(
                    f"{prefix}.priority_exception_reason is required when a passing "
                    "context has zero or multiple primary actions"
                )
        gate(item, prefix, f"action-group:{identifier or index}")

    visibility = records("action_visibility")
    for index, item in enumerate(visibility):
        prefix = f"action_visibility[{index}]"
        text(item, prefix, "action", "location")
        text(
            item, prefix, "disclosure_reason", "available_space_evidence",
            "alternative_path", empty=True,
        )
        choice(item, prefix, "importance", IMPORTANCE)
        choice(item, prefix, "frequency", FREQUENCY)
        choice(item, prefix, "visibility", VISIBILITY)
        steps = item.get("disclosure_steps")
        if not isinstance(steps, int) or isinstance(steps, bool) or steps < 0:
            error(f"{prefix}.disclosure_steps must be a non-negative integer")
        if item.get("visibility") == "persistent" and steps != 0:
            error(f"{prefix}.disclosure_steps must be 0 for a persistent action")
        if item.get("visibility") == "disclosed" and steps == 0:
            error(f"{prefix}.disclosure_steps must be greater than 0 for a disclosed action")
        important = (
            item.get("importance") in {"primary", "recovery"}
            or item.get("frequency") == "frequent"
        )
        hidden = item.get("visibility") in {"disclosed", "unavailable"}
        if item.get("status") == "pass" and important and hidden:
            if not present(item.get("disclosure_reason")):
                error(f"{prefix} passes an important action without a disclosure_reason")
            if not (
                present(item.get("available_space_evidence"))
                or present(item.get("alternative_path"))
            ):
                error(
                    f"{prefix} passes an important action without space evidence or "
                    "an alternative path"
                )
        gate(item, prefix, f"visibility:{item.get('action') or index}")

    grouping = records("grouping_decisions")
    for index, item in enumerate(grouping):
        prefix = f"grouping_decisions[{index}]"
        text(item, prefix, "location", "relationship")
        text(item, prefix, "container_justification", empty=True)
        strings(item.get("current_cues"), f"{prefix}.current_cues", values=CUES)
        recommended = strings(
            item.get("recommended_cues"), f"{prefix}.recommended_cues",
            allow_empty=False, values=CUES,
        )
        if "container" in recommended and not present(item.get("container_justification")):
            error(f"{prefix}.container_justification is required when retaining a container")
        gate(item, prefix, f"grouping:{item.get('location') or index}")

    lifecycle = data.get("system_lifecycle")
    if not isinstance(lifecycle, dict):
        error("system_lifecycle must be an object")
        lifecycle = {}
    if not isinstance(lifecycle.get("applicable"), bool):
        error("system_lifecycle.applicable must be boolean")
    choice(lifecycle, "system_lifecycle", "governance_model", GOVERNANCE)
    for name in (
        "system_scope", "contribution_process", "decision_process",
        "versioning_and_changelog", "roadmap", "adoption_strategy",
        "legacy_mapping", "coexistence_rules", "deprecation_gate",
    ):
        text(lifecycle, "system_lifecycle", name, empty=True)
    strings(lifecycle.get("owners"), "system_lifecycle.owners")
    surfaces = lifecycle.get("authoritative_surfaces")
    if not isinstance(surfaces, list):
        error("system_lifecycle.authoritative_surfaces must be an array")
        surfaces = []
    dimensions: set[str] = set()
    for index, item in enumerate(surfaces):
        prefix = f"system_lifecycle.authoritative_surfaces[{index}]"
        if not isinstance(item, dict):
            error(f"{prefix} must be an object")
            continue
        text(item, prefix, "dimension", "location", "owner")
        choice(item, prefix, "surface", SURFACES)
        dimension = item.get("dimension")
        if present(dimension):
            if dimension in dimensions:
                error(f"{prefix}.dimension duplicates {dimension!r}")
            dimensions.add(dimension)
    if lifecycle.get("applicable") is False:
        if lifecycle.get("governance_model") != "not-applicable":
            error("system_lifecycle.governance_model must be not-applicable when applicable is false")
        if lifecycle.get("status") != "not-applicable":
            error("system_lifecycle.status must be not-applicable when applicable is false")
    elif lifecycle.get("applicable") is True:
        if lifecycle.get("governance_model") == "not-applicable":
            error("system_lifecycle.governance_model cannot be not-applicable when applicable is true")
        if lifecycle.get("status") == "not-applicable":
            error("system_lifecycle.status cannot be not-applicable when applicable is true")
        if lifecycle.get("status") == "pass":
            required = (
                "system_scope", "contribution_process", "decision_process",
                "versioning_and_changelog", "adoption_strategy", "legacy_mapping",
                "coexistence_rules", "deprecation_gate",
            )
            for name in required:
                if not present(lifecycle.get(name)):
                    error(f"system_lifecycle.{name} must be non-empty when status is pass")
            if not surfaces:
                error(
                    "system_lifecycle.authoritative_surfaces cannot be empty when "
                    "status is pass"
                )
            strings(lifecycle.get("owners"), "system_lifecycle.owners", allow_empty=False)
    gate(lifecycle, "system_lifecycle", "system-lifecycle")

    findings = records("findings")
    for index, item in enumerate(findings):
        prefix = f"findings[{index}]"
        text(
            item, prefix, "location", "problem", "impact", "smallest_change",
            "verification", "owner",
        )
        choice(item, prefix, "severity", {"high", "medium", "low"})
        choice(item, prefix, "evidence_state", EVIDENCE)
        choice(item, prefix, "confidence", {"high", "medium", "low"})

    for name in ("accepted_risks", "unknowns"):
        strings(data.get(name), name)
    if not any((affordances, action_groups, visibility, grouping)) and not lifecycle.get("applicable"):
        error(
            "the extension must inspect at least one interaction dimension or an "
            "applicable system lifecycle"
        )

    valid = not errors
    return {
        "valid_report": valid,
        "mechanical_release_ready": valid and not blockers,
        "errors": errors,
        "warnings": [],
        "blockers": blockers,
        "counts": {
            "affordance_mappings": len(affordances),
            "action_groups": len(action_groups),
            "action_visibility": len(visibility),
            "grouping_decisions": len(grouping),
            "findings": len(findings),
        },
        "accepted_risks": data.get("accepted_risks", []),
        "note": (
            "This validates the declared interaction-governance contract. It does not "
            "operate the interface, measure discoverability, or prove usability."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a leeskills affordance, action, grouping, and design-system "
            "governance extension JSON file."
        )
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = validate(load(args.input))
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 2 if not result["valid_report"] else (0 if result["mechanical_release_ready"] else 1)


if __name__ == "__main__":
    raise SystemExit(main())
