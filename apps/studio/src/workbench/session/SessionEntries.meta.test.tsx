// @vitest-environment jsdom
import type { CorralDefinition, DirectiveStatus } from '@corral/contracts';
import {
  createTextAttachment,
  type DirectiveView,
  type ExecutionView,
  emptyProjection,
  type ModelCallView,
  type RunProjection,
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
import { placeEntries, type SteerRecord } from './entryMeta.ts';
import { EntryCard } from './SessionEntries.tsx';

// The one line under a sent message (features/composer-flow.md "보낸 메시지의 메타 줄"): its time
// and actions on hover or focus, and what became of it, always.

const fixture = vi.hoisted(() => ({ store: null as unknown, editRequest: vi.fn() }));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({ workspaces: null, mode: 'browser' }),
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
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/settings' }) }),
}));
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
vi.mock('../RefusalHelp.tsx', async (original) => ({
  ...(await original<typeof import('../RefusalHelp.tsx')>()),
  editRequest: fixture.editRequest,
}));
vi.mock('../MessageBranch.tsx', () => ({
  MessageBranch: ({ runId }: { runId: string }) => (
    <button type="button" aria-label="Branch before this request" data-run={runId} />
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a href="#link" className={className}>
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
  const projection = emptyProjection('run_next');
  projection.status = 'succeeded';
  fixture.store = sessionStore({ runId: 'run_next', projection });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const entry = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId: 'entry_steer',
  intent: 'steer',
  text: 'Keep the summary short',
  state: 'sent',
  createdAt: '2026-11-09T09:30:00Z',
  runId: 'run_live',
  executionId: 'exec_writer',
  commandId: 'cmd_steer',
  detail: null,
  ...patch,
});
const summary = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session_meta',
  startedAt: '2026-11-09T09:00:00Z',
});
const ended: RunSummary[] = [summary('run_live', 'succeeded'), summary('run_next', 'succeeded')];
const definition = {
  nodes: [{ id: 'writer', type: 'agent', label: 'Writer' }],
} as unknown as Pick<CorralDefinition, 'nodes'>;

function execution(patch: Partial<ExecutionView> = {}): ExecutionView {
  return {
    executionId: 'exec_writer',
    nodeId: 'writer',
    status: 'active',
    waitingOn: null,
    ...patch,
  } as ExecutionView;
}
function call(modelCallId: string, patch: Partial<ModelCallView> = {}): ModelCallView {
  return {
    modelCallId,
    executionId: 'exec_writer',
    contextSnapshotId: `ctx_${modelCallId}`,
    profile: 'mock',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: [],
    finished: true,
    usage: null,
    rawUsage: null,
    certainty: null,
    ...patch,
  };
}

/** The run's record with one directive for the instruction. */
function record(
  status: DirectiveStatus,
  patch: Partial<DirectiveView> = {},
  shape: (projection: RunProjection) => void = () => {},
): SteerRecord {
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  projection.executions.exec_writer = execution();
  projection.executionOrder = ['exec_writer'];
  const directive: DirectiveView = {
    directiveId: 'directive_steer',
    targetExecutionId: 'exec_writer',
    text: 'Keep the summary short',
    origin: { kind: 'person' },
    delivery: 'next_request',
    status,
    commandId: 'cmd_steer',
    acceptedSeq: 3,
    contextSnapshotId: null,
    modelCallId: null,
    reason: null,
    ...patch,
  } as DirectiveView;
  projection.directives[directive.directiveId] = directive;
  shape(projection);
  return { directive, projection, definition };
}

