// @vitest-environment jsdom
import { ApiError } from '@corral/client';
import {
  type MeetingHandoffReceipt,
  MeetingHandoffRequest,
  type MeetingView,
} from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { readDraft, writeDraft } from './sessionDraft.ts';

const fixture = vi.hoisted(() => ({ services: {} as any }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('./useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('./AutoModelMenu.tsx', () => ({
  AutoModelMenu: ({ onChange }: any) => (
    <button type="button" onClick={() => onChange({ modelProfile: 'model-b' })}>
      switchPrimary
    </button>
  ),
}));
vi.mock('./UltraModels.tsx', () => ({
  UltraModels: ({ value, onChange }: any) => (
    <button type="button" onClick={() => onChange({ ...value, refinementRounds: 1 })}>
      chooseUltra
    </button>
  ),
  defaultUltraSelection: () => ({
    version: 2,
    modelProfiles: ['model-a', 'model-b'],
    verifierProfile: 'model-b',
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: any) => (
    <a href={`${to}:${Object.values(params).join('/')}`}>{children}</a>
  ),
}));
vi.mock('@corral/react/design-kit', () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Select: ({ label, value, options, onValueChange, ...props }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      {...props}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
const { MeetingHandoff, MeetingHandoffLinks } = await import('./MeetingHandoff.tsx');
const receipt = {
  commandId: 'h',
  startCommandId: 's',
  sourceSessionId: 'meeting',
  decisionVersionId: 'v1',
  targetSessionId: 'work',
  entryId: 'e',
  action: 'draft',
  execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
  definitionRevision: null,
  mode: 'mock',
  brief: 'Do work',
  state: 'drafted',
  detail: null,
  runId: null,
  createdAt: 'now',
  result: null,
} as MeetingHandoffReceipt;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
async function mount(links = false, savedReceipt = receipt, source = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  const api = {
    send: vi.fn(async (_id: string, _request: any) => ({ handoff: receipt })),
    receipt: vi.fn(async () => ({ handoff: null as MeetingHandoffReceipt | null })),
    list: vi.fn(async () => ({ handoffs: links ? [savedReceipt] : [] })),
    cancel: vi.fn(),
    start: vi.fn(async () => ({ handoff: receipt })),
    rediscuss: vi.fn(async () => ({ ok: true })),
  };
  fixture.services = {
    mode: 'server',
    live: false,
    meetingHandoffs: api,
    repository: {
      list: vi.fn(async () => []),
      listSessions: vi.fn(async () => [
        { sessionId: 'work', title: 'Work', projectId: 'project', archivedAt: null },
        {
          sessionId: 'meeting2',
          title: 'Other meeting',
          projectId: 'project',
          archivedAt: null,
          meeting: {},
        },
        { sessionId: 'archived', title: 'Archived', projectId: 'project', archivedAt: 'date' },
        { sessionId: 'foreign', title: 'Other project', projectId: 'foreign', archivedAt: null },
      ]),
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const session = { sessionId: 'meeting', projectId: 'project' } as WorkSession;
  await act(async () =>
    root.render(
      links ? (
        <MeetingHandoffLinks sessionId={source ? 'meeting' : 'work'} />
      ) : (
        <MeetingHandoff
          session={session}
          decision={
            { versionId: 'v1', content: { goal: 'Do work' } } as NonNullable<
              MeetingView['decisions']
            >[number]
          }
          onChange={async () => {}}
        />
      ),
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const select = async (label: string, value: string) =>
    act(async () => {
      const el = container.querySelector(`select[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  return { api, container, button, select };
}
it('[TC-MEET-003-N] handoff excludes meetings, other projects and archived targets and preserves unsent input', async () => {
  writeDraft('work', 'Keep this request');
  const f = await mount();
  await act(async () => f.button('open').click());
  expect(f.container.textContent).not.toContain('Other meeting');
  expect(f.container.textContent).not.toContain('Archived');
  expect(f.container.textContent).not.toContain('Other project');
  await f.select('target', 'work');
  await act(async () => f.button('start').click());
  expect(MeetingHandoffRequest.safeParse(f.api.send.mock.calls[0]?.[1]).success).toBe(true);
  expect(f.api.send).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({
      action: 'start',
      target: { kind: 'existing', sessionId: 'work' },
      targetHasDraft: true,
    }),
  );
  expect(readDraft('work')).toBe('Keep this request');
});
it('[TC-MEET-003-F] lost response reads its receipt first and retries only the original command', async () => {
  const f = await mount();
  f.api.send.mockRejectedValueOnce(new Error('connection lost'));
  f.api.receipt.mockRejectedValueOnce(new Error('offline'));
  await act(async () => f.button('open').click());
  await act(async () => f.button('draft').click());
  const first = f.api.send.mock.calls[0]![1];
  expect(f.api.receipt).toHaveBeenCalledWith('meeting', first.commandId);
  await act(async () => f.button('retry').click());
  expect(f.api.receipt).toHaveBeenCalledTimes(2);
  expect(f.api.send.mock.calls[1]![1]).toEqual(first);
});
it('[TC-MEET-003-H] a work session links back to its source meeting and decision', async () => {
  const f = await mount(true);
  expect(f.container.querySelector('a')?.getAttribute('href')).toContain('meeting');
  expect(f.container.textContent).toContain('v1');
});

it('[TC-MEET-003-N] starting a saved handoff checks its receipt and keeps the target draft', async () => {
  writeDraft('work', 'Still editing');
  const f = await mount(true);
  f.api.receipt.mockResolvedValue({ handoff: receipt });
  await act(async () => f.button('startDraft').click());
  expect(f.api.receipt).toHaveBeenCalledWith('meeting', 'h');
  expect(f.api.start).toHaveBeenCalledWith(
    'meeting',
    'h',
    expect.objectContaining({ targetHasDraft: true }),
  );
  expect(readDraft('work')).toBe('Still editing');
});
it('[TC-MEET-003-F] a pending start cannot overtake input added to the target after the first attempt', async () => {
  const f = await mount();
  f.api.send.mockRejectedValueOnce(new Error('connection lost'));
  f.api.receipt.mockRejectedValueOnce(new Error('offline'));
  await act(async () => f.button('open').click());
  await f.select('target', 'work');
  await act(async () => f.button('start').click());
  writeDraft('work', 'New input since the uncertain start');
  await act(async () => f.button('retry').click());
  expect(f.api.send).toHaveBeenCalledTimes(1);
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain('draftChanged');
  expect(readDraft('work')).toBe('New input since the uncertain start');
});

it('[TC-MEET-003-F] a definite rejection with no receipt unlocks the handoff settings', async () => {
  const f = await mount();
  f.api.send.mockRejectedValueOnce(new ApiError(400, 'SCHEMA_INVALID', 'Invalid handoff fields'));
  await act(async () => f.button('open').click());
  await act(async () => f.button('draft').click());
  expect(f.api.receipt).toHaveBeenCalledOnce();
  expect(f.button('draft')?.disabled).toBe(false);
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
    'Invalid handoff fields',
  );
});

it.each(['paused', 'awaiting_user'])(
  '[TC-MEET-003-N] %s handoff runs still expose cancellation',
  async (status) => {
    const f = await mount(true, {
      ...receipt,
      state: 'started',
      runId: 'run1',
      result: { status, artifactVersionId: null },
    });
    await act(async () => f.button('cancel').click());
    expect(f.api.cancel).toHaveBeenCalledWith('meeting', 'h');
  },
);

it('[TC-MEET-003-N] changing the primary model in an edited Ultra setup keeps an independent verifier', async () => {
  const f = await mount();
  await act(async () => f.button('open').click());
  await f.select('qualityPreset', 'ultra');
  await act(async () => f.button('chooseUltra').click());
  await act(async () => f.button('switchPrimary').click());
  await act(async () => f.button('start').click());
  expect(f.api.send).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({
      execution: expect.objectContaining({
        choice: { modelProfile: 'model-b' },
        ultra: expect.objectContaining({ verifierProfile: 'model-a', refinementRounds: 1 }),
      }),
    }),
  );
});

it('[TC-MEET-003-F] a failed result without an artifact can be explicitly discussed again', async () => {
  const f = await mount(
    true,
    {
      ...receipt,
      state: 'started',
      runId: 'run1',
      result: { status: 'failed', artifactVersionId: null },
    },
    true,
  );
  await act(async () => f.button('rediscuss').click());
  expect(f.api.rediscuss).toHaveBeenCalledWith(
    'meeting',
    'h',
    expect.objectContaining({ mode: 'mock', commandId: expect.stringMatching(/^cmd_/) }),
  );
});
it('[TC-MEET-003-F] reopening an uncertain handoff shows its frozen target instead of new-request defaults', async () => {
  const first = await mount();
  first.api.send.mockRejectedValueOnce(new Error('connection lost'));
  first.api.receipt.mockRejectedValueOnce(new Error('offline'));
  await act(async () => first.button('open').click());
  await first.select('target', 'work');
  await act(async () => first.button('start').click());
  const second = await mount();
  const target = second.container.querySelector('select[aria-label="target"]') as HTMLSelectElement;
  expect(target.value).toBe('work');
  expect(target.disabled).toBe(true);
});
