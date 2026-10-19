#!/usr/bin/env python3
"""Validate a grounded content inventory without external dependencies."""

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

STATUSES = {"verified", "inferred", "placeholder", "prohibited"}
CONFIDENCE = {"high", "medium", "low"}


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(data, dict):
        die("top-level value must be an object")
    return data


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    context = data.get("context")
    if not isinstance(context, dict):
        errors.append("context must be an object")
    else:
        for field in ("artifact_type", "primary_user", "primary_task", "success_condition"):
            value = context.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"context.{field} must be a non-empty string")

    facts = data.get("facts")
    if not isinstance(facts, list):
        errors.append("facts must be an array")
        facts = []

    ids: set[str] = set()
    counts = {status: 0 for status in sorted(STATUSES)}
    for index, fact in enumerate(facts):
        prefix = f"facts[{index}]"
        if not isinstance(fact, dict):
            errors.append(f"{prefix} must be an object")
            continue

        fact_id = fact.get("id")
        if not isinstance(fact_id, str) or not fact_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif fact_id in ids:
            errors.append(f"duplicate fact id: {fact_id}")
        else:
            ids.add(fact_id)

        claim = fact.get("claim")
        if not isinstance(claim, str) or not claim.strip():
            errors.append(f"{prefix}.claim must be a non-empty string")

        status = fact.get("status")
        if status not in STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(STATUSES)}")
            continue
        counts[status] += 1

        sources = fact.get("sources")
        if not isinstance(sources, list) or any(not isinstance(x, str) for x in sources):
            errors.append(f"{prefix}.sources must be an array of strings")
            sources = []

        rationale = fact.get("rationale")
        if status == "verified" and not any(source.strip() for source in sources):
            errors.append(f"{prefix}: verified claims require at least one source")
        if status == "inferred":
            if not any(source.strip() for source in sources):
                errors.append(f"{prefix}: inferred claims require supporting sources")
            if not isinstance(rationale, str) or not rationale.strip():
                errors.append(f"{prefix}: inferred claims require a rationale")
        if status in {"placeholder", "prohibited"} and not rationale:
            warnings.append(f"{prefix}: add a rationale for the {status} status")

        confidence = fact.get("confidence")
        if confidence not in CONFIDENCE:
            errors.append(f"{prefix}.confidence must be one of {sorted(CONFIDENCE)}")

    content_groups = data.get("content_groups")
    if not isinstance(content_groups, dict):
        errors.append("content_groups must be an object")
    else:
        for group, fact_ids in content_groups.items():
            if not isinstance(group, str) or not group.strip():
                errors.append("content_groups keys must be non-empty strings")
                continue
            if not isinstance(fact_ids, list) or any(
                not isinstance(item, str) or not item.strip() for item in fact_ids
            ):
                errors.append(f"content_groups.{group} must be an array of fact IDs")
                continue
            unknown_ids = sorted(set(fact_ids) - ids)
            if unknown_ids:
                errors.append(
                    f"content_groups.{group} references unknown fact IDs: {', '.join(unknown_ids)}"
                )

    for field in (
        "contradictions",
        "missing",
        "prohibited_generation",
        "questions",
    ):
        value = data.get(field)
        if not isinstance(value, list) or any(
            not isinstance(x, str) or not x.strip() for x in value
        ):
            errors.append(f"{field} must be an array of non-empty strings")

    fact_status_by_id = {
        fact.get("id"): fact.get("status")
        for fact in facts
        if isinstance(fact, dict) and isinstance(fact.get("id"), str)
    }
    for field, allowed_statuses in (
        ("safe_claims", {"verified", "inferred"}),
        ("allowed_placeholders", {"placeholder"}),
    ):
        value = data.get(field)
        if not isinstance(value, list) or any(
            not isinstance(x, str) or not x.strip() for x in value
        ):
            errors.append(f"{field} must be an array of fact IDs")
            continue
        for fact_id in value:
            status = fact_status_by_id.get(fact_id)
            if status not in allowed_statuses:
                errors.append(
                    f"{field} contains {fact_id!r} with status {status!r}; "
                    f"expected one of {sorted(allowed_statuses)}"
                )

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "fact_count": len(facts),
        "status_counts": counts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a grounded content inventory.")
    parser.add_argument("input", type=Path, help="Path to inventory JSON")
    parser.add_argument("--output", type=Path, help="Optional JSON result path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = validate(read_json(args.input))
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
