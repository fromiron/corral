// @vitest-environment jsdom
import type { ImageAttachment, TextAttachment } from '@corral/contracts';
import {
  type CorralSummary,
  createTextAttachment,
  emptyProjection,
  type RunSummary,
  type SessionEntry,
  type WorkSession,
} from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { appendComposerAttachment, beginAttachmentCapture } from '../workbench/context/bridge.ts';
import { readComposerDraft, writeComposerDraft } from '../workbench/sessionDraft.ts';
import { Composer } from './SessionPage.tsx';

const fixture = vi.hoisted(() => ({
  services: {},
  invalidate: vi.fn(async () => {}),
  navigate: vi.fn(),
  href: '/sessions/session?panel=files',
  profiles: null as import('../workbench/useModels.ts').ProfileInfo[] | null,
  roles: [] as { profileId: string; name: string }[],
  executionStatus: 'active' as string,
  materialsRequest: vi.fn(
    async (_path: string, _body?: unknown): Promise<unknown> => ({ materials: [] }),
  ),
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../projects-api.ts', () => ({
  projectRequest: (...args: [string, unknown?]) => fixture.materialsRequest(...args),
}));
vi.mock('../router.tsx', () => ({ sessionRoute: {}, runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
  useNavigate: () => fixture.navigate,
  useRouter: () => ({
    invalidate: fixture.invalidate,
    state: { location: { href: fixture.href } },
  }),
}));
vi.mock('../commandRegistry.ts', () => ({
  useRegisterCommands() {},
  useRegisteredCommands: () => [],
}));
vi.mock('../shortcutBindings.ts', async (original) => ({
  ...(await original<typeof import('../shortcutBindings.ts')>()),
  useShortcutBindings() {},
}));
vi.mock('./Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/useModels.ts', () => ({
  useModelProfiles: () => fixture.profiles,
  useTeamRoles: () => fixture.roles,
}));
vi.mock('../workbench/useMentionSearch.ts', () => ({ useMentionSearch: () => async () => [] }));
vi.mock('../workbench/widgets/ChatWidgets.tsx', () => ({
  // The one-line status keeps the composer's own intent chips (lead) and held-items note;
  // the plan it expands sits under it.
  ComposerDock: ({
    lead,
    note,
    plan,
  }: {
    lead?: ReactNode;
    note?: ReactNode;
    plan?: ReactNode;
  }) => (
    <>
      <div data-testid="composer-status-pills">
        {lead}
        {note}
      </div>
      {plan}
    </>
  ),
  ComposerPlan: () => <div data-testid="composer-plan-fixture">Work plan</div>,
}));
vi.mock('../workbench/widgets/ComposerStats.tsx', () => ({ ComposerStats: () => null }));
vi.mock('../workbench/ImageAttachments.tsx', () => ({
  ImageAttachmentPicker: () => null,
  ImageAttachmentList: () => null,
}));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixture.profiles = null;
  fixture.roles = [];
  fixture.executionStatus = 'active';
  fixture.materialsRequest.mockReset();
  fixture.materialsRequest.mockResolvedValue({ materials: [] });
});

const captured: TextAttachment = {
  ...createTextAttachment('selection.txt', 'text/plain', 'const answer = 42;'),
  provenance: {
    kind: 'code',
    target: {
      hostId: 'host',
      projectId: 'project',
      sessionId: 'source_session',
      bindingId: 'binding',
      copyGeneration: 1,
    },
    path: 'src/answer.ts',
    snapshot: 'draft',
    baseHash: 'a'.repeat(64),
    bufferHash: 'b'.repeat(64),
    editVersion: 4,
    range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 19 },
  },
};
const image: ImageAttachment = {
  kind: 'image_attachment',
  imageId: 'image',
  name: 'next.png',
  mime: 'image/png',
  bytes: 1,
  sha256: 'c'.repeat(64),
  width: 1,
  height: 1,
};
const team: CorralSummary = {
  corralId: 'team',
  projectId: 'project',
  name: 'Team',
  definitionRevision: 1,
  nodeCount: 3,
  updatedAt: '2026-10-21T00:00:00Z',
};
const active: RunSummary = {
  runId: 'active',
  status: 'running',
  corralId: 'team',
  projectId: 'project',
  sessionId: 'other_session',
  startedAt: '2026-10-21T00:00:00Z',
};
const queuedEntry = (attachment: TextAttachment): SessionEntry => ({
  entryId: 'queued',
  intent: 'queue',
  text: 'Use the captured source',
  state: 'queued',
  createdAt: '2026-10-21T00:00:00Z',
  runId: null,
  executionId: null,
  detail: null,
  attachments: [attachment],
});

