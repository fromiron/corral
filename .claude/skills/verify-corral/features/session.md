# Session screen

The conversation screen at `/sessions/<id>`: the timeline, the composer, the activity bar above it, and the panel beside it with its tabs. The journeys are those of the `session-tasks` flow map; transition ids below are that map's.

Handles are English, as the walk pins Studio to `en`. Unless a row says otherwise, each was walked in mode (b) with `--mock-delay 1500` at 1280x800.

## Sub-features

- **Timeline** (`getByTestId('chat-timeline')`): each request, and under it its run as a region named `Run #n` holding the work-log line, the `Run #n` button and the answer.
- **Composer**: the region `Request` with the combobox `Request`, `Send` (or the Stop square while a run goes and nothing is typed), the team chip (combobox `Corral`), the `Model` chip and the permissions chip. A line above the box says where the next send goes (`getByTestId('composer-destination')`).
- **Activity bar** (`getByTestId('activity-bar')`, a group named `Activity`): one line about the run, `Overview`, and the toggle `Activity details` that opens the list `Roles` and the `Reins` row (`Pause`, and `Stop` when something is typed).
- **Panel** (region `Panel`): tabs in the tablist `Panel tabs` (`Run #n`, `Files`, `Changes`, `Results`), each with a `Close <tab>` button; `Maximize panel`; the banner's `Show or hide the panel`.
- **Run tab** (tabpanel `Run #n`): the tablist `Run views` (`Graph`, `Workflow`, `Timeline`, `Events <count>`, `Results`) and `Run info`.

## How to get to it

A fresh workspace opens on the project page of `My project` (`/projects/default`). Press `New conversation` in the main area (the sidebar has a link of the same name): the address becomes `/sessions/session_…`, and the screen is ready when the combobox `Request` is visible. That is the map's `conversation-idle`.

- `response-completed`: type a request, press `Send`, wait for `[data-testid="activity-bar"][data-run="succeeded"]:not([data-live])`. With the default `No Corral` the scripted run has an Assistant and two Helper executions and finishes in about six seconds at mock delay 1500.
- `conversation-running`: the same send, then wait for `[data-testid="activity-bar"][data-live]` and act at once; the run is live for a few seconds.

Scenarios each launch produces:

- **Mode (b).** The default scripted run has two roles working the moment it goes live, so the fact `several-roles` holds: Stop always asks first. `stop-run`'s default scenario (one role, `run.stop`) cannot be produced; walk `several-roles`. The `agent-unresponsive` scenarios need a mock delay of tens of seconds and are out of reach. At 1280x800 there is room for the panel beside the conversation, so `follow-active-run` should walk as its scenario `room` (read from the map, not walked).
- **Mode (a).** Not walked yet; find out which scenarios it produces before recording one.

## Handles

### send-request (walked: `session-tasks-send-request-mock-20261123`)

| Transition | Do | Wait for |
|---|---|---|
| `conversation.send` | `req.getByRole('combobox', { name: 'Request', exact: true }).fill(text)`, then `req.getByRole('button', { name: 'Send', exact: true }).click()`, where `req = page.getByRole('region', { name: 'Request', exact: true })` | `[data-testid="activity-bar"][data-live]` |
| `run.succeeded` (system) | nothing | `[data-testid="activity-bar"][data-run="succeeded"]:not([data-live])`; then the timeline button named `/^Work log · Assistant · Completed/` is visible |

### read-run-record (walked: `session-tasks-read-run-record-mock-20261123`)

Entry: `response-completed`. Let `panel = page.getByRole('region', { name: 'Panel', exact: true })`, `runTab = panel.getByRole('tabpanel', { name: 'Run #1', exact: true })`, `views = runTab.getByRole('tablist', { name: 'Run views', exact: true })`.

| Transition | Do | Wait for |
|---|---|---|
| `turn.open-run` | `getByTestId('chat-timeline').getByRole('button', { name: 'Run #1', exact: true }).click()` | `panel.getByRole('tablist', { name: 'Panel tabs', exact: true }).getByRole('tab', { name: 'Run #1', exact: true, selected: true })` and `views.getByRole('tab', { name: 'Graph', exact: true, selected: true })`; the group `Run graph` names each role with its state |
| `run-view.results` | `views.getByRole('tab', { name: 'Results', exact: true }).click()` | that tab selected, and `runTab.getByRole('table', { name: 'Results', exact: true })` |
| `result-list.other-view` | `views.getByRole('tab', { name: 'Graph', exact: true }).click()` | `Graph` selected |

### see-roles (walked: `session-tasks-see-roles-mock-20261123`)

Entry: `conversation-running`. Let `bar = page.getByTestId('activity-bar')`.

| Transition | Do | Wait for |
|---|---|---|
| `activity.expand` | `bar.getByRole('button', { name: 'Activity details', exact: true }).click()` | the same button with `expanded: true`, and `bar.getByRole('list', { name: 'Roles', exact: true })`; each row names a role, its state and `View` / `Join here` |

### join-run (walked: `session-tasks-join-run-mock-20261123`)

