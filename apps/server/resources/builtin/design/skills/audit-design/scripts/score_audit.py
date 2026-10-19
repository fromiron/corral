#!/usr/bin/env python3
"""Validate and score an anti-slop audit JSON file."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

EXPECTED_MAX = {
    "content_grounding": 20,
    "task_structure": 15,
    "visual_entropy": 15,
    "typography_spacing_alignment": 15,
    "component_necessity": 10,
    "image_relevance_authenticity": 10,
    "accessibility": 10,
    "motion_interaction": 5,
}
EVIDENCE_STATES = {"observed", "measured", "inferred", "unknown"}
DIRECT_EVIDENCE_STATES = {"observed", "measured"}
UNKNOWN_SCORE_CAP_RATIO = 0.5


def fail(message: str) -> "NoReturn":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(value, dict):
        fail("top-level JSON value must be an object")
    return value


def score(data: dict[str, Any]) -> dict[str, Any]:
    categories = data.get("categories")
    if not isinstance(categories, dict):
        fail("'categories' must be an object")

    missing = sorted(set(EXPECTED_MAX) - set(categories))
    extra = sorted(set(categories) - set(EXPECTED_MAX))
    if missing:
        fail(f"missing categories: {', '.join(missing)}")
    if extra:
        fail(f"unknown categories: {', '.join(extra)}")

    quality = 0.0
    normalized: dict[str, Any] = {}
    for name, expected_max in EXPECTED_MAX.items():
        item = categories[name]
        if not isinstance(item, dict):
            fail(f"category '{name}' must be an object")
        raw_score = item.get("score")
        raw_max = item.get("max")
        state = item.get("evidence_state")
        evidence = item.get("evidence")

        if not isinstance(raw_score, (int, float)) or isinstance(raw_score, bool):
            fail(f"category '{name}'.score must be a number")
        if raw_max != expected_max:
            fail(f"category '{name}'.max must be {expected_max}")
        if raw_score < 0 or raw_score > expected_max:
            fail(f"category '{name}'.score must be between 0 and {expected_max}")
        if state not in EVIDENCE_STATES:
            fail(f"category '{name}'.evidence_state must be one of {sorted(EVIDENCE_STATES)}")
        if not isinstance(evidence, str) or not evidence.strip():
            fail(f"category '{name}'.evidence must be a non-empty string")
        if state == "unknown":
            unknown_cap = expected_max * UNKNOWN_SCORE_CAP_RATIO
            if raw_score > unknown_cap:
                fail(
                    f"category '{name}'.score cannot exceed {unknown_cap:g} "
                    "when evidence_state is unknown"
                )

        quality += float(raw_score)
        normalized[name] = {
            "score": raw_score,
            "max": expected_max,
            "evidence_state": state,
            "evidence": evidence.strip(),
        }

    hard_failures = data.get("hard_failures")
    if not isinstance(hard_failures, list):
        fail("'hard_failures' must be an array")

    for index, item in enumerate(hard_failures):
        if not isinstance(item, dict):
            fail(f"hard_failures[{index}] must be an object")
        if not isinstance(item.get("id"), str) or not item["id"].strip():
            fail(f"hard_failures[{index}].id must be a non-empty string")
        state = item.get("evidence_state")
        if state not in DIRECT_EVIDENCE_STATES:
            fail(
                f"hard_failures[{index}].evidence_state must be one of "
                f"{sorted(DIRECT_EVIDENCE_STATES)}; inferred or unknown items belong in findings"
            )
        if not isinstance(item.get("evidence"), str) or not item["evidence"].strip():
            fail(f"hard_failures[{index}].evidence must be a non-empty string")

    quality_rounded = round(quality, 2)
    risk = round(100.0 - quality, 2)

    if hard_failures:
        verdict = "blocked"
    elif quality >= 85:
        verdict = "pass"
    elif quality >= 70:
        verdict = "revise"
    elif quality >= 50:
        verdict = "redesign"
    else:
        verdict = "high-slop-risk"

    return {
        "quality_score": quality_rounded,
        "slop_risk_score": risk,
        "verdict": verdict,
        "hard_failure_count": len(hard_failures),
        "unknown_score_cap_ratio": UNKNOWN_SCORE_CAP_RATIO,
        "categories": normalized,
        "note": (
            "This score prioritizes remediation. It is not a scientific "
            "measurement or an AI-authorship detector."
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and score an anti-slop audit JSON file."
    )
    parser.add_argument("input", type=Path, help="Path to audit JSON")
    parser.add_argument(
        "--output",
        type=Path,
        help="Write result JSON to this path instead of stdout",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = score(load_json(args.input))
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