async function mount(
  sessionId: string,
  initiallyActive: RunSummary | null,
  initialQueue: SessionEntry[] = [],
  runs: RunSummary[] = [],
  selectedRunId: string | null = null,
  mode: 'server' | 'browser' = 'server',
  runControlsOwnConfirmation = false,
  {
    session: change,
    ...extra
  }: { home?: boolean; corrals?: CorralSummary[]; session?: Partial<WorkSession> } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  disposals.push(async () => {
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
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
  const session: WorkSession = {
    sessionId,
    projectId: 'project',
    corralId: 'team',
    auto: null,
    title: 'Session',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    archivedAt: null,
    autoStart: true,
    entries: [],
    ...change,
  };
  let persistedQueue = initialQueue;
  const repository = {
    getSession: vi.fn(async () => ({
      ...session,
      entries: [...session.entries, ...persistedQueue],
    })),
    get: vi.fn(async () => ({ ...team, definition: linearCorral(['writer']) })),
    addSessionEntry: vi.fn(async (_sessionId: string, _entry: Partial<SessionEntry>) => ({
      ok: true,
      session,
    })),
    updateSessionEntry: vi.fn(async () => ({ ok: true, session })),
    updateSession: vi.fn(async (_sessionId: string, _change: unknown) => ({ ok: true, session })),
  };
  const transport = {
    sendCommand: vi.fn(async (_command: unknown) => ({ error: null })),
    startRun: vi.fn(async (_command: unknown) => ({ runId: 'started', receipt: { error: null } })),
    getSnapshot: vi.fn(async () => ({
      projection: {
        executionOrder: ['execution'],
        executions: {
          execution: { executionId: 'execution', nodeId: 'writer', status: 'running' },
        },
        output: { artifactVersionIds: ['result'] },
        artifacts: { result: { name: 'Result', version: 1 } },
      },
    })),
    getRunDefinition: vi.fn(async () => {
      const definition = linearCorral(['writer']);
      return {
        ...definition,
        nodes: definition.nodes.map((node) => ({ ...node, label: 'Writer' })),
      };
    }),
  };
  const startExplain = vi.fn();
  // a Corral session's turn starts the conversation lead with the Corral as its team.
  const startAuto = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
    runId: 'started',
    receipt: { error: null },
    autoRoute: null,
  }));
  // The live run's projection the composer reads its targets from (composer-flow.md "계약"):
  // the writer writing the answer, and a reviewer working beside it.
  const runSessions = new Map<string, StoreApi<Record<string, unknown>>>();
  const runFor = vi.fn((runId: string) => {
    const existing = runSessions.get(runId);
    if (existing) return existing;
    const projection = emptyProjection(runId);
    projection.status = 'running';
    projection.executionOrder = ['execution', 'reviewer'];
    projection.executions.execution = {
      executionId: 'execution',
      nodeId: 'writer',
      status: fixture.executionStatus,
      waitingOn: null,
    } as never;
    projection.executions.reviewer = {
      executionId: 'reviewer',
      nodeId: 'review',
      status: fixture.executionStatus,
      waitingOn: null,
    } as never;
    const team = linearCorral(['writer', 'review']);
    const created = createStore<Record<string, unknown>>(() => ({
      runId,
      projection,
      definition: {
        ...team,
        nodes: team.nodes.map((node) => ({
          ...node,
          label: node.id === 'writer' ? 'Writer' : node.id === 'review' ? 'Review' : node.label,
        })),
      },
      streamError: null,
      missingRunId: null,
      open: async () => {},
    }));
    runSessions.set(runId, created);
    return created;
  });
  fixture.services = {
    repository,
    transport,
    runFor,
    retainRun: () => () => {},
    startAuto,
    mode,
    live: false,
    workspaceId: 'host',
    workspaces: null,
    startExplain,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (running: RunSummary | null, queued: SessionEntry[]) => {
    persistedQueue = queued;
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Composer
            runControlsOwnConfirmation={runControlsOwnConfirmation}
            session={session}
            team={team}
            corrals={[team]}
            runs={runs}
            active={running}
            selectedRunId={selectedRunId}
            queued={queued}
            onChange={() => {}}
            reference={null}
            onReferenceUsed={() => {}}
            {...extra}
          />
        </IntlProvider>,
      ),
    );
  };
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render(initiallyActive, initialQueue);
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.getAttribute('aria-label') === label || node.textContent === label,
    );
    expect(button, label).toBeDefined();
    expect(button?.disabled, label).toBe(false);
    await act(async () => button?.click());
  };
  return {
    container,
    session,
    repository,
    transport,
    runFor,
    startAuto,
    startExplain,
    render,
    click,
  };
}

it('exposes the demo model picker as simulation without pretending a model is connected', async () => {
  const f = await mount('demo_picker', null, [], [], null, 'browser');
  await f.click(messages.Sessions.autoModel);
  expect(document.body.textContent).toContain(messages.Composer.modelPicker.demoEmpty);
  expect(document.querySelector('[role="option"]')).toBeNull();
  expect(document.querySelector('[role="switch"]')).toBeNull();
});

it('queues a captured source with the draft images, consumes both, and starts that snapshot without consuming a later draft', async () => {
  const sessionId = 'queue_capture';
  writeComposerDraft(sessionId, {
    text: 'Keep my typed request',
    intent: 'queue',
    target: null,
    targetLabel: null,
    references: [],
    images: [image],
  });
  const f = await mount(sessionId, active);
  await act(async () => {
    expect(
      appendComposerAttachment(
        beginAttachmentCapture({ hostId: 'host', projectId: 'project', sessionId }),
        captured,
      ),
    ).toEqual({ ok: true });
  });
  expect(
    f.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]')?.value,
  ).toBe('Keep my typed request');
  await f.click('Send');
  expect(f.repository.addSessionEntry).toHaveBeenCalledOnce();
  const saved = f.repository.addSessionEntry.mock.calls[0]?.[1];
  expect(saved).toMatchObject({
    intent: 'queue',
    state: 'queued',
    text: 'Keep my typed request',
    attachments: [captured],
    // A next request carries its images (features/composer-flow.md "합류 대상").
    images: [image],
  });
  expect(f.startAuto).not.toHaveBeenCalled();
  expect(readComposerDraft(sessionId)).toMatchObject({ text: '' });
  expect(readComposerDraft(sessionId).images).toBeUndefined();
  expect(readComposerDraft(sessionId).attachments).toBeUndefined();

  await f.render(null, [{ ...queuedEntry(captured), ...saved }]);
  const later = createTextAttachment('later.txt', 'text/plain', 'Only for the next request');
  await act(async () => {
    expect(
      appendComposerAttachment(
        beginAttachmentCapture({ hostId: 'host', projectId: 'project', sessionId }),
        later,
      ),
    ).toEqual({ ok: true });
  });
  await f.click('Start now');
  expect(f.startAuto).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId,
      references: [captured, image],
      brief: 'Keep my typed request',
      team: { corralId: 'team' },
    }),
    expect.anything(),
  );
  expect(f.repository.updateSessionEntry).toHaveBeenCalledWith(
    sessionId,
    'queued',
    expect.objectContaining({ state: 'started', runId: 'started' }),
  );
  expect(readComposerDraft(sessionId)).toMatchObject({ attachments: [later] });
  expect(readComposerDraft(sessionId).images).toBeUndefined();
});

