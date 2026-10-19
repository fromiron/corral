---
name: corral-debugging
description: "Reproduce and diagnose a concrete failure before making a focused correction."
---

Inspect the current code, callers, existing patterns and installed dependencies. Confirm the failing behavior before changing it.
Use the smallest realistic reproduction. Gather observations, form a falsifiable hypothesis and check the shared cause across affected callers.
Prefer existing code and standard APIs. Fix the cause once, preserve error handling and avoid unrelated cleanup.
Add a small regression test only where it protects a real behavior, data boundary or permission boundary. Confirm it fails for the right reason, then implement and run relevant existing regressions.
Use only registered Corral tools and checks. No arbitrary shell, new agent runtime or unapproved external call. Report anything that could not be reproduced.
