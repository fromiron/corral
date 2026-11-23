---
name: verify-corral
description: "Shows a change working in the real Corral Studio UI and leaves evidence: launches Studio against a server that cannot call a model, drives it headless with Playwright, and records a map-flows run per journey walked. Use when a change to Studio or the server should be seen working in the browser, when a claim about a screen needs a run behind it, or when a flow map's journeys are to be walked. Not for desktop (Electron) checks, for runs against a real model provider, or as a stand-in for unit, integration or E2E tests."
---

# Verify Corral

A test passing says the test passed. This skill shows the change in the browser Studio, one journey at a time, and leaves a run record for each journey walked.

Everything here runs from the checkout under test (a worktree is fine). Handles are in **English**: the e2e helpers in `apps/studio/e2e/workbench.ts` read `packages/react/src/messages/en.json`, and the walk pins Studio to `en`.

## 1. Launch

Pick one mode.

| Mode | Use for | Cannot show |
|---|---|---|
| (a) In-browser simulated runtime | Screens and flows that need no server: layout, navigation, the composer, the demo's simulated runs | Anything the server owns: storage across reloads, files and folders, settings that persist, real run events, the security boundary |
| (b) No-model server + Vite | Everything else in the browser Studio | Answers from a real model, provider sign-in, live search, local AI installs, anything outside the browser |

The desktop app (Electron) is not covered; its existing checks are the smoke scripts in `apps/desktop/scripts/` (`smoke.ts`, `native-smoke.ts`).

Ports 4317, 4318, 5173, 5174, 5179, 6006, 6007 and 4400 belong to other work on the machine. Never use them, and never stop a process you did not start. Both modes take private ports chosen at launch.

Each shell call may start a fresh shell, so the first call writes every value to `$VERIFY/env` and later calls start with `. <that file>`.

**Set up (both modes).** From the root of the checkout under test:

```sh
VERIFY=$(mktemp -d "${TMPDIR:-/tmp}/corral-verify.XXXXXX")
mkdir -p "$VERIFY/workspace" "$VERIFY/home" "$VERIFY/shots"
PORTS=$(node -e 'const n=require("node:net");const a=[n.createServer(),n.createServer()];let k=0;for(const s of a)s.listen(0,"127.0.0.1",()=>{if(++k===2){console.log(a.map(x=>x.address().port).join(" "));a.forEach(x=>x.close())}})')
printf 'REPO=%s\nVERIFY=%s\nSERVER_PORT=%s\nSTUDIO_PORT=%s\n' "$(pwd)" "$VERIFY" "${PORTS% *}" "${PORTS#* }" > "$VERIFY/env"
cat "$VERIFY/env"
```

Run Doctor checks 1 to 4 (section 2) now; nothing starts until they pass.

**Mode (a).** Vite alone, as `pnpm dev` runs it, on the private port:

```sh
. <VERIFY>/env; cd "$REPO/apps/studio"
env -u CORRAL_SERVER node node_modules/vite/bin/vite.js --port "$STUDIO_PORT" --strictPort > "$VERIFY/studio.log" 2>&1 &
echo "STUDIO_PID=$!" >> "$VERIFY/env"
```

Open `http://localhost:$STUDIO_PORT/`. There is no server and no bootstrap link.

**Mode (b).** The server first, with every home-derived directory pointed into the scratch folder, so it finds no stored sign-in or provider key and writes nothing under the real home. Then Vite, proxying `/api` to it, as `pnpm dev --live` does but on private ports:

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

The page is opened on Vite's origin with the server's token: `http://localhost:$STUDIO_PORT/#bootstrap=<token>`, the token taken from the link in `$VERIFY/server.log`. Never print the token into a record.

`--mock-delay` is how long each simulated agent turn waits, in ms. At 1500 the default scripted run (an Assistant and two Helper executions) is live for about six seconds, long enough to act on a running conversation. Use a few hundred ms when only finished runs matter. Never use tens of seconds: a stop cannot interrupt the delay, so the run ends unconfirmed. To change it, or when a long-lived server stops finishing runs, restart the server instead of waiting: `kill $SERVER_PID`, then run only the server's lines of the block above (from `. <VERIFY>/env; cd "$REPO"` to the `SERVER_PID` line) with the new delay. The same port and workspace are kept, the new `SERVER_PID` is appended, and the last line of `env` wins.

## 2. Doctor

Pass every check before driving. A failed check is fixed or reported, never skipped. Start each call with `. <VERIFY>/env`.

1. **Dependencies.** `test -x "$REPO/apps/studio/node_modules/.bin/vite" && echo deps ok` prints `deps ok`. If not, run `pnpm install --frozen-lockfile --offline` in `$REPO`.
2. **Browser.** `cd "$REPO/apps/studio" && node -e "require('@playwright/test').chromium.launch().then(b=>{console.log('chromium',b.version());return b.close()})"` prints `chromium <version>`.
3. **Ports free**, before launch: `ss -ltnH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"` prints nothing.
4. **No other Vite on this checkout**, before launch: the command below prints nothing. Two Vites in one checkout share `node_modules/.vite` and re-optimize under each other, which can disturb someone else's dev server; verify from a separate worktree instead.

   ```sh
   for p in $(pgrep -f '[v]ite/bin/vite'); do readlink "/proc/$p/cwd"; done | grep -Fx "$REPO/apps/studio"
   ```

