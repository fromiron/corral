# CR-055 — Conversation Agent, Team Selector and Turn Display

- Approval: Bell, 2026-10-25 (Asia/Tokyo). Bell asked for a root-level rework of chat, using DeepSeek Harness (DSH) as the behavioural reference: (1) remove automatic effort selection if it causes the write_artifact → submit_result pattern, otherwise propose an improvement; (2) a basic chat that calls subagents only when the prompt explicitly asks, plus a team option in the composer (none, auto, a Corral), shaped like the model selector, where the session's lead agent calls role agents by itself; (3) an in-progress display reworked after DSH. Bell approved decisions D1–D4 below and said that older CRs are cited for causes only: this rework may ignore them, and rewriting CRs is allowed.
- Tracking: C-187 / CRL-LLM-008 / TC-LLM-008-H,N,F (phase 1); C-188 / CRL-UX-012 / TC-TURN-001-H,N,F (phase 2); C-189 / CRL-LLM-009 / TC-TEAM-001-H,N,F (phases 3–4); C-190 / CRL-LLM-010 / TC-TEAM-002-H,N,F (§7).
- Status: approved and implemented (C-187–190) in the deterministic, demo and server E2E scope of the [evaluation record](../evaluation/Conversation-Agent-2026-10-25.md). Live provider runs and other OSes are not verified.
- Supersedes, where they conflict: CR-011 §3 (the `explain` intent in the composer), CR-024 (auto team as a fixed run graph for chat), CR-043 §4 (request options and the Corral inside them), CR-048's Ultra choice in the session composer, CR-049's restriction of plain-text answers to meetings, and CR-052 §8 (no-progress only warns).
- Reference: DSH 0.2.1-rc.2 (MIT), local npx cache, package READMEs only (`dsh-tool-subagent`, `dsh-subagent`, `dsh-experimental-agent-team`, `dsh-experimental-tool-agent-team`, `dsh-client-ui-chat`, `dsh-client-ui-conversation`), and Bell's running DSH UI viewed read-only. No code is copied. Corral's Coordinator records stay the source of truth.

## Findings

1. **Effort selection is not the cause.** The write_artifact → submit_result output contract dates from P3 (449844f, 2026-10-15). Automatic effort (dd02fe9, 2026-10-18) runs a local judge (`effort-judge-v6`, privacy local) and sends no provider request, so it stays. Auto mode adds one small chooser request per message (about 180 input tokens).
2. **Measured cost of one "하이" in Auto mode:** chooser 177 input tokens, then turn requests of 2,163 and 2,233. The second request re-sends the whole prompt and the answer only to call submit_result. All three read 0 cached tokens.
3. **The question-mode loop** (run_355e…): the Explainer called write_artifact 36 times and never submit_result. The tool result gives only a version ID, and the request tail repeats the task as a new user message. Explain's 4-call cap (`session-runs.ts`) was not enforced, because CR-052 runs every definition without a budget as unlimited. Each reworded rewrite counted as progress, so the warning came near reply 31, and it does not stop the run.
4. **DSH:** one agent per session. A turn ends when the model replies without a tool call, and that reply is the answer. A subagent tool starts a child, and the child's final answer returns to the parent. Agent Teams give the lead named teammates. The chat renders a turn as flat process rows (Think · preview, Bash · description, Read · path) with a running status line. A finished turn folds its process under a duration header, never hides the answer, and the composer shows turns, steps, speed, tokens and cache hit.
5. **Corral before this change:** every message started a new Run of a team graph. Answers needed write_artifact + submit_result. A question was a separate Explainer run. The work log nested Run → Assistant #1 → reasoning setting → conversation → "모델 호출 14/31", numbered by event seq. `spawn_subagents` / `await_tasks` already exist under Coordinator limits.

## Contract

### 1. Final-reply answers
1. A role may declare `answer: "final_reply"`. Such a role gets neither write_artifact nor submit_result. Its instructions say to reply directly; the reply without a tool call is its result.
2. When that execution ends normally, the Coordinator records the last finished model reply as the result version, citing that model call, and submits it through its own tools. It does this even when the agent used other tools earlier. An empty, truncated, failed, cancelled or late reply submits nothing, and the task fails as before.
3. The output contract is `text`. Meetings keep their own rule (no tool calls before the answer).

### 2. Conversation agent (team: none)
1. Chat in a session starts the conversation definition: one lead role (`answer: "final_reply"`), with the session's permitted work tools and `ask_user` / `update_plan`. No chooser request is sent.
2. Each person message is a turn recorded as a Run. The session's earlier turns reach the lead as CR-054 user/assistant messages.
3. The composer's 후속 작업 / 질문 selector is removed. A question about an earlier answer is an ordinary message. "New run from this version" (CR-007) and review feedback stay as explicit actions. The explain endpoint stays for existing clients and uses a final-reply role with no tools.

