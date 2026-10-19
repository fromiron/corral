#!/usr/bin/env python3
"""Check a visual-entropy budget JSON document."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, NoReturn, Optional

# Keep UTF-8 output stable on Windows consoles with legacy code pages.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

DEFAULT_LIMITS = {
    "layout_grammars": 1,
    "typeface_families": 1,
    "type_roles": 6,
    "accent_colors": 1,
    "radius_tokens": 2,
    "shadow_levels": 1,
    "surface_styles": 3,
    "primary_cta_styles": 1,
    "secondary_cta_styles": 1,
    "motion_patterns": 2,
    "decorative_image_families": 0,
}
RADIUS_SCOPES = {"none", "evaluated", "unknown"}
RADIUS_KINDS = {"shared-contour", "independent", "pill-or-circle"}
RADIUS_RULES = {"semantic-step", "concentric-offset"}
EVIDENCE_STATES = {"observed", "measured", "inferred", "unknown"}
DIRECT_EVIDENCE = {"observed", "measured"}


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


def as_count_map(value: Any, field: str) -> dict[str, int]:
    if not isinstance(value, dict):
        die(f"{field} must be an object")
    result: dict[str, int] = {}
    for key, count in value.items():
        if not isinstance(key, str):
            die(f"{field} keys must be strings")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            die(f"{field}.{key} must be a non-negative integer")
        result[key] = count
    return result


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def nonnegative_number(value: Any, field: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        die(f"{field} must be a non-negative number")
    return float(value)


def radius_exception(value: Any, field: str) -> Optional[dict[str, str]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        die(f"{field} must be an object")
    reason = value.get("reason")
    evidence = value.get("evidence")
    if not nonempty(reason) or not nonempty(evidence):
        die(f"{field} requires non-empty reason and evidence")
    return {"reason": reason.strip(), "evidence": evidence.strip()}


def check_radius_relationships(data: dict[str, Any]) -> dict[str, Any]:
    declared_scope = data.get("radius_scope")
    if declared_scope is None:
        scope = "unknown"
        scope_evidence = "Nested-radius scope was not declared."
    else:
        if not isinstance(declared_scope, str) or declared_scope not in RADIUS_SCOPES:
            die(f"radius_scope must be one of {sorted(RADIUS_SCOPES)}")
        scope = declared_scope
        scope_evidence_value = data.get("radius_scope_evidence")
        if not nonempty(scope_evidence_value):
            die("radius_scope_evidence must be a non-empty string")
        scope_evidence = scope_evidence_value.strip()

    relationships_value = data.get("radius_relationships", [])
    if not isinstance(relationships_value, list):
        die("radius_relationships must be an array")
    if scope == "evaluated" and not relationships_value:
        die("radius_scope evaluated requires at least one radius relationship")
    if scope in {"none", "unknown"} and relationships_value:
        die(f"radius_scope {scope} requires an empty radius_relationships array")

    results: list[dict[str, Any]] = []
    relationship_ids: set[str] = set()
    unresolved = 0
    review_items = 1 if scope == "unknown" else 0
    documented_exceptions = 0

    for index, item in enumerate(relationships_value):
        prefix = f"radius_relationships[{index}]"
        if not isinstance(item, dict):
            die(f"{prefix} must be an object")

        relationship_id = item.get("id")
        location = item.get("location")
        kind = item.get("kind")
        evidence_state = item.get("evidence_state")
        evidence = item.get("evidence")
        if not nonempty(relationship_id):
            die(f"{prefix}.id must be a non-empty string")
        normalized_id = relationship_id.strip()
        if normalized_id in relationship_ids:
            die(f"duplicate radius relationship id: {normalized_id}")
        relationship_ids.add(normalized_id)
        if not nonempty(location):
            die(f"{prefix}.location must be a non-empty string")
        if not isinstance(kind, str) or kind not in RADIUS_KINDS:
            die(f"{prefix}.kind must be one of {sorted(RADIUS_KINDS)}")
        if not isinstance(evidence_state, str) or evidence_state not in EVIDENCE_STATES:
            die(f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}")
        if not nonempty(evidence):
            die(f"{prefix}.evidence must be a non-empty string")

        exception = radius_exception(item.get("exception"), f"{prefix}.exception")
        result: dict[str, Any] = {
            "id": normalized_id,
            "location": location.strip(),
            "kind": kind,
            "evidence_state": evidence_state,
            "evidence": evidence.strip(),
            "exception": exception,
        }

        if kind != "shared-contour":
            reason = item.get("reason")
            if not nonempty(reason):
                die(f"{prefix}.reason is required for {kind}")
            if exception is not None:
                die(f"{prefix}.exception is only valid for shared-contour relationships")
            result["reason"] = reason.strip()
            if evidence_state in DIRECT_EVIDENCE:
                result["status"] = "not-applicable"
            else:
                result["status"] = "unverified"
                review_items += 1
            results.append(result)
            continue

        rule = item.get("rule")
        if not isinstance(rule, str) or rule not in RADIUS_RULES:
            die(f"{prefix}.rule must be one of {sorted(RADIUS_RULES)}")

        mismatches: list[str] = []
        result["rule"] = rule
        if rule == "semantic-step":
            outer_token = item.get("outer_token")
            inner_token = item.get("inner_token")
            steps = item.get("token_steps_inward")
            if not nonempty(outer_token) or not nonempty(inner_token):
                die(f"{prefix} semantic-step requires outer_token and inner_token")
            if not isinstance(steps, int) or isinstance(steps, bool) or steps < 0:
                die(f"{prefix}.token_steps_inward must be a non-negative integer")
            result.update(
                {
                    "outer_token": outer_token.strip(),
                    "inner_token": inner_token.strip(),
                    "token_steps_inward": steps,
                    "expected_token_steps_inward": 1,
                }
            )
            if steps != 1:
                mismatches.append(
                    "shared contours should move inward by one semantic radius step"
                )
            if outer_token.strip() == inner_token.strip():
                mismatches.append("outer and inner contours use the same radius token")
        else:
            outer_radius = nonnegative_number(
                item.get("outer_radius"), f"{prefix}.outer_radius"
            )
            inner_radius = nonnegative_number(
                item.get("inner_radius"), f"{prefix}.inner_radius"
            )
            inset = nonnegative_number(item.get("inset"), f"{prefix}.inset")
            tolerance = nonnegative_number(item.get("tolerance", 1), f"{prefix}.tolerance")
            expected_inner = max(0.0, outer_radius - inset)
            deviation = abs(inner_radius - expected_inner)
            result.update(
                {
                    "outer_radius": outer_radius,
                    "inner_radius": inner_radius,
                    "inset": inset,
                    "tolerance": tolerance,
                    "expected_inner_radius": expected_inner,
                    "deviation": deviation,
                }
            )
            if outer_radius > 0 and inner_radius >= outer_radius:
                mismatches.append(
                    "inner radius must be smaller than the rounded outer radius"
                )
            if deviation > tolerance:
                mismatches.append("inner radius does not follow the declared concentric offset")

        result["mismatches"] = mismatches
        if evidence_state not in DIRECT_EVIDENCE:
            result["status"] = "unverified"
            review_items += 1
        elif mismatches and exception is not None:
            result["status"] = "documented-exception"
            documented_exceptions += 1
            review_items += 1
        elif mismatches:
            result["status"] = "mismatch"
            unresolved += 1
        elif exception is not None:
            result["status"] = "documented-exception"
            documented_exceptions += 1
            review_items += 1
        else:
            result["status"] = "conforming"
        results.append(result)

    return {
        "scope": scope,
        "scope_evidence": scope_evidence,
        "relationships": results,
        "unresolved": unresolved,
        "review_items": review_items,
        "documented_exceptions": documented_exceptions,
    }


def check(data: dict[str, Any]) -> dict[str, Any]:
    artifact = data.get("artifact")
    if not isinstance(artifact, str) or not artifact.strip():
        die("artifact must be a non-empty string")

    observed = as_count_map(data.get("observed"), "observed")
    limits_value = data.get("limits")
    limits = as_count_map(limits_value, "limits")

    missing_core_limits = sorted(set(DEFAULT_LIMITS) - set(limits))
    if missing_core_limits:
        die("limits missing core metrics: " + ", ".join(missing_core_limits))

    missing_observed = sorted(set(limits) - set(observed))
    extra_observed = sorted(set(observed) - set(limits))
    if missing_observed:
        die("observed missing metrics: " + ", ".join(missing_observed))
    if extra_observed:
        die("observed metrics missing limits: " + ", ".join(extra_observed))

    exceptions_value = data.get("exceptions", [])
    if not isinstance(exceptions_value, list):
        die("exceptions must be an array")

    exceptions: dict[str, dict[str, str]] = {}
    for index, item in enumerate(exceptions_value):
        if not isinstance(item, dict):
            die(f"exceptions[{index}] must be an object")
        metric = item.get("metric")
        reason = item.get("reason")
        evidence = item.get("evidence")
        if not all(isinstance(x, str) and x.strip() for x in (metric, reason, evidence)):
            die(f"exceptions[{index}] requires non-empty metric, reason, and evidence")
        if metric in exceptions:
            die(f"duplicate exception metric: {metric}")
        exceptions[metric] = {
            "reason": reason.strip(),
            "evidence": evidence.strip(),
        }

    results: dict[str, Any] = {}
    unresolved = 0
    documented = 0

    for metric, limit in limits.items():
        count = observed[metric]
        overage = max(0, count - limit)
        exception = exceptions.get(metric)
        if overage == 0:
            status = "within-budget"
        elif exception:
            status = "documented-exception"
            documented += 1
        else:
            status = "over-budget"
            unresolved += 1
        results[metric] = {
            "observed": count,
            "limit": limit,
            "overage": overage,
            "status": status,
            "exception": exception,
        }

    unused_exceptions = sorted(set(exceptions) - set(limits))
    radius = check_radius_relationships(data)
    review_required = documented > 0 or radius["review_items"] > 0
    passed = unresolved == 0 and radius["unresolved"] == 0 and not review_required
    if unresolved or radius["unresolved"]:
        budget_status = "fail"
    elif review_required:
        budget_status = "review-required"
    else:
        budget_status = "pass"

    return {
        "artifact": artifact.strip(),
        "pass": passed,
        "budget_status": budget_status,
        "review_required": review_required,
        "unresolved_overages": unresolved,
        "unresolved_radius_relationships": radius["unresolved"],
        "documented_exceptions": documented,
        "documented_radius_exceptions": radius["documented_exceptions"],
        "unused_exceptions": unused_exceptions,
        "metrics": results,
        "radius": radius,
        "note": (
            "Documented exceptions and unverified nested-radius scope still "
            "require human review."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check a visual entropy budget.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    result = check(load(args.input))
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
