// @vitest-environment jsdom
import {
  createTextAttachment,
  emptyProjection,
  type RunSummary,
  type SessionEntry,
} from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import { EntryCard, RunCard } from './SessionEntries.tsx';

// One turn of the conversation: a plain bubble with a quiet icon row, then the run's one
// process line, whose run part opens the run record.

const fixture = vi.hoisted(() => ({
  store: null as unknown,
  editRequest: vi.fn(),
}));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({
    workspaces: null,
    mode: 'browser',
    transport: {
      getSnapshot: async () => ({
        projection: { executions: {}, executionOrder: [], directives: {} },
      }),
      getRunDefinition: async () => null,
    },
  }),
}));
vi.mock('../useCorralChat.ts', () => ({
  useCorralRun: () => ({
    store: fixture.store,
    state: useStore(fixture.store as RunSessionStore),
    conversationTurn: null,
    bodyMetadataCurrent: true,
  }),
}));
vi.mock('../../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('../RunChanges.tsx', () => ({ RunChanges: () => null }));
vi.mock('../ImageAttachments.tsx', () => ({ ImageAttachmentList: () => null }));
vi.mock('../TextAttachments.tsx', async (original) => ({
  ...(await original<typeof import('../TextAttachments.tsx')>()),
  TextAttachmentList: ({ attachments }: { attachments: { name: string }[] }) => (
    <ul data-testid="text-attachments">
      {attachments.map((item) => (
        <li key={item.name}>{item.name}</li>
      ))}
    </ul>
  ),
}));
vi.mock('../RefusalHelp.tsx', () => ({
  RESEND_REQUEST: 'corral:resend-request',
  RefusalHelp: () => null,
  editRequest: fixture.editRequest,
}));
vi.mock('../MessageBranch.tsx', () => ({
  MessageBranch: ({ icon }: { icon?: boolean }) => (
    <button type="button" aria-label="Branch before this request" data-icon={String(icon)} />
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode; 'aria-label'?: string }) => (
    <a href="#link" aria-label={props['aria-label']}>
      {children}
    </a>
  ),
}));

const cleanup: (() => void)[] = [];
Element.prototype.getAnimations ??= () => [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.editRequest.mockClear();
  const projection = emptyProjection('run_turn');
  projection.status = 'succeeded';
  projection.artifacts.answer = {
    artifactVersionId: 'answer',
    artifactId: 'answer',
    version: 1,
    parentVersionId: null,
    name: 'Answer',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 10,
    authorExecutionId: 'exec',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  };
  projection.output = { nodeId: 'output', artifactVersionIds: ['answer'] };
  fixture.store = sessionStore({
    runId: 'run_turn',
    projection,
    artifactTexts: { answer: 'The answer body' },
  });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

const entry = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId: 'entry_1',
  intent: 'next',
  text: 'Please tidy the conversation',
  state: 'started',
  createdAt: '2026-11-09T09:30:00Z',
  runId: 'run_turn',
  executionId: null,
  detail: null,
  ...patch,
});
const runs: RunSummary[] = [
  {
    runId: 'run_first',
    status: 'succeeded',
    corralId: 'team',
    projectId: 'project',
    sessionId: 'session_turn',
    startedAt: '2026-11-09T09:00:00Z',
  },
  {
    runId: 'run_turn',
    status: 'succeeded',
    corralId: 'team',
    projectId: 'project',
    sessionId: 'session_turn',
    startedAt: '2026-11-09T09:30:00Z',
  },
];

async function show(value: SessionEntry) {
  const onPanel = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        now={new Date('2026-11-09T12:00:00Z')}
      >
        <EntryCard
          sessionId="session_turn"
          entry={value}
          runs={runs}
          artifactMetadataVersion="run_turn"
          onPanel={onPanel}
        />
      </IntlProvider>,
    ),
  );
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.getAttribute('aria-label') === name || node.textContent === name,
    );
  return { container, onPanel, button };
}

it('a sent message is a plain bubble; copy, edit and branch are named icon buttons under it', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const value = entry();
  const f = await show(value);
  const text = [...f.container.querySelectorAll('p')].find(
    (node) => node.textContent === value.text,
  );
  expect(text).toBeDefined();
  for (const name of [messages.MessageBody.copyMessage, messages.MessageBody.editAsNew]) {
    const action = f.button(name);
    expect(action, name).toBeDefined();
    // An icon, never a text button, and outside the bubble that holds the text.
    expect(action?.textContent).toBe('');
    expect(action?.querySelector('svg')).not.toBeNull();
    expect(action?.tabIndex).toBe(0);
    expect(text?.parentElement?.closest('div')?.contains(action ?? null)).toBe(false);
    expect(
      text && action ? text.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
    ).toBeTruthy();
  }
  expect(f.button('Branch before this request')?.dataset.icon).toBe('true');
  await act(async () => f.button(messages.MessageBody.copyMessage)?.click());
  expect(writeText).toHaveBeenCalledWith(value.text);
  await act(async () => f.button(messages.MessageBody.editAsNew)?.click());
  expect(fixture.editRequest).toHaveBeenCalledWith(value.text, value);
});

it('an instruction keeps copy but cannot be edited as a new request', async () => {
  const f = await show(entry({ intent: 'steer', state: 'sent' }));
  expect(f.button(messages.MessageBody.copyMessage)).toBeDefined();
  expect(f.button(messages.MessageBody.editAsNew)).toBeUndefined();
});