5. **Listeners are yours**, after launch: `ss -ltnpH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"` shows one line per port, with `pid=$SERVER_PID` and `pid=$STUDIO_PID` (mode a: the Studio port only). Vite may listen on `[::1]` only; that is fine.
6. **Server answers**, mode (b): `curl -s "http://127.0.0.1:$SERVER_PORT/api/v1/health"` prints JSON with `"ok":true` and `"live":false`.
7. **No live model**, mode (b): these print `204`, then `[]`, then `[]`.

   ```sh
   TOKEN=$(sed -n 's/.*#bootstrap=\([A-Za-z0-9_-]*\).*/\1/p' "$VERIFY/server.log")
   curl -s -o /dev/null -w '%{http_code}\n' -c "$VERIFY/cookies" -H "Origin: http://127.0.0.1:$SERVER_PORT" \
     -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" "http://127.0.0.1:$SERVER_PORT/api/v1/session"
   curl -s -b "$VERIFY/cookies" "http://127.0.0.1:$SERVER_PORT/api/v1/model-profiles"; echo
   curl -s -b "$VERIFY/cookies" "http://127.0.0.1:$SERVER_PORT/api/v1/model-auth"; echo
   ```

   Anything but `[]` means a model could be called: stop, clean up, and find what leaked before going on. Starting a run against a real provider is outside this skill; AGENTS.md says who may.
8. **Studio serves this tree.** `readlink "/proc/$STUDIO_PID/cwd"` prints `$REPO/apps/studio`, and `curl -s "http://localhost:$STUDIO_PORT/" | grep -c 'corral-runtime" content="server'` prints `1` in mode (b), `0` in mode (a). From the checkout root, note `git rev-parse HEAD` and `git status --short` now: together they name what the walk saw. A Vite left running across a merge can serve old modules; that is why this skill always launches its own.
9. **Viewport, locale, runtime.** The drive script's first two lines of output (section 3) read `1280x800 en` and `Corral menu · Local · simulated` in mode (b), `Corral menu · Demo · simulated` in mode (a).

## 3. Drive

