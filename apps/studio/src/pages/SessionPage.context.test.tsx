// @vitest-environment jsdom
import type { ImageAttachment, TextAttachment } from '@corral/contracts';
import {
  type CorralSummary,
  createTextAttachment,
  type RunSummary,
  type SessionEntry,
  type WorkSession,
} from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { appendComposerAttachment, beginAttachmentCapture } from '../workbench/context/bridge.ts';
import { readComposerDraft, writeComposerDraft } from '../workbench/sessionDraft.ts';
import { Composer } from './SessionPage.tsx';

const fixture = vi.hoisted(() => ({
  services: {},
  invalidate: vi.fn(async () => {}),
  profiles: null as import('../workbench/useModels.ts').ProfileInfo[] | null,
  roles: [] as { profileId: string; name: string }[],
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ sessionRoute: {}, runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
  useNavigate: () => () => {},
  useRouter: () => ({ invalidate: fixture.invalidate }),
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
  ComposerDock: () => null,
  ComposerPlan: () => null,
}));
vi.mock('../workbench/widgets/ComposerStats.tsx', () => ({ ComposerStats: () => null }));
vi.mock('../workbench/ImageAttachments.tsx', () => ({
  ImageAttachmentPicker: () => null,
  ImageAttachmentList: () => null,
}));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixture.profiles = null;
  fixture.roles = [];
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
  layoutRevision: 1,
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
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
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
    entries: [],
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
  };
  const transport = {
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
    getRunDefinition: vi.fn(async () => ({ nodes: [{ id: 'writer', label: 'Writer' }] })),
  };
  const startExplain = vi.fn();
  // a Corral session's turn starts the conversation lead with the Corral as its team.
  const startAuto = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
    runId: 'started',
    receipt: { error: null },
    autoRoute: null,
  }));
  fixture.services = {
    repository,
    transport,
    startAuto,
    mode: 'server',
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
  return { container, session, repository, transport, startAuto, startExplain, render, click };
}

it('queues a captured source, consumes its draft attachment, and starts that snapshot without consuming next-only images or a later draft', async () => {
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
  });
  expect(saved).not.toHaveProperty('images');
  expect(f.startAuto).not.toHaveBeenCalled();
  expect(readComposerDraft(sessionId)).toMatchObject({ text: '', images: [image] });
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
      references: [captured],
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
  expect(readComposerDraft(sessionId)).toMatchObject({ attachments: [later], images: [image] });
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

it('an explain draft with captured context requires an explicit follow-up choice before sending', async () => {
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
  const send = f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
  expect(send?.disabled).toBe(true);
  expect(readComposerDraft(sessionId)).toMatchObject({
    text: 'Explain this capture',
    attachments: [captured],
  });
  expect(f.startExplain).not.toHaveBeenCalled();
  await f.click('Send as a follow-up');
  await f.click('Send');
  expect(f.startExplain).not.toHaveBeenCalled();
  expect(f.startAuto).toHaveBeenCalledWith(
    expect.objectContaining({ references: [captured], brief: 'Explain this capture' }),
    expect.anything(),
  );
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

it('names the viewed and active runs and the queue destination without changing the draft intent', async () => {
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
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toBe(
    'Send to: next run in this session · queue',
  );
  expect(readComposerDraft(sessionId).intent).toBe('queue');
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
  expect(f.container.querySelector('[data-testid="composer-destination"]')?.textContent).toBe(
    'Send to: Run #2 · Writer · #1 · instruction',
  );
});

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

it.each(['retry', 'queue', 'auto'] as const)(
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
    const run: RunSummary = {
      ...active,
      sessionId,
      status: path === 'auto' ? 'running' : 'cancelled',
    };
    const queued = queuedEntry(captured);
    const f = await mount(
      sessionId,
      path === 'auto' ? run : null,
      path === 'retry' ? [] : [queued],
      [run],
      run.runId,
    );
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
    } else if (path === 'queue') {
      await f.click('Start now');
    } else {
      const automatic = f.container.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(automatic).not.toBeNull();
      await act(async () => automatic?.click());
      expect(automatic?.getAttribute('aria-checked')).toBe('true');
      run.status = 'succeeded';
      await f.render(null, [queued]);
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
