import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { expect } from '../server/harness.ts';
import {
  type ChromeMeasure,
  countVisibleLabels,
  createProbe,
  duplicateLabels,
  measureChrome,
  type ShiftResult,
  waitForStill,
} from './probe.ts';

// The final scenes of docs/plans/unified-flow.md §9 (V2): one way to measure a transition, check
// it against the pass marks of §9 "측정", and record it in `test-results/flow/report.json`.
// A scene's interval starts on a still screen, the step that makes the transition happens inside
// it, and it ends once the screen is still again. Every pass mark is a soft assertion, so one run
// reports every interval of a scene; any miss still fails the test.
// Screenshots of each step go to `test-results/flow/<scene>/<step>.png` (the scene's theme) and
// `<step>-dark.png` / `<step>-light.png` (the other one); with CORRAL_FLOW_SHOTS set, a copy of
// each goes to `<CORRAL_FLOW_SHOTS>/<scene>/` as well.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const REPORT = join(OUT, 'report.json');

/** §9 "측정": the pass marks. */
export const MARKS = {
  /** Existing conversation items and sidebar session rows, in their container. */
  shiftPx: 1,
  /** The tail gap while following the end; items on screen while reading above. */
  followPx: 1,
  /** The input box's bottom edge on screen. */
  inputPx: 0,
  /** Top bar + idle composer (with the session totals line). */
  chromePx: 200,
  columnMinPx: 720,
  columnMaxPx: 760,
} as const;

/** A message from the English catalog by its dotted key, `{name}` placeholders filled in. */
export function msg(key: string, values: Record<string, string | number> = {}): string {
  let node: unknown = en;
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== 'string') throw new Error(`no message ${key}`);
  return node.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** A point a held response waits at: `reached` when the response is asked for, then `open`. */
export function hold() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { open, opened, reach, reached };
}

export const probeOptions = {
  itemSelector: '[data-chat-item]',
  rowSelector: '[data-session-row]',
  partSelector: '[data-chat-part]',
  // A needed-now tray after the last item ends the timeline as an item does.
  tailSelector: '[data-chat-item], [data-pending-tray]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

interface SceneReport {
  intervals: Record<string, unknown>;
  chrome?: unknown;
  checks?: Record<string, unknown>;
}

function update(scene: string, change: (entry: SceneReport) => void) {
  mkdirSync(OUT, { recursive: true });
  const report: { scenes: Record<string, SceneReport> } = existsSync(REPORT)
    ? JSON.parse(readFileSync(REPORT, 'utf8'))
    : { scenes: {} };
  const entry = report.scenes[scene] ?? { intervals: {} };
  change(entry);
  report.scenes[scene] = entry;
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

/** Records a fact a scene checked (a time, a count, what a line said) under `checks`. */
export function note(scene: string, name: string, value: unknown) {
  update(scene, (entry) => {
    entry.checks = { ...entry.checks, [name]: value };
  });
}

async function theme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  // The app follows the system theme with the dark class on the root.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(scheme === 'dark');
  await waitForStill(page, { stillMs: 400 });
}

/**
 * Screenshots the screen as it is, in the scene's theme and in the other one, then puts the
 * scene's theme back. Only on a still screen, outside any interval.
 */
export async function shot(page: Page, scene: string, step: string) {
  const dir = join(OUT, scene);
  mkdirSync(dir, { recursive: true });
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const files = [
    { scheme: dark ? 'dark' : 'light', file: `${step}.png` },
    { scheme: dark ? 'light' : 'dark', file: `${step}-${dark ? 'light' : 'dark'}.png` },
  ] as const;
  for (const { scheme, file } of files) {
    if (scheme !== files[0].scheme) await theme(page, scheme);
    await page.screenshot({ path: join(dir, file) });
  }
  await theme(page, files[0].scheme);
  const copy = process.env.CORRAL_FLOW_SHOTS;
  if (copy) {
    mkdirSync(join(copy, scene), { recursive: true });
    for (const { file } of files) copyFileSync(join(dir, file), join(copy, scene, file));
  }
}

export interface MeasureOptions {
  /**
   * Where the person reads: at the followed end (the tail gap holds), above it (the items on
   * screen hold their place on screen), or `jump` when the step itself moves the view on purpose
   * (a sent request going to the end, a quote leading back to its passage): then only the
   * container marks hold. Default: the end.
   */
  at?: 'end' | 'above' | 'jump';
  /**
   * Leave the input line's mark out, with the reason recorded (a change the spec makes on
   * purpose, such as an empty conversation's centred composer going to the bottom).
   */
  inputExempt?: string;
  /** Leave the tail gap's mark out, with the reason recorded. */
  tailExempt?: string;
  /** No shots before and after (a step whose screen a shot would change, such as a selection). */
  noShots?: boolean;
}

export interface Measured {
  result: ShiftResult;
  /** The largest shift of the conversation items and session rows in their container. */
  shift: number | null;
}

/** Elements that moved past `limit` on `axes`, with how far and over how many frames. */
function moved(result: ShiftResult, limit: number, axes: 'container' | 'viewport') {
  return result.items
    .filter((item) => item.kind !== 'part')
    .map((item) => ({
      element: `${item.kind} ${item.id}`,
      px:
        axes === 'container'
          ? Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx)
          : Math.max(item.maxViewportShiftYPx, item.maxViewportShiftXPx),
      frames: item.frames,
      framesMoved: item.framesMoved,
    }))
    .filter((item) => item.px > limit);
}

