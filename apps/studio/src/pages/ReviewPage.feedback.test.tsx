// @vitest-environment jsdom
import type { AutoRunStart, ReviewCommentView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileInfo } from '../workbench/useModels.ts';
import { CommentsPanel, ReviewPage } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({
  services: {},
  profiles: null as ProfileInfo[] | null,
  session: null as WorkSession | null,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({
  reviewRoute: { useLoaderData: () => ({ session: fixture.session }), useSearch: () => ({}) },
}));
vi.mock('./FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('./LspProposals.tsx', () => ({ LspProposals: () => null }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => () => {} }));
vi.mock('../workbench/useModels.ts', () => ({
  useModelProfiles: () => fixture.profiles,
}));
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    value,
    onValueChange,
    options,
    label,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    label: string;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const date = '2026-10-26T00:00:00Z';
function run(runId: string, status: RunSummary['status'] = 'succeeded'): RunSummary {
  return {
    runId,
    status,
    corralId: 'team',
    projectId: 'project',
    sessionId: 'session',
    startedAt: date,
  };
}
async function mount(
  options: {
    corralId?: string | null;
    mode?: 'server' | 'browser';
    teamMode?: 'none' | 'auto';
    auto?: WorkSession['auto'];
    profiles?: ProfileInfo[] | null;
    page?: boolean;
  } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.profiles =
    options.profiles === undefined
      ? ([
          {
            profileId: 'chosen-model',
            label: 'Chosen model',
            available: true,
            reasoningCapabilities: { levels: ['high'], providerDefault: true },
          },
        ] as ProfileInfo[])
      : options.profiles;
  const session: WorkSession = {
    sessionId: `session_${crypto.randomUUID()}`,
    projectId: 'project',
    corralId: options.corralId ?? null,
    auto:
      options.auto === undefined
        ? { modelProfile: 'chosen-model', reasoning: { mode: 'fixed', level: 'high' } }
        : options.auto,
    title: 'Session',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: date,
    updatedAt: date,
    archivedAt: null,
    entries: [],
  };
  fixture.session = session;
  let listedRuns = [run('latest'), run('older')].map((item) => ({
    ...item,
    sessionId: session.sessionId,
  }));
  const listRuns = vi.fn(async () => structuredClone(listedRuns));
  if (options.teamMode)
    window.localStorage.setItem(
      `corral:team-mode:${session.sessionId}`,
      JSON.stringify(options.teamMode),
    );
  let comments: ReviewCommentView[] = [
    {
      commentId: 'comment_1',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      path: 'README.md',
      side: 'after',
      startLine: 1,
      endLine: 1,
      quote: '# Setup',
      body: 'Clarify the setup.',
      state: 'draft',
      batchId: null,
      createdAt: date,
    },
  ];
  const startAuto = vi.fn(async (request: AutoRunStart) => ({
    runId: 'followup',
    receipt: { commandId: request.commandId, error: null },
    autoRoute: null,
  }));
  const startRun = vi.fn(async () => ({ runId: 'old_graph_run', receipt: { error: null } }));
  const recordFeedback = vi.fn(
    async (_id: string, batch: { sent: boolean; commentIds: string[] }) => {
      if (batch.sent)
        comments = comments.map((comment) =>
          batch.commentIds.includes(comment.commentId)
            ? { ...comment, state: 'submitted' }
            : comment,
        );
      return { batchId: 'batch' };
    },
  );
  const addSessionEntry = vi.fn(async () => ({ ok: true, session }));
  const feedbackText = vi.fn(
    async () => 'Review README.md:1 (current text): # Setup\nClarify the setup.',
  );
  const sendCommand = vi.fn(async () => ({ error: null }));
  const getSnapshot = vi.fn(async () => ({
    projection: {
      output: null,
      artifacts: {},
      executionOrder: ['execution'],
      executions: { execution: { status: 'running', nodeId: 'writer' } },
    },
  }));
  fixture.services = {
    mode: options.mode ?? 'server',
    live: true,
    workspaceId: 'review-test-host',
    startAuto,
    repository: {
      get: vi.fn(async () => ({
        corralId: 'team',
        definitionRevision: 1,
        definition: linearCorral(['writer']),
      })),
      addSessionEntry,
    },
    transport: {
      startRun,
      sendCommand,
      listRuns,
      getSnapshot,
      getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
    },
    workspaces: {
      feedbackText,
      recordFeedback,
      comments: vi.fn(async () => comments),
      worktree: vi.fn(async () => ({ missing: false })),
      changes: vi.fn(async () => ({ from: null, to: null, files: [] })),
      verifications: vi.fn(async () => []),
      fileOperations: vi.fn(async () => []),
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const render = async (runs = [run('latest'), run('older')]) => {
    await act(async () =>
      root.render(
        options.page ? (
          <ReviewPage />
        ) : (
          <CommentsPanel
            session={session}
            runs={runs}
            comments={comments}
            current={null}
            onChange={async () => {}}
          />
        ),
      ),
    );
  };
  const remount = async (runs: RunSummary[]) => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(runs);
  };
  const clickSend = async () => {
    const button = [...container.querySelectorAll('button')].find((node) =>
      ['Review.sendReview', 'Review.retrySend'].includes(node.textContent ?? ''),
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
  };
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  return {
    session,
    container,
    listRuns,
    setListedRuns: (runs: RunSummary[]) => {
      listedRuns = runs.map((item) => ({ ...item, sessionId: session.sessionId }));
    },
    render,
    remount,
    clickSend,
    startAuto,
    startRun,
    recordFeedback,
    addSessionEntry,
    feedbackText,
    sendCommand,
    getSnapshot,
    comments: () => comments,
    addDraft: () => {
      comments = [
        ...comments,
        { ...(comments[0] as ReviewCommentView), commentId: 'comment_2', state: 'draft' },
      ];
    },
  };
}

it.each([
  {
    name: 'no saved team',
    corralId: null,
    mode: 'server' as const,
    teamMode: 'none' as const,
    expectedTeam: 'none',
    expectedMode: 'live',
  },
  {
    name: 'saved team',
    corralId: 'team',
    mode: 'server' as const,
    expectedTeam: { corralId: 'team' },
    expectedMode: 'live',
  },
  {
    name: 'automatic team',
    corralId: null,
    mode: 'server' as const,
    teamMode: 'auto' as const,
    expectedTeam: 'auto',
    expectedMode: 'live',
  },
  {
    name: 'browser demo',
    corralId: null,
    mode: 'browser' as const,
    expectedTeam: 'none',
    expectedMode: 'mock',
  },
])(
  'review follows the ordinary conversation for $name',
  async ({ expectedTeam, expectedMode, ...options }) => {
    const view = await mount(options);
    await view.clickSend();
    expect(view.startAuto).toHaveBeenCalledTimes(1);
    expect(view.startAuto.mock.calls[0]?.[0]).toMatchObject({
      sessionId: view.session.sessionId,
      brief: await view.feedbackText(),
      choice: view.session.auto,
      mode: expectedMode,
      team: expectedTeam,
      conversation: { throughRunId: 'latest' },
    });
    expect(view.startAuto.mock.calls[0]?.[0]).not.toHaveProperty('startFrom');
    expect(view.startRun).not.toHaveBeenCalled();
    expect(view.recordFeedback).toHaveBeenCalledWith(
      view.session.sessionId,
      expect.objectContaining({ commentIds: ['comment_1'], sent: true, runId: 'followup' }),
    );
    expect(view.addSessionEntry).toHaveBeenCalledWith(
      view.session.sessionId,
      expect.objectContaining({
        state: 'started',
        commandId: view.startAuto.mock.calls[0]?.[0].commandId,
      }),
    );
  },
);

it('a refused request preserves draft comments and never reports Sent', async () => {
  const view = await mount({ corralId: 'deleted_team' });
  view.startAuto.mockResolvedValueOnce({
    runId: null,
    receipt: {
      commandId: 'refused',
      error: { code: 'TARGET_NOT_FOUND', message: 'The selected team no longer exists.' },
    },
    autoRoute: null,
  } as never);
  await view.clickSend();
  expect(view.comments()[0]?.state).toBe('draft');
  expect(view.startAuto.mock.calls[0]?.[0].team).toEqual({ corralId: 'deleted_team' });
  expect(view.recordFeedback).toHaveBeenCalledWith(
    view.session.sessionId,
    expect.objectContaining({ sent: false, runId: null }),
  );
  expect(view.container.textContent).toContain('The selected team no longer exists.');
  expect(view.container.textContent).not.toContain('Review.sent');
});

it('an unknown start retries the original command, model, team, context and comments after remount', async () => {
  const view = await mount({ corralId: 'team' });
  view.startAuto.mockRejectedValueOnce(new Error('response lost'));
  await view.clickSend();
  expect(view.recordFeedback).not.toHaveBeenCalled();
  expect(view.startAuto).toHaveBeenCalledTimes(1);
  const original = structuredClone(view.startAuto.mock.calls[0]?.[0]);
  view.session.auto = { modelProfile: 'changed-model' };
  view.session.corralId = null;
  view.addDraft();
  await view.remount([run('possibly_started', 'running'), run('newer_ended'), run('latest')]);
  await view.clickSend();
  expect(view.startAuto.mock.calls[1]?.[0]).toEqual(original);
  expect(view.feedbackText).toHaveBeenCalledTimes(1);
  expect(view.recordFeedback).toHaveBeenCalledWith(
    view.session.sessionId,
    expect.objectContaining({ commentIds: ['comment_1'], text: original?.brief, sent: true }),
  );
  expect(view.comments().find((comment) => comment.commentId === 'comment_2')?.state).toBe('draft');
  expect(view.sendCommand).not.toHaveBeenCalled();
});

it('a failed session record cannot turn an accepted follow-up into another run', async () => {
  const view = await mount();
  view.addSessionEntry.mockRejectedValueOnce(new Error('entry response lost'));
  await view.clickSend();
  expect(view.startAuto).toHaveBeenCalledTimes(1);
  const original = structuredClone(view.startAuto.mock.calls[0]?.[0]);
  expect(view.comments()[0]?.state).toBe('submitted');
  await view.remount([run('followup', 'running'), run('latest')]);
  await view.clickSend();
  expect(view.startAuto.mock.calls[1]?.[0]).toEqual(original);
  expect(view.addSessionEntry).toHaveBeenLastCalledWith(
    view.session.sessionId,
    expect.objectContaining({ runId: 'followup', commandId: original?.commandId }),
  );
});

it('active execution feedback keeps the Reins path', async () => {
  const view = await mount();
  await view.render([run('active', 'running')]);
  const select = view.container.querySelector('select');
  if (!select) throw new Error('missing feedback destination');
  await act(async () => {
    select.value = 'execution';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await view.clickSend();
  expect(view.startAuto).not.toHaveBeenCalled();
  expect(view.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'steer',
      runId: 'active',
      payload: {
        targetExecutionId: 'execution',
        text: await view.feedbackText(),
        delivery: 'next_request',
      },
    }),
  );
  expect(view.recordFeedback).toHaveBeenCalledWith(
    view.session.sessionId,
    expect.objectContaining({ intent: 'steer', executionId: 'execution', sent: true }),
  );
});

it('model loading cannot freeze an invented default before the connected model is known', async () => {
  const view = await mount({ auto: null, profiles: null });
  const send = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.sendReview',
  );
  expect(send?.disabled).toBe(true);
  await act(async () => send?.click());
  expect(view.startAuto).not.toHaveBeenCalled();
  fixture.profiles = [{ profileId: 'connected-other', label: 'Connected model', available: true }];
  await view.render();
  await view.clickSend();
  expect(view.startAuto.mock.calls[0]?.[0].choice).toEqual({ modelProfile: 'connected-other' });
});

it.each([
  {
    name: 'disconnected model',
    profile: { profileId: 'chosen-model', label: 'Chosen model', available: false },
    note: 'Sessions.autoNotReady',
  },
  {
    name: 'unsupported reasoning',
    profile: { profileId: 'chosen-model', label: 'Chosen model', available: true },
    note: 'Composer.reasoningUnsupportedHint',
  },
])('new feedback waits for a valid choice with $name', async ({ profile, note }) => {
  const view = await mount({ profiles: [profile] });
  const send = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.sendReview',
  );
  expect(send?.disabled).toBe(true);
  await act(async () => send?.click());
  expect(view.startAuto).not.toHaveBeenCalled();
  expect(view.recordFeedback).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain(note);
});

it('keeps review run state current so the next comment follows the reply just completed', async () => {
  vi.useFakeTimers();
  const view = await mount({ page: true });
  view.startAuto.mockImplementationOnce(async (request) => {
    view.setListedRuns([run('followup', 'running'), run('latest'), run('older')]);
    view.addDraft();
    return {
      runId: 'followup',
      receipt: { commandId: request.commandId, error: null },
      autoRoute: null,
    };
  });
  await view.clickSend();
  expect(view.listRuns).toHaveBeenCalledTimes(2);
  const recipient = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Review.sendTo"]',
  );
  if (!recipient) throw new Error('Missing review recipient');
  expect([...recipient.options].some((option) => option.value === 'next')).toBe(false);
  view.setListedRuns([run('followup'), run('latest'), run('older')]);
  view.listRuns.mockRejectedValueOnce(new Error('offline'));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(view.container.textContent).toContain('Sessions.connectionLost');
  expect(view.container.textContent).toContain('Docking.runLoading');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  await view.clickSend();
  expect(view.startAuto.mock.calls[1]?.[0].conversation).toEqual({ throughRunId: 'followup' });
});

it('ignores late Reins targets from the run just left', async () => {
  const view = await mount();
  let resolve!: (snapshot: Awaited<ReturnType<typeof view.getSnapshot>>) => void;
  view.getSnapshot.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await view.render([run('old-active', 'running')]);
  await view.render([run('new-active', 'running')]);
  await act(async () =>
    resolve({
      projection: {
        output: null,
        artifacts: {},
        executionOrder: ['ended-execution'],
        executions: { 'ended-execution': { status: 'running', nodeId: 'writer' } },
      },
    } as unknown as Awaited<ReturnType<typeof view.getSnapshot>>),
  );
  const recipient = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Review.sendTo"]',
  );
  if (!recipient) throw new Error('Missing review recipient');
  expect([...recipient.options].map((option) => option.value)).toEqual(['execution']);
});
