// @vitest-environment jsdom
import type {
  FileEditOperation,
  FileEditProposal,
  LanguageState,
  WorkspaceTarget,
} from '@corral/contracts';
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { EditProposals, type FileEditClient } from './EditProposalReview.tsx';

vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../pages/ReviewPage.tsx', () => ({
  FileDiff: ({
    loadKey,
    load,
  }: {
    loadKey: string;
    load(): Promise<{ before: { text: string }; after: { text: string } }>;
  }) => {
    const [text, setText] = useState('');
    // biome-ignore lint/correctness/useExhaustiveDependencies: Match FileDiff's immutable loadKey contract.
    useEffect(() => {
      void load().then((value) => setText(`${value.before.text} → ${value.after.text}`));
    }, [loadKey]);
    return <pre>{text}</pre>;
  },
}));
const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const proposal: FileEditProposal = {
  proposalId: 'proposal_1',
  target,
  title: 'Rename a',
  hash: 'a'.repeat(64),
  dismissed: false,
  operationId: null,
  source: { kind: 'replace', query: 'before', caseSensitive: true, replacement: 'after' },
  createdAt: '2026-10-23T00:00:00Z',
  files: [
    {
      path: 'a.ts',
      before: 'before',
      after: 'after',
      beforeHash: 'b'.repeat(64),
      afterHash: 'c'.repeat(64),
    },
  ],
};
const receipt = (
  operationId: string,
  state: FileEditOperation['state'] = 'succeeded',
): FileEditOperation => ({
  operationId,
  target,
  kind: 'document.batch',
  requestHash: 'd'.repeat(64),
  state,
  result: {
    proposalId: proposal.proposalId,
    proposalHash: proposal.hash,
    outcomes: [{ path: 'a.ts', state: state === 'uncertain' ? 'uncertain' : 'applied' }],
    error: null,
  },
  createdAt: proposal.createdAt,
  updatedAt: proposal.createdAt,
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(initial: FileEditProposal | null = proposal) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let stored = initial ?? proposal;
  const api = {
    fileEditProposals: vi.fn(async () => [stored]),
    fileEditProposal: vi.fn(async () => stored),
    applyFileEdits: vi.fn(
      async (_session: string, _proposal: string, input: { operationId: string }) => {
        stored = { ...stored, operationId: input.operationId };
        return receipt(input.operationId);
      },
    ),
    dismissFileEdits: vi.fn(async () => ({ ...stored, dismissed: true })),
    inverseFileEdits: vi.fn(async () => ({
      ...proposal,
      proposalId: 'inverse_1',
      hash: 'e'.repeat(64),
      title: 'Restore a',
      source: {
        kind: 'inverse' as const,
        proposalId: proposal.proposalId,
        operationId: stored.operationId ?? 'applied',
      },
      files: proposal.files.map((file) => ({
        ...file,
        before: file.after,
        after: file.before,
        beforeHash: file.afterHash,
        afterHash: file.beforeHash,
      })),
    })),
    fileEditOperation: vi.fn(async (_session: string, operationId: string) =>
      receipt(operationId, 'uncertain'),
    ),
    reconcileFileEdits: vi.fn(async (_session: string, input: { operationId: string }) =>
      receipt(input.operationId),
    ),
    languageState: vi.fn(
      async (): Promise<LanguageState> => ({
        target,
        available: true,
        unavailableReason: null,
        servers: [],
        session: null,
      }),
    ),
  };
  const model = { setValue: vi.fn() };
  const owner = Object.assign(
    createStore<{ documents: Record<string, DocumentBuffer> }>(() => ({
      documents: {
        doc: {
          key: 'doc',
          path: 'a.ts',
          target,
          dirty: false,
          saving: false,
          pendingSave: null,
          conflict: null,
          text: 'before',
          model,
        } as unknown as DocumentBuffer,
      },
    })),
    { refresh: vi.fn(async () => {}) },
  ) as unknown as DocumentStore;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const consumed = vi.fn();
  const render = async (value: FileEditProposal | null = initial, scope = target) =>
    act(async () =>
      root.render(
        <EditProposals
          api={api as FileEditClient}
          owner={owner}
          target={scope}
          proposal={value}
          onConsumed={consumed}
        />,
      ),
    );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  const button = (key: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === `EditProposals.${key}`,
    );
  const click = async (key: string) => {
    expect(button(key), key).toBeDefined();
    await act(async () => button(key)?.click());
  };
  const patch = async (value: Partial<DocumentBuffer>) =>
    act(async () => {
      const entry = owner.getState().documents.doc;
      if (!entry) throw new Error('Missing fixture document');
      owner.setState({ documents: { doc: { ...entry, ...value } } });
    });
  return {
    api,
    owner,
    model,
    render,
    button,
    click,
    patch,
    consumed,
    setStored: (value: FileEditProposal) => {
      stored = value;
    },
  };
}

it('protects changing drafts until explicit apply and refreshes only through the document owner', async () => {
  const view = await mount();
  expect(document.body.textContent).toContain('before → after');
  await view.patch({ dirty: true, text: 'unsaved' });
  expect(view.button('apply')?.disabled).toBe(true);
  await view.click('apply');
  expect(view.api.applyFileEdits).not.toHaveBeenCalled();
  await view.patch({ dirty: false, conflict: {} as DocumentBuffer['conflict'] });
  expect(view.button('apply')?.disabled).toBe(true);
  await view.patch({ conflict: null });
  await view.click('apply');
  expect(view.api.applyFileEdits).toHaveBeenCalledWith('session', proposal.proposalId, {
    target,
    proposalHash: proposal.hash,
    operationId: expect.any(String),
  });
  expect(view.owner.refresh).toHaveBeenCalledWith('doc');
  expect(view.model.setValue).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('EditProposals.outcomes.applied');
});

it('recovers a lost apply from history with the same operation and reviews an inverse without applying it', async () => {
  const view = await mount();
  view.api.applyFileEdits.mockImplementationOnce(async (_session, _id, input) => {
    view.setStored({ ...proposal, operationId: input.operationId });
    throw new Error('response lost');
  });
  await view.click('apply');
  const operationId = view.api.applyFileEdits.mock.calls[0]?.[2].operationId;
  expect(operationId).toBeDefined();
  await view.click('check');
  expect(view.api.fileEditOperation).toHaveBeenCalledWith('session', operationId);
  await view.click('close');
  await view.render(null);
  await view.click('history');
  const entry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes('Rename a'),
  );
  expect(entry).toBeDefined();
  await act(async () => entry?.click());
  await view.click('reconcile');
  expect(view.api.reconcileFileEdits).toHaveBeenCalledWith('session', { target, operationId });
  await view.click('inverse');
  expect(view.api.inverseFileEdits).toHaveBeenCalledWith('session', proposal.proposalId, {
    target,
    operationId,
    proposalHash: proposal.hash,
    requestId: expect.any(String),
  });
  expect(document.body.textContent).toContain('after → before');
  expect(view.api.applyFileEdits).toHaveBeenCalledTimes(1);
});