### 3. Progress guard
1. A new version of an artifact that the same execution already wrote since its last submission is not progress.
2. After six model replies without progress, every run, limited or not, waits for the person (`no_progress` approval) before the next request. An unlimited run's warning says why it paused.

### 4. Turn display (phase 2)
1. A turn shows the person's message, one process group and the answer. The answer is always visible.
2. Process rows are flat, one line each: icon · kind · summary. Kinds: Think (first line of reasoning), tool name with its target or description, Subagent · role · status, Ask · waiting. Rows share one muted colour; errors and warnings keep semantic colours.
3. While running, rows stream in and a bottom status shows elapsed time with a shimmer (static under reduced motion). When the turn ends, the group folds under "작업 N초 · M단계"; one click expands it.
4. The per-turn status badge, the result-version header and the nested Run → Assistant → conversation → model-call folds leave the chat flow. Versions, audit records and raw replies stay in the side panes. Raw replies are numbered by request order.
5. Under the composer: turns · steps · tokens · cache hit, from Coordinator usage. An unreported figure is named, never 0. Output speed is not shown yet: the projection has no per-call output duration to divide by.

### 5. Subagents and team selector (phases 3–4)
1. In basic chat the lead may call `spawn_subagents` / `await_tasks` with a general helper role. Its instructions say to delegate only when the person explicitly asks for subagents or a team. Children answer with final replies.
2. The composer's team selector, shaped like the model selector, lists **팀 없음** (none, the default) on its own, then a **Corral** group: **auto**, each saved Corral, and **Corral 만들기·관리**, which opens the project's Corral list.
3. **auto:** the lead receives a roster composed by Corral's auto team (planner, writer, reviewer and similar roles) as named delegates and decides when to call them. No chooser request runs per message.
4. **Corral (D1):** the chosen Corral's roles become the lead's delegates; its graph is given to the lead as guidance. The D&D editor and running a Corral directly stay available.
5. The selection applies from the next turn. A saved Corral is the session's Corral setting; none/auto is remembered per session in this browser. The team is part of the request identity, so a retry after a lost answer reuses its command only with the same team.

### 6. Composer without request options (amendment)
Bell, 2026-10-25: with the team selector, Ultra and the rest of the request options are no longer needed. The composer drops the request-options popover and everything in it: the Corral picker and its management link (now in the team selector), automatic work style, per-run role models and styles, Ultra, review-only, verification scope, project-material attachment and design templates, plus the `/ultra` command. Text and image attachments stay in the `+` menu and project files stay reachable through `@`. Server APIs for these options are unchanged for other clients; meetings keep their Ultra handoff.

### 7. Default session tools (amendment)
Bell, 2026-10-25: tool calling such as commands and previews must be available automatically, especially in the main session, unless a subagent was deliberately restricted. Command approval follows the permission mode.
1. A live session turn in a linked, trusted folder runs under the built-in **Session default** work style (`session-default`, trusted-native) unless the request names a work style. Its tool list covers the file, command, preview, check and collaboration tools of the conversation roles.
2. The person's and project's default work styles layer over it as before: any strict layer makes the result strict, and allowed tools intersect. Archiving the built-in style turns the default off.
3. The lead, the helper and writing roles get `run_command` and the preview tools; each command still goes through the permission mode. Reviewers stay read-only. A saved Corral role without its own work style works in the session's.
4. Simulated agents and folders without trust get no work style: a bound style would only be simulated and would take the file tools away.
5. The Coordinator's own final-reply publication (§1) is not a tool the work style offers, so the style's tool list does not block it. The model still cannot call those tools itself.
6. A wait on delegates that ends because the turn was cancelled settles as cancelled, not failed.
7. A conversation start records its request's identity, so a resend after a lost answer returns the recorded run, and the start's cancellation reaches that run as it does for an auto start.

## Decisions (Bell, 2026-10-25)
- D1: a Corral's roles are called freely by the lead; the graph is guidance.
- D2: remove the 후속 작업 / 질문 selector.
- D3: pause after the no-progress warning.
- D4: Claude implements; the DSH session in the same workspace only investigates and does not edit files.

## Phases
1. P1 — final-reply answers, conversation definition, merged question, progress guard, request-number label.
2. P2 — turn display and composer statistics.
3. P3 — explicit subagents in basic chat.
4. P4 — team selector.
5. Amendment — composer without request options (§6).
6. Amendment — default session tools (§7).

## Not in scope
Workspace isolation for delegates, DSH's task board and peer mailbox, and changes to D&D, Reins, Ultra or meetings beyond the shared answer path.
