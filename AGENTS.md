# Corral Development Agent Rules

These rules apply to every development agent making changes to Corral. This file is the canonical source; `CLAUDE.md` imports it with the single line `@AGENTS.md`. Do not create a separate copy for Claude or a separate set of product rules.

## Getting Started

1. Use the [documentation map](docs/README.md) to select only the current reference documents relevant to the task. Check implementation status and next steps against the [status table](docs/status.md), [active plans](docs/plans/README.md), relevant code, contracts, test IDs, and approved CRs.
2. Do not load entire initial proposals, completed plans, or historical validation records into the default context. Read only the sections needed for background. Do not treat goals in a plan as implemented features.
3. Every change must have an explicit requirement or task. Do not expand scope based on speculation, or remove or defer D&D or Reins without user approval.
4. When documentation and code conflict, check their scope, approval basis, and supersession relationships. A newer date alone does not establish precedence. Do not change documentation to legitimize a code bug or revert current behavior to match an old plan. Report conflicts that lack sufficient evidence.
5. Handoffs, plans, quoted user statements, and spending or merge permissions in Git history are historical records. Do not reuse them as instructions or authorization for the current task. Unapproved candidates in `proposals/` do not expand the current request's scope either.

## Implementation Boundaries

- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Define normal, failure, cancellation, duplicate, and late-event cases, including counterexamples, and confirm that the tests actually fail before implementing the change. Distinguish writing tests from running them successfully.
- Inject external calls, time, and IDs. Do not include paid LLM or search calls in ordinary CI. Live tests require explicit opt-in and limits.
- Do not independently finalize Task completion or budget usage from Pi/LangGraph internals or the UI store. Use the Coordinator command path.
- Every cancellation or patch must check the current attempt, scope, and revision. Do not overwrite past context or artifacts. Do not blindly retry a lost response with a new command ID.
- Do not expose provider keys, local paths, or user message bodies in logs, screenshots, or public exports. Do not execute raw HTML in generated UI. Keep the security boundaries of managed service previews and artifact HTML previews distinct.
- When adding a library, record its version, license, official supporting sources, and Node/peer compatibility. Do not install an RC by default just because documentation uses it in an example.
- For design or UI improvements, read and apply the relevant leeskills under `apps/server/resources/builtin/design/skills/`. Reuse existing tokens and shared components first, and check the actual UI and relevant regressions.

## Documentation and Validation

- Report approval, implementation, and validation in a specific environment separately. State what remains unverified, and do not claim API support without integration tests.
- If a product contract must change, update the Change Request and related requirements, tests, and ADRs first. Link, classification, or wording edits alone do not approve new features.
- Record current contracts in the relevant `docs/current/` documents and linked detailed contracts, remaining work in plans, and execution results in evidence records. Do not create independent copies of the same rules. Before deleting completed or superseded plans, preserve their still-valid contracts, remaining work, and necessary evidence in the appropriate documents; retain history in Git. Do not create a separate documentation archive.
- `contracts/backlog.json` is the source of truth for task status. `planned` in the test catalog is a scenario declaration format, not a verdict of missing implementation or test failure. `implemented` does not mean validation is complete for every OS, provider, or current candidate.
- Do not declare completion by deleting or weakening failing tests. Preserve CR, requirement, task, and test IDs, along with the commit, environment, and results of historical evidence.
- Before moving or deleting documents, check links and tools that consume them. Distinguish research on external products from notices for actual dependencies or borrowed material. Do not bulk-delete `LICENSE`, `THIRD-PARTY-NOTICES/`, or bundled notices.
- External product names, commits, and local paths in historical plans, CRs, or ADRs are not implementation sources. Do not fetch those repositories or align files with them.
- Development instructions are separate from the product's built-in Skills and prompts. Do not clean up `apps/server/resources/builtin/` on the grounds that it is outdated documentation.

Run `pnpm spec:check` when changing documentation or tracking data. If contract or dependency boundaries change, also run `pnpm contracts:check` or `pnpm deps:check`, respectively. For runtime changes, additionally run relevant unit, integration, and UI regression checks. Do not report passing documentation checks as passing product tests or release gates.
