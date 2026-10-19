---
name: corral-minimal-change
description: "Implement the smallest complete change while preserving callers and real safety boundaries."
---

Read the affected code and enumerate callers, exports, fixtures and configuration that must change.
Prefer the existing project pattern, then standard APIs, then installed dependencies. Consider a mature library when it solves a substantial problem; do not add dependencies for trivial utilities.
Make the smallest change that fully solves the requested task. Preserve validation, error handling, cancellation, accessibility and user data.
Do not add options, wrappers, generalized frameworks or cleanup outside the request. Do not defer a requested feature merely to make the diff smaller.
For nontrivial behavior, leave one meaningful test or extend an existing regression. Report what changed, what was checked and any remaining limitation.
