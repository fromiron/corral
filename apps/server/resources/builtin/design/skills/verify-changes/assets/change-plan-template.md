# Change verification report

## Scope

- Artifact:
- Request: review only / edits requested
- Verification: targeted (changed surfaces only) / release
- Changed surfaces and why targeted verification is enough (targeted only):
- Before version:
- After version:
- Primary user:
- Primary task:
- Success condition:
- Evidence inspected:
- Evidence not inspected:

## Result

- Targeted verification: pass / blocked for the changed surfaces. Never a
  release decision.
- Release verification: ready / not ready
- Required failures:
- Required unknowns:
- Accepted risks and accountable owner:
- Limitations:

## Change ledger

| ID | Action | Target | Evidence state | Reason | Proposed or applied | Diff or changed file | Rollback | Verification |
|---|---|---|---|---|---|---|---|---|
| C-001 | delete / consolidate / rewrite / replace / retain / restore |  | observed / measured / inferred / unknown |  |  |  |  |  |

## Verification matrix

Record actual outcomes against the after version, following the last applied
edit. Re-run affected checks if another change follows. Keep review-only
predictions separate from performed checks.

| Check ID | Test | Required | Status | Evidence state | Evidence | Impact | Remediation | Verification | Owner |
|---|---|---:|---|---|---|---|---|---|---|
|  | deletion | yes | pass / fail / unknown / not-applicable / out-of-scope (targeted only) |  |  |  |  |  |  |
|  | substitution | yes |  |  |  |  |  |  |  |
|  | semantic-structure | yes |  |  |  |  |  |  |  |
|  | glance-hierarchy | yes |  |  |  |  |  |  |  |
|  | primary-task | yes |  |  |  |  |  |  |  |
|  | growth | yes |  |  |  |  |  |  |  |
|  | reflow | yes |  |  |  |  |  |  |  |
|  | keyboard-focus | yes |  |  |  |  |  |  |  |
|  | reduced-motion | yes |  |  |  |  |  |  |  |
|  | provenance | yes |  |  |  |  |  |  |  |
|  | nested-radius-coherence | when applicable |  |  |  |  |  |  |  |
|  | journey-paths | when a mapped journey changed |  |  |  |  |  |  |  |

## What changed

### Deleted

### Consolidated

### Rewritten or replaced

### Retained with justification

### Restored for task, evidence, identity, or accessibility

## Remaining unknowns

## Repeatable release checks