it('the visible meta is the time and an unusual state; the rest stays for assistive tech', async () => {
  const normal = await show(entry());
  expect(normal.container.querySelector('[data-testid="entry-flag"]')).toBeNull();
  const time = normal.container.querySelector('time');
  expect(time?.getAttribute('datetime')).toBe('2026-11-09T09:30:00Z');
  // The same day shows the time alone; the full date stays in the tooltip.
  expect(time?.textContent).toBe('9:30 AM');
  expect(time?.getAttribute('title')).toContain('11/9/26');
  expect(normal.container.querySelector('.sr-only')?.textContent).toContain(
    `${messages.Sessions.youAsked.replace('{intent}', messages.Sessions.intent.next)} · ${messages.Sessions.state.started}`,
  );
  const refused = await show(entry({ intent: 'queue', state: 'refused', runId: null }));
  const flag = refused.container.querySelector('[data-testid="entry-flag"]');
  expect(flag?.textContent).toBe(
    `${messages.Sessions.intentShort.queue} · ${messages.Sessions.state.refused}`,
  );
  expect(flag?.classList.contains('sr-only')).toBe(false);
});

it("the process line's run part opens the run record; no separate link floats beside the turn", async () => {
  const f = await show(entry());
  const run = f.button(messages.Sessions.runNumber.replace('{number}', '2'));
  expect(run).toBeDefined();
  await act(async () => run?.click());
  expect(f.onPanel).toHaveBeenCalledWith('run', { run: 'run_turn', view: 'run' });
  expect(f.button(messages.Sessions.openRun)).toBeUndefined();
  // The line sits above the answer.
  const answer = f.container.querySelector('[data-testid="chat-result"]');
  expect(answer?.textContent).toContain('The answer body');
  expect(
    run && answer ? run.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
  ).toBeTruthy();
});

it('the answer’s icons sit on its run row’s tail: copy and open in results, by accessible name', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const f = await show(entry());
  const row = f.container.querySelector<HTMLElement>(
    '[data-chat-part="tail"] [data-testid="turn-actions"]',
  );
  expect(row).not.toBeNull();
  // The answer takes no icon line of its own under it.
  expect(f.container.querySelectorAll('[data-testid="turn-actions"]')).toHaveLength(1);
  expect(
    f.container.querySelector('[data-testid="chat-result"] [data-testid="turn-actions"]'),
  ).toBeNull();
  const copy = row?.querySelector<HTMLButtonElement>(
    `button[aria-label="${messages.MessageBody.copyMessage}"]`,
  );
  const open = row?.querySelector<HTMLAnchorElement>(
    `a[aria-label="${messages.Results.openResults}"]`,
  );
  expect(copy?.textContent).toBe('');
  expect(open?.textContent).toBe('');
  expect(open?.querySelector('svg')).not.toBeNull();
  await act(async () => copy?.click());
  expect(writeText).toHaveBeenCalledWith('The answer body');
});

it('a run no request names reads like any turn: its status is said once, by the line above the composer', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        now={new Date('2026-11-09T12:00:00Z')}
      >
        <RunCard
          run={runs[1] as RunSummary}
          number={2}
          artifactMetadataVersion="run_turn"
          onPanel={vi.fn()}
        />
      </IntlProvider>,
    ),
  );
  const badges = [...container.querySelectorAll('[data-status="succeeded"]')];
  // Assistive tech still hears the run's status with its turn; nothing shows it a second time.
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest('.sr-only')).not.toBeNull();
  // The turn still opens its run record from its process line.
  expect(container.querySelector('[data-testid="turn-run"]')?.textContent).toContain('Run #2');
  // The run has a name here, so assistive tech is never read its internal id.
  const card = container.querySelector('section');
  expect(card?.getAttribute('aria-label')).toBe('Run #2');
  expect(card?.textContent).not.toContain((runs[1] as RunSummary).runId);
});

it('a sent message shows its reply quotes as chips alone, and what each chip found is its own', async () => {
  const quote = createTextAttachment('quote.txt', 'text/plain', 'quick brown', {
    kind: 'reply',
    runId: 'run_gone',
    modelCallId: 'call_gone',
    start: 4,
    end: 15,
    prefix: 'The ',
    suffix: ' fox',
  });
  const notes = createTextAttachment('notes.txt', 'text/plain', 'Some notes');
  const first = await show(entry({ entryId: 'entry_a', attachments: [quote, notes] }));
  const second = await show(entry({ entryId: 'entry_b', attachments: [quote] }));
  const chip = (view: typeof first) =>
    [...view.container.querySelectorAll('button')].find((node) =>
      node.getAttribute('aria-label')?.startsWith('Go to the quoted passage'),
    );
  // The quote once, as its chip; the other attachment in the list.
  expect(
    [...first.container.querySelectorAll('[data-testid="text-attachments"] li')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['notes.txt']);
  expect(chip(first)).toBeDefined();
  expect(second.container.querySelector('[data-testid="text-attachments"]')).toBeNull();
  // Pressed in one message, its passage not found there: the other message's chip says nothing.
  await act(async () => chip(first)?.click());
  expect(chip(first)?.getAttribute('aria-describedby')).toBeTruthy();
  expect(chip(second)?.getAttribute('aria-describedby')).toBeNull();
});