Write each journey's walk as its own Node script in `$VERIFY`, never in the repository, named after the journey, and run it with `cd "$VERIFY" && node <journey>.mjs`. Start from this skeleton:

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
const walk = new URL(import.meta.url).pathname.split('/').pop().replace(/\.mjs$/, ''); // one script per journey
const steps = [];
let n = 0;
/** Finite animations and transitions have ended; spinners and scroll-driven effects run on. */
const still = () => !document.getAnimations().some((a) => { const t = a.effect?.getComputedTiming(); return a.playState === 'running' && typeof t?.duration === 'number' && t.iterations !== Infinity; });
/** One transition: act, wait for the state it should land on, screenshot, note what was seen. */
async function step(transition, act, landed, seen) {
  const shot = `${env.VERIFY}/shots/${walk}-${String(++n).padStart(2, '0')}-${transition}.png`;
  try {
    await act();
    await landed();
    steps.push({ transition, result: 'reached', evidence: await seen(), shot });
  } catch (error) {
    steps.push({ transition, result: 'did not land', evidence: String(error.message).split('\n')[0], shot });
    throw error;
  } finally {
    await page.waitForFunction(still, null, { timeout: 5_000 }).catch(() => {}); // a sliding tab pill is not the state
    await page.screenshot({ path: shot }); // not animations: 'disabled', which froze the pill on the wrong tab
  }
}
try {
  await page.goto(`http://localhost:${env.STUDIO_PORT}/${token ? '#bootstrap=' + token : ''}`);
  await page.getByRole('banner').waitFor({ timeout: 20_000 });
  console.log(await page.evaluate(() => `${innerWidth}x${innerHeight} ${document.documentElement.lang}`));
  console.log(await page.getByRole('button', { name: /^Corral menu · / }).getAttribute('aria-label'));
  // the journey's steps go here, each through step(...)
} finally {
  writeFileSync(`${env.VERIFY}/${walk}.steps.json`, JSON.stringify({ steps, errors }, null, 2));
  await browser.close();
}
```

`<journey>.steps.json` holds your notes, not the record. The run record is written from it (section 4): a step marked `did not land` becomes `diverged` with the state actually seen, or `blocked` when the control could not be operated, and the walk stops there.

Rules for the steps, from [the testing guide](../../../docs/guides/testing.md) ("추가·수정 기준"):

- Locate by role and accessible name (`getByRole('button', { name: 'Send', exact: true })`), scoped to a landmark or region when a name repeats. A test id or CSS selector only where the feature file names one.
- Act on the real handle. No `force`, no dispatched DOM events, no `waitForTimeout`, no raised timeouts to get past a covered or wrong target.
- After each action wait for one exact state: a role and name becoming visible, `aria-selected` or `aria-expanded` changing, an address matching a pattern. Then take the screenshot.
- Before writing that something "is shown", check it is visible (`toBeVisible`, `isVisible`). Text content includes screen-reader-only lines.
- Compute any expected date or number format in the page (`page.evaluate`), not in Node: their ICU data differ.
- Start each journey from a fresh conversation in a fresh page. Settle any run a journey needs before its entry state with plain steps that are not recorded.
- Look at every screenshot (open the image) before you describe it.

Finding the handles for a journey, in this order:

1. The feature file for the area in [features/](features/): its Handles section gives, per journey and transition id, the locator that worked and the state to wait for.
2. The flow map, when the checkout has one (see Evidence): the transition's `action`, `from` and `to`, and its evidence `ref` into the code.
3. The code: the component the ref names and the English string in `packages/react/src/messages/en.json`. A quick way to see the names on a screen is `console.log(await page.getByRole('main').ariaSnapshot())`.

When the walk finds a handle that the feature file lacks or gets wrong, fix the feature file in the same change.

## 4. Evidence

A verification leaves one [map-flows](../../../apps/server/resources/builtin/design/skills/map-flows/SKILL.md) run record per journey walked, written to the run schema (`assets/flow-run.schema.json` in that skill; read its `references/recording-runs.md` once).

**Where it goes.** The flow maps are not in Git; they live in the main checkout's `ux-flows/`, when it has one:

```sh
git rev-parse --path-format=absolute --git-common-dir      # prints <main checkout>/.git
find <main checkout>/ux-flows -maxdepth 1 -name '*.flow.json'
```

Below, `$MAPS` stands for that `ux-flows` folder.

- With the map: save the run as `$MAPS/runs/<map>-<journey>-<mode>-<yyyymmdd>.run.json` (`mode` is `mock` for (b), `demo` for (a); add a word if the name is taken). Runs are a log: never edit or delete an existing run file. Then validate and analyze from the map-flows folder:

  ```sh
  cd "$REPO/apps/server/resources/builtin/design/skills/map-flows"
  python3 -B scripts/validate_flow.py "$MAPS/<map>.flow.json"
  python3 -B scripts/analyze_flow.py "$MAPS/<map>.flow.json" --revision "<full HEAD hash noted in Doctor>"
  ```

  `-B` keeps Python from leaving a `__pycache__` folder in the repository. The validator must report `"valid": true`. A run that cites a transition the map lacks is a defect in the run or the map: fix the map in Inspect mode, never the run's facts.
- Without the map: keep the run in `$VERIFY`, say in the report that it was not validated against a map, and paste it into the report before Cleanup deletes the folder.

**What goes in it.** `revision` is the full `git rev-parse HEAD`; say in `limitations` if `git status` showed uncommitted changes. `method` `browser-automation`; `tool` `Playwright <version> (Chromium <version>)`; `environment` `{target, viewport: "1280x800", input: "pointer", locale: "en"}`, where `target` names the mode and mock delay in words, never a path or port. One step per transition, in walk order, with `reached`, `diverged` (and the real `landed` state), `blocked` or `unmapped` as it happened, and `evidence` saying what was visible afterwards. A step that did not land is recorded as it happened and the run ends there with its honest outcome. `limitations` lists what the run cannot show: the simulated agents, one viewport, pointer only, no assistive technology.

No message bodies beyond the synthetic request you typed, no credentials, tokens, cookies, ports or local paths in any record. Screenshots stay in `$VERIFY/shots` and never enter the repository; if the person wants them kept, move the folder where they say before Cleanup.

**Reporting.** Each claim about the UI points at a run and a step (`session-tasks-send-request-mock-20261123`, step 2). List the journeys, scenarios and transitions you did not walk, and the Doctor checks that were not possible. Keep "ran" apart from "read in the code".

## 5. Cleanup

Stop exactly the processes you started, by pid, and leave nothing behind:

```sh
. <VERIFY>/env
kill $STUDIO_PID ${SERVER_PID:-}; sleep 2
ps -o pid= -p "$STUDIO_PID,${SERVER_PID:-$STUDIO_PID}"              # expect no output
ss -ltnH "( sport = :$SERVER_PORT or sport = :$STUDIO_PORT )"         # expect no output
rm -rf "$VERIFY"
```

If a pid is still alive after the first `kill`, send `kill -9` to that pid only. Never kill by name or by port. Then, from the checkout root, `git status --short` shows only your own changes: no `__pycache__`, no screenshots, no scripts.

## Adding an area

A feature file is `features/<area>.md`, one per area of Studio, written only after its journeys were walked with this skill. It has four sections: **Sub-features**; **How to get to it** (as a user would, from a fresh workspace); **Handles** (per journey and transition id: the locator that worked and the state to wait for); **Gotchas**. Copy the shape of an existing file, and add the area to the list below.

- [features/session.md](features/session.md): the conversation screen, the journeys of the `session-tasks` map.
