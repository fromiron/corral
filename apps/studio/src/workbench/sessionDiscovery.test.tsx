import type { SessionSearchHit } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { groupSearchHits, SearchExcerpt } from './SessionSearchDialog.tsx';
import { sessionListState } from './sessionList.ts';

const session = { sessionId: 'session', entries: [] } as unknown as WorkSession;
const run = (status: RunSummary['status'], startedAt: string): RunSummary => ({
  sessionId: 'session',
  projectId: 'project',
  corralId: 'team',
  runId: startedAt,
  status,
  startedAt,
});
it('list status uses the newest run and distinguishes waiting, empty and completed sessions', () => {
  expect(sessionListState(session, [])).toBe('empty');
  expect(
    sessionListState(session, [run('succeeded', '2026-01-01'), run('running', '2026-01-02')]),
  ).toBe('running');
  expect(
    sessionListState(session, [run('running', '2026-01-01'), run('awaiting_user', '2026-01-02')]),
  ).toBe('attention');
  expect(sessionListState(session, [run('paused', '2026-01-01')])).toBe('attention');
  expect(sessionListState(session, [run('succeeded', '2026-01-01')])).toBe('completed');
  expect(sessionListState(session, [run('cancelled', '2026-01-01')])).toBe('cancelled');
});

it('keeps a configured meeting and an unsent purpose out of empty-session cleanup', () => {
  expect(sessionListState({ ...session, objective: 'Draft purpose' }, [])).toBe('ready');
  const meeting = {
    ...session,
    meeting: {
      config: { version: 1, participants: [], secretary: { modelProfile: 'model' } },
      rounds: [],
      queued: null,
    },
  } as WorkSession;
  expect(sessionListState(meeting, [])).toBe('ready');
});

it('keeps an uncertain terminal-only session in attention instead of empty or completed', () => {
  const terminal = { kind: 'uncertain_terminal' as const, sessionId: 'session', terminalId: 'pty' };
  const items = [terminal];
  expect(sessionListState(session, [], items)).toBe('attention');
  expect(sessionListState(session, [run('succeeded', '2026-01-01')], items)).toBe('attention');
  expect(sessionListState(session, [], [{ ...terminal, sessionId: 'another' }])).toBe('empty');
  expect(sessionListState(session, [], [])).toBe('empty');
});

it('groups duplicate search targets once without hiding another matching message', () => {
  const hit: SessionSearchHit = {
    sessionId: 's',
    projectId: 'p',
    title: 'Topic',
    kind: 'entry',
    runId: null,
    entryId: 'a',
    artifactVersionId: null,
    sequence: null,
    excerpt: 'matching request',
    archived: false,
  };
  const groups = groupSearchHits([
    hit,
    { ...hit },
    { ...hit, entryId: 'b' },
    { ...hit, sessionId: 'other' },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0]?.hits.map((item) => item.entryId)).toEqual(['a', 'b']);
});

it('highlights literal matches while keeping markup and regular expression characters as text', () => {
  expect(renderToStaticMarkup(<SearchExcerpt text="Find a.b and A.B <img>" query="a.b" />)).toBe(
    'Find <mark>a.b</mark> and <mark>A.B</mark> &lt;img&gt;',
  );
  expect(renderToStaticMarkup(<SearchExcerpt text="plain" query="" />)).toBe('plain');
});

it('uses server match ranges without changing the original Unicode or case', () => {
  const text = 'CASE ﬃ e\u0301';
  const matches = [
    { start: 5, end: 6 },
    { start: 7, end: 9 },
  ];
  expect(renderToStaticMarkup(<SearchExcerpt text={text} query="ffi" matches={matches} />)).toBe(
    'CASE <mark>ﬃ</mark> <mark>e\u0301</mark>',
  );
});
