import { beforeEach, expect, it } from 'vitest';
import { BROWSER_STEPS, SAMPLE_PULLS } from './fixture.ts';
import {
  answerPull,
  initialPreviewState,
  postComment,
  previewStore,
  resetPreviews,
  runBrowserStep,
  showBrowserStep,
} from './store.ts';

// The preview store holds only what a person changed in the sample flows; the fixture stays the
// definition of the sample data, and Reset returns to it (docs/specs/features/feature-preview.md).

const pristine = JSON.stringify({ SAMPLE_PULLS, BROWSER_STEPS });
const withoutResets = () => {
  const { resets: _resets, ...state } = previewStore.getState();
  return state;
};
const fixtureState = () => {
  const { resets: _resets, ...state } = initialPreviewState();
  return state;
};

beforeEach(() => resetPreviews());

const open = SAMPLE_PULLS.find((pull) => pull.state === 'open');
const merged = SAMPLE_PULLS.find((pull) => pull.state === 'merged');

it('starts from the fixture, with nothing simulated yet', () => {
  expect(withoutResets()).toEqual(fixtureState());
  const state = previewStore.getState();
  // Only the pull request review and browser QA flows keep state; there is no task board.
  expect(Object.keys(state).sort()).toEqual(['browser', 'resets', 'review']);
  expect(state.review.answers).toEqual({});
  expect(state.review.comments).toEqual({});
  expect(state.browser.progress).toBe(0);
});

it('keeps a posted comment trimmed, and ignores an empty one or an unknown pull request', () => {
  if (!open) throw new Error('fixture has no open pull request');
  postComment(open.number, '  Please keep the rounding rule in one place.  ', 1);
  postComment(open.number, '   ', 2);
  postComment(9999, 'Lost', 3);
  expect(previewStore.getState().review.comments).toEqual({
    [open.number]: [
      { id: `${open.number}-1`, body: 'Please keep the rounding rule in one place.', at: 1 },
    ],
  });
});

it('answers an open pull request once; a duplicate, an empty fix request or a merged one is ignored', () => {
  if (!open || !merged) throw new Error('fixture needs an open and a merged pull request');
  answerPull(open.number, { kind: 'fixes', feedback: '   ' });
  expect(previewStore.getState().review.answers).toEqual({});
  answerPull(open.number, { kind: 'fixes', feedback: ' Round half-cents up. ' });
  answerPull(open.number, { kind: 'approved' });
  answerPull(merged.number, { kind: 'approved' });
  expect(previewStore.getState().review.answers).toEqual({
    [open.number]: { kind: 'fixes', feedback: 'Round half-cents up.' },
  });
});

it('runs the browser QA steps only in order, each once, and shows only a reached step', () => {
  runBrowserStep('snapshot');
  expect(previewStore.getState().browser.progress).toBe(0);
  showBrowserStep('console');
  expect(previewStore.getState().browser.step).toBe('open');
  runBrowserStep('open');
  runBrowserStep('open');
  // The result stays in view; moving on is the person's choice.
  expect(previewStore.getState().browser).toEqual({ progress: 1, step: 'open' });
  showBrowserStep('act');
  expect(previewStore.getState().browser.step).toBe('open');
  showBrowserStep('snapshot');
  expect(previewStore.getState().browser.step).toBe('snapshot');
  for (const step of BROWSER_STEPS.slice(1)) runBrowserStep(step);
  expect(previewStore.getState().browser.progress).toBe(BROWSER_STEPS.length);
  showBrowserStep('attach');
  expect(previewStore.getState().browser.step).toBe('attach');
});

it('returns to the fixture state on reset, without touching the fixture', () => {
  if (!open) throw new Error('fixture needs an open pull request');
  const before = previewStore.getState().resets;
  postComment(open.number, 'A note', 1);
  answerPull(open.number, { kind: 'approved' });
  for (const step of BROWSER_STEPS) runBrowserStep(step);
  resetPreviews();
  expect(withoutResets()).toEqual(fixtureState());
  expect(previewStore.getState().resets).toBe(before + 1);
  expect(JSON.stringify({ SAMPLE_PULLS, BROWSER_STEPS })).toBe(pristine);
});