it('retries an uncertain queued snapshot with the same command identity and includes provenance in changed request identity', async () => {
  const f = await mount('queue_retry', null, [queuedEntry(captured)]);
  f.startAuto.mockRejectedValue(new Error('response lost'));
  await f.click('Start now');
  await f.click('Start now');
  expect(f.startAuto).toHaveBeenCalledTimes(2);
  const first = f.startAuto.mock.calls[0]?.[0] as {
    commandId: string;
    references: TextAttachment[];
  };
  const retry = f.startAuto.mock.calls[1]?.[0] as typeof first;
  expect(first.references).toEqual([captured]);
  expect(retry.commandId).toBe(first.commandId);
  expect(f.repository.updateSessionEntry).not.toHaveBeenCalled();
  if (captured.provenance?.kind !== 'code') throw new Error('code fixture missing');
  const changed = { ...captured, provenance: { ...captured.provenance, editVersion: 5 } };
  await f.render(null, [queuedEntry(changed)]);
  await f.click('Start now');
  const edited = f.startAuto.mock.calls[2]?.[0] as typeof first;
  expect(edited.references).toEqual([changed]);
  expect(edited.commandId).not.toBe(first.commandId);
});

it('an explain draft from an earlier version is sent as a next request with its captured context', async () => {
  const sessionId = 'context_explain';
  writeComposerDraft(sessionId, {
    text: 'Explain this capture',
    intent: 'explain',
    target: null,
    targetLabel: null,
    references: [],
    attachments: [captured],
  });
  const f = await mount(
    sessionId,
    null,
    [],
    [{ ...active, runId: 'finished', sessionId, status: 'succeeded' }],
  );
  // A stored intent other than an instruction is not fixed on the draft: nothing blocks it.
  expect(f.container.querySelector('[data-testid="intent-blocked"]')).toBeNull();
  expect(readComposerDraft(sessionId)).toMatchObject({
    text: 'Explain this capture',
    attachments: [captured],
  });
  await f.click('Send');
  expect(f.startExplain).not.toHaveBeenCalled();
  expect(f.startAuto).toHaveBeenCalledWith(
    expect.objectContaining({ references: [captured], brief: 'Explain this capture' }),
    expect.anything(),
  );
});

it('leaves whole-run stop to the top bar while composing a queued next request in the single input', async () => {
  const sessionId = 'stop_while_typing';
  writeComposerDraft(sessionId, {
    text: 'After this, summarize the result',
    intent: 'queue',
    target: null,
    targetLabel: null,
    references: [],
  });
  const ownRun = { ...active, sessionId };
  const f = await mount(sessionId, ownRun, [], [ownRun], ownRun.runId);
  expect(f.container.querySelectorAll('textarea')).toHaveLength(1);
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    'After this, summarize the result',
  );
  // The live run's Cancel sits once in the top bar's run controls (DockRunControls), so the
  // composer does not repeat it beside the draft.
  const stops = [...f.container.querySelectorAll('button')].filter((button) =>
    button.textContent?.includes(messages.Reins.cancelRun),
  );
  expect(stops).toHaveLength(0);
  expect(f.container.querySelector('button[aria-label="Send"]')).not.toBeNull();
});

it('leaves a pending whole-run confirmation to the visible run controls without opening a second dialog', async () => {
  const sessionId = 'one_cancel_confirmation';
  const ownRun = { ...active, sessionId };
  const key = `corral:cancel-confirmation:${ownRun.runId}`;
  window.sessionStorage.setItem(key, 'pending');
  try {
    const f = await mount(sessionId, ownRun, [], [ownRun], ownRun.runId, 'server', true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBe('pending');
    expect(f.transport.sendCommand).not.toHaveBeenCalled();
    expect(f.container.querySelectorAll('textarea')).toHaveLength(1);
  } finally {
    window.sessionStorage.removeItem(key);
  }
});

it('offers project references in the unified add menu instead of a second toolbar trigger', async () => {
  const f = await mount('unified_add', null);
  expect(
    f.container.querySelector(`button[aria-label="${messages.Composer.addReference}"]`),
  ).toBeNull();
  await f.click(messages.Composer.attachmentActions);
  let reference: HTMLElement | undefined;
  await vi.waitFor(() => {
    reference = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes(messages.Composer.addReference),
    );
    expect(reference).toBeDefined();
  });
  await act(async () => reference?.click());
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('@');
  expect(f.container.querySelectorAll('textarea')).toHaveLength(1);
});

it('names the add button in a tooltip, as the row’s other icon buttons are', async () => {
  const f = await mount('add_tooltip', null);
  const add = f.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${messages.Composer.attachmentActions}"]`,
  );
  expect(add).not.toBeNull();
  await act(async () => {
    add?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    add?.dispatchEvent(new MouseEvent('mouseenter'));
    add?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    add?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toBe(messages.Composer.attachmentActions);
});

it('removes a whole-file token without damaging its range or longer paths', async () => {
  const sessionId = 'exact_file_reference';
  writeComposerDraft(sessionId, {
    text: 'Read @README.md @README.md:L1-L3 @README.mdx',
    intent: 'next',
    target: null,
    targetLabel: null,
    references: [
      {
        id: 'file:readme',
        kind: 'file',
        label: 'README.md',
        reference: { kind: 'file', path: 'README.md' },
      },
      {
        id: 'file:range',
        kind: 'file',
        label: 'README.md',
        lines: { start: 1, end: 3 },
        reference: { kind: 'file', path: 'README.md', lines: { start: 1, end: 3 } },
      },
    ],
  });
  const f = await mount(sessionId, null);
  await f.click('Remove reference README.md');
  expect(f.container.querySelector('textarea')?.value).toBe('Read @README.md:L1-L3 @README.mdx');
  await f.click('Remove reference README.md:L1-L3');
  expect(f.container.querySelector('textarea')?.value).toBe('Read @README.mdx');
});

it('clears a bare slash on Escape without sending it', async () => {
  const sessionId = 'slash_escape';
  const f = await mount(sessionId, null);
  const input = f.container.querySelector('textarea');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '/');
    input?.setSelectionRange(1, 1);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input?.getAttribute('aria-expanded')).toBe('true');
  await act(async () =>
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(input?.value).toBe('');
  expect(f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
    true,
  );
  expect(f.startAuto).not.toHaveBeenCalled();
});

