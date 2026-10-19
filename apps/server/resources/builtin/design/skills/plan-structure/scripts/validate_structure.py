#!/usr/bin/env python3
"""Validate a structure-selection decision."""

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

GRAMMARS = {
    "identity-profile",
    "chronological-ledger",
    "writing-index",
    "portfolio-index",
    "product-service",
    "collection-catalog",
    "institution-information",
    "task-workflow",
    "justified-hybrid",
}
NAV_MODES = {"none", "linear", "anchor", "global", "filter", "mixed"}


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


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def string_list(value: Any, minimum: int = 0) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= minimum
        and all(nonempty_string(item) for item in value)
    )


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    for field in ("primary_user", "primary_task", "organizing_key", "growth_test"):
        if not nonempty_string(data.get(field)):
            errors.append(f"{field} must be a non-empty string")

    grammar = data.get("dominant_grammar")
    if grammar not in GRAMMARS:
        errors.append(f"dominant_grammar must be one of {sorted(GRAMMARS)}")

    if not string_list(data.get("content_sequence"), minimum=1):
        errors.append("content_sequence must contain at least one non-empty string")
    if not string_list(data.get("responsive_reflow"), minimum=1):
        errors.append("responsive_reflow must contain at least one non-empty string")
    if not string_list(data.get("unknowns"), minimum=0):
        errors.append("unknowns must be an array of strings")

    navigation = data.get("navigation")
    if not isinstance(navigation, dict):
        errors.append("navigation must be an object")
    else:
        if navigation.get("mode") not in NAV_MODES:
            errors.append(f"navigation.mode must be one of {sorted(NAV_MODES)}")
        if not string_list(navigation.get("items"), minimum=0):
            errors.append("navigation.items must be an array of strings")
        if navigation.get("mode") == "none" and navigation.get("items"):
            warnings.append("navigation.mode is none but items were supplied")

    rejected = data.get("rejected_patterns")
    if not isinstance(rejected, list) or len(rejected) < 2:
        errors.append("rejected_patterns must contain at least two entries")
    else:
        for index, item in enumerate(rejected):
            if not isinstance(item, dict):
                errors.append(f"rejected_patterns[{index}] must be an object")
                continue
            if not nonempty_string(item.get("pattern")):
                errors.append(f"rejected_patterns[{index}].pattern is required")
            if not nonempty_string(item.get("reason")):
                errors.append(f"rejected_patterns[{index}].reason is required")

    justification = data.get("hybrid_justification")
    if grammar == "justified-hybrid" and not nonempty_string(justification):
        errors.append("justified-hybrid requires a non-empty hybrid_justification")
    if grammar != "justified-hybrid" and nonempty_string(justification):
        warnings.append("hybrid_justification is present for a non-hybrid grammar")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "dominant_grammar": grammar,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a structure decision JSON file.")
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
