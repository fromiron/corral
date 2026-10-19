#!/usr/bin/env python3
"""Validate accessibility report completeness and release gates."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

STATUSES = {"pass", "fail", "unknown", "not-applicable"}
LEVELS = {"A", "AA", "AAA", "project"}


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(data, dict):
        die("top-level JSON value must be an object")
    return data


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[str] = []
    warnings: list[str] = []

    if not nonempty(data.get("artifact")):
        errors.append("artifact must be a non-empty string")

    target = data.get("target")
    if not isinstance(target, dict):
        errors.append("target must be an object")
    else:
        if not nonempty(target.get("standard")):
            errors.append("target.standard must be a non-empty string")
        if target.get("level") not in LEVELS:
            errors.append(f"target.level must be one of {sorted(LEVELS)}")

    evidence = data.get("evidence")
    if not isinstance(evidence, list) or any(not nonempty(x) for x in evidence):
        errors.append("evidence must be an array of non-empty strings")

    risks = data.get("accepted_risks")
    if not isinstance(risks, list) or any(not nonempty(x) for x in risks):
        errors.append("accepted_risks must be an array of non-empty strings")
        risks = []

    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty array")
        checks = []

    ids: set[str] = set()
    counts = {status: 0 for status in sorted(STATUSES)}

    for index, item in enumerate(checks):
        prefix = f"checks[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue

        check_id = item.get("id")
        if not nonempty(check_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif check_id in ids:
            errors.append(f"duplicate check id: {check_id}")
        else:
            ids.add(check_id)

        for field in ("criterion", "evidence", "impact", "fix", "verification"):
            if not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")

        level = item.get("level")
        if level not in LEVELS:
            errors.append(f"{prefix}.level must be one of {sorted(LEVELS)}")

        required = item.get("required")
        if not isinstance(required, bool):
            errors.append(f"{prefix}.required must be boolean")
            required = False

        status = item.get("status")
        if status not in STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(STATUSES)}")
            continue
        counts[status] += 1

        if status == "fail":
            risk_tag = f"{check_id}:{status}"
            suffix = " (accepted risk recorded; owner decision still required)" if risk_tag in risks else ""
            blockers.append(f"{prefix}: failed check blocks mechanical release readiness{suffix}")
        elif required and status == "unknown":
            risk_tag = f"{check_id}:{status}"
            suffix = " (accepted risk recorded; owner decision still required)" if risk_tag in risks else ""
            blockers.append(f"{prefix}: required check is unknown{suffix}")
        if status == "not-applicable" and item.get("evidence", "").strip().lower() in {
            "n/a",
            "not applicable",
        }:
            warnings.append(f"{prefix}: explain why the check is not applicable")

    valid = not errors
    release_ready = valid and not blockers
    return {
        "valid_report": valid,
        "release_ready": release_ready,
        "errors": errors,
        "blockers": blockers,
        "warnings": warnings,
        "status_counts": counts,
        "accepted_risks": risks,
        "note": "This validates the report contract, not the accessibility of the artifact.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate an accessibility report and required-check gates."
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
    return 0 if result["release_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