it('removes one legacy same-name result while preserving the other exact draft reference', async () => {
  const sessionId = 'legacy_result_identity';
  const references = ['one', 'two'].map((runId, index) => ({
    id: `result:${runId}`,
    kind: 'result' as const,
    label: 'notes v1',
    detail: `Run #${index + 1} · Writer`,
    reference: { kind: 'result' as const, runId, artifactVersionId: 'result' },
  }));
  writeComposerDraft(sessionId, {
    text: 'Compare @"notes v1" @"notes v1"',
    intent: 'next',
    target: null,
    targetLabel: null,
    references,
  });
  const f = await mount(sessionId, null);
  await f.click('Remove reference "notes v1" · Run #1 · Writer');
  expect(f.container.querySelector('textarea')?.value).toBe('Compare @"notes v1"');
  expect(readComposerDraft(sessionId).references).toEqual([references[1]]);
  expect(
    f.container.querySelector(
      'button[aria-label=\'Remove reference "notes v1" · Run #2 · Writer\']',
    ),
  ).not.toBeNull();
});

it('names the viewed and active runs and that the request waits, without changing the draft', async () => {
  const sessionId = 'view_old_run';
  const current = { ...active, runId: 'second', sessionId };
  const previous = { ...current, runId: 'first', status: 'cancelled' as const };
  writeComposerDraft(sessionId, {
    text: 'Later request',
    intent: 'queue',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(sessionId, current, [], [previous, current], 'first');
  expect(f.container.querySelector('[data-testid="viewed-run-warning"]')?.textContent).toContain(
    'Viewing Run #1 while Run #2 is active',
  );
  // A next request is picked for one send only, so the stored draft is not fixed to it: the
  // send key joins the active run, never the one being viewed (composer-flow.md "합류 대상").
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toBe(
    'Send to: Run #2 · Writer · instruction',
  );
  expect(readComposerDraft(sessionId).text).toBe('Later request');
});

it('names the selected run and role for an instruction', async () => {
  const sessionId = 'instruction_target';
  const current = { ...active, runId: 'second', sessionId };
  const f = await mount(
    sessionId,
    current,
    [],
    [{ ...current, runId: 'first', status: 'cancelled' }, current],
    'second',
  );
  // While a run goes, Send joins the execution writing the answer (composer-flow.md "전송"):
  // no send mode to choose first.
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toBe(
    'Send to: Run #2 · Writer · instruction',
  );
  expect(
    f.container.querySelector('[data-slot="composer-target"]')?.getAttribute('aria-label'),
  ).toBe(messages.Composer.targetLabel.replace('{name}', 'Writer'));
  expect(
    [...f.container.querySelectorAll('button')].some(
      (node) => node.getAttribute('aria-label') === messages.Sessions.intentLabel,
    ),
  ).toBe(false);
});

it('keeps one plan and the same draft input when explicitly choosing the target', async () => {
  const sessionId = 'compact_instruction';
  writeComposerDraft(sessionId, {
    text: 'Keep this request',
    intent: 'queue',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(sessionId, { ...active, sessionId });
  const input = f.container.querySelector('textarea');
  expect(input).not.toBeNull();
  input?.focus();
  input?.setSelectionRange(3, 8);
  await chooseTarget(f.container, 'Writer');
  expect(f.container.querySelector('textarea')).toBe(input);
  expect(input?.value).toBe('Keep this request');
  expect([input?.selectionStart, input?.selectionEnd]).toEqual([3, 8]);
  expect(f.container.querySelectorAll('[data-testid="composer-plan-fixture"]')).toHaveLength(1);
  expect(f.container.querySelector('[data-slot="agent-steering-activity"]')).toBeNull();
  expect(f.container.textContent).not.toContain(messages.Reins.noHistory);
  expect(f.container.textContent).not.toContain(messages.Reins.deliveredNote);
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toContain(
    'Writer · instruction',
  );
  // Picked with text in the box, the target is fixed on the draft.
  expect(readComposerDraft(sessionId)).toMatchObject({ intent: 'steer', target: 'execution' });
});

/** Picks the instruction's target in the tool line's target menu. */
async function chooseTarget(container: HTMLElement, name: string) {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="composer-target"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((node) =>
    node.textContent?.includes(name),
  );
  expect(item, document.body.textContent ?? '').toBeDefined();
  await act(async () => item?.click());
}

it.each(['cancelled', 'interrupted', 'failed'] as const)(
  'retries a %s request as a new entry without consuming the current draft or old entry',
  async (status) => {
    const sessionId = `retry_${status}`;
    writeComposerDraft(sessionId, {
      text: 'Keep this next draft',
      intent: 'next',
      target: null,
      targetLabel: null,
      references: [],
      images: [image],
    });
    const f = await mount(
      sessionId,
      null,
      [],
      [{ ...active, runId: 'cancelled', sessionId, status }],
    );
    const entry = {
      ...queuedEntry(captured),
      entryId: 'original',
      intent: 'next' as const,
      state: 'started' as const,
      runId: 'cancelled',
      images: [image],
      permissionMode: 'ask' as const,
    };
    // The original entry is repository state, not event-supplied request text.
    f.session.entries.push(entry);
    await f.render(null, []);
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'original' } }),
      ),
    );
    expect(f.startAuto).toHaveBeenCalledOnce();
    expect(f.startAuto.mock.calls[0]?.[0]).toMatchObject({
      brief: entry.text,
      references: [captured, image],
    });
    expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        intent: 'next',
        text: entry.text,
        attachments: [captured],
        images: [image],
        runId: 'started',
      }),
    );
    expect(f.repository.updateSessionEntry).not.toHaveBeenCalled();
    expect(
      f.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]')?.value,
    ).toBe('Keep this next draft');
  },
);

