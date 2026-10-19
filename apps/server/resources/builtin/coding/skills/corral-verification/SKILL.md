---
name: corral-verification
description: "Verify an implementation against explicit criteria and the current immutable target."
---

Identify the target artifact or file tree and the verification scope before selecting checks.
Use actual registered check results and available browser assertions. Validate owner, execution attempt, configuration revision, target tree, completion, cleanup and stale state.
Do not mark pending, failed, cancelled, timed-out, unknown or stale checks as passes. If files change, determine which earlier evidence no longer applies.
Verify the whole changed path, including callers and failure handling, using existing tests where possible. Add only missing tests that protect a meaningful behavior.
Separate deterministic fixtures from actual model calls, actual hardware, packaged runtime and production behavior. Paid or external verification requires explicit host authorization and limits.