/**
 * Measures one transition of `scene` that `happen` makes, checks the pass marks, and records it.
 * The screen must be still when this is called.
 */
export async function measure(
  page: Page,
  scene: string,
  name: string,
  happen: () => Promise<void>,
  options: MeasureOptions = {},
): Promise<Measured> {
  const at = options.at ?? 'end';
  if (!options.noShots) await shot(page, scene, `${name}-before`);
  // Following the end needs an end to follow: a conversation shorter than its view stands at
  // the top and grows down without moving, so the tail gap is not a mark there.
  const overflowing = await page.evaluate(() => {
    const timeline = document.querySelector('[data-testid="chat-timeline"]');
    return Boolean(timeline && timeline.scrollHeight > timeline.clientHeight + 1);
  });
  const tailExempt =
    options.tailExempt ?? (overflowing ? undefined : 'the conversation fits its view');
  const probe = createProbe(page, probeOptions);
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  const labels = await countVisibleLabels(page);
  const twice = await duplicateLabels(page);
  if (!options.noShots) await shot(page, scene, `${name}-after`);
  const kept = result.items.filter((item) => item.kind !== 'part');
  const shift = kept.length
    ? Math.max(...kept.flatMap((item) => [item.maxContainerShiftYPx, item.maxContainerShiftXPx]))
    : null;
  const viewport = kept.length
    ? Math.max(...kept.flatMap((item) => [item.maxViewportShiftYPx, item.maxViewportShiftXPx]))
    : null;
  const movedInContainer = moved(result, MARKS.shiftPx, 'container');
  const movedOnScreen = at === 'above' ? moved(result, MARKS.followPx, 'viewport') : [];
  const parts = result.items
    .filter((item) => item.kind === 'part')
    .map((item) => ({
      element: item.id,
      px: Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx),
    }))
    .filter((item) => item.px > MARKS.shiftPx);
  update(scene, (entry) => {
    entry.intervals[name] = {
      at,
      durationMs: result.durationMs,
      frames: result.samples.frames,
      tracked: result.samples.tracked,
      maxShiftPx: shift,
      maxViewportShiftPx: viewport,
      tailGapChangePx: result.maxTailGapChangePx,
      inputBottomChangePx: result.maxInputBottomChangePx,
      labelDuplicates: Object.keys(twice).length,
      labelsTwice: twice,
      unkeyed: labels.unkeyed,
      duplicateIds: result.samples.duplicateIds,
      duplicated: result.duplicated,
      lost: result.lost,
      moved: movedInContainer,
      movedOnScreen,
      // Parts are recorded, not marked: §9 marks the items and rows.
      partsMoved: parts,
      ...(options.inputExempt ? { inputExempt: options.inputExempt } : {}),
      ...(at === 'end' && tailExempt ? { tailExempt } : {}),
    };
  });
  expect(result.samples.frames, `${scene} ${name}: frames`).toBeGreaterThan(0);
  expect.soft(movedInContainer, `${scene} ${name}: existing items and rows moved`).toEqual([]);
  if (at === 'above')
    expect.soft(movedOnScreen, `${scene} ${name}: items moved on screen`).toEqual([]);
  if (at === 'end' && !tailExempt)
    expect
      .soft(result.maxTailGapChangePx ?? 0, `${scene} ${name}: tail gap`)
      .toBeLessThanOrEqual(MARKS.followPx);
  if (!options.inputExempt)
    expect
      .soft(result.maxInputBottomChangePx, `${scene} ${name}: input bottom`)
      .toBe(MARKS.inputPx);
  expect.soft(twice, `${scene} ${name}: a state name for one target on screen twice`).toEqual({});
  expect.soft(labels.unkeyed, `${scene} ${name}: state names without a target`).toBe(0);
  expect.soft(result.duplicated, `${scene} ${name}: identifying values shared`).toEqual([]);
  return { result, shift };
}