it('only resends a directive whose delivery record confirms it was not delivered', async () => {
  const sessionId = 'resend_directive';
  const f = await mount(sessionId, null);
  f.session.entries.push({
    ...queuedEntry(captured),
    entryId: 'directive',
    intent: 'steer',
    state: 'sent',
    runId: 'ended',
    commandId: 'steer_command',
  });
  for (const status of ['delivered', 'expired']) {
    f.transport.getSnapshot.mockResolvedValue({
      projection: { directives: { directive: { commandId: 'steer_command', status } } },
    } as never);
    await f.render(null, []);
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'directive' } }),
      ),
    );
    expect(f.startAuto).toHaveBeenCalledTimes(status === 'delivered' ? 0 : 1);
  }
  expect(f.repository.updateSessionEntry).not.toHaveBeenCalled();
});

it('resend cannot overwrite the receipt of an unrelated request whose answer was lost', async () => {
  const sessionId = 'retry_uncertain';
  writeComposerDraft(sessionId, {
    text: 'Uncertain current request',
    intent: 'next',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(
    sessionId,
    null,
    [],
    [{ ...active, runId: 'cancelled', sessionId, status: 'cancelled' }],
  );
  f.session.entries.push({
    ...queuedEntry(captured),
    entryId: 'original',
    intent: 'next',
    state: 'started',
    runId: 'cancelled',
  });
  await f.render(null, []);
  f.startAuto.mockRejectedValueOnce(new Error('Response lost'));
  await f.click('Send');
  expect(f.startAuto).toHaveBeenCalledOnce();
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'original' } }),
    ),
  );
  expect(f.startAuto).toHaveBeenCalledOnce();
  expect(f.container.textContent).toContain('Resolve the previous request');
});

it('a late directive lookup cannot resend after another run starts', async () => {
  const sessionId = 'resend_late';
  const f = await mount(sessionId, null);
  f.session.entries.push({
    ...queuedEntry(captured),
    entryId: 'directive',
    intent: 'steer',
    state: 'sent',
    runId: 'ended',
    commandId: 'steer_command',
  });
  let resolve!: (value: never) => void;
  f.transport.getSnapshot.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await f.render(null, []);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'directive' } }),
    ),
  );
  await f.render(active, []);
  await act(async () =>
    resolve({
      projection: { directives: { directive: { commandId: 'steer_command', status: 'expired' } } },
    } as never),
  );
  expect(f.startAuto).not.toHaveBeenCalled();
});

// The page starts a saved request only when the person does (Start now, or again after a failed
// run); the server starts the queue when a run ends (Composer.send.test.tsx).
it.each(['retry', 'queue'] as const)(
  '%s starts a saved request once despite an unrelated stale instruction draft',
  async (path) => {
    const sessionId = `stale_steer_${path}`;
    const draft = {
      text: 'Keep this  unsent instruction',
      intent: 'steer' as const,
      target: 'execution',
      targetLabel: 'Writer',
      references: [],
      images: [image],
    };
    writeComposerDraft(sessionId, draft);
    const run: RunSummary = { ...active, sessionId, status: 'cancelled' };
    const queued = queuedEntry(captured);
    const f = await mount(sessionId, null, path === 'retry' ? [] : [queued], [run], run.runId);
    if (path === 'retry') {
      f.session.entries.push({
        ...queued,
        entryId: 'retry',
        intent: 'next',
        state: 'started',
        runId: run.runId,
      });
      await f.render(null, []);
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'retry' } }),
        ),
      );
    } else {
      await f.click('Start now');
    }
    expect(f.startAuto).toHaveBeenCalledOnce();
    expect(f.startAuto.mock.calls[0]?.[0]).toMatchObject({
      brief: queued.text,
      references: [captured],
    });
    expect(readComposerDraft(sessionId)).toEqual(draft);
    expect(f.container.querySelector('textarea')?.value).toBe(draft.text);
  },
);

it('still blocks a saved request when its live team model is disconnected', async () => {
  const sessionId = 'saved_request_disconnected';
  writeComposerDraft(sessionId, {
    text: 'Unrelated stale instruction',
    intent: 'steer',
    target: 'ended',
    targetLabel: 'Writer',
    references: [],
  });
  const queued = queuedEntry(captured);
  const run: RunSummary = { ...active, sessionId, status: 'cancelled' };
  const f = await mount(sessionId, null, [queued], [run]);
  fixture.profiles = [];
  fixture.roles = [{ profileId: 'missing', name: 'Writer' }];
  (fixture.services as { live: boolean }).live = true;
  f.session.entries.push({
    ...queued,
    entryId: 'retry',
    intent: 'next',
    state: 'started',
    runId: run.runId,
  });
  await f.render(null, [queued]);
  const start = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Start now',
  );
  expect(start?.disabled).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('corral:resend-request', { detail: { sessionId, entryId: 'retry' } }),
    ),
  );
  expect(f.startAuto).not.toHaveBeenCalled();
  expect(readComposerDraft(sessionId).text).toBe('Unrelated stale instruction');
});

it('explicitly attaches a selected project material version and records that snapshot in the request', async () => {
  const attachment = createTextAttachment(
    'Coding style v1',
    'text/plain',
    'Use strict TypeScript.',
  );
  fixture.materialsRequest.mockImplementation(async (path, body) => {
    if (path.endsWith('/attachment')) {
      expect(body).toEqual({ id: 'material_style', revision: 1 });
      return { attachment };
    }
    return {
      materials: [
        {
          id: 'material_style',
          projectId: 'project',
          kind: 'instructions',
          name: 'Coding style',
          revision: 1,
          text: attachment.text,
        },
      ],
    };
  });
  writeComposerDraft('material_request', {
    text: 'Review my code',
    intent: 'next',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount('material_request', null);
  expect(readComposerDraft('material_request').attachments).toBeUndefined();
  await selectMaterial(f);
  expect(readComposerDraft('material_request').attachments).toEqual([attachment]);
  await f.click('Send');
  expect(f.startAuto).toHaveBeenCalledWith(
    expect.objectContaining({ references: [attachment], brief: 'Review my code' }),
    expect.anything(),
  );
  expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
    'material_request',
    expect.objectContaining({ attachments: [attachment] }),
  );
});

async function selectMaterial(f: Awaited<ReturnType<typeof mount>>) {
  await act(async () => {
    f.container.querySelector<HTMLButtonElement>('button[aria-label="Attachments"]')?.click();
    await new Promise(requestAnimationFrame);
  });
  const attachMaterial = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.startsWith('Attach instructions or memory'),
  );
  expect(attachMaterial).toBeDefined();
  await act(async () => attachMaterial?.click());
  const picker = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Attach project instructions or memory to this request"]',
  );
  expect(picker).not.toBeNull();
  await act(async () => picker?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.includes('Coding style'),
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
}

