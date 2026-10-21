# Markdown agent import verification

This records ABS-11 / I13 from `Desktop-Capabilities-Implementation-Plan.md`.
The subagents adapter also supports the ABS-13 vault owner; it does not create a second agent registry.

## Parent question follow-up

Final review found that the earlier prompt told children to put questions in their final result,
which did not meet the accepted ask/reply-and-continue requirement. That shortcut was removed.

The definition now records the reviewed opt-in as `parentQuestions: true` on the delegate link.
The child receives `ask`; the parent explicitly gains the corresponding collaboration tools.
An explicit parent work style must allow those tools at the same verified revision.
Legacy definitions retain their original plan shape and question semantics.

Before implementation, the new compiler tests failed 2/3, the import test failed 1/10, and
the restrictive work-style test failed as expected. After the definition/compiler/import
correction, compiler, importer, vault and component design checks passed **33/33**.
Studio typechecking and the affected files' Biome checks also passed.

The Coordinator now routes a child question to its exact current delegating parent execution
and attempt. `await_tasks` and ordered items can return open questions without ending either
task. A parent reply resumes the same child; no responder Task or additional depth is created.
Pending item continuations reserve their remaining spawn capacity, reject premature completion,
and retain their order and current parent ownership across questions and child restart.
Timeout and child cancellation do not cancel the parent.

- Core parent-question, legacy collaboration/items, Reins, boundary, limit and admission checks:
  **54 passed**, including seven parent-question cases and their nested assertions.
- Pi core/SDK actual Coordinator roundtrips: six scenarios cover parallel delegation,
  ordered items and a parent that is itself an ordinary question responder. The full affected
  adapter set passed **105 tests**, including pending-tool worker exit/cancel and late results.
- The first browser run exposed a missing continuation in the product's Simulated adapter.
  A separate actual Coordinator regression first failed, then passed after the generic adapter
  answered parent questions and awaited the same task IDs again. Its relevant regression set
  passed **25 tests**. No test limit or expected successful outcome was weakened.
- The seventh frontend build passed all three browser scenarios below. The first includes
  both the repaired Simulated run and a real Pi worker using a local deterministic model endpoint.

## Implemented flow

The team editor opens **Import Markdown agent**. A user supplies Markdown, reviews the
description and prompt, selects an existing parent and connected model, and explicitly maps
or excludes each declared tool. Unknown tools and unsupported frontmatter fields are rejected.
The parser supports bounded flat frontmatter, quoted strings, literal/folded text blocks and
string lists, up to 32 KiB.

The import adds an ordinary callable node, role and parent delegate link as one undoable
editor operation. **Save** uses the existing repository revision path. Control-flow edges,
run input and delegation/spawn/budget limits are preserved.

- Child tools are bounded by the parent's permissions. `write_artifact` and `submit_result`
  remain necessary for returning results. Imported children exclude `ask_user` and `update_plan`.
- `Glob` can be explicitly translated to folder listing; the UI states the difference.
  `Grep` has no equivalent content-search capability and must be explicitly excluded.
- `Edit` maps to `read_file` / `write_file` capabilities and `editingMode: hashline`.
  The worker offers `read_hashline` / `edit_hashline`; the import does not add broker names
  to the role's WorkTool enum.
- The child inherits only the selected parent's local work-style binding and revision.
  Shell import requires a verified `trusted-native` snapshot that permits `run_command`.
  An imported document cannot introduce trust or select a remote work-style binding.
- Source model names are informational. A connected local profile must be selected.

## Evidence

Final frontend artifact: `index-DwseoaDF.js`, stylesheet `index-P0zuN5FL.css`.

`apps/studio/e2e/server/markdown-agent-import.spec.ts`: **3/3 passed**, against fresh
isolated local servers using the production Studio bundle:

1. Markdown review → import → undo/redo → Save → reload and repository readback →
   normal Simulated Test run → two child questions and submitted results →
   the same Run button with a local model endpoint → one child question → same parent reply →
   same child continues → both submit. The live projection contains exactly two executions
   and one answered existing-parent question; no extra responder execution exists.
2. Markdown Read/Edit → explicit Hashline review → Save/reload → authoritative role mode,
   file capabilities and tag-reading instructions.
3. Explicit parent shell permission and local work style → verified inherited profile/revision →
   import → Save/reload → matching child binding and bounded tool list.

The model endpoint chooses responses from the actual request and tool results. These tests
prove orchestration and persistence, not a production model's judgement. No paid model or shell
command is invoked.

`packages/adapter-pi/test/imported-role-tools.test.ts`: **1/1 passed**. A definition produced
by the same importer runs through Coordinator and the actual Pi worker with a deterministic
provider. The parent delegates normally; the child sees Hashline schemas containing
`path`, `tag`, and `ops`, does not see native `edit` / `write`, and submits a result.
This verifies actual worker tool presentation; it does not execute a file edit.

`markdownAgentImport.test.ts`: **10/10 passed**. Covers parser failures, graph compilation,
permission/model boundaries, Hashline mode, local work-style verification, required result
tools, control-tool exclusion, graph limits and undo/redo.

The design guard's **6 tests passed** after adopting shared Dialog and Select components.
The rendered 1280×800 import preview was inspected; dialogs scroll, controls remain readable,
and the E2E verifies Escape and focus return.

Fresh 1280×800 captures were inspected:

- `test-results/agent-import-parent-final-7/server-markdown-agent-impo-61ec8-ad-and-is-one-undoable-edit-server/markdown-import-preview.png`
- `test-results/agent-import-parent-final-7/server-markdown-agent-impo-61ec8-ad-and-is-one-undoable-edit-server/markdown-parent-question-run.png`

The preview shows the effective child `ask`, explicit parent collaboration grant and the
question/continuation explanation. The final graph shows both parent and child completed.
The exact question and answer assertions use the authoritative Coordinator projection.

## Vault ownership and recovery

`createSubagentsVaultAdapter` requires an explicitly bound existing team and model/parent
mapping. Incoming snapshots contribute callable roles only; source control flow, task input,
limits and source work-style binding cannot replace the target team's settings.
Rollback consumes the vault's encrypted local pre-apply snapshot.

The production repository saves the graph and immutable operation receipt in one SQLite
transaction (`0026_corral_operations`). Forward and rollback receipts survive reopening.
Definition and layout revision guards reject concurrent changes, including a layout change
while resolving a model binding. A replay returns its original receipt without a second save.
Unsupported repositories fail explicitly; there is no non-atomic fallback.

`apps/server/test/vault-subagents.test.ts`: **5/5 passed**, using the actual SQLite owner,
including mapping, capability refusal, rollback, receipts/replay and concurrent-layout refusal.
The storage owner's receipt, legacy migration and cleanup verification passed **45/45 tests**,
including six new operation tests with database reopen and transaction-failure rollback.

Remaining limits: real paid-provider decisions and file/shell effects initiated by an
imported role were not exercised in these tests. The server's ordinary admission, broker,
work-style and process checks remain authoritative for those effects.
