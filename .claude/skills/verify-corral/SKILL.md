---
name: verify-corral
description: "Shows a change working in the real Corral Studio UI and leaves evidence: launches Studio against a server that cannot call a model, drives it headless with Playwright, and records a map-flows run per journey walked. Use when a change to Studio or the server should be seen working in the browser, when a claim about a screen needs a run behind it, or when a flow map's journeys are to be walked. Not for desktop (Electron) checks, for runs against a real model provider, or as a stand-in for unit, integration or E2E tests."
---

# Verify Corral

A passing test says the test passed. This skill shows the change in the browser Studio, one journey at a time, and leaves a run record per journey walked.

Run everything from the root of the checkout under test (a worktree is fine). Handles are **English**: the e2e helpers in `apps/studio/e2e/workbench.ts` read `packages/react/src/messages/en.json`, and the walk pins Studio to `en`.

## 1. Launch

| Mode | Use for | Cannot show |
|---|---|---|
| (a) In-browser simulated runtime | Screens that need no server: layout, navigation, the composer, the demo's simulated runs | Anything the server owns: persistence, files and folders, saved settings, real run events, the security boundary |
| (b) No-model server + Vite | Everything else in the browser Studio | Real model answers, provider sign-in, live search, local AI installs; a stop the agent does not answer in time (the agent-unresponsive scenarios need a mock delay of tens of seconds, which this skill rules out) |

The desktop app (Electron) is not covered; its checks are the smoke scripts in `apps/desktop/scripts/`.

Both modes take free ports from the OS, so they never collide with the fixed ports of the repository's own dev commands and test configs (`tools/dev.ts`, `apps/studio/playwright*.config.ts`, `.claude/launch.json`). Never stop a process you did not start.

A shell call may start a fresh shell, so the set-up writes every value to `$VERIFY/env`, and every later call starts with `. <VERIFY>/env` (the path it printed).

```sh
VERIFY=$(mktemp -d "${TMPDIR:-/tmp}/corral-verify.XXXXXX")
mkdir -p "$VERIFY/workspace" "$VERIFY/home" "$VERIFY/shots"
PORTS=$(node -e 'const n=require("node:net");const a=[n.createServer(),n.createServer()];let k=0;for(const s of a)s.listen(0,"127.0.0.1",()=>{if(++k===2){console.log(a.map(x=>x.address().port).join(" "));a.forEach(x=>x.close())}})')
printf 'REPO=%s\nVERIFY=%s\nSERVER_PORT=%s\nSTUDIO_PORT=%s\n' "$(pwd)" "$VERIFY" "${PORTS% *}" "${PORTS#* }" > "$VERIFY/env"
cat "$VERIFY/env"
```

Pass Doctor checks 1 to 4 now; nothing starts before they pass.

**Mode (a)**, Vite alone as `pnpm dev` runs it:

```sh
. <VERIFY>/env; cd "$REPO/apps/studio"
env -u CORRAL_SERVER node node_modules/vite/bin/vite.js --port "$STUDIO_PORT" --strictPort > "$VERIFY/studio.log" 2>&1 &
echo "STUDIO_PID=$!" >> "$VERIFY/env"
```

**Mode (b)**: the server, with every home-derived directory inside the scratch folder so it finds no stored sign-in or key and writes nothing under the real home; then Vite proxying `/api` to it, as `pnpm dev --live` does:

```sh
. <VERIFY>/env; cd "$REPO"
env HOME="$VERIFY/home" XDG_CONFIG_HOME="$VERIFY/home/.config" XDG_DATA_HOME="$VERIFY/home/.local/share" \
    XDG_STATE_HOME="$VERIFY/home/.local/state" XDG_CACHE_HOME="$VERIFY/home/.cache" CODEX_HOME="$VERIFY/home/.codex" \
  node apps/server/src/main.ts --workspace "$VERIFY/workspace" --port "$SERVER_PORT" \
    --allow-origin "http://localhost:$STUDIO_PORT" --no-live --mock-delay 1500 > "$VERIFY/server.log" 2>&1 &
echo "SERVER_PID=$!" >> "$VERIFY/env"
cd apps/studio
env CORRAL_SERVER="http://127.0.0.1:$SERVER_PORT" node node_modules/vite/bin/vite.js --port "$STUDIO_PORT" --strictPort > "$VERIFY/studio.log" 2>&1 &
echo "STUDIO_PID=$!" >> "$VERIFY/env"
```