it('ignores completion from a dismissed picker while its replacement is still loading', async () => {
  const attachment = createTextAttachment(
    'Coding style v1',
    'text/plain',
    'Use strict TypeScript.',
  );
  const pending: ((value: unknown) => void)[] = [];
  fixture.materialsRequest.mockImplementation(async (path) => {
    if (path.endsWith('/attachment')) return new Promise((resolve) => pending.push(resolve));
    return {
      materials: [
        {
          id: 'style',
          projectId: 'project',
          kind: 'instructions',
          name: 'Coding style',
          revision: 1,
          text: attachment.text,
        },
      ],
    };
  });
  const id = 'cancelled_material';
  writeComposerDraft(id, {
    text: 'Keep my request',
    intent: 'next',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(id, null);
  await selectMaterial(f);
  expect(pending).toHaveLength(1);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await selectMaterial(f);
  expect(pending).toHaveLength(2);
  await act(async () => pending[0]?.({ attachment }));
  expect(f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
    true,
  );
  expect(readComposerDraft(id).attachments).toBeUndefined();
  await act(async () => pending[1]?.({ attachment }));
  expect(f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
    false,
  );
  expect(readComposerDraft(id)).toMatchObject({
    text: 'Keep my request',
    attachments: [attachment],
  });
});

it('browsing an older run does not change the active instruction destination', async () => {
  const sessionId = 'historical_view_current_destination';
  const current = { ...active, runId: 'second', sessionId };
  const previous = { ...current, runId: 'first', status: 'cancelled' as const };
  writeComposerDraft(sessionId, {
    text: 'Check edge cases',
    intent: 'steer',
    target: 'execution',
    targetLabel: 'Writer',
    references: [],
  });
  const f = await mount(sessionId, current, [], [previous, current], 'first');
  // The targets are the going run's, read from its live projection.
  expect(f.runFor).toHaveBeenCalledWith('second');
  expect(f.runFor).not.toHaveBeenCalledWith('first');
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toContain(
    'Run #2',
  );
  await f.click('Send');
  expect(f.transport.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'second',
      type: 'steer',
      payload: expect.objectContaining({
        targetExecutionId: 'execution',
        text: 'Check edge cases',
      }),
    }),
  );
  expect(f.startAuto).not.toHaveBeenCalled();
});

it('two independent composers use one queued identity and a conflicting loser cannot overwrite the entry', async () => {
  const queued = queuedEntry(captured);
  const first = await mount('two_tabs', null, [queued]);
  const second = await mount('two_tabs', null, [queued]);
  first.startAuto.mockRejectedValueOnce(new Error('response lost'));
  await first.click('Start now');
  second.startAuto.mockResolvedValueOnce({
    runId: null,
    receipt: {
      error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Already started with another choice' },
    },
    autoRoute: null,
  } as never);
  await second.click('Start now');
  expect(second.startAuto.mock.calls[0]?.[0]).toMatchObject({
    commandId: (first.startAuto.mock.calls[0]?.[0] as { commandId: string } | undefined)?.commandId,
  });
  expect(second.repository.updateSessionEntry).not.toHaveBeenCalled();
  second.repository.getSession.mockResolvedValueOnce({
    ...second.session,
    entries: [{ ...queued, state: 'started', runId: 'winner' }],
  });
  await second.click('Start now');
  expect(second.startAuto).toHaveBeenCalledTimes(1);
});

it('an empty session suggests up to four saved teams, and a chip sets the team through the existing selection', async () => {
  const corrals = Array.from({ length: 5 }, (_, index) => ({
    ...team,
    corralId: `team_${index + 1}`,
    name: `Team ${index + 1}`,
  }));
  const f = await mount('home_teams', null, [], [], null, 'server', false, {
    home: true,
    corrals,
  });
  const list = f.container.querySelector(`[aria-label="${messages.Sessions.startSuggestions}"]`);
  const chips = [...(list?.querySelectorAll('button') ?? [])];
  expect(chips.map((chip) => chip.textContent)).toEqual(
    ['Team 1', 'Team 2', 'Team 3', 'Team 4'].map((name) =>
      messages.Sessions.startWithTeam.replace('{team}', name),
    ),
  );
  await f.click(messages.Sessions.startWithTeam.replace('{team}', 'Team 2'));
  expect(f.repository.updateSession).toHaveBeenCalledWith('home_teams', {
    corralId: 'team_2',
    expectedRevision: 1,
  });
  expect(fixture.invalidate).toHaveBeenCalled();
  // A suggestion never writes a prompt.
  expect(f.container.querySelector('textarea')?.value).toBe('');
  expect(f.startAuto).not.toHaveBeenCalled();
});

it('shows no start suggestions without saved teams or outside the empty session', async () => {
  const empty = await mount('home_none', null, [], [], null, 'server', false, {
    home: true,
    corrals: [],
  });
  expect(
    empty.container.querySelector(`[aria-label="${messages.Sessions.startSuggestions}"]`),
  ).toBeNull();
  const busy = await mount('home_later', null, [], [], null, 'server', false, { home: false });
  expect(
    busy.container.querySelector(`[aria-label="${messages.Sessions.startSuggestions}"]`),
  ).toBeNull();
});

it('editing a queued request puts its text back in the composer and dismisses the entry', async () => {
  const sessionId = 'queue_edit';
  const f = await mount(sessionId, active, [queuedEntry(captured)]);
  await f.click(`Edit queued request: ${queuedEntry(captured).text}`);
  expect(
    f.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]')?.value,
  ).toBe('Use the captured source');
  expect(f.repository.updateSessionEntry).toHaveBeenCalledWith(sessionId, 'queued', {
    state: 'dismissed',
    detail: 'edited',
  });
  expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
});