/** The state-name marks on the screen as it is now (outside an interval). */
export async function checkLabels(page: Page, scene: string, where: string) {
  const labels = await countVisibleLabels(page);
  const twice = await duplicateLabels(page);
  note(scene, `labels ${where}`, { twice, unkeyed: labels.unkeyed });
  expect.soft(twice, `${scene} ${where}: a state name for one target on screen twice`).toEqual({});
  expect.soft(labels.unkeyed, `${scene} ${where}: state names without a target`).toBe(0);
  // Sidebar session rows say no state name in words (presence.md "한 화면에 한 번").
  const inRows = await page.locator('[data-session-row] [data-presence-label]').count();
  expect.soft(inRows, `${scene} ${where}: state names in sidebar rows`).toBe(0);
  return labels;
}

/** The fixed areas on the idle screen (§9 "고정 영역"), checked and recorded. */
export async function checkChrome(
  page: Page,
  scene: string,
  where: string,
): Promise<ChromeMeasure> {
  await waitForStill(page);
  const chrome = await measureChrome(page);
  const fixed = (chrome.topBarHeightPx ?? Number.NaN) + (chrome.composerHeightPx ?? Number.NaN);
  update(scene, (entry) => {
    entry.chrome = {
      ...(entry.chrome as Record<string, unknown> | undefined),
      [where]: { ...chrome, fixedPx: Math.round(fixed * 100) / 100 },
    };
  });
  const label = `${scene} ${where}`;
  expect.soft(fixed, `${label}: top bar + idle composer`).toBeLessThanOrEqual(MARKS.chromePx);
  expect
    .soft(chrome.columnWidthPx ?? 0, `${label}: column width`)
    .toBeGreaterThanOrEqual(MARKS.columnMinPx);
  expect
    .soft(chrome.columnWidthPx ?? Number.POSITIVE_INFINITY, `${label}: column width`)
    .toBeLessThanOrEqual(MARKS.columnMaxPx);
  return chrome;
}

/**
 * Nothing waits on the person when the scene ends: the server does not clear approval timers
 * when it closes, so an approval or question left open breaks the tests after it.
 */
export function nothingWaiting(
  coordinator: {
    listRuns(): readonly { runId: string }[];
    getSnapshot(runId: string): {
      projection: { status: string; approvals: Record<string, { status: string }> };
    };
  },
  scene: string,
) {
  const open = coordinator.listRuns().flatMap((run) => {
    const { projection } = coordinator.getSnapshot(run.runId);
    const approvals = Object.entries(projection.approvals)
      .filter(([, item]) => item.status === 'pending')
      .map(([id]) => `approval ${id}`);
    // A question (`ask_user`) leaves its run waiting on the person.
    return projection.status === 'awaiting_user'
      ? [...approvals, `run ${run.runId} awaiting_user`]
      : approvals;
  });
  expect(open, `${scene}: approvals or questions left open`).toEqual([]);
}
