---
name: corral-browser-verification
description: Verify a concrete change in a registered, trusted anonymous local browser fixture using owned Playwright MCP observations and assertions.
---

Use only the browser tools explicitly provided for this execution. If the recipe or browser is unavailable, report that limit; do not install packages, connect a personal profile, enable native permissions, or use shell/evaluate/run-code as a substitute.

1. Read the task scope, acceptance criteria and current file/check evidence. Confirm the registered loopback origin and intended anonymous fixture. External sites require a separately approved capability.
2. Navigate to the registered origin. Call browser_snapshot explicitly: navigation may return only a link to a snapshot file. Observe accessible names and current element targets before selecting one.
3. Assert readiness with browser_verify_element_visible or browser_verify_text_visible. A server being reachable, a sleep or network idle is not readiness evidence.
4. Perform the requested action with the observed target, then assert the expected result. Inspect relevant errors. Keep every failed assertion in the report; do not replace it with a screenshot-only success.
5. Capture only the relevant anonymous UI if a screenshot is useful. Use the default owned output location; never supply a filename, upload files, capture credentials, or claim a file link will remain available after cleanup.
6. Report the origin, current tree, exact workflow and assertions, observed success/failure and limitations. Native tool outcomes are retained in the private execution record. Browser evidence is distinct from schema validation, code inspection and model judgment. Screenshots alone do not establish accessibility conformance or release readiness.
7. Cancellation belongs to the current execution. Do not kill global browsers or servers. Corral owns and reaps this fixture's children. Its HTTP/redirect/WebSocket interception is not an operating-system sandbox.