it('shows the send keys on the tool line, never a send mode to choose first', async () => {
  const keys = (container: HTMLElement) =>
    container.querySelector('[data-slot="composer-keys"]')?.textContent ?? '';
  const sessionId = 'idle_intent';
  const finished = { ...active, runId: 'finished', sessionId, status: 'succeeded' as const };
  const f = await mount(sessionId, null, [], [finished]);
  const line = f.container.querySelector('[data-testid="composer-status-pills"]');
  // Idle, every key sends a new request: the status line names nothing and the keys say Send.
  expect(line?.textContent).not.toContain(messages.Sessions.intentShort.next);
  expect(keys(f.container)).toContain(messages.Composer.keyHint.new);
  expect(f.container.querySelector('[data-slot="composer-target"]')).toBeNull();
  // A running target: the keys join, interrupt and queue, and the target is named.
  const running = await mount('two_modes', { ...active, sessionId: 'two_modes' });
  for (const kind of ['join', 'interrupt', 'queue'] as const)
    expect(keys(running.container)).toContain(messages.Composer.keyHint[kind]);
  expect(running.container.querySelector('[data-slot="composer-target"]')).not.toBeNull();
  for (const node of [f.container, running.container])
    expect(
      [...node.querySelectorAll('button')].some(
        (button) => button.getAttribute('aria-label') === messages.Sessions.intentLabel,
      ),
    ).toBe(false);
});

it("the team chip's popup names the selected saved team's revision", async () => {
  const f = await mount('team_revision', null);
  await f.click(messages.Composer.teamLabel);
  const selected = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.getAttribute('aria-selected') === 'true',
  );
  expect(selected?.textContent).toContain('Team');
  expect(selected?.textContent).toContain('r1');
});

it("the team picker's Create or manage opens the library's teams for this project and comes back", async () => {
  fixture.href = '/sessions/manage_teams?panel=files';
  const f = await mount('manage_teams', null);
  await f.click(messages.Composer.teamLabel);
  const manage = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes(messages.Composer.manageCorrals),
  );
  expect(manage).toBeDefined();
  await act(async () => manage?.click());
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: '/library/teams',
    search: { project: 'project', returnTo: '/sessions/manage_teams?panel=files' },
  });
});

const destination = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="composer-destination"]');
const describedBy = (container: HTMLElement) =>
  (
    container
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]')
      ?.getAttribute('aria-describedby') ?? ''
  ).split(' ');

it('a new run in this session has no visible destination line; the input describes it', async () => {
  const sessionId = 'quiet_destination';
  const finished = { ...active, runId: 'finished', sessionId, status: 'succeeded' as const };
  const f = await mount(sessionId, null, [], [finished]);
  const line = destination(f.container);
  expect(line?.textContent).toBe(messages.Composer.destination.next);
  expect(line?.classList.contains('sr-only')).toBe(true);
  expect(line?.id).toBeTruthy();
  expect(describedBy(f.container)).toContain(line?.id);
});

it('an instruction destination is said by the target on the tool line and describes the input', async () => {
  const sessionId = 'shown_destination_steer';
  const current = { ...active, sessionId };
  writeComposerDraft(sessionId, {
    text: 'Later',
    intent: 'steer',
    target: 'execution',
    targetLabel: 'Writer',
    references: [],
  });
  const f = await mount(sessionId, current, [], [current]);
  const line = destination(f.container);
  const input = f.container.querySelector('textarea[aria-label="Request"]');
  expect(line?.textContent).toContain('instruction');
  // The name is shown once, on the target; the line only describes the input.
  expect(line?.classList.contains('sr-only')).toBe(true);
  expect(input).not.toBeNull();
  expect(f.container.querySelector('[data-slot="composer-target"]')?.textContent).toContain(
    'Writer',
  );
  expect(describedBy(f.container)).toContain(line?.id);
});

it('a next request that will wait is said by the input description only', async () => {
  // A run goes and nothing in it takes an instruction: every key queues.
  fixture.executionStatus = 'succeeded';
  const sessionId = 'quiet_destination_queue';
  const current = { ...active, sessionId };
  writeComposerDraft(sessionId, {
    text: 'Later',
    intent: 'queue',
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(sessionId, current, [], [current]);
  const line = destination(f.container);
  expect(line?.textContent).toBe(messages.Composer.destination.queue);
  expect(line?.classList.contains('sr-only')).toBe(true);
  expect(describedBy(f.container)).toContain(line?.id);
  expect(
    f.container.querySelector('[data-testid="composer-status-pills"]')?.textContent,
  ).not.toContain(messages.Sessions.intentShort.queue);
});

it('an instruction whose target ended shows that it cannot be delivered', async () => {
  const sessionId = 'unavailable_destination';
  writeComposerDraft(sessionId, {
    text: 'Too late',
    intent: 'steer',
    target: 'execution',
    targetLabel: 'Writer',
    references: [],
  });
  const ended = { ...active, runId: 'ended', sessionId, status: 'cancelled' as const };
  const f = await mount(sessionId, null, [], [ended]);
  const line = destination(f.container);
  expect(line?.textContent).toContain('target unavailable');
  expect(describedBy(f.container)).toContain(line?.id);
  // The blocked instruction is said once, where it can be sent another way.
  expect(f.container.querySelector('[data-testid="intent-blocked"]')?.textContent).toContain(
    messages.Composer.blocked.run,
  );
});

/** Types into the request box as a person does. */
async function type(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      value,
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('a draft typed during a run without a picked target starts a run once the run ends', async () => {
  const sessionId = 'typed_during_run';
  const ownRun = { ...active, sessionId };
  const f = await mount(sessionId, ownRun, [], [ownRun]);
  await type(f.container, 'After this run, write the summary');
  // While the run goes, Send joins it; nothing is fixed on the draft.
  expect(destination(f.container)?.textContent).toBe('Send to: Run #1 · Writer · instruction');
  // The run ends while the draft waits in the box.
  await f.render(null, []);
  expect(f.container.querySelector('[data-testid="intent-blocked"]')).toBeNull();
  expect(destination(f.container)?.textContent).toBe(messages.Composer.destination.next);
  await f.click('Send');
  expect(f.startAuto).toHaveBeenCalledWith(
    expect.objectContaining({ brief: 'After this run, write the summary' }),
    expect.anything(),
  );
  expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
    sessionId,
    expect.objectContaining({ intent: 'next', state: 'started', runId: 'started' }),
  );
});

it('a draft typed while idle and sent after a run started joins that run', async () => {
  const sessionId = 'typed_while_idle';
  const f = await mount(sessionId, null);
  await type(f.container, 'Then check the docs');
  expect(destination(f.container)?.textContent).toBe(messages.Composer.destination.next);
  await f.render({ ...active, sessionId }, []);
  await f.click('Send');
  expect(f.startAuto).not.toHaveBeenCalled();
  expect(f.transport.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'steer',
      payload: expect.objectContaining({ text: 'Then check the docs', delivery: 'next_request' }),
    }),
  );
});