async function show(
  value: SessionEntry,
  options: {
    record?: SteerRecord | null;
    carried?: SessionEntry;
    runOnly?: boolean;
    carriedHere?: boolean;
    heldAs?: DirectiveView['status'];
    runs?: RunSummary[];
  } = {},
) {
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
          sessionId="session_meta"
          entry={value}
          runs={options.runs ?? ended}
          artifactMetadataVersion="run_next"
          onPanel={onPanel}
          {...('record' in options ? { record: options.record } : {})}
          {...(options.carried ? { carried: options.carried } : {})}
          {...(options.runOnly ? { runOnly: true } : {})}
          {...(options.carriedHere ? { carriedHere: true } : {})}
          {...(options.heldAs ? { heldAs: options.heldAs } : {})}
        />
      </IntlProvider>,
    ),
  );
  const meta = () => container.querySelector<HTMLElement>('[data-chat-part="meta"]');
  const status = () => meta()?.querySelector<HTMLElement>('[data-testid="entry-status"]');
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.getAttribute('aria-label') === name || node.textContent === name,
    );
  // The status as read: its separators are marks between parts, spaced by the layout.
  const said = () => (status()?.textContent ?? '').replace(/\s*·\s*/g, ' · ').trim();
  return { container, onPanel, meta, status, said, button };
}

const m = messages.Sessions.meta;
const rows: [string, () => SteerRecord, SessionEntry | undefined, string][] = [
  ['accepted', () => record('accepted'), undefined, m.waiting],
  ['queued', () => record('queued'), undefined, m.waiting],
  [
    'queued for a target waiting on an approval',
    () =>
      record('queued', {}, (p) => {
        p.executions.exec_writer = execution({ status: 'waiting_approval' });
      }),
    undefined,
    m.afterDecision,
  ],
  [
    'queued for a target asking the person',
    () =>
      record('queued', {}, (p) => {
        p.executions.exec_writer = execution({
          status: 'waiting_message',
          waitingOn: { kind: 'user' },
        } as Partial<ExecutionView>);
      }),
    undefined,
    m.afterDecision,
  ],
  ['attached to a request', () => record('attached_to_request'), undefined, m.delivering],
  ['delivered as a join', () => record('delivered'), undefined, `${m.read} · Writer`],
  [
    'delivered as an interrupt that cut the response before it',
    () =>
      record('delivered', { delivery: 'interrupt', modelCallId: 'call_2' }, (p) => {
        p.modelCalls.call_1 = call('call_1', { interrupted: true });
        p.modelCalls.call_2 = call('call_2');
      }),
    undefined,
    `${m.interrupted} · Writer`,
  ],
  [
    'delivered as an interrupt with nothing to cut',
    () =>
      record('delivered', { delivery: 'interrupt', modelCallId: 'call_2' }, (p) => {
        p.modelCalls.call_1 = call('call_1');
        p.modelCalls.call_2 = call('call_2');
      }),
    undefined,
    `${m.read} · Writer`,
  ],
  [
    'delivered as an interrupt whose cut call was another execution’s',
    () =>
      record('delivered', { delivery: 'interrupt', modelCallId: 'call_2' }, (p) => {
        p.modelCalls.call_1 = call('call_1', { interrupted: true, executionId: 'exec_other' });
        p.modelCalls.call_2 = call('call_2');
      }),
    undefined,
    `${m.read} · Writer`,
  ],
  [
    'delivered as an interrupt after an earlier cut, with an uncut response between',
    () =>
      record('delivered', { delivery: 'interrupt', modelCallId: 'call_3' }, (p) => {
        p.modelCalls.call_1 = call('call_1', { interrupted: true });
        p.modelCalls.call_2 = call('call_2');
        p.modelCalls.call_3 = call('call_3');
      }),
    undefined,
    `${m.read} · Writer`,
  ],
  [
    'delivered as a join right after a response another interrupt cut',
    () =>
      record('delivered', { modelCallId: 'call_2' }, (p) => {
        p.modelCalls.call_1 = call('call_1', { interrupted: true });
        p.modelCalls.call_2 = call('call_2');
      }),
    undefined,
    `${m.read} · Writer`,
  ],
  [
    'expired and carried, the request waiting',
    () => record('expired'),
    entry({ entryId: 'entry_carried', intent: 'queue', state: 'queued', runId: null }),
    m.carriedWaiting,
  ],
  [
    'expired and carried, the request started',
    () => record('expired'),
    entry({ entryId: 'entry_carried', intent: 'queue', state: 'started', runId: 'run_next' }),
    m.carriedStarted,
  ],
  ['not delivered', () => record('not_delivered'), undefined, m.notDelivered],
  ['expired and not carried', () => record('expired'), undefined, m.notDelivered],
  ['rejected', () => record('rejected'), undefined, m.notDelivered],
  ['delivery unknown', () => record('delivery_unknown'), undefined, m.unknown],
];

