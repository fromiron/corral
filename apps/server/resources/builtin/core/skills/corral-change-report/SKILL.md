---
name: corral-change-report
description: "Reports implemented file changes together with their actual verification and application state. Use when finishing an implementation, a fix or rework in Corral and handing back what changed, what was checked and what has not been applied to the original project."
license: MIT
compatibility: "Designed for Corral."
---

Lead with what changed and why it matters to the user's task. Name the relevant files or immutable diff scope.
Distinguish changes in the managed working copy from changes applied to the original project. A successful write or natural-language claim is not an apply receipt.
Report the actual commands or registered checks run, their target tree and outcome. Distinguish code inspection, tests, browser assertions and screenshots.
Include unresolved failures, unverified environments and recovery limits. Do not claim an OS sandbox, release, deployment or external effect rollback without evidence.
Keep the report proportional; small edits need a short result and the meaningful checks.
