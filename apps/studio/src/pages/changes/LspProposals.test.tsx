// @vitest-environment jsdom
import type { LspProposalSummary } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LspProposals } from './LspProposals.tsx';

vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(items: LspProposalSummary[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <LspProposals
        api={{
          lspProposals: async () => items,
          lspProposal: vi.fn(),
          applyLspProposal: vi.fn(),
          dismissLspProposal: vi.fn(),
        }}
        sessionId="session"
        version={0}
        onApplied={() => {}}
        renderFile={() => null}
      />,
    ),
  );
  await act(async () => {});
  return container;
}

it('is not there at all while nothing is proposed', async () => {
  const container = await mount([]);
  expect(container.querySelector('section')).toBeNull();
  expect(container.textContent).toBe('');
});

it('lists the proposals once there are some', async () => {
  const container = await mount([
    {
      proposalId: 'proposal_1',
      title: 'Rename to renamed',
      state: 'pending',
      files: [{ path: 'main.ts' }],
    } as unknown as LspProposalSummary,
  ]);
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
    'LspProposals.heading',
  );
  expect(container.textContent).toContain('LspProposals.review');
  expect(container.textContent).toContain('LspProposals.states.pending');
});
