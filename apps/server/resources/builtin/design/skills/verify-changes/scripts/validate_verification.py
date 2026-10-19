#!/usr/bin/env python3
"""Validate a verify-changes report and its targeted or release gates."""

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

STATUSES = {"pass", "fail", "unknown", "not-applicable", "out-of-scope"}
OPERATIONS = {"review", "edit"}
VERIFICATIONS = {"targeted", "release"}
EVIDENCE_STATES = {"observed", "measured", "inferred", "unknown"}
ACTIONS = {"delete", "consolidate", "rewrite", "replace", "retain", "restore"}
TESTS = {
    "deletion",
    "substitution",
    "semantic-structure",
    "glance-hierarchy",
    "primary-task",
    "growth",
    "reflow",
    "keyboard-focus",
    "reduced-motion",
    "provenance",
    "assistive-technology",
    "nested-radius-coherence",
    "affordance-mapping",
    "action-hierarchy",
    "action-visibility",
    "grouping-cues",
    "system-lifecycle",
    "custom",
}
BASELINE_TESTS = {
    "deletion",
    "substitution",
    "semantic-structure",
    "glance-hierarchy",
    "primary-task",
    "growth",
    "reflow",
    "keyboard-focus",
    "reduced-motion",
    "provenance",
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


def string_list(value: Any) -> bool:
    return isinstance(value, list) and all(nonempty(item) for item in value)


def validate_scope(data: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    """Return the declared scope; a report without one is a release verification."""
    if "scope" not in data:
        return {"operation": None, "verification": "release", "declared": False}
    scope = data.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope must be an object when present")
        return {"operation": None, "verification": "release", "declared": True}
    operation = scope.get("operation")
    verification = scope.get("verification")
    if operation not in OPERATIONS:
        errors.append(f"scope.operation must be one of {sorted(OPERATIONS)}")
    if verification not in VERIFICATIONS:
        errors.append(f"scope.verification must be one of {sorted(VERIFICATIONS)}")
        verification = "release"
    surfaces = scope.get("changed_surfaces", [])
    if not string_list(surfaces):
        errors.append("scope.changed_surfaces must be an array of non-empty strings")
    if verification == "targeted":
        if not surfaces:
            errors.append("targeted verification must name its changed_surfaces")
        if not nonempty(scope.get("rationale")):
            errors.append("targeted verification requires a scope.rationale")
    return {
        "operation": operation,
        "verification": verification,
        "changed_surfaces": surfaces if isinstance(surfaces, list) else [],
        "declared": True,
    }


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[str] = []
    warnings: list[str] = []

    scope = validate_scope(data, errors)
    targeted = scope["verification"] == "targeted"

    for field in ("artifact", "primary_user", "primary_task", "success_condition"):
        if not nonempty(data.get(field)):
            errors.append(f"{field} must be a non-empty string")

    for field in ("evidence", "accepted_risks", "limitations"):
        if not string_list(data.get(field)):
            errors.append(f"{field} must be an array of non-empty strings")

    accepted = data.get("accepted_risks")
    accepted_risks = set(accepted) if isinstance(accepted, list) else set()

    changes = data.get("changes")
    if not isinstance(changes, list):
        errors.append("changes must be an array")
        changes = []

    change_ids: set[str] = set()
    action_counts = {action: 0 for action in sorted(ACTIONS)}
    for index, item in enumerate(changes):
        prefix = f"changes[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        change_id = item.get("id")
        if not nonempty(change_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif change_id in change_ids:
            errors.append(f"duplicate change id: {change_id}")
        else:
            change_ids.add(change_id)
        action = item.get("action")
        if action not in ACTIONS:
            errors.append(f"{prefix}.action must be one of {sorted(ACTIONS)}")
        else:
            action_counts[action] += 1
        for field in ("target", "reason"):
            if not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if item.get("evidence_state") not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )
        if not isinstance(item.get("reversible"), bool):
            errors.append(f"{prefix}.reversible must be boolean")

    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty array")
        checks = []

    check_ids: set[str] = set()
    present_tests: set[str] = set()
    status_counts = {status: 0 for status in sorted(STATUSES)}

    for index, item in enumerate(checks):
        prefix = f"checks[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue

        check_id = item.get("id")
        if not nonempty(check_id):
            errors.append(f"{prefix}.id must be a non-empty string")
            check_id = f"invalid-{index}"
        elif check_id in check_ids:
            errors.append(f"duplicate check id: {check_id}")
        else:
            check_ids.add(check_id)

        test = item.get("test")
        if test not in TESTS:
            errors.append(f"{prefix}.test must be one of {sorted(TESTS)}")
        else:
            present_tests.add(test)

        required = item.get("required")
        if not isinstance(required, bool):
            errors.append(f"{prefix}.required must be boolean")
            required = False

        status = item.get("status")
        if status not in STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(STATUSES)}")
        else:
            status_counts[status] += 1

        evidence_state = item.get("evidence_state")
        if evidence_state not in EVIDENCE_STATES:
            errors.append(
                f"{prefix}.evidence_state must be one of {sorted(EVIDENCE_STATES)}"
            )

        for field in ("evidence", "impact", "remediation", "verification", "owner"):
            if not nonempty(item.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")

        if status == "out-of-scope":
            if not targeted:
                errors.append(
                    f"{prefix}: out-of-scope is only valid in targeted verification; "
                    "release verification classifies every check"
                )
            if required is True:
                errors.append(f"{prefix}: a required check cannot be out of scope")

        if status == "pass" and evidence_state == "unknown":
            errors.append(f"{prefix}: a passing check cannot have unknown evidence")

        if status == "not-applicable":
            evidence_text = item.get("evidence", "")
            if isinstance(evidence_text, str) and evidence_text.strip().lower() in {
                "n/a",
                "not applicable",
            }:
                warnings.append(f"{prefix}: explain why the test is not applicable")

        if status == "fail":
            risk_tag = f"{check_id}:{status}"
            suffix = (
                " (accepted risk recorded; owner decision still required)"
                if risk_tag in accepted_risks
                else ""
            )
            blockers.append(f"{prefix}: failed check blocks mechanical release readiness{suffix}")
        elif required and status == "unknown":
            risk_tag = f"{check_id}:{status}"
            suffix = (
                " (accepted risk recorded; owner decision still required)"
                if risk_tag in accepted_risks
                else ""
            )
            blockers.append(f"{prefix}: required check is unknown{suffix}")

        if (
            not targeted
            and test in BASELINE_TESTS
            and required is False
            and status != "not-applicable"
        ):
            blockers.append(
                f"{prefix}: baseline test must be required or explicitly not-applicable"
            )

    in_scope_tests = {
        item.get("test")
        for item in checks
        if isinstance(item, dict) and item.get("status") != "out-of-scope"
    }
    missing_baseline = sorted(BASELINE_TESTS - present_tests)
    not_checked = sorted(BASELINE_TESTS - in_scope_tests)
    if targeted:
        if not in_scope_tests:
            errors.append("targeted verification must include at least one in-scope check")
    elif missing_baseline:
        blockers.append(
            "baseline tests missing: " + ", ".join(missing_baseline)
        )

    unused_risks = sorted(
        accepted_risks
        - {
            f"{item.get('id')}:{item.get('status')}"
            for item in checks
            if isinstance(item, dict)
        }
    )
    if unused_risks:
        warnings.append("accepted risks not matched to checks: " + ", ".join(unused_risks))

    valid = not errors
    # A targeted result covers the changed surfaces only; it never establishes
    # release readiness for the whole artifact.
    release_ready = valid and not blockers and not targeted
    targeted_pass = valid and not blockers if targeted else None
    if targeted:
        verdict = "targeted-pass" if targeted_pass else "blocked"
    else:
        verdict = "release-ready" if release_ready else "blocked"
    return {
        "valid_report": valid,
        "scope": scope,
        "verdict": verdict,
        "release_ready": release_ready,
        "targeted_pass": targeted_pass,
        "not_checked": not_checked if targeted else [],
        "errors": errors,
        "blockers": blockers,
        "warnings": warnings,
        "status_counts": status_counts,
        "action_counts": action_counts,
        "accepted_risks": sorted(accepted_risks),
        "baseline_tests_present": sorted(BASELINE_TESTS & present_tests),
        "note": (
            "This validates the report contract and declared gates; it does not "
            "perform usability, browser, provenance, or accessibility testing."
            + (
                " Targeted verification covers the declared changed surfaces only "
                "and is not a release or conformance decision."
                if targeted
                else ""
            )
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a verify-changes report and required-check gates. Exits 0 "
            "when a release report is release-ready or a targeted report passes "
            "its declared scope; a targeted report is never release-ready."
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
    passed = result["targeted_pass"] if result["targeted_pass"] is not None else result["release_ready"]
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