it.each(rows)('an instruction %s says so on its meta line', async (_name, made, carried, text) => {
  const f = await show(entry(), { record: made(), ...(carried ? { carried } : {}) });
  expect(f.meta()).not.toBeNull();
  // The words, then a resend only where nothing was delivered.
  expect(f.said().replace(m.resend, '').trim()).toBe(text);
  expect(Boolean(f.button(m.resend))).toBe(text === m.notDelivered);
});

it('before the record is read the line holds its place and says nothing', async () => {
  const f = await show(entry());
  expect(f.meta()).not.toBeNull();
  expect(f.status()?.textContent ?? '').toBe('');
});

it('the role name opens that execution’s run record', async () => {
  const f = await show(entry(), { record: record('delivered') });
  const role = f.button('Writer');
  expectQuiet(f.status());
  expect(role).toBeDefined();
  await act(async () => role?.click());
  expect(f.onPanel).toHaveBeenCalledWith('run', {
    run: 'run_live',
    view: 'run',
    execution: 'exec_writer',
  });
  // The meta line replaced the separate "View run" button.
  expect(f.button(messages.Sessions.openRun)).toBeUndefined();
});

it('a role with another open execution of its name is told apart as the send menu tells it', async () => {
  const value = record('delivered', {}, (p) => {
    p.executions.exec_second = execution({ executionId: 'exec_second' });
    p.executionOrder = ['exec_writer', 'exec_second'];
  });
  const f = await show(entry(), { record: value });
  expect(f.said()).toBe(`${m.read} · Writer · #1`);
});

it('resend goes the resend path and waits while a run is going', async () => {
  const sent = vi.fn();
  window.addEventListener('corral:resend-request', sent);
  cleanup.push(() => window.removeEventListener('corral:resend-request', sent));
  const idle = await show(entry(), { record: record('not_delivered') });
  await act(async () => idle.button(m.resend)?.click());
  expect(sent).toHaveBeenCalledTimes(1);
  expectQuiet(idle.status());
  expect((sent.mock.calls[0] as unknown as [CustomEvent])[0].detail).toEqual({
    sessionId: 'session_meta',
    entryId: 'entry_steer',
  });
  const busy = await show(entry(), {
    record: record('not_delivered'),
    runs: [summary('run_live', 'succeeded'), summary('run_next', 'running')],
  });
  expect(busy.button(m.resend)?.disabled).toBe(true);
});

it('every state is the same one line: one meta row holding time, actions and status, nothing beside it', async () => {
  const shapes = new Set<string>();
  for (const [, made, carried] of rows) {
    const f = await show(entry(), { record: made(), ...(carried ? { carried } : {}) });
    const article = f.container.querySelector('article');
    expect(article?.querySelectorAll('[data-chat-part="meta"]')).toHaveLength(1);
    const meta = f.meta();
    // The status is always shown: it is not inside the part revealed on hover.
    expect(f.status()?.closest('.opacity-0')).toBeNull();
    expect(meta?.querySelector('time')).not.toBeNull();
    expect(meta?.className).toContain('flex-nowrap');
    // No line of its own above or below the message for the state.
    expect(article?.querySelector('[data-testid="entry-flag"]')).toBeNull();
    expect(article?.querySelector('[data-testid="refusal"]')).toBeNull();
    shapes.add(
      [...(article?.querySelectorAll('*') ?? [])]
        .filter((node) => node.parentElement === article)
        .map((node) => node.tagName)
        .join(','),
    );
  }
  expect([...shapes]).toHaveLength(1);
});