Entry: `conversation-running`, and first wait until `getByTestId('composer-destination')` reads `Send to: Run #1 · Assistant · Join`. Before that the box has no target, and `Send` starts a new request instead of joining.

| Transition | Do | Wait for |
|---|---|---|
| `run.join` | fill the combobox `Request`, then `req.getByRole('button', { name: 'Send', exact: true }).click()` | `getByTestId('chat-timeline').getByText('Waiting to join · read at the next step', { exact: true })` |

### stop-run, scenario several-roles (walked: `session-tasks-stop-run-mock-20261123-several-roles`)

Entry: `conversation-running`, with nothing typed. Let `dialog = page.getByRole('dialog', { name: 'Stop the run', exact: true })`.

| Transition | Do | Wait for |
|---|---|---|
| `run.stop-ask` | `page.getByTestId('composer-stop').click()` (named `Stop`) | `dialog`, holding `Keep running` and `Stop the run` |
| `stop-confirm.confirm` | `dialog.getByRole('button', { name: 'Stop the run', exact: true }).click()`: the dialog's title has the same name, so scope the button to it | `[data-testid="activity-bar"][data-run="cancelled"]:not([data-live])`; the work log reads `Work log · Assistant · Cancelled · …` |

The default scenario's `run.stop` lands on `stop-confirm` instead and is recorded as diverged (`session-tasks-stop-run-mock-20261123`); pass `elsewhere: { 'stop-confirm': () => dialog }` to `step()` so the record names it.

### Not walked yet

Read from the code at e9ca894f, or seen once while probing without a run record. Confirm each when you walk it, then move it into a walked section with its run.

- **choose-team.** `team.open`: `req.getByRole('combobox', { name: 'Corral', exact: true })`; a listbox opens with the options `No Corral …`, `Auto …` and `Create or manage Corrals`. Option names carry a hint after the name, so match with `/^Auto/`. `team-menu.close`: Escape.
- **choose-model.** `model.open`: `req.getByRole('button', { name: 'Model', exact: true })` opens the dialog `Model settings`. On a no-model server its only option is `model-a, Unavailable profile`, disabled, so `model.choose` cannot be reached in mode (b).
- **stop-run, the other Stop.** With text in the box, Stop is only in the open bar: `bar.getByRole('region', { name: 'Reins' }).getByRole('button', { name: 'Stop', exact: true })` (the `expanded.*` transitions). `stop-confirm.keep` is the dialog's `Keep running`.
- **follow-active-run.** It needs run #1 ended and run #2 going in one conversation. At 1280x800 the earlier run's tab opens beside the conversation, which is the map's scenario `room`. The line with `View active run` (`getByTestId('run-active-elsewhere')`) shows only while the panel covers the conversation, as a drawer or maximized (`Maximize panel`).
- **open-file.** It needs a linked folder. Files opens with `/files` in the request box or from the panel's empty list, not from a top button. Tree rows are `treeitem`s, and the tree is virtualized.

## Gotchas

- **Repeated names.** `Run #1` is a timeline button, the region of that turn, a panel tab and that tab's tabpanel, so scope every locator. `New conversation` is both a main-area button and a sidebar link. `Results` is a run view, a panel tab, and both a region and a table inside the run tab.
- **Two Results screens.** The `Results` run view lists results in the table `Results`. The answer's `Open in Results` link (a link, not a button) opens the reader instead: a region `Results` with an article per result. They are different map states (`result-list`, `result-reader`).
- **Hidden text in the activity bar.** It holds screen-reader-only lines such as `Run status: Working` and an alert. `isVisible()` and `checkVisibility()` both return true for them (a 1x1 box clipped by `clip-path: inset(50%)`); the skeleton's `shown` returns false for them and true for the visible `2 roles working · …` line.
- **Run state is on attributes.** The activity bar's `data-run` (`working`, `succeeded`, `cancelled`, …) and `data-live` are the exact states to wait on. The sidebar row of the open conversation showed a spinner-like icon after its run had completed; do not read run state from the sidebar.
- **Address.** Opening a run tab puts `?view=run&panel=run&run=…` in the address; closing the tab leaves `?compose=true`. Start every journey from `New conversation` in a fresh page, never from a reused address.
- **Sliding pill.** The `Run views` pill slides after a click. A screenshot taken at once can catch it between tabs, and Playwright's `animations: 'disabled'` froze it on the wrong tab. The skeleton's wait for finite animations fixes the picture. `aria-selected` is the evidence either way.
- **Mock delay.** At 1500 a live run lasts a few seconds, which is enough for the running entries if you act right after `data-live` appears. Tens of seconds make a stop end unconfirmed; this is reported from an earlier walk and was not re-checked here.
- **The stop dialog outlives the run.** Left open, `Stop the run` stays on screen after the scripted run has finished on its own (seen once, Run #1 "Completed" behind the dialog).
- **The list grows.** Each walk leaves its conversation in the sidebar of the same server. Restart the server on a new scratch workspace when a journey needs an empty list.