The page opens on Vite's origin with the token from the link in `server.log` (the skeleton in section 3 does this). Never put the token in a record.

`--mock-delay` is each simulated agent turn's wait in ms. At 1500 the default scripted run (an Assistant and two Helper executions) is live for about six seconds. Use a few hundred ms when only finished runs matter; never tens of seconds, since a stop cannot interrupt the delay. To change it, or when a long-lived server stops finishing runs, `kill $SERVER_PID` and run only the server lines above again (through the `SERVER_PID` line); the appended `SERVER_PID` wins.

## 2. Doctor

Every check passes before driving; a failed one is fixed or reported, never skipped.

1. **Dependencies.** `test -x "$REPO/apps/studio/node_modules/.bin/vite" && echo deps ok` prints `deps ok`. Otherwise run `pnpm install --frozen-lockfile --offline` in `$REPO`.
2. **Browser.** `cd "$REPO/apps/studio" && node -e "require('@playwright/test').chromium.launch().then(b=>{console.log('chromium',b.version());return b.close()})"` prints `chromium <version>`. If Chromium is missing, run `pnpm --filter @corral/studio exec playwright install --with-deps chromium` (as CI does), or without `--with-deps` when the system libraries are present.
3. **Ports free.** `ss -ltnH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"` prints nothing.
4. **No other Vite on this checkout.** This prints nothing. Two Vites in one checkout share `node_modules/.vite` and re-optimize under each other; verify from another worktree instead.

   ```sh
   for p in $(pgrep -f '[v]ite/bin/vite'); do readlink "/proc/$p/cwd"; done | grep -Fx "$REPO/apps/studio"
   ```

5. **Listeners are yours.** `ss -ltnpH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"` shows `pid=$SERVER_PID` and `pid=$STUDIO_PID` (mode a: the Studio port only). Vite may listen on `[::1]` only.
6. **Server answers** (b). `curl -s "http://127.0.0.1:$SERVER_PORT/api/v1/health"` prints JSON with `"ok":true` and `"live":false`.
7. **No live model** (b). These print `204`, `[]`, `[]`. Anything else means a model could be called: clean up and find the leak first. Runs against a real provider are outside this skill; AGENTS.md says who may start them.

   ```sh
   TOKEN=$(sed -n 's/.*#bootstrap=\([A-Za-z0-9_-]*\).*/\1/p' "$VERIFY/server.log")
   curl -s -o /dev/null -w '%{http_code}\n' -c "$VERIFY/cookies" -H "Origin: http://127.0.0.1:$SERVER_PORT" \
     -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" "http://127.0.0.1:$SERVER_PORT/api/v1/session"
   curl -s -b "$VERIFY/cookies" "http://127.0.0.1:$SERVER_PORT/api/v1/model-profiles"; echo
   curl -s -b "$VERIFY/cookies" "http://127.0.0.1:$SERVER_PORT/api/v1/model-auth"; echo
   ```

8. **Studio serves this tree.** `readlink "/proc/$STUDIO_PID/cwd"` prints `$REPO/apps/studio`; `curl -s "http://localhost:$STUDIO_PORT/" | grep -c 'corral-runtime" content="server'` prints `1` in (b), `0` in (a). Note `git rev-parse HEAD` and `git status --short`: they name what the walk saw. Launching fresh is what keeps a Vite from serving modules older than a merge.
9. **Viewport, locale, runtime.** The walk script's first two output lines are `1280x800 en` and `Corral menu · Local · simulated` in (b), `Corral menu · Demo · simulated` in (a).

## 3. Drive

One Node script per journey, in `$VERIFY` and never in the repository, named after the journey: `cd "$VERIFY" && node <journey>.mjs`. Start from this skeleton:

