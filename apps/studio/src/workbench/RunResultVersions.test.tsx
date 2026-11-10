// @vitest-environment jsdom
import { emptyProjection, type RunProjection } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { RunResultVersions } from './RunResultVersions.tsx';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(status: RunProjection['status']) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projection = { ...emptyProjection('run_1'), status };
  const session = sessionStore({ runId: 'run_1', projection });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunResultVersions session={session} onOpenResult={vi.fn()} onOpenArtifact={vi.fn()} />
      </IntlProvider>,
    ),
  );
  return container;
}

// chat-widgets-contract.md 7.1: with no result the view shows the real pending or none state.
// The run page's header already says the run is still working, so the state is a title only:
// no sentence about results appearing later.
it.each(['running', 'awaiting_user', 'paused'] as const)(
  'names the pending state, as a title only, while a %s run has no results yet',
  async (status) => {
    const container = await render(status);
    const state = container.querySelector('[role="status"]');
    expect(state?.textContent).toBe(messages.Results.kind.pending);
    expect(state?.querySelector('p')).toBeNull();
  },
);

it('names an ended run that made no results, as a title only', async () => {
  const container = await render('cancelled');
  const state = container.querySelector('[role="status"]');
  expect(state?.textContent).toBe(messages.Results.kind.none);
  expect(state?.querySelector('p')).toBeNull();
});