it('a join’s text attachments show under its message: quotes as chips, the rest by name', async () => {
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
  const f = await show(entry(), {
    record: record('queued', { attachments: [quote, notes] }),
  });
  const chip = [...f.container.querySelectorAll('button')].find((node) =>
    node.getAttribute('aria-label')?.startsWith('Go to the quoted passage'),
  );
  expect(chip).toBeDefined();
  expect(
    [...f.container.querySelectorAll('[data-testid="text-attachments"] li')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['notes.txt']);
  // The quote chip comes before the list.
  const list = f.container.querySelector('[data-testid="text-attachments"]');
  expect(
    chip && list ? chip.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
  ).toBeTruthy();
});

it('nothing polls the run: no timer is set for an instruction', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  await show(entry(), { record: record('queued') });
  await show(entry());
  // jsdom runs animation frames on a frame-length interval; a poll would be slower than that.
  expect(interval.mock.calls.filter(([, ms]) => Number(ms ?? 0) > 1000 / 30)).toEqual([]);
});

const request = (patch: Partial<SessionEntry> = {}) =>
  entry({
    entryId: 'entry_next',
    intent: 'next',
    text: 'Please tidy the conversation',
    state: 'started',
    runId: 'run_next',
    executionId: null,
    commandId: 'cmd_next',
    ...patch,
  });

it('a started request leaves its number and state to the run row', async () => {
  const f = await show(request());
  expect(f.meta()).not.toBeNull();
  expect(f.status()?.textContent ?? '').toBe('');
  expect(f.container.querySelector('[data-testid="turn-run"]')).not.toBeNull();
  // A question still says what it was, at the line's start.
  const question = await show(request({ intent: 'explain' }));
  expect(question.status()?.textContent).toBe(messages.Sessions.intentShort.explain);
  const scheduled = await show(request({ commandId: 'scheduled_daily' }));
  expect(scheduled.status()?.textContent).toBe(messages.Sessions.scheduledRequest);
});

/**
 * The line's buttons are the kit's smallest quiet ones: never the primary variant (the screen's
 * one primary is Send) and never the default control height.
 */
function expectQuiet(status: HTMLElement | null | undefined) {
  const controls = [...(status?.querySelectorAll<HTMLElement>('button, a') ?? [])];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.className, control.textContent ?? '').not.toContain('text-background');
    expect(control.className, control.textContent ?? '').toContain('h-7');
  }
}

it('a refused request says why in one line; the reason opens the runtime’s words', async () => {
  const value = request({
    intent: 'queue',
    state: 'refused',
    runId: null,
    detail: 'no such model profile: writer-pro',
    refusal: { code: 'TARGET_NOT_FOUND', message: 'no such model profile: writer-pro' },
    references: [{ kind: 'file', path: 'src/a.ts' }],
    permissionMode: 'ask',
  });
  const f = await show(value);
  const status = f.status();
  // A queued request is not a kind of message: the reason comes first, in the danger color.
  expect(status?.textContent?.startsWith(messages.Refusal.profile)).toBe(true);
  const reason = f.button(messages.Refusal.profile);
  expect(reason).toBeDefined();
  expect(reason?.className).toContain('text-danger');
  expect(reason?.title).toBe(messages.Refusal.profile);
  // No alert box under the message.
  expect(f.container.querySelector('[data-testid="refusal"]')).toBeNull();
  expect(f.container.querySelector('[role="alert"]')).toBeNull();
  // The actions for its kind, on the same line.
  expect(status?.textContent).toContain(messages.Refusal.connect);
  expectQuiet(f.status());
  // Its edit is the message's own pencil on this line: the line does not offer it twice.
  expect(f.button(messages.Refusal.edit)).toBeUndefined();
  const edit = f.button(messages.MessageBody.editAsNew);
  expect(f.meta()?.contains(edit ?? null)).toBe(true);
  await act(async () => edit?.click());
  expect(fixture.editRequest).toHaveBeenCalledWith(value.text, value);
  await act(async () => reason?.click());
  const raw = document.body.querySelector('[data-testid="refusal-raw"]');
  expect(raw?.textContent).toContain('no such model profile: writer-pro');
  expect(raw?.textContent).toContain('TARGET_NOT_FOUND');
});

