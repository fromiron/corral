import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { BROWSER_STEPS, type BrowserStep, SAMPLE_PULLS } from './fixture.ts';

// The feature previews' own state (docs/specs/features/feature-preview.md): only what a person
// changed in a sample flow, on top of the fixture. Nothing outside the previews reads it, so no
// session, run, inbox, usage, badge or notification ever counts a sample value.

export type PullTab = 'changes' | 'checks' | 'comments';
export type PullAnswer = { kind: 'approved' } | { kind: 'fixes'; feedback: string };

/** A simulated comment. */
export interface PostedComment {
  id: string;
  body: string;
  at: number;
}

export interface PreviewState {
  /** How many times Reset was pressed: each flow starts over. */
  resets: number;
  review: {
    selected: number;
    tab: PullTab;
    answers: Record<number, PullAnswer>;
    comments: Record<number, PostedComment[]>;
  };
  browser: {
    /** Steps done, in order: the next step to run is `BROWSER_STEPS[progress]`. */
    progress: number;
    /** The step in view. */
    step: BrowserStep;
  };
}

/** The state the fixture defines: nothing simulated yet. */
export function initialPreviewState(): PreviewState {
  return {
    resets: 0,
    review: {
      selected: SAMPLE_PULLS[0]?.number ?? 0,
      tab: 'changes',
      answers: {},
      comments: {},
    },
    browser: { progress: 0, step: 'open' },
  };
}

export const previewStore = createStore<PreviewState>(() => initialPreviewState());

export function usePreview<T>(select: (state: PreviewState) => T): T {
  return useStore(previewStore, select);
}

/** Back to the fixture, everywhere. */
export function resetPreviews() {
  previewStore.setState((state) => ({ ...initialPreviewState(), resets: state.resets + 1 }), true);
}

const pull = (number: number) => SAMPLE_PULLS.find((item) => item.number === number);

export function selectPull(number: number) {
  if (!pull(number)) return;
  previewStore.setState((state) => ({ review: { ...state.review, selected: number } }));
}

export function showPullTab(tab: PullTab) {
  previewStore.setState((state) => ({ review: { ...state.review, tab } }));
}

/** A simulated comment, trimmed; an empty one or an unknown pull request changes nothing. */
export function postComment(number: number, body: string, at: number) {
  const text = body.trim();
  if (!text || !pull(number)) return;
  previewStore.setState((state) => {
    const posted = state.review.comments[number] ?? [];
    return {
      review: {
        ...state.review,
        comments: {
          ...state.review.comments,
          [number]: [...posted, { id: `${number}-${posted.length + 1}`, body: text, at }],
        },
      },
    };
  });
}

/** A simulated answer to an open pull request, given once; a fix request needs feedback. */
export function answerPull(number: number, answer: PullAnswer) {
  if (pull(number)?.state !== 'open') return;
  const value: PullAnswer =
    answer.kind === 'fixes' ? { kind: 'fixes', feedback: answer.feedback.trim() } : answer;
  if (value.kind === 'fixes' && !value.feedback) return;
  previewStore.setState((state) =>
    state.review.answers[number]
      ? state
      : { review: { ...state.review, answers: { ...state.review.answers, [number]: value } } },
  );
}

/** Runs the next browser QA step; any other step, or one already done, changes nothing. */
export function runBrowserStep(step: BrowserStep) {
  previewStore.setState((state) =>
    BROWSER_STEPS.indexOf(step) === state.browser.progress
      ? { browser: { ...state.browser, progress: state.browser.progress + 1 } }
      : state,
  );
}

/** Shows a step already reached: one done, or the next to run. */
export function showBrowserStep(step: BrowserStep) {
  previewStore.setState((state) =>
    BROWSER_STEPS.indexOf(step) <= state.browser.progress && BROWSER_STEPS.includes(step)
      ? { browser: { ...state.browser, step } }
      : state,
  );
}