```js
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('./env', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s)));
const { chromium } = createRequire(env.REPO + '/apps/studio/package.json')('@playwright/test');
const serverLog = env.VERIFY + '/server.log'; // mode (b) only; mode (a) has no token
const token = existsSync(serverLog) ? /#bootstrap=([A-Za-z0-9_-]+)/.exec(readFileSync(serverLog, 'utf8'))?.[1] : undefined;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC' });
await context.addInitScript(() => localStorage.setItem('corral:locale', 'en'));
await context.route('**/*', (r) => (['localhost', '127.0.0.1'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort('blockedbyclient')));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const walk = new URL(import.meta.url).pathname.split('/').pop().replace(/\.mjs$/, '');
/** On screen for a sighted person; isVisible() and checkVisibility() are also true for sr-only text. */
const shown = (el) => { if (!el.checkVisibility()) return false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e), r = e.getBoundingClientRect(); if (s.clipPath === 'inset(50%)' || (s.overflow === 'hidden' && r.width <= 1 && r.height <= 1)) return false; } return true; };
/** Finite animations and transitions have ended; spinners and scroll-driven effects run on. */
const still = () => !document.getAnimations().some((a) => { const t = a.effect?.getComputedTiming(); return a.playState === 'running' && typeof t?.duration === 'number' && t.iterations !== Infinity; });
const steps = [];
const shots = [];
let at = '<entry state id>'; // set once the journey's entry is reached
/** One map transition. elsewhere: {stateId: () => locator} for other states it may land on. A step not reached ends the walk. */
async function step({ transition, to, act, arrive, seen, elsewhere = {} }) {
  const why = (e) => String(e.message).split('\n')[0];
  let record;
  try {
    await act();
    await arrive().then(async () => (record = { transition, result: 'reached', landed: to, evidence: await seen().catch(why) }), async (e) => {
      let landed;
      for (const [id, locator] of Object.entries(elsewhere)) if (await locator().isVisible()) { landed = id; break; }
      record = { transition, result: 'diverged', landed, evidence: `Did not reach ${to} (${why(e)}); ${landed ? `${landed} is showing` : 'name the state from the screenshot'}.` };
    });
  } catch (e) {
    record ??= { transition, result: 'blocked', landed: at, evidence: `Could not perform it: ${why(e)}` };
  }
  await page.waitForFunction(still, null, { timeout: 5_000 }).catch(() => {}); // a sliding tab pill is not the state
  shots.push(`${env.VERIFY}/shots/${walk}-${String(steps.length + 1).padStart(2, '0')}-${transition}.png`);
  await page.screenshot({ path: shots.at(-1) }); // not animations: 'disabled', which froze the pill on the wrong tab
  steps.push(record);
  at = record.landed;
  if (record.result !== 'reached') throw new Error(`walk ended: ${transition} ${record.result}`);
}
try {
  await page.goto(`http://localhost:${env.STUDIO_PORT}/${token ? '#bootstrap=' + token : ''}`);
  await page.getByRole('banner').waitFor({ timeout: 20_000 });
  console.log(await page.evaluate(() => `${innerWidth}x${innerHeight} ${document.documentElement.lang}`));
  console.log(await page.getByRole('button', { name: /^Corral menu · / }).getAttribute('aria-label'));
  // reach the entry state with unrecorded steps, set `at`, then one step({...}) per transition
} finally {
  writeFileSync(`${env.VERIFY}/${walk}.steps.json`, JSON.stringify({ steps, shots, errors }, null, 2));
  await browser.close();
}
```

`<journey>.steps.json` holds `steps` already in the run record's step shape (`transition`, `result`, `landed`, `evidence`), the screenshot paths and the page errors. A diverged step names its `landed` state when one of `elsewhere` showed; otherwise name it from the screenshot. Rewrite any `evidence` that does not say what was visible.

Rules, from the [testing guide](../../../docs/guides/testing.md) ("추가·수정 기준"):

- Locate by role and accessible name, scoped to a region when a name repeats. A test id only where the feature file names one.
- Act on the real handle: no `force`, no dispatched events, no `waitForTimeout`, no raised timeouts to get past a covered target.
- After each action wait for one exact state: a role and name appearing, `aria-selected` or `aria-expanded` changing, an attribute such as `data-run`, an address pattern.
- Say something "is shown" only after `await locator.evaluate(shown)` is true. `isVisible()` and `checkVisibility()` are also true for screen-reader-only text.
- Compute expected dates and numbers in the page (`page.evaluate`), not in Node; their ICU data differ.
- Start each journey with `New conversation` in a fresh page. Reach a journey's entry with unrecorded steps, then set `at`.
- Open every screenshot before describing it.

Handles for a journey, in this order: the area's feature file in [features/](features/) (per journey and transition id: what to do and what to wait for); the flow map's transition (`action`, `from`, `to`, and the code `ref`); the code and `en.json`. `console.log(await page.getByRole('main').ariaSnapshot())` lists the names on a screen. A handle the walk corrects goes into the feature file in the same change.

## 4. Evidence

Each journey walked leaves one [map-flows](../../../apps/server/resources/builtin/design/skills/map-flows/SKILL.md) run record (`assets/flow-run.schema.json` there; read `references/recording-runs.md` once). The maps are not in Git: `git rev-parse --path-format=absolute --git-common-dir` prints `<main checkout>/.git`, and the maps, when there are any, are `<main checkout>/ux-flows/*.flow.json` with runs in `ux-flows/runs/`. Below, `$MAPS` is that folder.

**The record.** Name it `<map>-<journey>[-<scenario>]-<mode>-<yyyymmdd>` (scenario left out for `default`; mode `mock` for (b), `demo` for (a); add a word if taken) and save it as `<name>.run.json`:

```json
{ "schema_version": "1.0", "run": "<name>", "map": "<map>", "journey": "<journey>", "scenario": "default",
  "recorded_at": "<yyyy-mm-dd>", "revision": "<full git rev-parse HEAD>", "method": "browser-automation",
  "tool": "Playwright <version> (Chromium <version>)",
  "environment": { "target": "<mode and mock delay in words, no path or port>", "viewport": "1280x800", "input": "pointer", "locale": "en" },
  "steps": [ "<the steps array of <journey>.steps.json>" ],
  "outcome": "success | failure | blocked | abandoned", "success_evidence": "<only for success>",
  "limitations": [ "simulated agents", "one viewport, pointer only, no assistive technology", "uncommitted changes, if git status showed any" ] }
```

A step that did not land is recorded as it happened, and the run ends there with its honest outcome. When a step lands on a state the map reaches under another scenario's facts (the map's `requires` show which), record that divergence, then walk the scenario whose facts held as its own run.

**Where it goes, then validate:**

- Map present and writable: save into `$MAPS/runs/`. Never edit or delete an existing run.
- Map present but not writable (an isolated worktree's tool may refuse writes into the main checkout): copy `$MAPS/<map>.flow.json` and `$MAPS/runs/*.run.json` into `$VERIFY/maps/` and `$VERIFY/maps/runs/`, add your runs there, and validate the copy. Paste the records into the report and say they were not saved.
- No map: keep the record in `$VERIFY`, paste it into the report, and say it was not validated against a map.

```sh
cd "$REPO/apps/server/resources/builtin/design/skills/map-flows"
python3 -B scripts/validate_flow.py <maps folder>/<map>.flow.json
python3 -B scripts/analyze_flow.py <maps folder>/<map>.flow.json --revision "<full HEAD hash>"
```

The validator must print `"valid": true`; `-B` keeps a `__pycache__` out of the repository. A run citing a transition the map lacks means the map needs an Inspect-mode fix; never change what a run records.

No message bodies beyond the synthetic request you typed, and no credentials, tokens, cookies, ports or local paths in any record. Screenshots stay in `$VERIFY/shots`; if the person wants them, move them where they say before Cleanup.

**Report.** Each claim about the UI points at a run and step (`session-tasks-send-request-mock-20261123`, step 2). List what was not walked (journeys, scenarios, transitions) and any Doctor check that could not run. Keep "ran" apart from "read in the code".

## 5. Cleanup

```sh
. <VERIFY>/env
kill $STUDIO_PID ${SERVER_PID:-}; sleep 2
ps -o pid= -p "$STUDIO_PID,${SERVER_PID:-$STUDIO_PID}"              # expect no output
ss -ltnH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"         # expect no output
rm -rf "$VERIFY"
```

A pid still alive after `kill` gets `kill -9`, that pid only; never kill by name or port. Then `git status --short` at the checkout root shows only your own changes.

## Adding an area

`features/<area>.md`, written only after its journeys were walked, has four sections: **Sub-features**; **How to get to it** (as a user would, from a fresh workspace, and which scenarios each launch mode produces); **Handles** (per journey and transition id); **Gotchas**. Copy an existing file's shape and list it here.

- [features/session.md](features/session.md): the conversation screen, the `session-tasks` map's journeys.
