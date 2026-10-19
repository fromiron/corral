---
name: corral-delegation
description: "Delegate a bounded task only when the role has Corral collaboration tools."
---

First decide whether delegation helps this task. Do not create agents just to follow a ritual.
Use only callable targets and spawn_subagents, await_tasks, ask and reply actually offered by Corral. Do not start a separate workflow engine, CLI agent, worktree or background process.
For each delegation give the objective, immutable inputs, allowed scope, completion criteria and return format. Keep independent work independent and avoid conflicting file writes.
Wait for the owned tasks and inspect their results. A message that work is done is not completion evidence. Report failed, cancelled or uncertain children accurately.
Use ask for another agent. Use ask_user for a person when available. Delegation cannot transfer permissions, grant approval or increase the host budget.
