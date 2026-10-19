#!/usr/bin/env python3
"""Validate a motion inventory and enforce project safety gates."""

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

DECISIONS = {"keep", "reduce", "replace", "remove"}
SCROLL_HIJACK_TERMS = {
    "scroll-jacking",
    "scroll jacking",
    "scroll-hijacking",
    "scroll hijacking",
    "forced slide scroll",
}


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
    warnings: list[str] = []
    hard_failures: list[str] = []

    if not nonempty(data.get("artifact")):
        errors.append("artifact must be a non-empty string")

    patterns = data.get("patterns")
    if not isinstance(patterns, list):
        errors.append("patterns must be an array")
        patterns = []

    ids: set[str] = set()
    counts = {decision: 0 for decision in sorted(DECISIONS)}

    for index, item in enumerate(patterns):
        prefix = f"patterns[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue

        pattern_id = item.get("id")
        if not nonempty(pattern_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif pattern_id in ids:
            errors.append(f"duplicate pattern id: {pattern_id}")
        else:
            ids.add(pattern_id)

        for field in ("trigger", "purpose"):
            if not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")

        essential = item.get("essential")
        information = item.get("information_conveyed")
        static_equivalent = item.get("static_equivalent")
        for field, value in (
            ("essential", essential),
            ("information_conveyed", information),
            ("static_equivalent", static_equivalent),
        ):
            if not isinstance(value, bool):
                errors.append(f"{prefix}.{field} must be boolean")

        decision = item.get("decision")
        if decision not in DECISIONS:
            errors.append(f"{prefix}.decision must be one of {sorted(DECISIONS)}")
        else:
            counts[decision] += 1

        reduced = item.get("reduced_motion_behavior")
        if not isinstance(reduced, str):
            errors.append(f"{prefix}.reduced_motion_behavior must be a string")
            reduced = ""

        purpose = str(item.get("purpose", "")).casefold()
        trigger = str(item.get("trigger", "")).casefold()
        combined = f"{trigger} {purpose}"

        if essential is True and any(word in purpose for word in ("decorative", "premium", "alive")):
            warnings.append(f"{prefix}: essential is inconsistent with a decorative purpose")

        if information is True and static_equivalent is False:
            hard_failures.append(
                f"{prefix}: information is conveyed only through motion"
            )

        if decision in {"keep", "reduce"} and essential is False and not reduced.strip():
            hard_failures.append(
                f"{prefix}: retained nonessential motion has no reduced-motion behavior"
            )

        if any(term in combined for term in SCROLL_HIJACK_TERMS) and decision not in {
            "remove",
            "replace",
        }:
            hard_failures.append(
                f"{prefix}: scroll hijacking is retained without replacement"
            )

        if decision == "remove" and information is True and static_equivalent is False:
            hard_failures.append(
                f"{prefix}: removal would also remove information"
            )

    unknowns = data.get("unknowns", [])
    if not isinstance(unknowns, list) or any(not isinstance(x, str) for x in unknowns):
        errors.append("unknowns must be an array of strings")

    valid = not errors and not hard_failures
    return {
        "valid": valid,
        "errors": errors,
        "warnings": warnings,
        "hard_failures": hard_failures,
        "pattern_count": len(patterns),
        "decision_counts": counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a motion inventory.")
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
