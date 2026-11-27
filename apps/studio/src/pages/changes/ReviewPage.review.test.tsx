// @vitest-environment jsdom
import type { IntegrationResultView, ReviewDecisionView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WORKSPACE_CHANGED } from '../../workbench/workspaceEvents.ts';
import { DecisionPanel } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({ reviewRoute: {} }));
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
  folderFailed?: string,
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
      <DecisionPanel
        sessionId="session"
        from={base}
        to={to}
        changed={0}
        linked={!folderFailed}
        {...(folderFailed ? { folderFailed } : {})}
        active={false}
      />,
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
  // The state says it once; there is no second, disabled "Approved" button.
  expect(view.textContent?.split('Review.decisionState.approved')).toHaveLength(2);
  const approve = [...view.querySelectorAll('button')].find(
    (button) =>
      button.textContent?.includes('Review.decisionState.approved') ||
      button.textContent?.includes('Review.approve'),
  );
  expect(approve).toBeUndefined();
  expect(
    [...view.querySelectorAll('button')].some(
      (button) => button.textContent === 'Review.requestChanges',
    ),
  ).toBe(true);
});

// docs/specs/workbench.md: a failed folder read is never taken as "none".
it('an approval whose folder link could not be read says why and offers Try again', async () => {
  const view = await render(approved(base), [], vi.fn(), 'offline');
  expect(view.querySelector('[role="alert"]')?.textContent).toBe('Files.folderReadFailed');
  expect(view.textContent).not.toContain('Review.integrateHeading');
  const asked = vi.fn();
  window.addEventListener(WORKSPACE_CHANGED, asked);
  cleanups.push(async () => window.removeEventListener(WORKSPACE_CHANGED, asked));
  await act(async () =>
    [...view.querySelectorAll('button')]
      .find((button) => button.textContent === 'Files.retry')
      ?.click(),
  );
  expect(asked).toHaveBeenCalledOnce();
});

it('says nothing of the folder link before there is an approval to apply', async () => {
  const view = await render(
    { ...approved(base), decision: 'changes_requested' },
    [],
    vi.fn(),
    'offline',
  );
  expect(view.querySelector('[role="alert"]')).toBeNull();
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

async function mountPanel(
  workspaces: Record<string, unknown>,
  props: Partial<Parameters<typeof DecisionPanel>[0]> = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = { workspaces };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const draw = (more: Partial<Parameters<typeof DecisionPanel>[0]> = {}) =>
    act(async () =>
      root.render(
        <DecisionPanel
          sessionId="session"
          from={base}
          to={to}
          changed={0}
          linked
          active={false}
          {...props}
          {...more}
        />,
      ),
    );
  await draw();
  return { container, draw };
}
const named = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll('button')].filter((button) => button.textContent === name);
const alertsOf = (view: HTMLElement) =>
  [...view.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
const decisionReads = () => vi.fn<() => Promise<ReviewDecisionView[]>>();
const listen = () => {
  const asked = vi.fn();
  window.addEventListener(WORKSPACE_CHANGED, asked);
  cleanups.push(async () => window.removeEventListener(WORKSPACE_CHANGED, asked));
  return asked;
};

// docs/specs/workbench.md: the judgment is offered only once it is read, and a failed read is
// never shown as "not judged yet".
it('offers no decision before the decisions are read', async () => {
  const { container } = await mountPanel({
    decisions: () => new Promise(() => {}),
    integrations: async () => [],
  });
  expect(named(container, 'Review.approve')).toHaveLength(0);
  expect(named(container, 'Review.requestChanges')).toHaveLength(0);
});

it('a failed read of the decisions says why and offers Try again, and no decision', async () => {
  const decisions = decisionReads()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([]);
  const { container } = await mountPanel({ decisions, integrations: async () => [] });
  expect(alertsOf(container)).toEqual(['Review.decisionsReadFailed']);
  expect(named(container, 'Review.approve')).toHaveLength(0);
  await act(async () => named(container, 'Files.retry')[0]?.click());
  expect(alertsOf(container)).toEqual([]);
  expect(named(container, 'Review.approve')).toHaveLength(1);
});

it('keeps the last decision it read when a later read fails', async () => {
  const decisions = decisionReads()
    .mockResolvedValueOnce([approved(base)])
    .mockRejectedValue(new Error('offline'));
  const { container, draw } = await mountPanel({ decisions, integrations: async () => [] });
  await draw({ changed: 1 });
  expect(container.querySelector('[data-testid="decision"]')?.textContent).toBe(
    'Review.decisionState.approved',
  );
  expect(alertsOf(container)).toEqual(['Review.decisionsReadFailed']);
  expect(named(container, 'Review.approve')).toHaveLength(0);
  expect(container.textContent).toContain('Review.integrateHeading');
});

it('a recorded decision is not shown as a failed action when the read after it fails', async () => {
  const decisions = decisionReads()
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error('offline'));
  const decide = vi.fn(async () => {});
  const { container } = await mountPanel({ decisions, integrations: async () => [], decide });
  await act(async () => named(container, 'Review.approve')[0]?.click());
  expect(decide).toHaveBeenCalledOnce();
  expect(alertsOf(container)).toEqual(['Review.decisionsReadFailed']);
});

it('says one failure when the folder link also could not be read, and Try again reads both', async () => {
  const decisions = decisionReads()
    .mockResolvedValueOnce([approved(base)])
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([approved(base)]);
  const { container, draw } = await mountPanel(
    { decisions, integrations: async () => [] },
    { linked: false, folderFailed: 'offline' },
  );
  await draw({ changed: 1 });
  expect(alertsOf(container)).toEqual(['Review.decisionsReadFailed']);
  expect(named(container, 'Files.retry')).toHaveLength(1);
  const asked = listen();
  await act(async () => named(container, 'Files.retry')[0]?.click());
  expect(asked).toHaveBeenCalledOnce();
  expect(alertsOf(container)).toEqual(['Files.folderReadFailed']);
});

it('says a failed read where there is nothing to decide', async () => {
  const { container } = await mountPanel(
    {
      decisions: decisionReads().mockRejectedValue(new Error('offline')),
      integrations: async () => [],
    },
    { judged: false },
  );
  expect(alertsOf(container)).toEqual(['Review.decisionsReadFailed']);
  expect(named(container, 'Files.retry')).toHaveLength(1);
});