it('a draft typed while idle waits behind a run of another session', async () => {
  const sessionId = 'typed_while_other';
  const f = await mount(sessionId, null);
  await type(f.container, 'Then check the docs');
  await f.render(active, []);
  await f.click('Send');
  expect(f.startAuto).not.toHaveBeenCalled();
  expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
    sessionId,
    expect.objectContaining({ intent: 'queue', state: 'queued', text: 'Then check the docs' }),
  );
});

it('an instruction typed for a run that then ends stays blocked, and its draft is kept', async () => {
  const sessionId = 'instruction_run_ended';
  const ownRun = { ...active, sessionId };
  const f = await mount(sessionId, ownRun, [], [ownRun]);
  await chooseTarget(f.container, 'Writer');
  await type(f.container, 'Use shorter sentences');
  await f.render(null, []);
  expect(f.container.querySelector('[data-testid="intent-blocked"]')?.textContent).toContain(
    messages.Composer.blocked.run,
  );
  const send = f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
  expect(send?.disabled).toBe(true);
  expect(f.container.querySelector('textarea')?.value).toBe('Use shorter sentences');
  expect(readComposerDraft(sessionId)).toMatchObject({
    text: 'Use shorter sentences',
    intent: 'steer',
    target: 'execution',
  });
  expect(f.transport.sendCommand).not.toHaveBeenCalled();
  expect(f.startAuto).not.toHaveBeenCalled();
});

it.each(['next', 'queue'] as const)(
  'nothing but the session totals sits under the input (%s)',
  async (intent) => {
    const sessionId = `quiet_footer_${intent}`;
    const finished = { ...active, runId: 'finished', sessionId, status: 'succeeded' as const };
    const current = { ...active, sessionId };
    const f =
      intent === 'next'
        ? await mount(sessionId, null, [], [finished])
        : await mount(sessionId, current, [], [finished, current]);
    await act(async () => {});
    const footer = f.container.querySelector<HTMLElement>('[data-testid="composer-footer"]');
    expect(footer).not.toBeNull();
    const text = footer?.textContent ?? '';
    for (const sentence of [
      'Continues this conversation',
      messages.Sessions.intentHint.queue,
      messages.Sessions.intentHint.steer,
      messages.Sessions.modeLive,
    ])
      expect(text).not.toContain(sentence);
    expect(footer?.querySelector('[data-testid="pre-run"]')).toBeNull();
    // The footer holds the totals and, where nothing else says so, the simulation badge.
    expect(text).toBe(
      [
        footer?.querySelector('[data-testid="composer-stats"]')?.textContent ?? '',
        footer?.querySelector('[data-testid="composer-environment"]')?.textContent ?? '',
      ].join(''),
    );
  },
);

it('says Simulated once: under the input on a server without live models, on the model chip in the demo', async () => {
  const server = await mount('environment_server', null);
  expect(server.container.querySelector('[data-testid="composer-environment"]')?.textContent).toBe(
    messages.Sessions.modeMock,
  );
  const demo = await mount('environment_demo', null, [], [], null, 'browser');
  expect(demo.container.querySelector('[data-testid="composer-environment"]')).toBeNull();
  expect(demo.container.textContent).toContain(messages.Composer.modelPicker.demo);
});

it('keeps what the next run starts with for assistive tech, not as a line under the input', async () => {
  const f = await mount('pre_run_state', null);
  await act(async () => {});
  const summary = f.container.querySelector<HTMLElement>('[data-testid="pre-run"]');
  expect(summary?.textContent).toContain('r1');
  expect(summary?.classList.contains('sr-only')).toBe(true);
  expect(summary?.closest('[data-testid="composer-footer"]')).toBeNull();
});

it.each(['next', 'queue'] as const)(
  'sends no completion criteria with a %s request; the server reads them from the session',
  async (intent) => {
    const sessionId = `done_when_${intent}`;
    const criterion = 'The build passes without warnings';
    writeComposerDraft(sessionId, {
      text: 'Fix the build',
      intent,
      target: null,
      targetLabel: null,
      references: [],
    });
    const f =
      intent === 'next'
        ? await mount(sessionId, null, [], [], null, 'server', false, {
            session: { criteria: [criterion] },
          })
        : await mount(sessionId, active, [], [], null, 'server', false, {
            session: { criteria: [criterion] },
          });
    await f.click('Send');
    if (intent === 'queue') {
      expect(f.repository.addSessionEntry).toHaveBeenCalledOnce();
      const saved = f.repository.addSessionEntry.mock.calls[0]?.[1];
      await f.render(null, [{ ...queuedEntry(captured), attachments: undefined, ...saved }]);
      await f.click('Start now');
    }
    expect(f.startAuto).toHaveBeenCalledOnce();
    const sent = JSON.stringify([
      f.startAuto.mock.calls,
      f.repository.addSessionEntry.mock.calls,
      f.repository.updateSessionEntry.mock.calls,
      f.repository.updateSession.mock.calls,
      f.transport.startRun.mock.calls,
      f.transport.sendCommand.mock.calls,
    ]);
    expect(sent).not.toContain('"criteria"');
    expect(sent).not.toContain(criterion);
  },
);
