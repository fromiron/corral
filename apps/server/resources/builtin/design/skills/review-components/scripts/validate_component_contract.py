#!/usr/bin/env python3
"""Validate a reusable UI component contract report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

EVIDENCE_STATES = {"observed", "measured", "inferred", "unknown"}
CHECK_STATUSES = {"pass", "fail", "unknown", "not-applicable"}
PARITY_STATUSES = {"aligned", "drift", "unknown", "not-inspected"}
REQUIREMENTS = {"required", "optional", "conditional"}


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


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def string_list(value: Any) -> bool:
    return isinstance(value, list) and all(nonempty_string(item) for item in value)


def require_object(
    data: dict[str, Any],
    field: str,
    required_strings: tuple[str, ...],
    errors: list[str],
) -> dict[str, Any]:
    value = data.get(field)
    if not isinstance(value, dict):
        errors.append(f"{field} must be an object")
        return {}
    for key in required_strings:
        if not nonempty_string(value.get(key)):
            errors.append(f"{field}.{key} must be a non-empty string")
    return value


def validate_records(
    data: dict[str, Any],
    field: str,
    required_fields: tuple[str, ...],
    errors: list[str],
    minimum: int = 0,
) -> list[dict[str, Any]]:
    value = data.get(field)
    if not isinstance(value, list) or len(value) < minimum:
        errors.append(f"{field} must be an array with at least {minimum} item(s)")
        return []
    records: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        prefix = f"{field}[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        records.append(item)
        for key in required_fields:
            if key not in item:
                errors.append(f"{prefix}.{key} is required")
    return records


def validate_status_record(
    prefix: str,
    item: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(item.get("required"), bool):
        errors.append(f"{prefix}.required must be boolean")
    if item.get("status") not in CHECK_STATUSES:
        errors.append(f"{prefix}.status must be one of {sorted(CHECK_STATUSES)}")
    if item.get("evidence_state") not in EVIDENCE_STATES:
        errors.append(
            f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
        )


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    blockers: list[str] = []

    for field in ("component", "purpose", "primary_user_task"):
        if not nonempty_string(data.get(field)):
            errors.append(f"{field} must be a non-empty string")

    source = require_object(
        data,
        "source_of_truth",
        ("location", "owner", "change_process"),
        errors,
    )
    if source and source.get("surface") not in {
        "design", "documentation", "code", "live", "split"
    }:
        errors.append("source_of_truth.surface is invalid")

    evidence = validate_records(
        data,
        "evidence",
        ("surface", "location", "evidence_state", "notes"),
        errors,
    )
    for index, item in enumerate(evidence):
        prefix = f"evidence[{index}]"
        if not nonempty_string(item.get("location")):
            errors.append(f"{prefix}.location must be a non-empty string")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )

    anatomy = validate_records(
        data,
        "anatomy",
        ("name", "requirement", "role", "evidence_state"),
        errors,
        minimum=1,
    )
    required_parts = 0
    anatomy_names: set[str] = set()
    for index, item in enumerate(anatomy):
        prefix = f"anatomy[{index}]"
        name = item.get("name")
        if not nonempty_string(name):
            errors.append(f"{prefix}.name must be a non-empty string")
        elif name in anatomy_names:
            errors.append(f"{prefix}.name duplicates {name!r}")
        else:
            anatomy_names.add(name)
        if item.get("requirement") not in REQUIREMENTS:
            errors.append(f"{prefix}.requirement must be one of {sorted(REQUIREMENTS)}")
        elif item.get("requirement") == "required":
            required_parts += 1
        if not nonempty_string(item.get("role")):
            errors.append(f"{prefix}.role must be a non-empty string")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )
    if anatomy and required_parts == 0:
        warnings.append("anatomy has no part declared as required")

    variants = validate_records(
        data,
        "variants",
        ("name", "purpose", "required", "status", "evidence_state"),
        errors,
    )
    for index, item in enumerate(variants):
        prefix = f"variants[{index}]"
        if not nonempty_string(item.get("name")):
            errors.append(f"{prefix}.name must be a non-empty string")
        if not nonempty_string(item.get("purpose")):
            errors.append(f"{prefix}.purpose must be a non-empty string")
        validate_status_record(prefix, item, errors)
        if (
            item.get("required") is True
            and item.get("status") in {"fail", "unknown"}
        ):
            blockers.append(f"variant:{item.get('name')}:{item.get('status')}")

    states = validate_records(
        data,
        "states",
        (
            "name",
            "applicable",
            "status",
            "visual",
            "behavior",
            "accessibility",
            "evidence_state",
        ),
        errors,
        minimum=1,
    )
    state_names: set[str] = set()
    for index, item in enumerate(states):
        prefix = f"states[{index}]"
        name = item.get("name")
        if not nonempty_string(name):
            errors.append(f"{prefix}.name must be a non-empty string")
        elif name in state_names:
            errors.append(f"{prefix}.name duplicates {name!r}")
        else:
            state_names.add(name)
        if not isinstance(item.get("applicable"), bool):
            errors.append(f"{prefix}.applicable must be boolean")
        if item.get("status") not in CHECK_STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(CHECK_STATUSES)}")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )
        if item.get("applicable") is True:
            if item.get("status") == "not-applicable":
                errors.append(f"{prefix} is applicable but status is not-applicable")
            elif item.get("status") in {"fail", "unknown"}:
                blockers.append(f"state:{name}:{item.get('status')}")
        elif item.get("applicable") is False and item.get("status") != "not-applicable":
            errors.append(f"{prefix} is not applicable but status is not not-applicable")

    for field, required_fields in (
        (
            "responsive_behavior",
            (
                "condition",
                "change",
                "preserved_information",
                "required",
                "status",
                "evidence_state",
            ),
        ),
        (
            "content_rules",
            ("rule", "reason", "required", "status", "evidence_state"),
        ),
        (
            "accessibility",
            ("check", "required", "status", "evidence_state", "evidence"),
        ),
    ):
        minimum = 1 if field == "accessibility" else 0
        records = validate_records(data, field, required_fields, errors, minimum=minimum)
        for index, item in enumerate(records):
            prefix = f"{field}[{index}]"
            validate_status_record(prefix, item, errors)
            label = (
                item.get("check")
                or item.get("condition")
                or item.get("rule")
                or str(index)
            )
            if item.get("required") is True and item.get("status") in {"fail", "unknown"}:
                blockers.append(f"{field}:{label}:{item.get('status')}")

    mappings = validate_records(
        data,
        "token_mappings",
        ("role", "token", "surface", "evidence_state"),
        errors,
    )
    for index, item in enumerate(mappings):
        prefix = f"token_mappings[{index}]"
        for key in ("role", "token"):
            if not nonempty_string(item.get(key)):
                errors.append(f"{prefix}.{key} must be a non-empty string")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )

    parity = validate_records(
        data,
        "parity",
        ("surface", "required", "status", "evidence"),
        errors,
        minimum=1,
    )
    parity_surfaces: set[str] = set()
    for index, item in enumerate(parity):
        prefix = f"parity[{index}]"
        surface = item.get("surface")
        if surface not in {"design", "documentation", "code", "live"}:
            errors.append(f"{prefix}.surface is invalid")
        elif surface in parity_surfaces:
            errors.append(f"{prefix}.surface duplicates {surface!r}")
        else:
            parity_surfaces.add(surface)
        if not isinstance(item.get("required"), bool):
            errors.append(f"{prefix}.required must be boolean")
        if item.get("status") not in PARITY_STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(PARITY_STATUSES)}")
        if item.get("required") is True and item.get("status") in {
            "drift", "unknown", "not-inspected"
        }:
            blockers.append(f"parity:{surface}:{item.get('status')}")

    exceptions = validate_records(
        data,
        "exceptions",
        (
            "decision",
            "reason",
            "identity_or_task_value",
            "owner",
            "review_trigger",
            "status",
            "evidence_state",
        ),
        errors,
    )
    for index, item in enumerate(exceptions):
        prefix = f"exceptions[{index}]"
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )

    findings = validate_records(
        data,
        "findings",
        (
            "severity",
            "location",
            "problem",
            "impact",
            "smallest_change",
            "verification",
            "owner",
            "evidence_state",
            "confidence",
        ),
        errors,
    )
    for index, item in enumerate(findings):
        prefix = f"findings[{index}]"
        if item.get("severity") not in {"high", "medium", "low"}:
            errors.append(f"{prefix}.severity must be high, medium, or low")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )
        if item.get("confidence") not in {"high", "medium", "low"}:
            errors.append(f"{prefix}.confidence must be high, medium, or low")

    for field in ("accepted_risks", "unknowns"):
        if not string_list(data.get(field)):
            errors.append(f"{field} must be an array of non-empty strings")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "mechanical_release_ready": not errors and not blockers,
        "blockers": blockers,
        "accepted_risks": data.get("accepted_risks", []),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a leeskills component contract audit JSON file."
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
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
