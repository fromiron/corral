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

const fixture = vi.hoisted(() => ({ services: {}, invalidate: vi.fn(async () => {}) }));
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
  useModelProfiles: () => null,
  useTeamRoles: () => [],
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
  const repository = {
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
        output: { artifactVersionIds: ['result'] },
        artifacts: { result: { name: 'Result', version: 1 } },
      },
    })),
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
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Composer
            session={session}
            team={team}
            corrals={[team]}
            runs={runs}
            active={running}
            selectedRunId={null}
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
