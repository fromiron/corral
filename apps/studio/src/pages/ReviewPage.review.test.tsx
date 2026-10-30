// @vitest-environment jsdom
import type { IntegrationResultView, ReviewDecisionView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DecisionPanel } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => () => {} }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const base = 'a'.repeat(40),
  other = 'c'.repeat(40),
  to = 'b'.repeat(40);
const approved = (from: string): ReviewDecisionView => ({
  decisionId: 'decision_1',
  from,
  to,
  decision: 'approved',
  note: '',
  createdAt: '2026-10-23T00:00:00.000Z',
  stale: false,
});

async function render(
  decision: ReviewDecisionView,
  integrations: IntegrationResultView[] = [],
  revert = vi.fn(),
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = {
    workspaces: {
      decisions: vi.fn(async () => [decision]),
      integrations: vi.fn(async () => integrations),
      revert,
    },
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
      <DecisionPanel sessionId="session" from={base} to={to} changed={0} linked active={false} />,
    ),
  );
  return container;
}

it('an approval of this exact comparison is current and can be applied', async () => {
  const view = await render(approved(base));
  expect(view.querySelector('[data-testid="decision"]')?.textContent).toBe(
    'Review.decisionState.approved',
  );
  expect(view.textContent).toContain('Review.integrateHeading');
  const approve = [...view.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Review.decisionState.approved'),
  );
  expect(approve?.disabled).toBe(true);
});

it('requires confirmation before reverting', async () => {
  const revert = vi.fn(async () => {});
  const view = await render(
    approved(base),
    [
      {
        integrationId: 'integration',
        decisionId: 'decision_1',
        state: 'applied',
        createdAt: '2026-10-29T00:00:00Z',
        files: [{ path: 'note.txt', action: 'write', outcome: 'applied', detail: null }],
      },
    ],
    revert,
  );
  await act(async () =>
    [...view.querySelectorAll('button')]
      .find((button) => button.textContent === 'Review.revert')
      ?.click(),
  );
  expect(revert).not.toHaveBeenCalled();
  const cancel = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.cancelRevert',
  );
  await act(async () => cancel?.click());
  expect(revert).not.toHaveBeenCalled();
  await act(async () =>
    [...view.querySelectorAll('button')]
      .find((button) => button.textContent === 'Review.revert')
      ?.click(),
  );
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.confirmRevert',
  );
  expect(confirm).toBeDefined();
  await act(async () => confirm?.click());
  expect(revert).toHaveBeenCalledExactlyOnceWith('session', 'integration');
});

it('shows revert outcomes separately from apply outcomes', async () => {
  const view = await render(approved(base), [
    {
      integrationId: 'integration',
      decisionId: 'decision_1',
      state: 'partial',
      createdAt: '2026-10-29T00:00:00Z',
      files: [
        { path: 'a.txt', action: 'write', outcome: 'reverted', detail: null },
        { path: 'b.txt', action: 'write', outcome: 'revert_conflict', detail: null },
      ],
    },
  ]);
  expect(view.textContent).toContain('Review.integrationState.partlyReverted');
  expect(view.textContent).not.toContain('Review.integrationState.partial');
  expect(view.textContent).toContain('Review.fileOutcome.revert_conflict');
});

it('an approval of another comparison with the same result is not this review', async () => {
  const view = await render(approved(other));
  expect(view.querySelector('[data-testid="decision"]')?.textContent).toContain(
    'Review.staleDecision',
  );
  expect(view.textContent).not.toContain('Review.integrateHeading');
  const approve = [...view.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Review.approve'),
  );
  expect(approve?.disabled).toBe(false);
});