it('a terminal refusal offers the terminal on the line; the owner is in the raw words', async () => {
  const f = await show(
    request({
      state: 'refused',
      runId: null,
      detail: 'working copy is busy',
      refusal: {
        code: 'RUN_ALREADY_ACTIVE',
        message: 'working copy is busy',
        owner: { kind: 'terminal', id: 'term_1', sessionId: 'session_meta', state: 'active' },
      },
    } as Partial<SessionEntry>),
  );
  expect(f.status()?.textContent).toContain(messages.Refusal.openTerminal);
  expectQuiet(f.status());
  await act(async () => f.button(messages.Refusal.terminal)?.click());
  expect(document.body.querySelector('[data-testid="refusal-raw"]')?.textContent).toContain(
    'term_1',
  );
});

it('a refused instruction, or a carried request that did not start, offers the edit on the line', async () => {
  const steer = entry({ state: 'refused', detail: 'The run has ended', runId: 'run_live' });
  const f = await show(steer, { record: null });
  expect(f.button(messages.MessageBody.editAsNew)).toBeUndefined();
  expectQuiet(f.status());
  await act(async () => f.button(messages.Refusal.edit)?.click());
  expect(fixture.editRequest).toHaveBeenCalledWith(steer.text, steer);
  const carried = entry({
    entryId: 'entry_carried',
    intent: 'queue',
    state: 'refused',
    runId: null,
    detail: 'no such model profile: writer-pro',
    carriedFrom: 'directive_steer',
  });
  const source = await show(entry(), { record: record('expired'), carried });
  expect(source.status()?.textContent).toContain(messages.Refusal.profile);
  await act(async () => source.button(messages.Refusal.edit)?.click());
  expect(fixture.editRequest).toHaveBeenLastCalledWith(carried.text, carried);
});

it('a detail without a refusal is said on the line too', async () => {
  const f = await show(request({ state: 'undelivered', runId: null, detail: 'Handoff closed' }));
  const detail = f.status()?.querySelector('.text-danger');
  expect(detail?.textContent).toBe('Handoff closed');
  expect(f.container.querySelector('p[role="note"]')).toBeNull();
});

const carriedStarted = entry({
  entryId: 'entry_carried',
  intent: 'queue',
  text: 'Keep the summary short',
  state: 'started',
  runId: 'run_next',
  executionId: null,
  commandId: 'cmd_carried',
  carriedFrom: 'directive_steer',
});

it('a carried request with its source here draws its run row alone', async () => {
  const f = await show(carriedStarted, { runOnly: true });
  expect(f.meta()).toBeNull();
  expect(f.container.textContent).not.toContain(carriedStarted.text);
  expect(f.container.querySelector('[data-testid="turn-run"]')).not.toBeNull();
});

it('the source message takes the carried request’s edit and branch when the request is right under it', async () => {
  const f = await show(entry(), {
    record: record('expired'),
    carried: carriedStarted,
    carriedHere: true,
  });
  expect(f.status()?.textContent).toBe(m.carriedStarted);
  const edit = f.button(messages.MessageBody.editAsNew);
  expect(edit).toBeDefined();
  await act(async () => edit?.click());
  expect(fixture.editRequest).toHaveBeenCalledWith(carriedStarted.text, carriedStarted);
  expect(f.button('Branch before this request')?.dataset.run).toBe('run_next');
  // The instruction itself has no run row: the carried request's row follows it.
  expect(f.container.querySelector('[data-testid="turn-run"]')).toBeNull();
});

it('with another item between, the source says the same words but has no request actions', async () => {
  const f = await show(entry(), { record: record('expired'), carried: carriedStarted });
  expect(f.status()?.textContent).toBe(m.carriedStarted);
  expect(f.button(messages.MessageBody.editAsNew)).toBeUndefined();
  expect(f.button('Branch before this request')).toBeUndefined();
});

