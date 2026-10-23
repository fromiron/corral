// @vitest-environment jsdom
import type { FileChangeView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  changeReviewKey,
  contentReadKey,
  type ReviewMarks,
  useReviewMarks,
} from './reviewMarks.ts';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const file = (beforeBlob: string | null, afterBlob: string | null): FileChangeView => ({
  path: 'src/a.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  provenance: 'managed_agent',
  beforeBlob,
  afterBlob,
});

function mount(initial: { hostId: string; sessionId: string }) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const marks: { current: ReviewMarks | null } = { current: null };
  function Probe(props: { hostId: string; sessionId: string }) {
    marks.current = useReviewMarks(props.hostId, props.sessionId);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props: { hostId: string; sessionId: string }) =>
    act(() => root.render(<Probe {...props} />));
  return { marks, render, ready: render(initial), unmount: () => act(() => root.unmount()) };
}

it('[TC-WBD-013-H] a change review holds for its own comparison; reading the same final content does not review another', async () => {
  const fromA = file('a'.repeat(40), 'b'.repeat(40));
  const fromC = file('c'.repeat(40), 'b'.repeat(40));
  expect(contentReadKey(fromA)).toBe(contentReadKey(fromC));
  expect(changeReviewKey('host', fromA)).not.toBe(changeReviewKey('host', fromC));
  const view = mount({ hostId: 'host', sessionId: 'session' });
  await view.ready;
  await act(() => view.marks.current?.toggleChange(fromA));
  expect(view.marks.current?.changeReviewed(fromA)).toBe(true);
  expect(view.marks.current?.changeReviewed(fromC)).toBe(false);
  // The content was read, and that stays true under the other comparison.
  expect(view.marks.current?.contentRead(fromC)).toBe(true);
  await act(() => view.marks.current?.toggleChange(fromA));
  expect(view.marks.current?.changeReviewed(fromA)).toBe(false);
  expect(view.marks.current?.contentRead(fromA)).toBe(true);
  await view.unmount();
});

it('[TC-WBD-013-N] marks belong to one host and session, and a session switch never carries them over', async () => {
  const change = file('a'.repeat(40), 'b'.repeat(40));
  // A read mark written before change reviews existed is still a read, not a review.
  window.localStorage.setItem('corral:reviewed:old', JSON.stringify([contentReadKey(change)]));
  const view = mount({ hostId: 'host', sessionId: 'first' });
  await view.ready;
  await act(() => view.marks.current?.toggleChange(change));
  await view.render({ hostId: 'host', sessionId: 'second' });
  expect(view.marks.current?.changeReviewed(change)).toBe(false);
  expect(view.marks.current?.contentRead(change)).toBe(false);
  await act(() => view.marks.current?.toggleChange(change));
  await view.render({ hostId: 'other-host', sessionId: 'first' });
  expect(view.marks.current?.changeReviewed(change)).toBe(false);
  await view.render({ hostId: 'host', sessionId: 'old' });
  expect(view.marks.current?.contentRead(change)).toBe(true);
  expect(view.marks.current?.changeReviewed(change)).toBe(false);
  await view.render({ hostId: 'host', sessionId: 'first' });
  expect(view.marks.current?.changeReviewed(change)).toBe(true);
  await view.unmount();
});
