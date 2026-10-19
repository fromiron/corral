# Design-system lifecycle

Read this file only when introducing, migrating, or adopting a shared design
system is in scope. A review of individual components does not need it. Run the
commands below from the `review-components` skill directory.

## Procedure

1. Record the shared system's current inventory, authoritative surfaces,
   governance model, contribution process, release and changelog policy,
   legacy mappings, coexistence rules, adoption status, roadmap, owners, and
   deprecation gate.
2. Mark each item `unknown` when the supplied material does not establish it.
3. When migration or adoption is part of the release scope, a lifecycle that
   remains `fail` or `unknown` blocks a mechanical release-ready result.

Record the lifecycle in the `system_lifecycle` object of the
interaction-governance report
([schema](../assets/interaction-governance.schema.json),
[example](../assets/interaction-governance-example.json)) and validate it:

```bash
python scripts/validate_interaction_governance.py path/to/interaction-governance.json
```

## Design-system lifecycle and adoption

When a shared system is in scope, inspect more than its final component library.
Record:

1. **Inventory** — current components, raw values, variants, exceptions, live
   usages, and known owners.
2. **Authoritative surfaces** — which dimensions are owned by design,
   documentation, code, tests, or live configuration.
3. **Governance model** — central, federated, distributed, solo, hybrid, or
   unknown. No model passes by name alone.
4. **Contribution process** — proposal, review, decision, implementation, and
   consumer feedback paths.
5. **Versioning and changelog** — how consumers learn what changed and whether
   migration is required.
6. **Legacy-to-target mapping** — exact current component or token, target,
   adoption status, exception, owner, and migration note.
7. **Coexistence rules** — when old and new systems may coexist and how that
   period remains visible and bounded.
8. **Adoption strategy** — such as a coordinated migration, incremental
   replacement during feature work, or a documented hybrid.
9. **Roadmap and review triggers** — priorities grounded in user and maintainer
   impact rather than visual novelty.
10. **Deprecation gate** — measurable conditions for warning, blocking new usage,
    and removing the obsolete API or visual contract.

Do not require a dedicated central team or ambassador program. Those are
possible operating models, not universal requirements. A small project may use
a solo owner; a large product organization may distribute authority by
dimension. The contract must make responsibility and convergence reviewable.

A migration reset does not repair current component defects. Continue to audit
states, affordances, accessibility, content, and behavior in the target system.