it('a carried request without its source here draws its own message, saying it started', async () => {
  const f = await show(carriedStarted);
  expect(f.status()?.textContent).toBe(m.carriedStarted);
  expect(f.container.textContent).toContain(carriedStarted.text);
  expect(f.container.querySelector('[data-testid="turn-run"]')).not.toBeNull();
  // Its own actions.
  expect(f.button(messages.MessageBody.editAsNew)).toBeDefined();
});

it('a carried request taken out of the queue, or back to edit, leaves the message not delivered', async () => {
  const removed = entry({
    entryId: 'entry_carried',
    intent: 'queue',
    state: 'dismissed',
    runId: null,
    carriedFrom: 'directive_steer',
  });
  const f = await show(entry(), { record: record('expired'), carried: removed });
  expect(f.said().replace(m.resend, '').trim()).toBe(m.notDelivered);
  expect(f.button(m.resend)).toBeDefined();
});

it('expired while watched and before the session is read again, the line says what it said', async () => {
  // Held: what it was before the expiry this view saw.
  const held = await show(entry(), { record: record('expired'), heldAs: 'queued' });
  expect(held.said()).toBe(m.waiting);
  expect(held.button(m.resend)).toBeUndefined();
  // Read again with no carried request: not delivered. Opened already expired: the same.
  const settled = await show(entry(), { record: record('expired') });
  expect(settled.said().replace(m.resend, '').trim()).toBe(m.notDelivered);
  // A carried request in the session is followed, held or not.
  const carried = entry({
    entryId: 'entry_carried',
    intent: 'queue',
    state: 'queued',
    runId: null,
    carriedFrom: 'directive_steer',
  });
  const late = await show(entry(), { record: record('expired'), carried, heldAs: 'queued' });
  expect(late.said()).toBe(m.carriedWaiting);
});

it('the role button says what it opens; the visible words stay the role', async () => {
  const f = await show(entry(), { record: record('delivered') });
  const role = f.button('Writer');
  expect(role?.getAttribute('aria-label')).toBe(
    messages.Sessions.meta.openTarget.replace('{name}', 'Writer'),
  );
  // The sentence for assistive tech still says it was an instruction.
  expect(f.container.querySelector('.sr-only')?.textContent).toContain(
    messages.Sessions.intent.steer,
  );
});

it('a carried request is placed once: right under its source, under an unread one, and alone', () => {
  const steer = entry();
  const carried = carriedStarted;
  const directive = record('expired').directive;
  const read = placeEntries([steer, carried], () => directive);
  expect([...read.runOnly]).toEqual([carried.entryId]);
  expect([...read.carriesActions]).toEqual([steer.entryId]);
  expect(read.carriedOf.get(steer.entryId)).toBe(carried);
  // Unread, the instruction right above is taken to be its source, so its message does not
  // appear and then go.
  expect([...placeEntries([steer, carried], () => undefined).runOnly]).toEqual([carried.entryId]);
  // Sent from the run record: no instruction of the conversation is its source.
  const other = placeEntries([steer, carried], () => ({
    ...directive,
    directiveId: 'directive_other',
  }));
  expect(other.runOnly.size).toBe(0);
  expect(placeEntries([carried], () => undefined).runOnly.size).toBe(0);
  // Another item between: drawn whole, though its source is known.
  const between = request({ entryId: 'entry_between' });
  const apart = placeEntries([steer, between, carried], () => directive);
  expect(apart.runOnly.size).toBe(0);
  expect(apart.carriedOf.get(steer.entryId)).toBe(carried);
  // Did not start, under its source: an item drawn as nothing, reached through its source.
  const refused = { ...carried, state: 'refused' as const, runId: null };
  expect(placeEntries([steer, refused], () => directive).emptyFor.get(refused.entryId)).toBe(
    steer.entryId,
  );
});

it('an instruction whose run was read but has no directive for it is not known to be delivered', async () => {
  const f = await show(entry(), { record: null });
  expect(f.said()).toBe(m.unknown);
});
