// @vitest-environment jsdom
import type { CandidateComparisonView, Receipt } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CandidateComparison } from './CandidateComparison.tsx';

const translate = vi.hoisted(() => (key: string) => key);
vi.mock('use-intl', () => ({ useTranslations: () => translate }));
vi.mock('@corral/react/ui', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogPopup: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));
const tree = 'b'.repeat(40);
const base: CandidateComparisonView = {
  runId: 'run',
  baselineTree: 'a'.repeat(40),
  status: 'awaiting_selection',
  selectedCandidateId: null,
  candidates: ['acceptable', 'failed'].map((state, index) => ({
    candidateId: `candidate_${index + 1}`,
    modelProfile: `model_${index + 1}`,
    state: state as 'acceptable' | 'failed',
    tree,
    artifactVersionId: null,
    checks: index
      ? [
          {
            verificationId: 'failed-check',
            owner: { kind: 'manual', sessionId: 'session' },
            sessionId: 'session',
            commandId: 'types',
            configRevision: 1,
            fingerprint: 'a'.repeat(64),
            tree,
            state: 'error',
            verdict: 'pass',
            exitCode: null,
            signal: null,
            timedOut: false,
            cleanupConfirmed: true,
            targetUnchanged: true,
            durationMs: 1,
            startedAt: '2026-10-23T00:00:00Z',
            endedAt: '2026-10-23T00:00:00Z',
            retainUntil: '2026-10-24T00:00:00Z',
            output: {
              text: 'Unable to complete check',
              bytes: 24,
              hash: 'c'.repeat(64),
              truncated: false,
            },
          },
        ]
      : [],
    reason: index ? 'Required check failed' : null,
    executionIds: [],
    usage: { outputTokens: 20, modelCalls: 2, unknownOutputTokens: index ? 10 : 0 },
  })),
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let view = structuredClone(base);
  const api = {
    candidateComparison: vi.fn(async () => view),
    candidateChanges: vi.fn(async () => ({
      from: base.baselineTree,
      to: tree,
      files: [{ path: 'main.ts', status: 'M' as const }],
    })),
  };
  const receipt: Receipt = {
    commandId: 'command',
    runId: 'run',
    status: 'applied',
    acceptedSeq: 1,
    target: 'run:run',
    requestedBoundary: 'immediate',
    relatedEventIds: [],
  };
  const transport = {
    getSnapshot: vi.fn(async () => ({ projection: { controlRevision: 4 } })),
    sendCommand: vi.fn(async (command: { commandId: string }) => {
      view = { ...view, status: 'selected', selectedCandidateId: 'candidate_1' };
      return { ...receipt, commandId: command.commandId };
    }),
    getReceipt: vi.fn(async () => receipt),
    subscribe: vi.fn(() => () => {}),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <CandidateComparison
        api={api}
        transport={transport as never}
        runId="run"
        onApplied={vi.fn()}
        renderFile={() => <p>Candidate file diff</p>}
      />,
    ),
  );
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === text,
    );
  return { api, transport, container, button };
}
it('[TC-ULTRA-002-H] compares fixed files, checks and usage before explicitly applying exactly one candidate', async () => {
  const f = await mount();
  expect(f.transport.sendCommand).not.toHaveBeenCalled();
  expect(f.button('open')).toBeDefined();
  await act(async () => f.button('open')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[value="candidate_2"]')?.click(),
  );
  expect(f.container.textContent).toContain('check.error');
  expect(f.button('apply')?.disabled).toBe(true);
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[value="candidate_1"]')?.click(),
  );
  expect(f.api.candidateChanges).toHaveBeenCalledWith('run', 'candidate_1', tree);
  expect(f.container.textContent).toContain('Candidate file diff');
  expect(f.container.textContent).toContain('Required check failed');
  expect(f.container.textContent).toContain('unknownUsage');
  await act(async () => f.button('apply')?.click());
  expect(f.transport.sendCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      runId: 'run',
      type: 'select_candidate',
      expectedControlRevision: 4,
      payload: { candidateId: 'candidate_1', tree },
    }),
  );
  expect(f.button('apply')?.disabled).toBe(true);
});
it('[TC-ULTRA-002-F] recovers a lost selection receipt without sending another promotion', async () => {
  const f = await mount();
  f.transport.sendCommand.mockRejectedValueOnce(new Error('Connection lost'));
  await act(async () => f.button('open')?.click());
  await act(async () =>
    f.container.querySelector<HTMLInputElement>('input[value="candidate_1"]')?.click(),
  );
  await act(async () => f.button('apply')?.click());
  expect(f.button('apply')?.disabled).toBe(true);
  const command = f.transport.sendCommand.mock.calls[0]?.[0];
  await act(async () => f.button('recover')?.click());
  expect(f.transport.getReceipt).toHaveBeenCalledExactlyOnceWith('run', command?.commandId);
  expect(f.transport.sendCommand).toHaveBeenCalledTimes(1);
});