it('refuses an old language generation and discards a late proposal from another copy', async () => {
  const language: FileEditProposal = {
    ...proposal,
    source: {
      kind: 'language',
      operation: 'rename',
      language: {
        generation: 'old',
        clientId: 'client',
        serverId: 'ts',
        configRevision: 1,
        fingerprint: 'f'.repeat(64),
        path: 'a.ts',
        version: 2,
      },
    },
  };
  const view = await mount(language);
  view.api.languageState.mockResolvedValueOnce({
    target,
    available: true,
    unavailableReason: null,
    servers: [],
    session: {
      generation: 'new',
      clientId: 'client',
      serverId: 'ts',
      configRevision: 1,
      fingerprint: 'f'.repeat(64),
      state: 'running',
      diagnostics: [],
      error: null,
      capabilities: {
        completion: true,
        definition: true,
        references: true,
        rename: true,
        codeActions: true,
        diagnostics: true,
        diagnosticPull: false,
        triggerCharacters: [],
      },
    },
  });
  await view.click('apply');
  expect(view.api.applyFileEdits).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('EditProposals.stale');
  let resolve!: (value: FileEditProposal) => void;
  view.api.fileEditProposals.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = (value) => done([value]);
      }),
  );
  await view.click('close');
  await view.render(null);
  await view.click('history');
  await view.render(null, { ...target, copyGeneration: 2 });
  await act(async () => resolve(language));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Rename a');
  expect(view.model.setValue).not.toHaveBeenCalled();
});
